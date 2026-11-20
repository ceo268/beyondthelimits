import { databaseRpc } from "./database.mjs";
import { authorizedWorker, sendTicketEmail, ticketEmailConfigured, ticketEmailMessage } from "./resend.mjs";

export function ticketEmailHandler(env, fetcher = fetch) {
  return async (request) => {
    const headers = { "Cache-Control": "no-store" };
    if (request.method !== "POST") return Response.json({ ok: false }, { status: 405, headers });
    if (!await authorizedWorker(request.headers.get("x-summit-cron-secret"), env.TICKET_EMAIL_WORKER_SECRET)) {
      return Response.json({ ok: false }, { status: 401, headers });
    }
    if (!ticketEmailConfigured(env)) return Response.json({ ok: false }, { status: 503, headers });

    try {
      const rpc = databaseRpc(env, fetcher);
      const lease = crypto.randomUUID();
      const tickets = await rpc("summit_claim_ticket_emails", { p_lease: lease });
      const results = await Promise.allSettled(tickets.map(async (ticket) => {
        const keys = { p_order: ticket.order_id, p_lease: lease };
        const proposed = ticket.payload || ticketEmailMessage(ticket, env);
        let result;
        if (!proposed) {
          result = { outcome: "failed", errorCode: "invalid_recipient" };
        } else {
          const payload = await rpc("summit_prepare_ticket_email", { ...keys, p_payload: proposed });
          result = payload
            ? await sendTicketEmail(payload, ticket.order_id, env.RESEND_API_KEY, fetcher)
            : { outcome: "cancelled" };
        }
        const recorded = await rpc("summit_finish_ticket_email", {
          ...keys,
          p_outcome: result.outcome,
          p_provider_id: result.providerId || null,
          p_error_code: result.errorCode || null,
          p_retry_seconds: result.retrySeconds || null,
        });
        if (!recorded) throw new Error("Email lease expired.");
        return result.outcome;
      }));
      const outcomes = { sent: 0, retry: 0, failed: 0, cancelled: 0, interrupted: 0 };
      for (const result of results) {
        outcomes[result.status === "fulfilled" ? result.value : "interrupted"] += 1;
      }
      if (outcomes.interrupted) console.error("Ticket email worker left interrupted leases for retry.");
      return Response.json(outcomes, { headers });
    } catch {
      console.error("Ticket email worker could not process its batch.");
      return Response.json({ ok: false }, { status: 503, headers });
    }
  };
}
