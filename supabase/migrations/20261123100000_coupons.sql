begin;

-- Coupon codes managed from the organizer panel. Discounts are always computed here, in the database,
-- from the tier's server-side price: the browser only ever sends the code it typed.
create table summit_private.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9][A-Z0-9_-]{2,29}$'),
  discount_type text not null check (discount_type in ('percent', 'fixed')),
  -- percent: 1-100. fixed: paise.
  discount_value integer not null check (discount_value > 0),
  expires_at timestamptz,
  usage_limit integer check (usage_limit > 0),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (discount_type <> 'percent' or discount_value <= 100)
);
alter table summit_private.coupons enable row level security;

-- Failed-guess throttling for the public quote endpoint (stops brute-forcing codes).
create table summit_private.coupon_attempts (
  origin_hash text not null,
  attempted_at timestamptz not null default now()
);
create index summit_coupon_attempts_recent on summit_private.coupon_attempts (origin_hash, attempted_at desc);
alter table summit_private.coupon_attempts enable row level security;

-- Orders keep a snapshot of the coupon, so editing or deleting a coupon never changes a past order.
alter table summit_private.orders
  add column coupon_id uuid references summit_private.coupons(id) on delete set null,
  add column coupon_code text,
  add column discount_paise integer not null default 0 check (discount_paise >= 0);

-- A discounted order is charged less than the list price, so replace "amount >= base" with
-- "amount + discount >= base" and keep Razorpay's ₹1 minimum.
do $$
declare
  c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'summit_private.orders'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%amount_paise >= base_paise%' loop
    execute format('alter table summit_private.orders drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table summit_private.orders
  add constraint summit_orders_amount check (amount_paise >= 100 and amount_paise + discount_paise >= base_paise);
create index summit_orders_coupon on summit_private.orders (coupon_id, mode) where coupon_id is not null;

-- How many times a coupon is in use: paid orders, plus unpaid orders still inside the 30-minute payment
-- window (so several people can't race past the limit at the same moment).
create function summit_private.coupon_uses(p_coupon uuid, p_mode text) returns integer
language sql stable set search_path = ''
as $$
  select count(*)::integer from summit_private.orders
   where coupon_id = p_coupon and mode = p_mode
     and (paid_at is not null and status <> 'refunded'
          or paid_at is null and last_failed_at is null and created_at > now() - interval '30 minutes');
$$;

-- Price a tier with a coupon. Never trusts the caller for amounts.
create function summit_private.coupon_price(p_code text, p_tier text, p_mode text) returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  rec_tier summit_private.pass_tiers%rowtype;
  rec summit_private.coupons%rowtype;
  discount integer;
  amount integer;
begin
  select * into rec_tier from summit_private.pass_tiers where slug = p_tier and sale_enabled;
  if not found then return jsonb_build_object('result', 'closed'); end if;
  select * into rec from summit_private.coupons where code = upper(trim(p_code));
  if not found then return jsonb_build_object('result', 'coupon_not_found'); end if;
  if not rec.enabled then return jsonb_build_object('result', 'coupon_disabled'); end if;
  if rec.expires_at is not null and rec.expires_at <= now() then
    return jsonb_build_object('result', 'coupon_expired');
  end if;
  if rec.usage_limit is not null and summit_private.coupon_uses(rec.id, p_mode) >= rec.usage_limit then
    return jsonb_build_object('result', 'coupon_used_up');
  end if;

  -- Percentage discounts round down to whole rupees (20% of ₹2,999 = ₹599 off), so totals stay in rupees.
  discount := case rec.discount_type
    when 'percent' then (rec_tier.charge_paise::bigint * rec.discount_value / 10000 * 100)::integer
    else rec.discount_value end;
  -- Never more than the ticket price, and Razorpay needs at least ₹1 to take a payment.
  amount := greatest(rec_tier.charge_paise - discount, 100);
  return jsonb_build_object(
    'result', 'ok', 'coupon_id', rec.id, 'code', rec.code,
    'discount_type', rec.discount_type, 'discount_value', rec.discount_value,
    'price_paise', rec_tier.charge_paise, 'discount_paise', rec_tier.charge_paise - amount,
    'amount_paise', amount
  );
end;
$$;

-- Public quote used by the checkout "Apply" button (service role only, via the checkout function).
create function public.summit_coupon_quote(p_code text, p_tier text, p_mode text, p_origin_hash text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  quote jsonb;
begin
  if p_mode not in ('test', 'live') then raise exception 'Invalid mode' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('coupon-origin:' || p_origin_hash, 0));
  if (select count(*) from summit_private.coupon_attempts
       where origin_hash = p_origin_hash and attempted_at > now() - interval '10 minutes') >= 12 then
    return jsonb_build_object('result', 'coupon_limited');
  end if;

  quote := summit_private.coupon_price(p_code, p_tier, p_mode);
  if quote->>'result' = 'coupon_not_found' then
    insert into summit_private.coupon_attempts (origin_hash) values (p_origin_hash);
    delete from summit_private.coupon_attempts where attempted_at < now() - interval '1 day';
  end if;
  return quote - 'coupon_id';
end;
$$;

drop function public.summit_reserve(text,text,text,text,text,integer,text,text,uuid);

create function public.summit_reserve(
  p_hash text, p_tier text, p_name text, p_email text, p_phone text,
  p_amount integer, p_mode text, p_origin_hash text, p_worker uuid, p_coupon text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  record_order summit_private.orders%rowtype;
  record_tier summit_private.pass_tiers%rowtype;
  coupon_code text := nullif(upper(trim(coalesce(p_coupon, ''))), '');
  quote jsonb;
  charge integer;
  discount integer := 0;
  recovered boolean := false;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('checkout:' || p_hash, 0));

  select * into record_order from summit_private.orders where checkout_hash = p_hash for update;
  if found then
    if (record_order.tier, record_order.customer_name, record_order.customer_email,
        record_order.customer_phone, record_order.amount_paise, record_order.mode, record_order.coupon_code)
       is distinct from (p_tier, p_name, p_email, p_phone, p_amount, p_mode, coupon_code) then
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
    charge := record_tier.charge_paise;
    if coupon_code is not null then
      -- Serialize uses of one coupon so its usage limit holds under concurrent checkouts.
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('coupon:' || coupon_code, 0));
      quote := summit_private.coupon_price(coupon_code, p_tier, p_mode);
      if quote->>'result' <> 'ok' then
        return jsonb_build_object('result', quote->>'result');
      end if;
      charge := (quote->>'amount_paise')::integer;
      discount := (quote->>'discount_paise')::integer;
    end if;
    if charge is distinct from p_amount then
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
      base_paise, amount_paise, mode, origin_hash, coupon_id, coupon_code, discount_paise
    ) values (
      p_hash, record_tier.slug, record_tier.label, p_name, p_email, p_phone,
      record_tier.base_paise, charge, p_mode, p_origin_hash,
      (quote->>'coupon_id')::uuid, quote->>'code', discount
    ) returning * into record_order;
  end if;

  update summit_private.orders set lease_id = p_worker, lease_until = now() + interval '25 seconds', updated_at = now()
    where id = record_order.id returning * into record_order;
  return jsonb_build_object('result', 'reserved', 'recovered', recovered, 'order', to_jsonb(record_order));
end;
$$;

-- Organizer panel: list, save (create or edit) and delete coupons.
create function public.summit_admin_coupons() returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.summit_admin_access() then
    raise exception 'Summit admin access required' using errcode = '42501';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'code', c.code, 'discount_type', c.discount_type, 'discount_value', c.discount_value,
      'expires_at', c.expires_at, 'usage_limit', c.usage_limit, 'enabled', c.enabled,
      'created_at', c.created_at, 'updated_at', c.updated_at,
      'used', (select count(*) from summit_private.orders o
                where o.coupon_id = c.id and o.mode = 'live' and o.paid_at is not null and o.status <> 'refunded'),
      'held', summit_private.coupon_uses(c.id, 'live'),
      'discount_given_paise', (select coalesce(sum(o.discount_paise), 0) from summit_private.orders o
                where o.coupon_id = c.id and o.mode = 'live' and o.paid_at is not null and o.status <> 'refunded')
    ) order by c.created_at desc), '[]'::jsonb)
    from summit_private.coupons c);
end;
$$;

create function public.summit_admin_save_coupon(
  p_id uuid, p_code text, p_discount_type text, p_discount_value integer,
  p_expires_at timestamptz default null, p_usage_limit integer default null, p_enabled boolean default true
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  clean_code text := upper(trim(coalesce(p_code, '')));
  saved summit_private.coupons%rowtype;
begin
  if not public.summit_admin_access() then
    raise exception 'Summit admin access required' using errcode = '42501';
  end if;
  if clean_code !~ '^[A-Z0-9][A-Z0-9_-]{2,29}$' then
    raise exception 'Use 3–30 letters, numbers, - or _ for the code.' using errcode = '22023';
  end if;
  if p_discount_type not in ('percent', 'fixed') then
    raise exception 'Choose a percentage or a fixed amount.' using errcode = '22023';
  end if;
  if p_discount_value is null or p_discount_value < 1
     or (p_discount_type = 'percent' and p_discount_value > 100)
     or (p_discount_type = 'fixed' and p_discount_value > 100000000) then
    raise exception 'Enter a discount between 1%% and 100%%, or a positive rupee amount.' using errcode = '22023';
  end if;
  if p_usage_limit is not null and p_usage_limit < 1 then
    raise exception 'The usage limit must be at least 1, or left empty for no limit.' using errcode = '22023';
  end if;
  if exists (select 1 from summit_private.coupons where code = clean_code and id is distinct from p_id) then
    raise exception 'A coupon with this code already exists.' using errcode = '23505';
  end if;

  if p_id is null then
    insert into summit_private.coupons (code, discount_type, discount_value, expires_at, usage_limit, enabled)
      values (clean_code, p_discount_type, p_discount_value, p_expires_at, p_usage_limit, coalesce(p_enabled, true))
      returning * into saved;
  else
    update summit_private.coupons
       set code = clean_code, discount_type = p_discount_type, discount_value = p_discount_value,
           expires_at = p_expires_at, usage_limit = p_usage_limit, enabled = coalesce(p_enabled, true),
           updated_at = now()
     where id = p_id returning * into saved;
    if not found then raise exception 'This coupon no longer exists.' using errcode = 'P0002'; end if;
  end if;
  return to_jsonb(saved);
end;
$$;

create function public.summit_admin_delete_coupon(p_id uuid) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.summit_admin_access() then
    raise exception 'Summit admin access required' using errcode = '42501';
  end if;
  -- Orders keep their coupon_code and discount snapshot; only the link is cleared.
  delete from summit_private.coupons where id = p_id;
  return found;
end;
$$;

-- Show the coupon on purchases and in the CSV export.
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
        o.razorpay_payment_id, o.coupon_code)), lower(left(trim(p_search), 120))) > 0)
  ),
  rows_for_page as (
    select o.id, o.customer_name, o.customer_email, o.customer_phone, o.tier, o.pass_label,
      o.base_paise, o.amount_paise, o.refunded_paise, o.status, o.created_at, o.paid_at,
      o.last_failed_at, o.razorpay_order_id, o.razorpay_payment_id, o.coupon_code, o.discount_paise,
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

create or replace function public.summit_admin_export(p_mode text default 'live') returns jsonb
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
      'coupon_code', o.coupon_code, 'discount_paise', o.discount_paise,
      'paid_at', o.paid_at, 'checked_in_at', o.checked_in_at, 'email_status', e.status,
      'razorpay_payment_id', o.razorpay_payment_id
    ) order by o.ticket_no), '[]'::jsonb)
    from summit_private.orders o left join summit_private.ticket_email_outbox e on e.order_id = o.id
    where o.mode = p_mode and o.paid_at is not null);
end;
$$;

revoke all on function summit_private.coupon_uses(uuid,text) from public, anon, authenticated;
revoke all on function summit_private.coupon_price(text,text,text) from public, anon, authenticated;
revoke all on function public.summit_coupon_quote(text,text,text,text) from public, anon, authenticated;
revoke all on function public.summit_reserve(text,text,text,text,text,integer,text,text,uuid,text) from public, anon, authenticated;
revoke all on function public.summit_admin_coupons() from public, anon, authenticated;
revoke all on function public.summit_admin_save_coupon(uuid,text,text,integer,timestamptz,integer,boolean) from public, anon, authenticated;
revoke all on function public.summit_admin_delete_coupon(uuid) from public, anon, authenticated;

grant execute on function public.summit_coupon_quote(text,text,text,text) to service_role;
grant execute on function public.summit_reserve(text,text,text,text,text,integer,text,text,uuid,text) to service_role;
grant execute on function public.summit_admin_coupons() to authenticated;
grant execute on function public.summit_admin_save_coupon(uuid,text,text,integer,timestamptz,integer,boolean) to authenticated;
grant execute on function public.summit_admin_delete_coupon(uuid) to authenticated;

commit;
