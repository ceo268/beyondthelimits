-- Run in the production project after setting the Edge secrets and both Vault entries.
-- Vault: summit_ticket_email_url = https://<project-ref>.supabase.co/functions/v1/ticket-email
-- Vault: summit_ticket_email_worker_secret = the value of TICKET_EMAIL_WORKER_SECRET.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule('summit-ticket-email', '30 seconds', $job$
  select net.http_post(
    url := url_secret.decrypted_secret,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-summit-cron-secret', token_secret.decrypted_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  from vault.decrypted_secrets url_secret
  cross join vault.decrypted_secrets token_secret
  where url_secret.name = 'summit_ticket_email_url'
    and token_secret.name = 'summit_ticket_email_worker_secret'
    and exists (
      select 1 from summit_private.ticket_email_outbox
      where status in ('queued','retry','sending') and next_attempt_at <= now()
        and (lease_until is null or lease_until <= now())
    );
$job$);
