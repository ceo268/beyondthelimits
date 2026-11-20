-- Apply the project migration first. Run against a clean local test database.
begin;

insert into auth.users(id, email) values
  ('19e6274e-3dd4-4dae-b864-d7e717ba0f6a', 'organizer@example.test'),
  ('36cf9686-6cd3-4ecd-9f0b-4fcfceeb1391', 'other@example.test');
insert into summit_private.admin_users(user_id) values ('19e6274e-3dd4-4dae-b864-d7e717ba0f6a');

do $$
begin
  if public.summit_catalog() <> '[]'::jsonb then raise exception 'Sales should start closed'; end if;
  if has_function_privilege('anon', 'public.summit_admin_orders(text,text,text,text,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.summit_record_payment(text,text,text,integer,text,text,text,text,integer)', 'execute')
     or has_schema_privilege('authenticated', 'summit_private', 'usage') then
    raise exception 'Private payment data is accessible';
  end if;
end;
$$;

-- ₹3,500 here is a test-only fixture total. This transaction is rolled back.
update summit_private.pass_tiers set charge_paise = 350000, sale_enabled = true where slug = 'standard';

set local role service_role;
do $$
declare
  order_data jsonb;
  registration uuid;
  worker uuid := 'fb280372-4613-4304-a13d-a82ecfed134d';
  other_worker uuid := '44a39755-cbff-4784-8e27-7348ed42ac35';
begin
  order_data := public.summit_reserve('fixture-token', 'standard', 'Test Buyer', 'buyer@example.test', '+919000001234', 100, 'test', 'fixture-origin', worker);
  if order_data->>'result' <> 'price_changed' then raise exception 'An altered price was accepted'; end if;

  order_data := public.summit_reserve('fixture-token', 'standard', 'Test Buyer', 'buyer@example.test', '+919000001234', 350000, 'test', 'fixture-origin', worker);
  if order_data->>'result' <> 'reserved' then raise exception 'Order could not be reserved'; end if;
  registration := (order_data #>> '{order,id}')::uuid;
  order_data := public.summit_reserve('fixture-token', 'standard', 'Test Buyer', 'buyer@example.test', '+919000001234', 350000, 'test', 'fixture-origin', other_worker);
  if order_data->>'result' <> 'busy' then raise exception 'A concurrent order lease was allowed'; end if;

  if public.summit_attach(registration, other_worker, 'order_Fixture') then raise exception 'Wrong worker attached order'; end if;
  if not public.summit_attach(registration, worker, 'order_Fixture') then raise exception 'Provider ID could not be attached'; end if;
  if public.summit_lookup('fixture-token', 'live') is not null then raise exception 'Test order accessible in live mode'; end if;

  order_data := public.summit_reserve('fixture-token', 'standard', 'Test Buyer', 'buyer@example.test', '+919000001234', 350000, 'test', 'fixture-origin', other_worker);
  if order_data->>'result' <> 'existing' or order_data #>> '{order,razorpay_order_id}' <> 'order_Fixture' then raise exception 'Retry did not reuse provider order'; end if;
  order_data := public.summit_reserve('fixture-token', 'standard', 'Changed Buyer', 'buyer@example.test', '+919000001234', 350000, 'test', 'fixture-origin', other_worker);
  if order_data->>'result' <> 'conflict' then raise exception 'A checkout token was reused with different details'; end if;

  if public.summit_record_payment('test', 'order_other', 'pay_Another', 350000, 'INR', 'captured') <> 'unknown' then
    raise exception 'Unrelated merchant order was recorded';
  end if;
  begin
    perform public.summit_record_payment('test', 'order_Fixture', 'pay_Fixture', 5000, 'INR', 'captured');
    raise exception 'Trust in provider amount was bypassed' using errcode = '22000';
  exception when raise_exception then null;
  end;

  if public.summit_record_payment('test', 'order_Fixture', 'pay_Failed', 350000, 'INR', 'failed', 'evt_failed') <> 'failed' then raise exception 'Failed status was not recorded'; end if;
  if public.summit_record_payment('test', 'order_Fixture', 'pay_Fixture', 350000, 'INR', 'captured', 'evt_refundfirst', 'rfnd_fixture', 50000) <> 'partially_refunded' then raise exception 'Refund did not record an out-of-order capture'; end if;
  if public.summit_record_payment('test', 'order_Fixture', 'pay_Fixture', 350000, 'INR', 'captured', 'evt_refundfirst', 'rfnd_fixture', 50000) <> 'partially_refunded' then raise exception 'Duplicate delivery changed state'; end if;
  if public.summit_record_payment('test', 'order_Fixture', 'pay_Failed', 350000, 'INR', 'failed', 'evt_oldfailed') <> 'partially_refunded' then raise exception 'Late failure downgraded capture'; end if;
  if public.summit_record_payment('test', 'order_Fixture', 'pay_Fixture', 350000, 'INR', 'captured', 'evt_refundagain', 'rfnd_fixture', 50000) <> 'partially_refunded' then raise exception 'Duplicate refund was counted'; end if;
  if public.summit_record_payment('test', 'order_Fixture', 'pay_Fixture', 350000, 'INR', 'captured', 'evt_fullrefund', 'rfnd_final', 300000) <> 'refunded' then raise exception 'Full refund was not recorded'; end if;
end;
$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '36cf9686-6cd3-4ecd-9f0b-4fcfceeb1391', true);
do $$
begin
  if public.summit_admin_access() then raise exception 'Regular account received organizer access'; end if;
  begin
    perform public.summit_admin_orders();
    raise exception 'Regular account queried purchases';
  exception when insufficient_privilege then null;
  end;
end;
$$;
select set_config('request.jwt.claim.sub', '19e6274e-3dd4-4dae-b864-d7e717ba0f6a', true);
do $$
declare dashboard jsonb;
begin
  if not public.summit_admin_access() then raise exception 'Organizer did not receive access'; end if;
  dashboard := public.summit_admin_orders('test', 'buyer@example.test', 'refunded', 'standard', 0);
  if dashboard->>'count' <> '1' or dashboard #>> '{totals,confirmed}' <> '0'
     or dashboard #>> '{totals,gross_paise}' <> '350000' or dashboard #>> '{totals,refunded_paise}' <> '350000'
     or dashboard #>> '{rows,0,customer_phone}' <> '+919000001234' then
    raise exception 'Admin search or metrics returned an incorrect result: %', dashboard;
  end if;
  if public.summit_admin_orders('live')->>'count' <> '0' then raise exception 'Live view includes test data'; end if;
end;
$$;
reset role;
rollback;
