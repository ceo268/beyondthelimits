import { databaseRpc } from "./database.mjs";
import { ticketEmailConfigured } from "./resend.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const paymentId = /^pay_[A-Za-z0-9]{1,64}$/;
const orderId = /^order_[A-Za-z0-9]{1,64}$/;
const refundId = /^rfnd_[A-Za-z0-9]{1,64}$/;

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

async function readBytes(request, maxBytes) {
  const length = request.headers.get("content-length");
  if (length && Number(length) > maxBytes) throw new RequestError(413, "payload_size", "Request is too large.");
  if (!request.body) throw new RequestError(400, "invalid_body", "Missing request body.");

  const reader = request.body.getReader();
  const buffer = new Uint8Array(maxBytes);
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) return buffer.subarray(0, size);
    if (size + value.byteLength > maxBytes) {
      await reader.cancel();
      throw new RequestError(413, "payload_size", "Request is too large.");
    }
    buffer.set(value, size);
    size += value.byteLength;
  }
}

function parseJson(raw) {
  try {
    const data = JSON.parse(decoder.decode(raw));
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {
    // Return the same public error for invalid UTF-8 and malformed JSON.
  }
  throw new RequestError(400, "invalid_body", "Expected a JSON object.");
}

async function hmacKey(secret, usage) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checkHmac(secret, data, signature) {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const bytes = Uint8Array.from(signature.match(/../g), (pair) => Number.parseInt(pair, 16));
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), bytes, data);
}

async function checkoutHash(token) {
  if (typeof token !== "string" || !uuid.test(token)) {
    throw new RequestError(400, "invalid_checkout", "Open checkout again to continue.");
  }
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(token.toLowerCase())));
}

async function originHash(request, secret) {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "unavailable";
  return hex(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(ip.slice(0, 80))));
}

function paymentMode(keyId = "") {
  if (/^rzp_test_\w+$/.test(keyId)) return "test";
  if (/^rzp_live_\w+$/.test(keyId)) return "live";
  throw new Error("Invalid Razorpay key mode.");
}

function clients(env, fetcher) {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) throw new Error("Missing payment configuration.");
  const rpc = databaseRpc(env, fetcher);
  const mode = paymentMode(env.RAZORPAY_KEY_ID);
  const razorHeaders = {
    Authorization: "Basic " + btoa(env.RAZORPAY_KEY_ID + ":" + env.RAZORPAY_KEY_SECRET),
    "Content-Type": "application/json",
  };

  async function razor(path, body) {
    const response = await fetcher(`https://api.razorpay.com/v1${path}`, {
      method: body ? "POST" : "GET", headers: razorHeaders,
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(6500),
    });
    if (!response.ok) throw new Error(`Razorpay API returned ${response.status}.`);
    return response.json();
  }
  return { rpc, razor, mode };
}

// Indian mobiles may be typed without +91 ("98765 43210", "098765 43210", "91 98765 43210").
export function normalizedPhone(raw) {
  const phone = raw.replace(/[ ()-]/g, "");
  if (/^0?[6-9]\d{9}$/.test(phone)) return "+91" + phone.slice(-10);
  if (/^91[6-9]\d{9}$/.test(phone)) return "+" + phone;
  return phone;
}

function validatedCustomer(input) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const rawPhone = typeof input.phone === "string" ? input.phone.trim() : "";
  const phone = normalizedPhone(rawPhone);
  if (name.length < 2 || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)
      || email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
      || rawPhone.length > 32 || !/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new RequestError(400, "invalid_customer", "Enter your full name, a valid email address, and a valid mobile number.");
  }
  return { name, email, phone };
}

function checkoutSummary(order) {
  return {
    reference: order.id,
    amount: order.amount_paise,
    currency: order.currency,
    status: order.status,
  };
}

const reserveErrors = {
  closed: [409, "This pass is currently unavailable."],
  price_changed: [409, "The total changed. Reload the page to see the current price."],
  busy: [409, "Checkout is still starting. Wait a few seconds and try again."],
  conflict: [409, "Close checkout and reopen it to update your details."],
  limited: [429, "Too many checkout attempts. Please try again in a few minutes."],
};

async function createOrder(body, request, env, { rpc, razor, mode }) {
  const hash = await checkoutHash(body.token);
  const { name, email, phone } = validatedCustomer(body);
  if (!["standard", "premium", "vip"].includes(body.tier) || !Number.isInteger(body.amount)
      || body.amount < 100 || body.amount > 2_147_483_647) {
    throw new RequestError(400, "invalid_pass", "Choose a valid pass.");
  }
  if (!env.CHECKOUT_RATE_LIMIT_SECRET) throw new Error("Missing rate limit secret.");

  const worker = crypto.randomUUID();
  const reservation = await rpc("summit_reserve", {
    p_hash: hash, p_tier: body.tier, p_name: name, p_email: email, p_phone: phone,
    p_amount: body.amount, p_mode: mode, p_worker: worker,
    p_origin_hash: await originHash(request, env.CHECKOUT_RATE_LIMIT_SECRET),
  });
  if (Object.hasOwn(reserveErrors, reservation.result)) {
    const [status, text] = reserveErrors[reservation.result];
    throw new RequestError(status, reservation.result, text);
  }
  const order = reservation.order;
  if (!order) throw new Error("Missing reserved order.");
  let providerOrderId = order.razorpay_order_id;
  if (reservation.result === "reserved") {
    const receipt = order.id;
    let providerOrder;
    if (reservation.recovered) {
      const listed = await razor(`/orders?receipt=${encodeURIComponent(receipt)}&count=10`);
      const matches = listed.items.filter((item) => item.receipt === receipt);
      if (matches.length > 1) throw new Error("Duplicate provider receipt. Resolve in Razorpay.");
      [providerOrder] = matches;
    }
    if (!providerOrder) {
      providerOrder = await razor("/orders", {
        amount: order.amount_paise, currency: order.currency, receipt, partial_payment: false,
      });
    }
    if (!orderId.test(providerOrder.id) || providerOrder.amount !== order.amount_paise
        || providerOrder.currency !== order.currency || providerOrder.receipt !== receipt) {
      throw new Error("Provider order does not match reservation.");
    }
    providerOrderId = providerOrder.id;
    const attached = await rpc("summit_attach", {
      p_id: order.id, p_worker: worker, p_razorpay_order_id: providerOrderId,
    });
    if (!attached) throw new RequestError(409, "busy", reserveErrors.busy[1]);
  }
  if (!orderId.test(providerOrderId)) throw new Error("Missing provider order.");
  return { ...checkoutSummary(order), razorpayOrderId: providerOrderId, keyId: env.RAZORPAY_KEY_ID, mode };
}

async function getOrder(body, { rpc, mode }) {
  const order = await rpc("summit_lookup", { p_hash: await checkoutHash(body.token), p_mode: mode });
  if (!order) throw new RequestError(404, "order_missing", "This checkout could not be found.");
  return order;
}

function captured(payment) {
  return payment.captured === true || payment.status === "captured" || payment.status === "refunded";
}

function paymentRecord(payment, mode, state) {
  if (!paymentId.test(payment?.id) || !orderId.test(payment?.order_id)
      || !Number.isInteger(payment.amount) || payment.amount < 1 || typeof payment.currency !== "string") {
    throw new RequestError(400, "invalid_payment", "Payment details are invalid.");
  }
  return {
    p_mode: mode, p_order_id: payment.order_id, p_payment_id: payment.id,
    p_amount: payment.amount, p_currency: payment.currency, p_state: state,
  };
}

async function verifyOrder(body, env, backend) {
  const order = await getOrder(body, backend);
  const id = body.razorpay_payment_id;
  if (!order.razorpay_order_id || body.razorpay_order_id !== order.razorpay_order_id
      || typeof id !== "string" || !paymentId.test(id)
      || !await checkHmac(env.RAZORPAY_KEY_SECRET, encoder.encode(`${order.razorpay_order_id}|${id}`), body.razorpay_signature)) {
    throw new RequestError(400, "invalid_signature", "The payment confirmation could not be verified.");
  }

  const payment = await backend.razor(`/payments/${id}`);
  if (payment.id !== id || payment.order_id !== order.razorpay_order_id
      || payment.amount !== order.amount_paise || payment.currency !== order.currency) {
    throw new Error("Payment does not match trusted order.");
  }
  const state = captured(payment) ? "captured" : payment.status === "failed" ? "failed" : "pending";
  const status = await backend.rpc("summit_record_payment", paymentRecord(payment, backend.mode, state));
  return { ...checkoutSummary(order), status };
}

function handleError(error, headers, context) {
  if (error instanceof RequestError) return json({ code: error.code, message: error.message }, error.status, headers);
  const message = error instanceof Error ? error.message : "Unexpected error.";
  console.error(context, message);
  return json({ code: "unavailable", message: "This service is temporarily unavailable. Please try again." }, 503, headers);
}

export function checkoutHandler(env, fetcher = fetch) {
  const origins = new Set((env.CHECKOUT_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean));
  return async (request) => {
    const origin = request.headers.get("origin");
    if (!origins.has(origin)) return json({ code: "origin_denied", message: "Checkout is unavailable from this site." }, 403);
    const headers = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, apikey",
      Vary: "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return json({ code: "method", message: "Use POST." }, 405, headers);

    try {
      const body = parseJson(await readBytes(request, 8192));
      const backend = clients(env, fetcher);
      switch (body.action) {
        case "catalog":
          return json({
            mode: backend.mode,
            tiers: backend.mode === "live" && !ticketEmailConfigured(env) ? [] : await backend.rpc("summit_catalog"),
          }, 200, headers);
        case "create":
          if (backend.mode === "live" && !ticketEmailConfigured(env)) {
            throw new RequestError(503, "sales_closed", "Live ticket sales are unavailable.");
          }
          return json(await createOrder(body, request, env, backend), 200, headers);
        case "verify":
          return json(await verifyOrder(body, env, backend), 200, headers);
        case "status":
          return json(checkoutSummary(await getOrder(body, backend)), 200, headers);
        default:
          return json({ code: "action", message: "Unknown checkout action." }, 400, headers);
      }
    } catch (error) {
      return handleError(error, headers, "Summit checkout:");
    }
  };
}

export function webhookHandler(env, fetcher = fetch) {
  return async (request) => {
    if (request.method !== "POST") return json({ ok: false }, 405);
    try {
      if (!env.RAZORPAY_WEBHOOK_SECRET) throw new Error("Missing webhook signing secret.");
      const bytes = await readBytes(request, 131072);
      if (!await checkHmac(env.RAZORPAY_WEBHOOK_SECRET, bytes, request.headers.get("x-razorpay-signature"))) {
        return json({ ok: false }, 401);
      }
      const event = parseJson(bytes);
      if (!["payment.captured", "payment.failed", "refund.processed"].includes(event.event)) {
        return json({ ok: true });
      }
      const eventId = request.headers.get("x-razorpay-event-id");
      if (!eventId || !/^[A-Za-z0-9_-]{1,150}$/.test(eventId)) {
        throw new RequestError(400, "invalid_event", "Missing or invalid event ID.");
      }
      const backend = clients(env, fetcher);
      const payload = event.payload;
      let payment = payload?.payment?.entity;
      let processedRefund;
      if (event.event === "refund.processed") {
        processedRefund = payload?.refund?.entity;
        if (!refundId.test(processedRefund?.id) || !paymentId.test(processedRefund?.payment_id)
            || processedRefund.status !== "processed" || !Number.isInteger(processedRefund.amount) || processedRefund.amount < 1) {
          throw new RequestError(400, "invalid_refund", "Refund details are invalid.");
        }
        if (!payment) payment = await backend.razor(`/payments/${processedRefund.payment_id}`);
        if (payment.id !== processedRefund.payment_id || payment.currency !== processedRefund.currency) {
          throw new RequestError(400, "invalid_refund", "Refund payment does not match.");
        }
        // Razorpay can auto-refund an authorization that was never captured.
        if (!captured(payment)) return json({ ok: true });
      }
      // The same merchant account can receive unrelated payment events without an order.
      if (!payment?.order_id) return json({ ok: true });
      const state = event.event === "payment.failed" ? "failed" : "captured";
      const args = { ...paymentRecord(payment, backend.mode, state), p_event_id: eventId };
      if (processedRefund) {
        args.p_refund_id = processedRefund.id;
        args.p_refund_amount = processedRefund.amount;
      }
      await backend.rpc("summit_record_payment", args);
      return json({ ok: true });
    } catch (error) {
      return handleError(error, {}, "Razorpay webhook:");
    }
  };
}
