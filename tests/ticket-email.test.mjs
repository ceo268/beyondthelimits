import assert from "node:assert/strict";
import test from "node:test";
import { ticketEmailMessage, sendTicketEmail } from "../supabase/functions/_shared/resend.mjs";
import { ticketEmailHandler } from "../supabase/functions/_shared/ticket-worker.mjs";
import { checkoutHandler } from "../supabase/functions/_shared/core.mjs";

const env = {
  SUPABASE_URL: "https://database.example.test",
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_fixture" }),
  RESEND_API_KEY: "re_fixture_key",
  RESEND_FROM_EMAIL: "Beyond the Limits <tickets@example.test>",
  TICKET_EMAIL_WORKER_SECRET: "fixture_worker_authentication_secret_01",
  TICKET_EVENT_VENUE: "Sir Mutha Venkatasubba Rao Concert Hall",
};
const ticket = {
  order_id: "83a70e3b-2ad7-4856-8eb6-96c06daf1228",
  name: "Asha <Example>",
  email: "attendee@example.test",
  pass_label: "Standard Pass",
  amount_paise: 299900,
};
const invoke = (secret) => new Request("https://database.example.test/functions/v1/ticket-email", {
  method: "POST",
  headers: { "x-summit-cron-secret": secret },
});

test("email is the attendee ticket and escapes customer data", () => {
  const message = ticketEmailMessage(ticket, env);
  assert.deepEqual(message.to, [ticket.email]);
  assert.equal(message.from, env.RESEND_FROM_EMAIL);
  assert.match(message.text, /7 February 2027/);
  assert.match(message.text, /₹2,999/);
  assert(message.text.includes(ticket.order_id));
  assert.match(message.html, /Asha &lt;Example&gt;/);
  assert.doesNotMatch(message.html, /Asha <Example>/);
  assert.equal(ticketEmailMessage({ ...ticket, email: "invalid" }, env), null);
});

test("worker rejects disallowed callers and incomplete configuration before claiming an order", async () => {
  const neverFetch = () => assert.fail("External call from unauthorized worker");
  const handler = ticketEmailHandler(env, neverFetch);
  assert.equal((await handler(invoke("incorrect-secret"))).status, 401);
  assert.equal((await ticketEmailHandler({ ...env, RESEND_API_KEY: "" }, neverFetch)(invoke(env.TICKET_EMAIL_WORKER_SECRET))).status, 503);
});

test("worker uses the exact frozen message, booking address, and stable idempotency key", async () => {
  let prepared;
  let finished;
  const expected = ticketEmailMessage(ticket, env);
  const handler = ticketEmailHandler(env, async (url, options) => {
    const payload = JSON.parse(options.body);
    if (url.endsWith("/summit_claim_ticket_emails")) return Response.json([ticket]);
    if (url.endsWith("/summit_prepare_ticket_email")) {
      prepared = payload;
      assert.deepEqual(payload.p_payload, expected);
      return Response.json(expected);
    }
    if (url === "https://api.resend.com/emails") {
      assert.equal(options.headers["Idempotency-Key"], "summit-ticket/" + ticket.order_id);
      assert.deepEqual(payload, expected);
      return Response.json({ id: "provider-12345" });
    }
    assert.match(url, /summit_finish_ticket_email$/);
    finished = payload;
    return Response.json(true);
  });
  const result = await handler(invoke(env.TICKET_EMAIL_WORKER_SECRET));
  assert.equal((await result.json()).sent, 1);
  assert.equal(prepared.p_lease, finished.p_lease);
  assert.equal(finished.p_outcome, "sent");
  assert.equal(finished.p_provider_id, "provider-12345");
});

test("a refund that wins before dispatch prevents a provider call", async () => {
  const worker = ticketEmailHandler(env, async (url, options) => {
    if (url.endsWith("/summit_claim_ticket_emails")) return Response.json([ticket]);
    if (url.endsWith("/summit_prepare_ticket_email")) return Response.json(null);
    assert.match(url, /summit_finish_ticket_email$/);
    assert.equal(JSON.parse(options.body).p_outcome, "cancelled");
    return Response.json(true);
  });
  assert.equal((await (await worker(invoke(env.TICKET_EMAIL_WORKER_SECRET))).json()).cancelled, 1);
});

test("Resend rate limits are retried, while invalid messages are marked for attention", async () => {
  const message = ticketEmailMessage(ticket, env);
  const send = (status, headers = {}) => sendTicketEmail(message, ticket.order_id, env.RESEND_API_KEY,
    () => Promise.resolve(Response.json({ name: "fixture" }, { status, headers })));
  assert.deepEqual(await send(429, { "Retry-After": "45" }), {
    outcome: "retry", errorCode: "resend_429", retrySeconds: 45,
  });
  assert.equal((await send(400)).outcome, "failed");
  assert.equal((await send(503)).outcome, "retry");
});

test("Live Mode checkout remains closed while the ticket email configuration is missing", async () => {
  const paymentEnv = {
    ...env,
    RESEND_API_KEY: "",
    RAZORPAY_KEY_ID: "rzp_live_fixture",
    RAZORPAY_KEY_SECRET: "fixture",
    CHECKOUT_ORIGINS: "https://summit.example.test",
  };
  const checkout = checkoutHandler(paymentEnv, () => assert.fail("Live checkout used external services before setup"));
  const call = (action) => checkout(new Request("https://database.example.test/functions/v1/checkout", {
    method: "POST",
    headers: { Origin: paymentEnv.CHECKOUT_ORIGINS, "content-type": "application/json" },
    body: JSON.stringify({ action }),
  }));
  assert.deepEqual(await (await call("catalog")).json(), { mode: "live", tiers: [] });
  assert.equal((await call("create")).status, 503);
});

test("ticket with a code embeds the entry QR inline and shows the ticket number", () => {
  const code = "3f9a21c0b7d64e1f8a2b5c6d7e8f9012";
  let encoded;
  const qrImage = (text) => { encoded = text; return "R0lGODlhAQABAAAAACw="; };
  const message = ticketEmailMessage({ ...ticket, ticket_code: code, tier: "vip", phone: "+919876543210", mode: "live" },
    { ...env, TICKET_ART_BASE_URL: "https://summit.example.test/assets/tickets/" }, { qrImage });
  assert.equal(encoded, "BTL1:" + code);
  assert.deepEqual(message.attachments, [{
    filename: "ticket-qr.gif", content: "R0lGODlhAQABAAAAACw=", content_type: "image/gif", content_id: "ticket-qr",
  }]);
  assert.match(message.html, /src="cid:ticket-qr"/);
  assert.match(message.html, /3F9A-21C0/);
  assert.match(message.html, /src="https:\/\/summit\.example\.test\/assets\/tickets\/vip\.png"/);
  assert.match(message.subject, /\(3F9A-21C0\)/);
  assert.match(message.text, /Ticket no\.: 3F9A-21C0/);
  assert.doesNotMatch(message.html, /TEST TICKET/);
});

test("test-mode tickets are clearly marked and a bad QR result is dropped", () => {
  const message = ticketEmailMessage({ ...ticket, ticket_code: "0".repeat(32), mode: "test" }, env,
    { qrImage: () => "not base64!" });
  assert.match(message.subject, /^\[TEST\] /);
  assert.match(message.html, /TEST TICKET · NOT VALID FOR ENTRY/);
  assert.equal(message.attachments, undefined);
  assert.doesNotMatch(message.html, /cid:ticket-qr/);
});
