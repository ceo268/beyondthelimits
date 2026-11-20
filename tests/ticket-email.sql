-- Run after the migrations against an empty local test database. All fixtures are rolled back.
begin;

do $$
declare
  order_live uuid := '83a70e3b-2ad7-4856-8eb6-96c06daf1228';
  order_test uuid := 'b1c63f98-fff8-4a4d-ae1c-8613a73f27f1';
  order_cancel uuid := '11227aeb-53a8-44dd-b18b-ece68e99e08f';
  order_expired uuid := 'a9acae5f-3093-4cf4-98e1-5a8148ce49f1';
  lease uuid := '10088fce-d5b6-4ae9-9d8b-63ac2bfb4a55';
  second_lease uuid := 'd79d5824-07c7-4a5d-9aa1-76dad02ac6e2';
  claim jsonb;
  message jsonb := '{"to":["attendee@example.test"],"subject":"Original ticket"}';
begin
  if has_function_privilege('anon', 'public.summit_claim_ticket_emails(uuid)', 'execute')
    or has_function_privilege('authenticated', 'public.summit_prepare_ticket_email(uuid,uuid,jsonb)', 'execute') then
    raise exception 'Client roles can access private mail functions';
  end if;

  insert into summit_private.orders
    (id, checkout_hash, tier, pass_label, customer_name, customer_email, customer_phone,
    base_paise, amount_paise, mode, origin_hash, razorpay_order_id)
  select id, 'fixture'||id, 'standard', 'Standard Pass', 'Test Attendee', 'attendee@example.test',
    '+919000000001', 299900, 299900, mode, 'fixture', provider
  from (values (order_live,'live','order_Live'), (order_test,'test','order_Test'),
    (order_cancel,'live','order_Cancel'), (order_expired,'live','order_Expired')) fixture(id,mode,provider);

  if public.summit_record_payment('live','order_Live','pay_Live',299900,'INR','pending') <> 'pending'
    or exists (select 1 from summit_private.ticket_email_outbox) then
    raise exception 'Authorization or unpaid order incorrectly queued an email';
  end if;
  perform public.summit_record_payment('test','order_Test','pay_Test',299900,'INR','captured');
  perform public.summit_record_payment('live','order_Live','pay_Live',299900,'INR','captured');
  perform public.summit_record_payment('live','order_Live','pay_Live',299900,'INR','captured','evt_DuplicateCapture');
  if (select count(*) from summit_private.ticket_email_outbox) <> 1 then
    raise exception 'Test or duplicate capture incorrectly queued an email';
  end if;

  claim := public.summit_claim_ticket_emails(lease);
  if jsonb_array_length(claim) <> 1 or claim #>> '{0,email}' <> 'attendee@example.test'
    or public.summit_claim_ticket_emails(second_lease) <> '[]'::jsonb then
    raise exception 'Claim did not preserve the booking email or exclusive lease';
  end if;
  if public.summit_prepare_ticket_email(order_live, lease, message) <> message
    or public.summit_prepare_ticket_email(order_live, second_lease, message) is not null then
    raise exception 'Email payload was not saved with the correct lease';
  end if;
  if not public.summit_finish_ticket_email(order_live, lease, 'retry', null, 'resend_429', 45) then
    raise exception 'Transient outcome was not recorded';
  end if;
  if public.summit_claim_ticket_emails(second_lease) <> '[]'::jsonb then
    raise exception 'Retry backoff was skipped';
  end if;
  update summit_private.ticket_email_outbox set next_attempt_at=now() where order_id=order_live;
  claim := public.summit_claim_ticket_emails(second_lease);
  if claim #> '{0,payload}' <> message
    or public.summit_prepare_ticket_email(order_live, second_lease, '{"subject":"Changed"}') <> message then
    raise exception 'Retry did not preserve the first idempotency payload';
  end if;
  if not public.summit_finish_ticket_email(order_live, second_lease, 'sent', 'fixture-provider-id') then
    raise exception 'Provider acknowledgement was not recorded';
  end if;
  perform public.summit_record_payment('live','order_Live','pay_Live',299900,'INR','captured','evt_AfterSend');
  if not exists (select 1 from summit_private.ticket_email_outbox
      where order_id=order_live and status='sent' and sent_at is not null and payload is null)
    or public.summit_claim_ticket_emails(second_lease) <> '[]'::jsonb then
    raise exception 'Sent mail was not recorded exactly once and cleaned up';
  end if;

  perform public.summit_record_payment('live','order_Cancel','pay_Cancel',299900,'INR','captured');
  perform public.summit_record_payment('live','order_Cancel','pay_Cancel',299900,'INR','captured','evt_Refund','rfnd_Fixture',299900);
  if not exists (select 1 from summit_private.ticket_email_outbox where order_id=order_cancel and status='cancelled') then
    raise exception 'Fully refunded order still has email queued';
  end if;

  perform public.summit_record_payment('live','order_Expired','pay_Expired',299900,'INR','captured');
  update summit_private.ticket_email_outbox set status='retry', first_attempt_at=now()-interval '23 hours', payload=message where order_id=order_expired;
  claim := public.summit_claim_ticket_emails(lease);
  if claim <> '[]'::jsonb or not exists (
    select 1 from summit_private.ticket_email_outbox
    where order_id=order_expired and status='failed' and last_error_code='retry_window_expired' and payload is null
  ) then
    raise exception 'Retry was not stopped inside the provider idempotency window';
  end if;
end;
$$;

rollback;
