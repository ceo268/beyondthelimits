begin;

-- Each order gets an unguessable ticket code (128 random bits as 32 hex chars). The QR code carries it.
alter table summit_private.orders
  add column ticket_code text not null default replace(gen_random_uuid()::text, '-', ''),
  add column checked_in_at timestamptz,
  add column checked_in_by uuid references auth.users(id) on delete set null;
alter table summit_private.orders add constraint summit_orders_ticket_code unique (ticket_code);

-- Single-row settings. email_test_tickets lets organizers rehearse email + QR + scanning with Razorpay test payments.
create table summit_private.settings (
  id boolean primary key default true check (id),
  email_test_tickets boolean not null default false
);
insert into summit_private.settings default values;
alter table summit_private.settings enable row level security;
revoke all on summit_private.settings from public, anon, authenticated;

create function summit_private.emails_for(p_mode text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_mode = 'live' or coalesce((select email_test_tickets from summit_private.settings), false);
$$;
revoke all on function summit_private.emails_for(text) from public, anon, authenticated;

create or replace function summit_private.queue_ticket_email() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not summit_private.emails_for(new.mode) then return new; end if;

  if new.status = 'refunded' then
    update summit_private.ticket_email_outbox
      set status = 'cancelled', payload = null, lease_id = null, lease_until = null
      where order_id = new.id and status in ('queued','retry');
  elsif new.paid_at is not null and old.paid_at is null then
    insert into summit_private.ticket_email_outbox (order_id)
      values (new.id) on conflict (order_id) do nothing;
  end if;

  return new;
end;
$$;

create or replace function public.summit_claim_ticket_emails(p_lease uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  claimed jsonb;
begin
  -- Resend deduplicates for 24 hours. Stop automatic attempts while that window is still open.
  update summit_private.ticket_email_outbox e
     set status = case when o.status = 'refunded' then 'cancelled' else 'failed' end,
         last_error_code = case when o.status = 'refunded' then null else 'retry_window_expired' end,
         lease_until = null, lease_id = null, payload = null
    from summit_private.orders o
   where e.order_id = o.id and e.status in ('queued','retry','sending')
     and (e.lease_until is null or e.lease_until <= now())
     and (o.status = 'refunded' or e.first_attempt_at <= now() - interval '22 hours');

  with due as (
    select e.order_id
      from summit_private.ticket_email_outbox e
      join summit_private.orders o on o.id = e.order_id
     where summit_private.emails_for(o.mode) and o.status in ('paid','partially_refunded')
       and e.status in ('queued','retry','sending')
       and e.next_attempt_at <= now() and (e.lease_until is null or e.lease_until <= now())
       and (e.first_attempt_at is null or e.first_attempt_at > now() - interval '22 hours')
     order by e.next_attempt_at, e.order_id
     limit 8 for update of e skip locked
  ),
  claimed_rows as (
    update summit_private.ticket_email_outbox e
       set status = 'sending', attempts = attempts + 1, lease_id = p_lease,
           lease_until = now() + interval '90 seconds', first_attempt_at = coalesce(first_attempt_at, now())
      from due where e.order_id = due.order_id
    returning e.order_id, e.payload
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'order_id', o.id, 'name', o.customer_name, 'email', o.customer_email, 'phone', o.customer_phone,
    'tier', o.tier, 'pass_label', o.pass_label, 'amount_paise', o.amount_paise, 'mode', o.mode,
    'ticket_code', o.ticket_code, 'payload', c.payload
  )), '[]'::jsonb)
  into claimed from claimed_rows c join summit_private.orders o on o.id = c.order_id;
  return claimed;
end;
$$;

create or replace function public.summit_prepare_ticket_email(p_order uuid, p_lease uuid, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  message jsonb;
begin
  -- Freeze the sender and message so retries keep the same Resend idempotency payload.
  update summit_private.ticket_email_outbox e
     set payload = coalesce(e.payload, p_payload)
    from summit_private.orders o
   where e.order_id = p_order and e.lease_id = p_lease and e.lease_until > now()
     and o.id = p_order and summit_private.emails_for(o.mode) and o.status in ('paid','partially_refunded')
  returning e.payload into message;
  return message;
end;
$$;

-- Gate check-in. p_code is the 32-char code from the QR, or the first 8+ chars printed on the ticket.
-- p_mode must match the order (the dashboard's Test/Live selector), so test tickets never admit at the live gate.
create function public.summit_admin_check_in(p_code text, p_mode text, p_action text default 'admit') returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  code text := lower(regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g'));
  rec summit_private.orders%rowtype;
  matches integer;
  result text;
begin
  if not public.summit_admin_access() then
    raise exception 'Summit admin access required' using errcode = '42501';
  end if;
  if p_mode not in ('test', 'live') or p_action not in ('lookup', 'admit', 'undo') then
    raise exception 'Invalid check-in request' using errcode = '22023';
  end if;
  if code !~ '^[0-9a-f]{8,32}$' then
    return jsonb_build_object('result', 'invalid');
  end if;

  if length(code) = 32 then
    select * into rec from summit_private.orders where ticket_code = code and mode = p_mode for update;
  else
    select count(*) into matches from summit_private.orders
      where mode = p_mode and paid_at is not null and starts_with(ticket_code, code);
    if matches > 1 then return jsonb_build_object('result', 'ambiguous'); end if;
    select * into rec from summit_private.orders
      where mode = p_mode and paid_at is not null and starts_with(ticket_code, code) for update;
  end if;
  if not found then
    if exists (select 1 from summit_private.orders where starts_with(ticket_code, code) and mode <> p_mode) then
      return jsonb_build_object('result', 'wrong_mode');
    end if;
    return jsonb_build_object('result', 'not_found');
  end if;

  if rec.paid_at is null then
    result := 'not_paid';
  elsif rec.status = 'refunded' then
    result := 'refunded';
  elsif p_action = 'undo' then
    update summit_private.orders set checked_in_at = null, checked_in_by = null, updated_at = now()
      where id = rec.id returning * into rec;
    result := 'undone';
  elsif rec.checked_in_at is not null then
    result := 'already';
  elsif p_action = 'admit' then
    update summit_private.orders set checked_in_at = now(), checked_in_by = auth.uid(), updated_at = now()
      where id = rec.id returning * into rec;
    result := 'admitted';
  else
    result := 'valid';
  end if;

  return jsonb_build_object(
    'result', result,
    'ticket', jsonb_build_object(
      'id', rec.id, 'ticket_code', rec.ticket_code, 'name', rec.customer_name, 'email', rec.customer_email,
      'phone', rec.customer_phone, 'tier', rec.tier, 'pass_label', rec.pass_label, 'status', rec.status,
      'mode', rec.mode, 'checked_in_at', rec.checked_in_at,
      'checked_in_by', (select email from auth.users where id = rec.checked_in_by)
    )
  );
end;
$$;

create or replace function public.summit_admin_orders(
  p_mode text default 'test', p_search text default '', p_status text default '',
  p_tier text default '', p_page integer default 0
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.summit_admin_access() then
    raise exception 'Summit admin access required' using errcode = '42501';
  end if;
  if p_mode not in ('test', 'live') or p_page not between 0 and 100000 then
    raise exception 'Invalid dashboard filter' using errcode = '22023';
  end if;

  with all_orders as materialized (
    select * from summit_private.orders where mode = p_mode
  ),
  filtered as materialized (
    select * from all_orders o
    where (p_status = '' or o.status = p_status)
      and (p_tier = '' or o.tier = p_tier)
      and (p_search = '' or strpos(lower(concat_ws(' ', o.customer_name, o.customer_email, o.customer_phone,
        o.id, o.ticket_code, o.razorpay_order_id, o.razorpay_payment_id)), lower(left(p_search, 120))) > 0)
  ),
  rows_for_page as (
    select o.id, o.customer_name, o.customer_email, o.customer_phone, o.tier, o.pass_label,
      o.base_paise, o.amount_paise, o.refunded_paise, o.status, o.created_at, o.paid_at,
      o.last_failed_at, o.razorpay_order_id, o.razorpay_payment_id,
      case when o.paid_at is not null then o.ticket_code end as ticket_code, o.checked_in_at,
      e.status as ticket_email_status, e.sent_at as ticket_email_sent_at,
      e.last_error_code as ticket_email_error
    from filtered o left join summit_private.ticket_email_outbox e on e.order_id = o.id
    order by o.created_at desc, o.id desc limit 20 offset p_page * 20
  )
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
      'orders', count(*),
      'confirmed', count(*) filter (where status in ('paid', 'partially_refunded')),
      'checked_in', count(*) filter (where status in ('paid', 'partially_refunded') and checked_in_at is not null),
      'pending', count(*) filter (where status = 'pending'),
      'gross_paise', coalesce(sum(amount_paise) filter (where paid_at is not null), 0),
      'refunded_paise', coalesce(sum(refunded_paise), 0)
    ) from all_orders),
    'tiers', (select coalesce(jsonb_agg(to_jsonb(b) order by b.base_paise), '[]'::jsonb) from (
      select t.slug, t.label, t.base_paise,
        count(o.id) filter (where o.status in ('paid', 'partially_refunded')) as confirmed
      from summit_private.pass_tiers t left join all_orders o on o.tier = t.slug
      group by t.slug, t.label, t.base_paise
    ) b),
    'count', (select count(*) from filtered),
    'rows', (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc, r.id desc), '[]'::jsonb) from rows_for_page r)
  ) into result;

  return result;
end;
$$;

revoke all on function public.summit_admin_check_in(text,text,text) from public, anon, authenticated;
grant execute on function public.summit_admin_check_in(text,text,text) to authenticated;

commit;
