import assert from "node:assert/strict";
import test from "node:test";
import { analyticsHandler, signedAssertion } from "../supabase/functions/_shared/analytics.mjs";

const origin = "https://www.beyondthelimits.example";
const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"],
);
const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64");
const account = {
  client_email: "reports@summit-fixture.iam.gserviceaccount.com",
  private_key: `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`,
  private_key_id: "fixture-key",
};
const env = {
  SUPABASE_URL: "https://db.example.test",
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "sb_publishable_fixture" }),
  CHECKOUT_ORIGINS: origin,
  GA_PROPERTY_ID: "469316749",
  GA_SERVICE_ACCOUNT_JSON: JSON.stringify(account),
};
const call = (handler, { token = "organizer-jwt", range = "7d" } = {}) => handler(new Request("https://db.example.test/functions/v1/admin-analytics", {
  method: "POST",
  headers: { Origin: origin, Authorization: "Bearer " + token, "content-type": "application/json" },
  body: JSON.stringify({ range }),
}));
const rows = (...list) => ({ rows: list.map(([dims, mets]) => ({
  dimensionValues: dims.map((value) => ({ value })), metricValues: mets.map((value) => ({ value: String(value) })),
})) });

test("the Google assertion is a valid RS256 JWT for read-only analytics", async () => {
  const jwt = await signedAssertion(account, 1_800_000_000);
  const [header, claims, signature] = jwt.split(".");
  const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString());
  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT", kid: "fixture-key" });
  assert.equal(decode(claims).scope, "https://www.googleapis.com/auth/analytics.readonly");
  assert.equal(decode(claims).exp - decode(claims).iat, 3600);
  assert(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keyPair.publicKey,
    Buffer.from(signature, "base64url"), new TextEncoder().encode(header + "." + claims)));
});

test("only organizers get analytics, and missing setup is reported clearly", async () => {
  const denied = analyticsHandler(env, async (url) => {
    assert.match(url, /summit_admin_access$/);
    return Response.json(false);
  });
  assert.equal((await call(denied, { token: "visitor-jwt" })).status, 403);
  const unconfigured = analyticsHandler({ ...env, GA_SERVICE_ACCOUNT_JSON: "" }, async () => Response.json(true));
  const response = await call(unconfigured);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "not_configured");
  const wrongSite = await analyticsHandler(env, () => assert.fail("no calls"))(new Request("https://x.test", {
    method: "POST", headers: { Origin: "https://evil.example" }, body: "{}",
  }));
  assert.equal(wrongSite.status, 403);
});

test("reports are fetched once, shaped for the panel, and cached", async () => {
  let reports = 0;
  let tokens = 0;
  const handler = analyticsHandler(env, async (url, options) => {
    if (url.endsWith("/summit_admin_access")) {
      assert.equal(options.headers.Authorization, "Bearer organizer-jwt");
      return Response.json(true);
    }
    if (url === "https://oauth2.googleapis.com/token") {
      tokens += 1;
      return Response.json({ access_token: "ga-token", expires_in: 3600 });
    }
    assert.equal(options.headers.Authorization, "Bearer ga-token");
    assert.match(url, /properties\/469316749:(runReport|runRealtimeReport)$/);
    reports += 1;
    const body = JSON.parse(options.body);
    if (url.endsWith(":runRealtimeReport")) return Response.json(rows([[], [4]]));
    const dimension = body.dimensions?.[0]?.name;
    if (!dimension) return Response.json(rows([[], [120, 90, 150, 400, 0.62, 95, 3, 8997]]));
    if (dimension === "customEvent:section_id") return Response.json({ error: { message: "not registered" } }, { status: 400 });
    const fixtures = {
      date: rows([["20261125"], [50, 160]], [["20261126"], [70, 240]]),
      eventName: rows([["page_view"], [400, 120]], [["begin_checkout"], [20, 15]], [["add_payment_info"], [9, 8]], [["purchase"], [3, 3]]),
      linkText: rows([["Passes"], [30]]),
      "customEvent:link_text": rows([["View Passes"], [41]], [["Speakers"], [12]]),
      "customEvent:content_id": rows([["Networking"], [9]]),
      sessionSourceMedium: rows([["instagram / referral"], [60]], [["(direct) / (none)"], [50]]),
      deviceCategory: rows([["mobile"], [100]], [["desktop"], [20]]),
      city: rows([["Chennai"], [80]], [["(not set)"], [5]]),
    };
    return Response.json(fixtures[dimension]);
  });

  const data = await (await call(handler)).json();
  assert.equal(data.live, 4);
  assert.deepEqual(data.totals, { users: 120, newUsers: 90, sessions: 150, pageViews: 400, engagementRate: 0.62,
    avgSessionSeconds: 95, purchases: 3, revenue: 8997 });
  assert.deepEqual(data.funnel.map(({ users }) => users), [120, 15, 8, 3]);
  assert.deepEqual(data.clicks[0], { label: "View Passes", value: 41 }, "custom link_text wins when registered");
  assert.equal(data.sections, null, "unregistered dimension is reported as missing, not an error");
  assert.deepEqual(data.missing, ["section_id"]);
  assert.deepEqual(data.cities, [{ label: "Chennai", value: 80 }]);
  assert.equal(data.daily.length, 2);
  const before = reports;
  await call(handler);
  assert.equal(reports, before, "second request within 5 minutes is served from cache");
  assert.equal(tokens, 1);
});
