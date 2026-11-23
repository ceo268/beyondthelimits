-- Coupons: admin management, server-side pricing, limits and checkout reservation.
-- Run after all migrations against a clean local test database. Everything is rolled back.
begin;

insert into auth.users(id, email) values
  ('5a1d0c1e-0000-4000-8000-000000000001', 'organizer@example.test'),
  ('5a1d0c1e-0000-4000-8000-000000000002', 'other@example.test');
insert into summit_private.admin_users(user_id) values ('5a1d0c1e-0000-4000-8000-000000000001');
update summit_private.pass_tiers set charge_paise = base_paise, sale_enabled = true;

do $$
begin
  if has_function_privilege('anon', 'public.summit_coupon_quote(text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.summit_coupon_quote(text,text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.summit_admin_save_coupon(uuid,text,text,integer,timestamptz,integer,boolean)', 'execute')
     or has_function_privilege('authenticated', 'summit_private.coupon_price(text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.summit_reserve(text,text,text,text,text,integer,text,text,uuid,text)', 'execute') then
    raise exception 'Coupon pricing is reachable without the checkout service';
  end if;
end;
$$;

-- A signed-in account that is not an organizer cannot manage coupons.
set local role authenticated;
select set_config('request.jwt.claim.sub', '5a1d0c1e-0000-4000-8000-000000000002', true);
do $$
begin
  begin
    perform public.summit_admin_save_coupon(null, 'HACK90', 'percent', 90);
    raise exception 'Regular account created a coupon';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.summit_admin_coupons();
    raise exception 'Regular account listed coupons';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- The organizer creates, validates and edits coupons.
select set_config('request.jwt.claim.sub', '5a1d0c1e-0000-4000-8000-000000000001', true);
do $$
declare
  saved jsonb;
begin
  perform public.summit_admin_save_coupon(null, 'bni100', 'fixed', 10000);
  saved := public.summit_admin_save_coupon(null, 'BEYOND20', 'percent', 20);
  perform public.summit_admin_save_coupon(null, 'VIP500', 'fixed', 50000, null, 1);
  perform public.summit_admin_save_coupon(null, 'OLD10', 'percent', 10, now() - interval '1 minute');
  perform public.summit_admin_save_coupon(null, 'OFF10', 'percent', 10, null, null, false);
  perform public.summit_admin_save_coupon(null, 'HUGE', 'fixed', 10000000);
  if saved->>'code' <> 'BEYOND20' or (saved->>'enabled')::boolean is not true then
    raise exception 'Coupon was not saved: %', saved;
  end if;
  if not exists (select 1 from jsonb_array_elements(public.summit_admin_coupons()) c
                  where c->>'code' = 'BNI100' and (c->>'discount_value')::int = 10000) then
    raise exception 'Codes are not stored upper-case';
  end if;

  begin
    perform public.summit_admin_save_coupon(null, 'BEYOND20', 'fixed', 100);
    raise exception 'Duplicate code accepted';
  exception when unique_violation then null;
  end;
  begin
    perform public.summit_admin_save_coupon(null, 'BAD CODE!', 'fixed', 100);
    raise exception 'Malformed code accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.summit_admin_save_coupon(null, 'TOOMUCH', 'percent', 101);
    raise exception 'Percentage over 100 accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.summit_admin_save_coupon(null, 'ZERO', 'fixed', 0);
    raise exception 'Zero discount accepted';
  exception when invalid_parameter_value then null;
  end;
  if jsonb_array_length(public.summit_admin_coupons()) <> 6 then raise exception 'Coupon list is incomplete'; end if;
end;
$$;
reset role;

-- Checkout pricing (service role only, called by the checkout Edge Function).
set local role service_role;
do $$
declare
  q jsonb;
  i integer;
  res jsonb;
  worker uuid := 'fb280372-4613-4304-a13d-a82ecfed134d';
begin
  -- Standard pass is ₹2,999. 20% rounds down to whole rupees: ₹599 off, ₹2,400 payable.
  q := public.summit_coupon_quote(' beyond20 ', 'standard', 'test', 'origin-a');
  if q->>'result' <> 'ok' or (q->>'price_paise')::int <> 299900 or (q->>'discount_paise')::int <> 59900
     or (q->>'amount_paise')::int <> 240000 or q ? 'coupon_id' then
    raise exception 'Percentage coupon priced wrongly: %', q;
  end if;
  q := public.summit_coupon_quote('BNI100', 'premium', 'test', 'origin-a');
  if (q->>'discount_paise')::int <> 10000 or (q->>'amount_paise')::int <> 489900 then
    raise exception 'Fixed coupon priced wrongly: %', q;
  end if;
  -- A discount never exceeds the price; Razorpay still needs ₹1.
  q := public.summit_coupon_quote('HUGE', 'standard', 'test', 'origin-a');
  if (q->>'amount_paise')::int <> 100 or (q->>'discount_paise')::int <> 299800 then
    raise exception 'Oversized discount was not capped: %', q;
  end if;
  if public.summit_coupon_quote('OLD10', 'standard', 'test', 'origin-a')->>'result' <> 'coupon_expired' then raise exception 'Expired coupon accepted'; end if;
  if public.summit_coupon_quote('OFF10', 'standard', 'test', 'origin-a')->>'result' <> 'coupon_disabled' then raise exception 'Disabled coupon accepted'; end if;
  if public.summit_coupon_quote('BEYOND20', 'nosuch', 'test', 'origin-a')->>'result' <> 'closed' then raise exception 'Unknown tier priced'; end if;

  -- Wrong guesses are throttled per visitor: 12 misses in 10 minutes, then even valid codes wait.
  for i in 1..12 loop
    if public.summit_coupon_quote('GUESS' || i, 'standard', 'test', 'origin-b')->>'result' <> 'coupon_not_found' then
      raise exception 'Unknown coupon was not reported';
    end if;
  end loop;
  if public.summit_coupon_quote('BEYOND20', 'standard', 'test', 'origin-b')->>'result' <> 'coupon_limited' then
    raise exception 'Coupon guessing was not throttled';
  end if;
  if public.summit_coupon_quote('BEYOND20', 'standard', 'test', 'origin-c')->>'result' <> 'ok' then
    raise exception 'Throttling leaked to another visitor';
  end if;

  -- Reservation reprices on the server: the browser's amount must match, never the reverse.
  res := public.summit_reserve('hash-1', 'standard', 'Buyer One', 'one@example.test', '+919000000001', 299900, 'test', 'origin-a', worker, 'beyond20');
  if res->>'result' <> 'price_changed' then raise exception 'Full price accepted with a coupon: %', res; end if;
  res := public.summit_reserve('hash-1', 'standard', 'Buyer One', 'one@example.test', '+919000000001', 100, 'test', 'origin-a', worker, 'beyond20');
  if res->>'result' <> 'price_changed' then raise exception 'Tampered amount accepted: %', res; end if;
  res := public.summit_reserve('hash-1', 'standard', 'Buyer One', 'one@example.test', '+919000000001', 240000, 'test', 'origin-a', worker, 'beyond20');
  if res->>'result' <> 'reserved' or res #>> '{order,coupon_code}' <> 'BEYOND20'
     or (res #>> '{order,discount_paise}')::int <> 59900 or (res #>> '{order,amount_paise}')::int <> 240000
     or (res #>> '{order,base_paise}')::int <> 299900 then
    raise exception 'Discounted order stored wrongly: %', res;
  end if;
  -- The same checkout token can't swap coupons afterwards.
  res := public.summit_reserve('hash-1', 'standard', 'Buyer One', 'one@example.test', '+919000000001', 240000, 'test', 'origin-a', worker, null);
  if res->>'result' <> 'conflict' then raise exception 'Coupon removed from an existing reservation: %', res; end if;
  -- Orders without a coupon work exactly as before.
  res := public.summit_reserve('hash-2', 'standard', 'Buyer Two', 'two@example.test', '+919000000002', 299900, 'test', 'origin-a', worker);
  if res->>'result' <> 'reserved' or (res #>> '{order,discount_paise}')::int <> 0 then raise exception 'Plain order broke: %', res; end if;
  res := public.summit_reserve('hash-3', 'standard', 'Buyer Three', 'three@example.test', '+919000000003', 269900, 'test', 'origin-a', worker, 'OLD10');
  if res->>'result' <> 'coupon_expired' then raise exception 'Expired coupon reserved: %', res; end if;

  -- Usage limit 1: a pending order holds the only use; a failed attempt releases it.
  res := public.summit_reserve('hash-4', 'vip', 'Buyer Four', 'four@example.test', '+919000000004', 649900, 'test', 'origin-a', worker, 'VIP500');
  if res->>'result' <> 'reserved' then raise exception 'Limited coupon could not be used: %', res; end if;
  if public.summit_coupon_quote('VIP500', 'vip', 'test', 'origin-a')->>'result' <> 'coupon_used_up' then raise exception 'Usage limit not enforced on quote'; end if;
  res := public.summit_reserve('hash-5', 'vip', 'Buyer Five', 'five@example.test', '+919000000005', 649900, 'test', 'origin-a', worker, 'VIP500');
  if res->>'result' <> 'coupon_used_up' then raise exception 'Usage limit not enforced on reserve: %', res; end if;
  if public.summit_coupon_quote('VIP500', 'vip', 'live', 'origin-a')->>'result' <> 'ok' then raise exception 'Test orders used up the live limit'; end if;
end;
$$;
reset role;

-- The payment fails (as the webhook would record it), which releases the held use.
update summit_private.orders set last_failed_at = now() where checkout_hash = 'hash-4';
select set_config('test.beyond', (select id::text from summit_private.coupons where code = 'BEYOND20'), true);
select set_config('test.bni', (select id::text from summit_private.coupons where code = 'BNI100'), true);

set local role service_role;
do $$
begin
  if public.summit_coupon_quote('VIP500', 'vip', 'test', 'origin-a')->>'result' <> 'ok' then raise exception 'A failed payment kept holding the coupon'; end if;
end;
$$;
reset role;

-- Edits apply instantly to new quotes; past orders keep their snapshot even if the coupon is deleted.
set local role authenticated;
select set_config('request.jwt.claim.sub', '5a1d0c1e-0000-4000-8000-000000000001', true);
do $$
begin
  perform public.summit_admin_save_coupon(current_setting('test.beyond')::uuid, 'BEYOND20', 'percent', 30);
  if not public.summit_admin_delete_coupon(current_setting('test.bni')::uuid) then
    raise exception 'Coupon was not deleted';
  end if;
  if (select count(*) from jsonb_array_elements(public.summit_admin_coupons())) <> 5 then
    raise exception 'Deleted coupon still listed';
  end if;
end;
$$;
reset role;

set local role service_role;
do $$
declare
  q jsonb := public.summit_coupon_quote('BEYOND20', 'standard', 'test', 'origin-a');
begin
  if (q->>'discount_paise')::int <> 89900 or (q->>'amount_paise')::int <> 210000 then
    raise exception 'Edited coupon value not applied: %', q;
  end if;
  if public.summit_coupon_quote('BNI100', 'standard', 'test', 'origin-a')->>'result' <> 'coupon_not_found' then
    raise exception 'Deleted coupon still works';
  end if;
end;
$$;
reset role;

do $$
begin
  if (select (coupon_code, discount_paise, amount_paise) from summit_private.orders where checkout_hash = 'hash-1')
     is distinct from ('BEYOND20'::text, 59900, 240000) then
    raise exception 'Editing a coupon changed an existing order';
  end if;
  begin
    insert into summit_private.orders (checkout_hash, tier, pass_label, customer_name, customer_email, customer_phone,
      base_paise, amount_paise, mode, origin_hash, discount_paise)
    values ('hash-bad', 'standard', 'Standard Pass', 'X', 'x@example.test', '+919000000009', 299900, 100000, 'test', 'o', 0);
    raise exception 'An undiscounted order below list price was stored';
  exception when check_violation then null;
  end;
end;
$$;

rollback;
