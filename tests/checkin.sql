-- Run after all migrations. Every fixture is created inside this transaction and rolled back.
-- Safe as a dry run against a hosted project too: nothing is committed.
do $$
declare
  organizer uuid := 'f0e1d2c3-b4a5-4697-8899-aabbccddeeff';
  paid_live uuid := 'c1a2b3c4-d5e6-4f70-8192-a3b4c5d6e7f8';
  paid_test uuid := 'd1a2b3c4-d5e6-4f70-8192-a3b4c5d6e7f8';
  refunded uuid := 'e1a2b3c4-d5e6-4f70-8192-a3b4c5d6e7f8';
  code text;
  reply jsonb;
  label text;
  first_no integer;
begin
  if has_function_privilege('anon', 'public.summit_admin_check_in(text,text,text)', 'execute') then
    raise exception 'Anonymous visitors can call check-in';
  end if;

  insert into auth.users (id, email) values (organizer, 'checkin-fixture@example.test');
  insert into summit_private.admin_users (user_id) values (organizer);

  insert into summit_private.orders
    (id, checkout_hash, tier, pass_label, customer_name, customer_email, customer_phone,
     base_paise, amount_paise, mode, origin_hash, razorpay_order_id)
  select id, 'checkin-fixture-' || id, 'vip', 'VIP Pass', 'Gate Fixture', 'gate@example.test',
    '+919000000009', 699900, 699900, mode, 'fixture', provider
  from (values (paid_live, 'live', 'order_CheckinLive'), (paid_test, 'test', 'order_CheckinTest'),
               (refunded, 'live', 'order_CheckinRefund')) fixture(id, mode, provider);

  if exists (select 1 from summit_private.orders where id in (paid_live, paid_test, refunded)
             and ticket_code !~ '^[0-9a-f]{32}$') then
    raise exception 'Orders did not get a 32-char ticket code';
  end if;

  update summit_private.settings set email_test_tickets = false;
  perform public.summit_record_payment('live', 'order_CheckinLive', 'pay_CheckinLive', 699900, 'INR', 'captured');
  perform public.summit_record_payment('test', 'order_CheckinTest', 'pay_CheckinTest', 699900, 'INR', 'captured');
  if not exists (select 1 from summit_private.ticket_email_outbox where order_id = paid_live)
     or exists (select 1 from summit_private.ticket_email_outbox where order_id = paid_test) then
    raise exception 'Only the live capture should queue an email while test emails are off';
  end if;

  perform public.summit_record_payment('live', 'order_CheckinRefund', 'pay_CheckinRefund', 699900, 'INR', 'captured');
  perform public.summit_record_payment('live', 'order_CheckinRefund', 'pay_CheckinRefund', 699900, 'INR',
    'captured', 'evt_CheckinRefund', 'rfnd_CheckinRefund', 699900);

  -- Signed-out callers are refused.
  begin
    perform public.summit_admin_check_in('00000000', 'live');
    raise exception 'Check-in worked without organizer access';
  exception when insufficient_privilege then null;
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', organizer, 'role', 'authenticated')::text, true);
  select ticket_code into code from summit_private.orders where id = paid_live;

  reply := public.summit_admin_check_in(code, 'live', 'lookup');
  if reply->>'result' <> 'valid' or reply #>> '{ticket,name}' <> 'Gate Fixture' then
    raise exception 'Lookup failed: %', reply;
  end if;
  reply := public.summit_admin_check_in(upper(left(code, 4) || '-' || substr(code, 5, 4)), 'live');
  if reply->>'result' <> 'admitted' or reply #>> '{ticket,checked_in_by}' <> 'checkin-fixture@example.test' then
    raise exception 'Short-code admit failed: %', reply;
  end if;
  if public.summit_admin_check_in(code, 'live')->>'result' <> 'already' then
    raise exception 'Second scan should report already checked in';
  end if;
  if public.summit_admin_check_in(code, 'live', 'undo')->>'result' <> 'undone'
     or public.summit_admin_check_in(code, 'live')->>'result' <> 'admitted' then
    raise exception 'Undo then re-admit failed';
  end if;

  -- Countable numbers: live captures get BTL-nnn in payment order, test captures TEST-nnn.
  select ticket_no, summit_private.ticket_label(mode, ticket_no) into first_no, label
    from summit_private.orders where id = paid_live;
  if label !~ '^BTL-[0-9]{3,}$'
     or (select ticket_no from summit_private.orders where id = refunded) <> first_no + 1 then
    raise exception 'Live ticket numbers are not sequential: %', label;
  end if;
  if public.summit_admin_check_in(lower(label), 'live')->>'result' <> 'already'
     or public.summit_admin_check_in(first_no::text, 'live', 'lookup') #>> '{ticket,ticket_label}' <> label then
    raise exception 'Lookup by ticket number failed';
  end if;
  select summit_private.ticket_label(mode, ticket_no) into label from summit_private.orders where id = paid_test;
  if label !~ '^TEST-[0-9]{3,}$' or public.summit_admin_check_in(label, 'live')->>'result' <> 'wrong_mode' then
    raise exception 'A TEST number must not admit at the live gate: %', label;
  end if;
  if jsonb_array_length(public.summit_admin_export('live')) < 2 then
    raise exception 'Export is missing paid tickets';
  end if;

  select ticket_code into code from summit_private.orders where id = paid_test;
  if public.summit_admin_check_in(code, 'live')->>'result' <> 'wrong_mode' then
    raise exception 'A test ticket must not admit in live mode';
  end if;
  select ticket_code into code from summit_private.orders where id = refunded;
  if public.summit_admin_check_in(code, 'live')->>'result' <> 'refunded' then
    raise exception 'A refunded ticket must not admit';
  end if;
  if public.summit_admin_check_in('BTL1:nothex', 'live')->>'result' <> 'invalid'
     or public.summit_admin_check_in(repeat('0', 32), 'live')->>'result' <> 'not_found' then
    raise exception 'Bad codes were not rejected';
  end if;

  if (public.summit_admin_orders('live', 'gate@example.test') #>> '{totals,checked_in}')::int < 1 then
    raise exception 'Dashboard totals miss the check-in';
  end if;
  raise notice 'checkin.sql: all checks passed';
end;
$$;
