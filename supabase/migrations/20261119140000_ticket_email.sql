begin;

create table summit_private.ticket_email_outbox (
  order_id uuid primary key references summit_private.orders(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','sending','retry','sent','failed','cancelled')),
  queued_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  first_attempt_at timestamptz,
  lease_until timestamptz,
  lease_id uuid,
  attempts integer not null default 0,
  payload jsonb,
  provider_id text,
  last_error_code text,
  sent_at timestamptz
);

create index ticket_email_outbox_due on summit_private.ticket_email_outbox (next_attempt_at)
  where status in ('queued','retry','sending');
alter table summit_private.ticket_email_outbox enable row level security;
revoke all on summit_private.ticket_email_outbox from public, anon, authenticated;

create function summit_private.queue_ticket_email() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.mode <> 'live' then return new; end if;

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
revoke all on function summit_private.queue_ticket_email() from public, anon, authenticated;

create trigger summit_queue_ticket_email
after update of paid_at, refunded_paise on summit_private.orders
for each row execute function summit_private.queue_ticket_email();

create function public.summit_claim_ticket_emails(p_lease uuid) returns jsonb
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
     where o.mode = 'live' and o.status in ('paid','partially_refunded')
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
    'order_id', o.id, 'name', o.customer_name, 'email', o.customer_email,
    'pass_label', o.pass_label, 'amount_paise', o.amount_paise, 'payload', c.payload
  )), '[]'::jsonb)
  into claimed from claimed_rows c join summit_private.orders o on o.id = c.order_id;
  return claimed;
end;
$$;

create function public.summit_prepare_ticket_email(p_order uuid, p_lease uuid, p_payload jsonb) returns jsonb
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
     and o.id = p_order and o.mode = 'live' and o.status in ('paid','partially_refunded')
  returning e.payload into message;
  return message;
end;
$$;

create function public.summit_finish_ticket_email(
  p_order uuid, p_lease uuid, p_outcome text, p_provider_id text default null,
  p_error_code text default null, p_retry_seconds integer default null
) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_outcome not in ('sent','retry','failed','cancelled') or (p_outcome = 'sent' and p_provider_id is null) then
    raise exception 'Invalid email result';
  end if;

  update summit_private.ticket_email_outbox
     set status = p_outcome, lease_id = null, lease_until = null,
         next_attempt_at = case when p_outcome = 'retry' then
           now() + make_interval(secs => greatest(30, least(3600,
             coalesce(p_retry_seconds, 30 * (2 ^ least(attempts, 7))::integer))))
           else next_attempt_at end,
         payload = case when p_outcome = 'retry' then payload else null end,
         provider_id = case when p_outcome = 'sent' then p_provider_id else null end,
         sent_at = case when p_outcome = 'sent' then now() else null end,
         last_error_code = p_error_code
   where order_id = p_order and lease_id = p_lease and status = 'sending';
  return found;
end;
$$;

revoke all on function public.summit_claim_ticket_emails(uuid) from public, anon, authenticated;
revoke all on function public.summit_prepare_ticket_email(uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.summit_finish_ticket_email(uuid,uuid,text,text,text,integer) from public, anon, authenticated;
grant execute on function public.summit_claim_ticket_emails(uuid) to service_role;
grant execute on function public.summit_prepare_ticket_email(uuid,uuid,jsonb) to service_role;
grant execute on function public.summit_finish_ticket_email(uuid,uuid,text,text,text,integer) to service_role;

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
        o.id, o.razorpay_order_id, o.razorpay_payment_id)), lower(left(p_search, 120))) > 0)
  ),
  rows_for_page as (
    select o.id, o.customer_name, o.customer_email, o.customer_phone, o.tier, o.pass_label,
      o.base_paise, o.amount_paise, o.refunded_paise, o.status, o.created_at, o.paid_at,
      o.last_failed_at, o.razorpay_order_id, o.razorpay_payment_id,
      e.status as ticket_email_status, e.sent_at as ticket_email_sent_at,
      e.last_error_code as ticket_email_error
    from filtered o left join summit_private.ticket_email_outbox e on e.order_id = o.id
    order by o.created_at desc, o.id desc limit 20 offset p_page * 20
  )
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
      'orders', count(*),
      'confirmed', count(*) filter (where status in ('paid', 'partially_refunded')),
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

commit;
