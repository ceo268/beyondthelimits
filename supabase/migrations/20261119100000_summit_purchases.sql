begin;

create schema summit_private;
revoke all on schema summit_private from public, anon, authenticated;

create table summit_private.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);

create table summit_private.pass_tiers (
  slug text primary key,
  label text not null,
  base_paise integer not null check (base_paise >= 100),
  charge_paise integer check (charge_paise >= base_paise),
  sale_enabled boolean not null default false,
  check (not sale_enabled or charge_paise is not null)
);

insert into summit_private.pass_tiers (slug, label, base_paise) values
  ('standard', 'Standard Pass', 299900),
  ('premium', 'Premium Pass', 499900),
  ('vip', 'VIP Pass', 699900);

create table summit_private.orders (
  id uuid primary key default gen_random_uuid(),
  checkout_hash text not null unique,
  tier text not null references summit_private.pass_tiers(slug),
  pass_label text not null,
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
  base_paise integer not null,
  amount_paise integer not null check (amount_paise >= base_paise),
  currency text not null default 'INR' check (currency = 'INR'),
  mode text not null check (mode in ('test', 'live')),
  origin_hash text not null,
  razorpay_order_id text,
  razorpay_payment_id text,
  last_failed_at timestamptz,
  paid_at timestamptz,
  refunded_paise integer not null default 0 check (refunded_paise between 0 and amount_paise),
  status text generated always as (
    case
      when paid_at is not null and refunded_paise = amount_paise then 'refunded'
      when paid_at is not null and refunded_paise > 0 then 'partially_refunded'
      when paid_at is not null then 'paid'
      when last_failed_at is not null then 'failed'
      else 'pending'
    end
  ) stored,
  lease_id uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (mode, razorpay_order_id),
  unique (mode, razorpay_payment_id)
);

create index summit_orders_admin_page on summit_private.orders (mode, created_at desc, id desc);
create index summit_orders_recent_email on summit_private.orders (mode, customer_email, created_at desc);
create index summit_orders_recent_origin on summit_private.orders (mode, origin_hash, created_at desc);

create table summit_private.webhook_receipts (
  mode text not null check (mode in ('test', 'live')),
  event_id text not null,
  order_id uuid not null references summit_private.orders(id) on delete cascade,
  recorded_at timestamptz not null default now(),
  primary key (mode, event_id)
);

create table summit_private.processed_refunds (
  mode text not null check (mode in ('test', 'live')),
  refund_id text not null,
  order_id uuid not null references summit_private.orders(id) on delete cascade,
  amount_paise integer not null check (amount_paise > 0),
  primary key (mode, refund_id)
);
create index summit_refunds_order on summit_private.processed_refunds (order_id);

alter table summit_private.admin_users enable row level security;
alter table summit_private.pass_tiers enable row level security;
alter table summit_private.orders enable row level security;
alter table summit_private.webhook_receipts enable row level security;
alter table summit_private.processed_refunds enable row level security;

create function public.summit_catalog() returns jsonb
language sql security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'tier', slug, 'label', label, 'base_paise', base_paise, 'amount_paise', charge_paise
  ) order by base_paise), '[]'::jsonb)
  from summit_private.pass_tiers
  where sale_enabled;
$$;

create function public.summit_reserve(
  p_hash text, p_tier text, p_name text, p_email text, p_phone text,
  p_amount integer, p_mode text, p_origin_hash text, p_worker uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  record_order summit_private.orders%rowtype;
  record_tier summit_private.pass_tiers%rowtype;
  recovered boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('checkout:' || p_hash, 0));

  select * into record_order from summit_private.orders where checkout_hash = p_hash for update;
  if found then
    if (record_order.tier, record_order.customer_name, record_order.customer_email,
        record_order.customer_phone, record_order.amount_paise, record_order.mode)
       is distinct from (p_tier, p_name, p_email, p_phone, p_amount, p_mode) then
      return jsonb_build_object('result', 'conflict');
    end if;
    if record_order.razorpay_order_id is not null then
      return jsonb_build_object('result', 'existing', 'order', to_jsonb(record_order));
    end if;
    if record_order.lease_until > now() then
      return jsonb_build_object('result', 'busy');
    end if;
    recovered := true;
  else
    select * into record_tier from summit_private.pass_tiers where slug = p_tier and sale_enabled;
    if not found then
      return jsonb_build_object('result', 'closed');
    end if;
    if record_tier.charge_paise is distinct from p_amount then
      return jsonb_build_object('result', 'price_changed');
    end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('origin:' || p_origin_hash, 0));
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('contact:' || p_email, 0));
    if (select count(*) from summit_private.orders
          where mode = p_mode and origin_hash = p_origin_hash and created_at > now() - interval '10 minutes') >= 40
       or (select count(*) from summit_private.orders
          where mode = p_mode and customer_email = p_email and created_at > now() - interval '10 minutes') >= 6 then
      return jsonb_build_object('result', 'limited');
    end if;

    insert into summit_private.orders (
      checkout_hash, tier, pass_label, customer_name, customer_email, customer_phone,
      base_paise, amount_paise, mode, origin_hash
    ) values (
      p_hash, record_tier.slug, record_tier.label, p_name, p_email, p_phone,
      record_tier.base_paise, record_tier.charge_paise, p_mode, p_origin_hash
    ) returning * into record_order;
  end if;

  update summit_private.orders set lease_id = p_worker, lease_until = now() + interval '25 seconds', updated_at = now()
    where id = record_order.id returning * into record_order;
  return jsonb_build_object('result', 'reserved', 'recovered', recovered, 'order', to_jsonb(record_order));
end;
$$;

create function public.summit_attach(p_id uuid, p_worker uuid, p_razorpay_order_id text) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update summit_private.orders
    set razorpay_order_id = p_razorpay_order_id, lease_id = null, lease_until = null, updated_at = now()
    where id = p_id and lease_id = p_worker and razorpay_order_id is null;
  return found;
end;
$$;

create function public.summit_lookup(p_hash text, p_mode text) returns jsonb
language sql security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', id, 'status', status, 'amount_paise', amount_paise, 'currency', currency,
    'tier', tier, 'label', pass_label, 'razorpay_order_id', razorpay_order_id
  )
  from summit_private.orders where checkout_hash = p_hash and mode = p_mode;
$$;

create function public.summit_record_payment(
  p_mode text, p_order_id text, p_payment_id text, p_amount integer, p_currency text,
  p_state text, p_event_id text default null, p_refund_id text default null, p_refund_amount integer default null
) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  record_order summit_private.orders%rowtype;
  new_refunded bigint;
begin
  select * into record_order from summit_private.orders
    where mode = p_mode and razorpay_order_id = p_order_id for update;
  if not found then return 'unknown'; end if;
  if record_order.amount_paise is distinct from p_amount or record_order.currency is distinct from p_currency then
    raise exception 'Payment amount or currency differs from order';
  end if;

  if p_event_id is not null then
    insert into summit_private.webhook_receipts (mode, event_id, order_id)
      values (p_mode, p_event_id, record_order.id) on conflict do nothing;
    if not found then return record_order.status; end if;
  end if;

  if p_state = 'failed' and record_order.paid_at is null then
    update summit_private.orders set last_failed_at = now(), updated_at = now()
      where id = record_order.id returning status into record_order.status;
  elsif p_state = 'captured' then
    if record_order.razorpay_payment_id is not null and record_order.razorpay_payment_id <> p_payment_id then
      raise exception 'A different payment already captured this order';
    end if;
    if p_refund_id is not null then
      insert into summit_private.processed_refunds (mode, refund_id, order_id, amount_paise)
        values (p_mode, p_refund_id, record_order.id, p_refund_amount) on conflict do nothing;
    end if;
    select coalesce(sum(amount_paise), 0) into new_refunded
      from summit_private.processed_refunds where order_id = record_order.id;
    if new_refunded > record_order.amount_paise then
      raise exception 'Processed refunds exceed the captured amount';
    end if;
    update summit_private.orders
      set razorpay_payment_id = p_payment_id, paid_at = coalesce(paid_at, now()),
          refunded_paise = new_refunded, updated_at = now()
      where id = record_order.id returning status into record_order.status;
  end if;
  return record_order.status;
end;
$$;

create function public.summit_admin_access() returns boolean
language sql security definer set search_path = ''
as $$
  select exists (select 1 from summit_private.admin_users where user_id = auth.uid());
$$;

create function public.summit_admin_orders(
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
    select id, customer_name, customer_email, customer_phone, tier, pass_label, base_paise, amount_paise,
      refunded_paise, status, created_at, paid_at, last_failed_at, razorpay_order_id, razorpay_payment_id
    from filtered order by created_at desc, id desc limit 20 offset p_page * 20
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

revoke all on function public.summit_catalog() from public, anon, authenticated;
revoke all on function public.summit_reserve(text,text,text,text,text,integer,text,text,uuid) from public, anon, authenticated;
revoke all on function public.summit_attach(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.summit_lookup(text,text) from public, anon, authenticated;
revoke all on function public.summit_record_payment(text,text,text,integer,text,text,text,text,integer) from public, anon, authenticated;
revoke all on function public.summit_admin_access() from public, anon, authenticated;
revoke all on function public.summit_admin_orders(text,text,text,text,integer) from public, anon, authenticated;

grant execute on function public.summit_catalog() to service_role;
grant execute on function public.summit_reserve(text,text,text,text,text,integer,text,text,uuid) to service_role;
grant execute on function public.summit_attach(uuid,uuid,text) to service_role;
grant execute on function public.summit_lookup(text,text) to service_role;
grant execute on function public.summit_record_payment(text,text,text,integer,text,text,text,text,integer) to service_role;
grant execute on function public.summit_admin_access() to authenticated;
grant execute on function public.summit_admin_orders(text,text,text,text,integer) to authenticated;

commit;
