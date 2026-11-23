import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { checkoutHandler, webhookHandler } from "../supabase/functions/_shared/core.mjs";

const env = {
  SUPABASE_URL: "https://database.example.test",
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_fixture" }),
  RAZORPAY_KEY_ID: "rzp_test_fixture",
  RAZORPAY_KEY_SECRET: "fixture-api-secret",
  RAZORPAY_WEBHOOK_SECRET: "fixture-webhook-secret",
  CHECKOUT_RATE_LIMIT_SECRET: "fixture-rate-limit-secret",
  CHECKOUT_ORIGINS: "https://summit.example.test",
};
const fixture = {
  id: "8fdb7bfc-666e-4ff4-be2a-03663ae5b9b8", razorpay_order_id: "order_Fixture",
  status: "pending", currency: "INR", amount_paise: 350000,
};
const card = {
  id: "pay_Fixture", order_id: fixture.razorpay_order_id,
  currency: "INR", amount: fixture.amount_paise, captured: true, status: "captured",
};
const customer = {
  token: "8f58b3dc-d57c-48ab-8d4e-db91ad397711", tier: "standard", amount: 350000,
  name: "Test Buyer", email: " BUYER@example.test ", phone: "+91 90000 01234",
};
const hmac = (secret, value) => createHmac("sha256", secret).update(value).digest("hex");
const callback = {
  token: customer.token,
  razorpay_order_id: fixture.razorpay_order_id,
  razorpay_payment_id: card.id,
  razorpay_signature: hmac(env.RAZORPAY_KEY_SECRET, `${fixture.razorpay_order_id}|${card.id}`),
};

function browser(action, data = {}, origin = env.CHECKOUT_ORIGINS) {
  return new Request("https://database.example.test/functions/v1/checkout", {
    method: "POST",
    headers: { Origin: origin, "content-type": "application/json" },
    body: JSON.stringify({ action, ...data }),
  });
}

function webhook(event, eventId, signatureOverride) {
  const body = JSON.stringify(event, null, 2);
  return new Request("https://database.example.test/functions/v1/razorpay-webhook", {
    method: "POST",
    headers: {
      "x-razorpay-event-id": eventId,
      "x-razorpay-signature": signatureOverride ?? hmac(env.RAZORPAY_WEBHOOK_SECRET, body),
    },
    body,
  });
}

function mock(overrides = {}) {
  const callLog = [];
  async function fetcher(address, options) {
    const url = new URL(address);
    const data = options.body ? JSON.parse(options.body) : null;
    callLog.push([url.hostname, url.pathname + url.search, data]);
    if (url.hostname === "database.example.test") {
      assert.equal(options.headers.apikey, "sb_secret_fixture");
      assert.equal(options.headers.Authorization, undefined);
      const name = url.pathname.split("/").at(-1);
      if (name === "summit_catalog") return Response.json([{ tier: "standard", amount_paise: 350000 }]);
      if (name === "summit_lookup") return Response.json(fixture);
      if (name === "summit_reserve") return Response.json(overrides.reserve ?? {
        result: "reserved", recovered: false, order: { ...fixture, razorpay_order_id: null },
      });
      if (name === "summit_attach") return Response.json(true);
      if (name === "summit_coupon_quote") return Response.json(overrides.quote ?? {
        result: "ok", code: "BEYOND20", discount_type: "percent", discount_value: 20,
        price_paise: 350000, discount_paise: 70000, amount_paise: 280000,
      });
      if (name === "summit_record_payment") return Response.json(overrides.status ?? "paid");
    }
    assert.equal(url.hostname, "api.razorpay.com");
    assert.match(options.headers.Authorization, /^Basic /);
    const order = { id: fixture.razorpay_order_id, amount: fixture.amount_paise, currency: "INR", receipt: fixture.id };
    if (url.pathname === "/v1/orders" && options.method === "POST") return Response.json(order);
    if (url.pathname === "/v1/orders") return Response.json({ items: [order] });
    if (url.pathname === "/v1/payments/pay_Fixture") return Response.json(overrides.payment ?? card);
    throw new Error("Unrecognized fixture request.");
  }
  return { callLog, fetcher };
}

test("checkout CORS and catalog keep requests scoped", async () => {
  const { fetcher, callLog } = mock();
  const handle = checkoutHandler(env, fetcher);
  const denied = await handle(browser("catalog", {}, "https://elsewhere.example.test"));
  assert.equal(denied.status, 403);
  assert.equal(callLog.length, 0);
  const allowed = await handle(browser("catalog"));
  assert.equal(allowed.headers.get("access-control-allow-origin"), env.CHECKOUT_ORIGINS);
  assert.equal((await allowed.json()).mode, "test");
});

test("create passes only the database price and normalized details to the respective systems", async () => {
  const { fetcher, callLog } = mock();
  const result = await checkoutHandler(env, fetcher)(browser("create", customer));
  assert.equal(result.status, 200);
  assert.equal((await result.json()).razorpayOrderId, fixture.razorpay_order_id);
  const [reserve, provider] = callLog;
  assert.equal(reserve[2].p_email, "buyer@example.test");
  assert.equal(reserve[2].p_phone, "+919000001234");
  assert.notEqual(reserve[2].p_hash, customer.token);
  assert.deepEqual(provider[2], { amount: 350000, currency: "INR", receipt: fixture.id, partial_payment: false });
});

test("coupon quotes come from the database and send only the normalized code", async () => {
  const { fetcher, callLog } = mock();
  const handle = checkoutHandler(env, fetcher);
  const result = await handle(browser("quote", { tier: "standard", coupon: " beyond20 ", discount: 999999 }));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    code: "BEYOND20", tier: "standard", price: 350000, discount: 70000, amount: 280000,
    discountType: "percent", discountValue: 20,
  });
  const [, path, args] = callLog[0];
  assert.match(path, /summit_coupon_quote$/);
  assert.equal(args.p_code, "BEYOND20");
  assert.equal(args.p_mode, "test");
  assert.equal(Object.hasOwn(args, "p_discount"), false);
  assert.match(args.p_origin_hash, /^[0-9a-f]{64}$/);
});

test("invalid, expired, disabled and exhausted coupons return clear errors", async () => {
  for (const [result, status] of [["coupon_not_found", 400], ["coupon_expired", 400],
    ["coupon_disabled", 400], ["coupon_used_up", 400], ["coupon_limited", 429]]) {
    const { fetcher } = mock({ quote: { result } });
    const response = await checkoutHandler(env, fetcher)(browser("quote", { tier: "standard", coupon: "SAVE10" }));
    assert.equal(response.status, status, result);
    const body = await response.json();
    assert.equal(body.code, result);
    assert.ok(body.message.length > 10);
  }
  const { fetcher, callLog } = mock();
  const malformed = await checkoutHandler(env, fetcher)(browser("quote", { tier: "standard", coupon: "x'; drop" }));
  assert.equal(malformed.status, 400);
  assert.equal(callLog.length, 0, "malformed codes never reach the database");
});

test("create forwards the coupon code so the database reprices the order", async () => {
  const { fetcher, callLog } = mock();
  const result = await checkoutHandler(env, fetcher)(browser("create", { ...customer, coupon: "beyond20" }));
  assert.equal(result.status, 200);
  assert.equal(callLog[0][2].p_coupon, "BEYOND20");
  const plain = mock();
  await checkoutHandler(env, plain.fetcher)(browser("create", customer));
  assert.equal(plain.callLog[0][2].p_coupon, null);
  const expired = mock({ reserve: { result: "coupon_expired" } });
  const refused = await checkoutHandler(env, expired.fetcher)(browser("create", { ...customer, coupon: "OLD10" }));
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).code, "coupon_expired");
  assert.equal(expired.callLog.length, 1, "a refused coupon never opens a Razorpay order");
});

test("an unapproved amount never opens a Razorpay order", async () => {
  const { fetcher, callLog } = mock({ reserve: { result: "price_changed" } });
  const result = await checkoutHandler(env, fetcher)(browser("create", { ...customer, amount: 100 }));
  assert.equal(result.status, 409);
  assert.equal((await result.json()).code, "price_changed");
  assert.equal(callLog.length, 1);
});

test("a lease retry reattaches a previously created Razorpay order", async () => {
  const { fetcher, callLog } = mock({ reserve: { result: "reserved", recovered: true, order: fixture } });
  const result = await checkoutHandler(env, fetcher)(browser("create", customer));
  assert.equal(result.status, 200);
  assert.match(callLog[1][1], /orders\?receipt=/);
  assert.equal(callLog[1][2], null);
  assert.match(callLog[2][1], /summit_attach/);
  assert.equal(callLog.length, 3);
});

test("checkout only verifies signatures derived from the trusted order ID", async () => {
  const { fetcher, callLog } = mock();
  const handle = checkoutHandler(env, fetcher);
  assert.equal((await handle(browser("verify", { ...callback, razorpay_order_id: "order_Tampered" }))).status, 400);
  assert.equal((await handle(browser("verify", { ...callback, razorpay_signature: "0".repeat(64) }))).status, 400);
  assert.equal(callLog.filter((call) => call[0] === "api.razorpay.com").length, 0);
  const result = await handle(browser("verify", callback));
  assert.equal((await result.json()).status, "paid");
  assert.equal(callLog.at(-1)[2].p_state, "captured");
});

test("an authorized payment remains pending", async () => {
  const { fetcher, callLog } = mock({ payment: { ...card, captured: false, status: "authorized" }, status: "pending" });
  const result = await checkoutHandler(env, fetcher)(browser("verify", callback));
  assert.equal((await result.json()).status, "pending");
  assert.equal(callLog.at(-1)[2].p_state, "pending");
});

test("webhook authenticates its raw bytes and passes a deduplication ID", async () => {
  const { fetcher, callLog } = mock();
  const handle = webhookHandler(env, fetcher);
  const event = { event: "payment.captured", payload: { payment: { entity: card } } };
  const wrong = await handle(webhook(event, "evt_fixture", hmac(env.RAZORPAY_WEBHOOK_SECRET, JSON.stringify(event))));
  assert.equal(wrong.status, 401);
  assert.equal(callLog.length, 0);
  const result = await handle(webhook(event, "evt_fixture"));
  assert.equal(result.status, 200);
  assert.equal(callLog[0][2].p_event_id, "evt_fixture");
  assert.equal(callLog[0][2].p_payment_id, card.id);
});

test("refund processing tracks a stable refund ID and ignores uncaptured auto-refunds", async () => {
  const { fetcher, callLog } = mock();
  const handle = webhookHandler(env, fetcher);
  const entity = { id: "rfnd_Fixture", payment_id: card.id, amount: 50000, currency: "INR", status: "processed" };
  const event = { event: "refund.processed", payload: { refund: { entity }, payment: { entity: card } } };
  assert.equal((await handle(webhook(event, "evt_refund"))).status, 200);
  assert.equal(callLog.at(-1)[2].p_refund_id, entity.id);
  assert.equal(callLog.at(-1)[2].p_refund_amount, 50000);
  event.payload.payment.entity = { ...card, captured: false, status: "authorized" };
  assert.equal((await handle(webhook(event, "evt_auto"))).status, 200);
  assert.equal(callLog.length, 1);
});

test("Indian mobile numbers are accepted without the +91 prefix", async () => {
  const { normalizedPhone } = await import("../supabase/functions/_shared/core.mjs");
  assert.equal(normalizedPhone("98765 43210"), "+919876543210");
  assert.equal(normalizedPhone("098765-43210"), "+919876543210");
  assert.equal(normalizedPhone("91 98765 43210"), "+919876543210");
  assert.equal(normalizedPhone("+91 98765 43210"), "+919876543210");
  assert.equal(normalizedPhone("+1 (415) 555-0100"), "+14155550100");
  assert.equal(normalizedPhone("12345"), "12345");
});
