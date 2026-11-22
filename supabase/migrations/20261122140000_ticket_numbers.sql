begin;

-- Countable ticket numbers (BTL-001, BTL-002, ...) assigned in payment order. Test payments use TEST-001.
-- The QR keeps carrying the unguessable ticket_code; the number is for people (ticket, admin, gate).
create sequence summit_private.ticket_no_live;
create sequence summit_private.ticket_no_test;
revoke all on sequence summit_private.ticket_no_live, summit_private.ticket_no_test from public, anon, authenticated;

alter table summit_private.orders add column ticket_no integer;
alter table summit_private.orders add constraint summit_orders_ticket_no unique (mode, ticket_no);

create function summit_private.ticket_label(p_mode text, p_no integer) returns text
language sql immutable set search_path = ''
as $$
  select case when p_no is null then null
    else case when p_mode = 'live' then 'BTL-' else 'TEST-' end || lpad(p_no::text, 3, '0') end;
$$;

create function summit_private.assign_ticket_no() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.paid_at is not null and new.ticket_no is null then
    new.ticket_no := nextval(case when new.mode = 'live'
      then 'summit_private.ticket_no_live' else 'summit_private.ticket_no_test' end::regclass);
  end if;
  return new;
end;
$$;
revoke all on function summit_private.assign_ticket_no() from public, anon, authenticated;

create trigger summit_assign_ticket_no
before update of paid_at on summit_private.orders
for each row execute function summit_private.assign_ticket_no();

-- Number any orders already paid, oldest first.
do $$
declare
  r record;
begin
  for r in select id, mode from summit_private.orders where paid_at is not null and ticket_no is null order by paid_at, id loop
    update summit_private.orders set ticket_no = nextval(case when r.mode = 'live'
      then 'summit_private.ticket_no_live' else 'summit_private.ticket_no_test' end::regclass) where id = r.id;
  end loop;
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
    'tier', o.tier, 'pass_label', o.pass_label, 'amount_paise', o.amount_paise, 'base_paise', o.base_paise,
    'mode', o.mode, 'ticket_code', o.ticket_code, 'ticket_label', summit_private.ticket_label(o.mode, o.ticket_no),
    'paid_at', o.paid_at, 'payload', c.payload
  )), '[]'::jsonb)
  into claimed from claimed_rows c join summit_private.orders o on o.id = c.order_id;
  return claimed;
end;
$$;

-- Gate check-in. p_code is the 32-char code from the QR, a ticket number (BTL-007 / 7), or 8+ chars of the code.
create or replace function public.summit_admin_check_in(p_code text, p_mode text, p_action text default 'admit') returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  raw text := lower(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  code text := replace(raw, '-', '');
  number_match text[] := regexp_match(raw, '^(btl|test)?-?0*([0-9]{1,6})$');
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

  if number_match is not null and length(code) < 8 then
    if number_match[1] = 'test' and p_mode = 'live' or number_match[1] = 'btl' and p_mode = 'test' then
      return jsonb_build_object('result', 'wrong_mode');
    end if;
    select * into rec from summit_private.orders
      where mode = p_mode and ticket_no = number_match[2]::integer for update;
  elsif code !~ '^[0-9a-f]{8,32}$' then
    return jsonb_build_object('result', 'invalid');
  elsif length(code) = 32 then
    select * into rec from summit_private.orders where ticket_code = code and mode = p_mode for update;
  else
    select count(*) into matches from summit_private.orders
      where mode = p_mode and paid_at is not null and starts_with(ticket_code, code);
    if matches > 1 then return jsonb_build_object('result', 'ambiguous'); end if;
    select * into rec from summit_private.orders
      where mode = p_mode and paid_at is not null and starts_with(ticket_code, code) for update;
  end if;
  if not found then
    if length(code) >= 8 and exists (select 1 from summit_private.orders where starts_with(ticket_code, code) and mode <> p_mode) then
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
      'id', rec.id, 'ticket_code', rec.ticket_code, 'ticket_label', summit_private.ticket_label(rec.mode, rec.ticket_no),
      'name', rec.customer_name, 'email', rec.customer_email,
      'phone', rec.customer_phone, 'tier', rec.tier, 'pass_label', rec.pass_label, 'status', rec.status,
      'mode', rec.mode, 'checked_in_at', rec.checked_in_at,
      'checked_in_by', (select email from auth.users where id = rec.checked_in_by)
    )
  );
end;
$$;

create or replace function public.summit_admin_orders(
  p_mode text default 'live', p_search text default '', p_status text default '',
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
    where (p_status = '' or o.status = p_status or (p_status = 'checked_in' and o.checked_in_at is not null))
      and (p_tier = '' or o.tier = p_tier)
      and (p_search = '' or strpos(lower(concat_ws(' ', o.customer_name, o.customer_email, o.customer_phone,
        o.id, o.ticket_code, summit_private.ticket_label(o.mode, o.ticket_no), o.razorpay_order_id,
        o.razorpay_payment_id)), lower(left(trim(p_search), 120))) > 0)
  ),
  rows_for_page as (
    select o.id, o.customer_name, o.customer_email, o.customer_phone, o.tier, o.pass_label,
      o.base_paise, o.amount_paise, o.refunded_paise, o.status, o.created_at, o.paid_at,
      o.last_failed_at, o.razorpay_order_id, o.razorpay_payment_id,
      case when o.paid_at is not null then o.ticket_code end as ticket_code,
      o.ticket_no, summit_private.ticket_label(o.mode, o.ticket_no) as ticket_label, o.checked_in_at,
      e.status as ticket_email_status, e.sent_at as ticket_email_sent_at,
      e.last_error_code as ticket_email_error
    from filtered o left join summit_private.ticket_email_outbox e on e.order_id = o.id
    order by o.ticket_no desc nulls last, o.created_at desc, o.id desc limit 20 offset p_page * 20
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
        count(o.id) filter (where o.status in ('paid', 'partially_refunded')) as confirmed,
        count(o.id) filter (where o.status in ('paid', 'partially_refunded') and o.checked_in_at is not null) as checked_in
      from summit_private.pass_tiers t left join all_orders o on o.tier = t.slug
      group by t.slug, t.label, t.base_paise
    ) b),
    'count', (select count(*) from filtered),
    'rows', (select coalesce(jsonb_agg(to_jsonb(r) order by r.ticket_no desc nulls last, r.created_at desc, r.id desc), '[]'::jsonb) from rows_for_page r)
  ) into result;

  return result;
end;
$$;

-- Full attendee list for CSV export (every paid ticket, including refunded ones, marked as such).
create function public.summit_admin_export(p_mode text default 'live') returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.summit_admin_access() then
    raise exception 'Summit admin access required' using errcode = '42501';
  end if;
  if p_mode not in ('test', 'live') then
    raise exception 'Invalid export' using errcode = '22023';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'ticket', summit_private.ticket_label(o.mode, o.ticket_no), 'name', o.customer_name,
      'email', o.customer_email, 'phone', o.customer_phone, 'pass', o.pass_label,
      'amount_paise', o.amount_paise, 'refunded_paise', o.refunded_paise, 'status', o.status,
      'paid_at', o.paid_at, 'checked_in_at', o.checked_in_at, 'email_status', e.status,
      'razorpay_payment_id', o.razorpay_payment_id
    ) order by o.ticket_no), '[]'::jsonb)
    from summit_private.orders o left join summit_private.ticket_email_outbox e on e.order_id = o.id
    where o.mode = p_mode and o.paid_at is not null);
end;
$$;
revoke all on function public.summit_admin_export(text) from public, anon, authenticated;
grant execute on function public.summit_admin_export(text) to authenticated;

commit;
