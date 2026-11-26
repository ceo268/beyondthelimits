// Admin "Analytics" panel backend: reads Google Analytics 4 through the GA4 Data API with a
// read-only service account, for signed-in organizers only. Results are cached for 5 minutes per range.
//
// Secrets: GA_PROPERTY_ID (e.g. 469316749) and GA_SERVICE_ACCOUNT_JSON (the downloaded key file).

const encoder = new TextEncoder();
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta/properties/";
const RANGES = { today: "today", "7d": "6daysAgo", "30d": "29daysAgo", "90d": "89daysAgo" };
const FUNNEL = ["page_view", "begin_checkout", "add_payment_info", "purchase"];
const CACHE_MS = 5 * 60 * 1000;

function base64url(input) {
  const bytes = typeof input === "string" ? encoder.encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem) {
  const body = String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
}

export function serviceAccount(env) {
  try {
    const parsed = JSON.parse(env.GA_SERVICE_ACCOUNT_JSON || "");
    if (typeof parsed.client_email === "string" && typeof parsed.private_key === "string") return parsed;
  } catch {
    // Treated as not configured.
  }
  return null;
}

export async function signedAssertion(account, nowSeconds) {
  const header = { alg: "RS256", typ: "JWT", ...(account.private_key_id ? { kid: account.private_key_id } : {}) };
  const claims = { iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 };
  const unsigned = base64url(JSON.stringify(header)) + "." + base64url(JSON.stringify(claims));
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
  return unsigned + "." + base64url(signature);
}

function publishableKey(env) {
  try {
    const keys = JSON.parse(env.SUPABASE_PUBLISHABLE_KEYS || "{}");
    if (keys.default) return keys.default;
  } catch {
    // Fall back to the legacy anon key.
  }
  return env.SUPABASE_ANON_KEY;
}

async function isOrganizer(env, userJwt, fetcher) {
  if (!userJwt || userJwt.length > 4096) return false;
  const response = await fetcher(env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/rpc/summit_admin_access", {
    method: "POST",
    headers: { apikey: publishableKey(env), Authorization: "Bearer " + userJwt, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(6000),
  });
  return response.ok && (await response.json().catch(() => false)) === true;
}

const rowsOf = (report) => (report?.rows || []).map((row) => ({
  dims: (row.dimensionValues || []).map((value) => value.value),
  mets: (row.metricValues || []).map((value) => Number(value.value) || 0),
}));
const pairs = (report, limit = 10) => rowsOf(report)
  .filter(({ dims }) => dims[0] && dims[0] !== "(not set)")
  .slice(0, limit)
  .map(({ dims, mets }) => ({ label: dims[0], value: mets[0] }));

export function shapeReport(range, results, live) {
  const [overview, daily, events, clicksBuiltIn, clicksCustom, sections, tabs, sources, devices, cities] = results;
  const total = rowsOf(overview)[0]?.mets || [];
  const eventRows = rowsOf(events);
  const eventCounts = Object.fromEntries(eventRows.map(({ dims, mets }) => [dims[0], { count: mets[0], users: mets[1] }]));
  const clicks = pairs(clicksCustom).length ? pairs(clicksCustom) : pairs(clicksBuiltIn);
  const missing = [];
  if (sections === null) missing.push("section_id");
  if (tabs === null) missing.push("content_id");
  return {
    range,
    generatedAt: new Date().toISOString(),
    live,
    totals: {
      users: total[0] || 0, newUsers: total[1] || 0, sessions: total[2] || 0, pageViews: total[3] || 0,
      engagementRate: total[4] || 0, avgSessionSeconds: total[5] || 0, purchases: total[6] || 0, revenue: total[7] || 0,
    },
    daily: rowsOf(daily).map(({ dims, mets }) => ({ date: dims[0], users: mets[0], views: mets[1] })),
    funnel: FUNNEL.map((name) => ({ event: name, users: eventCounts[name]?.users || 0, count: eventCounts[name]?.count || 0 })),
    events: eventRows.slice(0, 20).map(({ dims, mets }) => ({ label: dims[0], value: mets[0] })),
    clicks,
    sections: sections === null ? null : pairs(sections),
    tabs: tabs === null ? null : pairs(tabs),
    sources: pairs(sources, 8),
    devices: pairs(devices, 5),
    cities: pairs(cities, 8),
    missing,
  };
}

export function analyticsHandler(env, fetcher = fetch) {
  const origins = new Set((env.CHECKOUT_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean));
  let token = null;
  const cache = new Map();

  async function googleToken() {
    if (token && token.expires > Date.now() + 60000) return token.value;
    const account = serviceAccount(env);
    const assertion = await signedAssertion(account, Math.floor(Date.now() / 1000));
    const response = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw Object.assign(new Error("google_auth"), { code: "google_auth" });
    token = { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
    return token.value;
  }

  async function ga(method, body, accessToken) {
    const response = await fetcher(DATA_API + env.GA_PROPERTY_ID + ":" + method, {
      method: "POST",
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = response.status === 403 ? "ga_permission" : "ga_error";
      throw Object.assign(new Error(data?.error?.message || code), { code, status: response.status });
    }
    return data;
  }

  async function build(range) {
    const accessToken = await googleToken();
    const dateRanges = [{ startDate: RANGES[range], endDate: "today" }];
    const report = (body) => ga("runReport", { dateRanges, ...body }, accessToken);
    const byEvent = (names) => ({ filter: { fieldName: "eventName", inListFilter: { values: names } } });
    const top = (dimension, metric, extra = {}, limit = 10) => report({
      dimensions: [{ name: dimension }], metrics: [{ name: metric }],
      orderBys: [{ metric: { metricName: metric }, desc: true }], limit, ...extra,
    });
    const requests = [
      report({ metrics: ["activeUsers", "newUsers", "sessions", "screenPageViews", "engagementRate",
        "averageSessionDuration", "ecommercePurchases", "purchaseRevenue"].map((name) => ({ name })) }),
      report({ dimensions: [{ name: "date" }], metrics: [{ name: "activeUsers" }, { name: "screenPageViews" }],
        orderBys: [{ dimension: { dimensionName: "date" } }] }),
      report({ dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }],
        orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 50 }),
      top("linkText", "eventCount", { dimensionFilter: byEvent(["navigation_click", "click"]) }),
      // Optional: available once the matching custom dimensions are registered in GA4.
      top("customEvent:link_text", "eventCount", { dimensionFilter: byEvent(["navigation_click"]) }),
      top("customEvent:section_id", "eventCount", { dimensionFilter: byEvent(["section_view"]) }),
      top("customEvent:content_id", "eventCount", { dimensionFilter: byEvent(["select_content"]) }),
      top("sessionSourceMedium", "sessions", {}, 8),
      top("deviceCategory", "activeUsers", {}, 5),
      top("city", "activeUsers", {}, 8),
    ];
    const optional = new Set([4, 5, 6]);
    const settled = await Promise.allSettled([...requests, ga("runRealtimeReport", { metrics: [{ name: "activeUsers" }] }, accessToken)]);
    const failure = settled.find((result, i) => result.status === "rejected" && !optional.has(i));
    if (failure) throw failure.reason;
    const results = settled.slice(0, requests.length).map((result) => (result.status === "fulfilled" ? result.value : null));
    const live = settled.at(-1).status === "fulfilled" ? Number(rowsOf(settled.at(-1).value)[0]?.mets[0] || 0) : null;
    return shapeReport(range, results, live);
  }

  return async (request) => {
    const origin = request.headers.get("origin");
    const headers = {
      "Cache-Control": "no-store",
      ...(origins.has(origin) ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, apikey, content-type",
        Vary: "Origin",
      } : {}),
    };
    const reply = (data, status = 200) => Response.json(data, { status, headers });
    if (!origins.has(origin)) return reply({ code: "origin_denied" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return reply({ code: "method" }, 405);

    try {
      const userJwt = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!await isOrganizer(env, userJwt, fetcher)) return reply({ code: "forbidden" }, 403);
      if (!serviceAccount(env) || !/^\d{5,15}$/.test(env.GA_PROPERTY_ID || "")) {
        return reply({ code: "not_configured", message: "Google Analytics access is not set up yet." }, 503);
      }
      const body = await request.json().catch(() => ({}));
      const range = Object.hasOwn(RANGES, body?.range) ? body.range : "7d";
      const cached = cache.get(range);
      if (cached && cached.at > Date.now() - CACHE_MS && !body?.refresh) return reply(cached.data);
      const data = await build(range);
      cache.set(range, { at: Date.now(), data });
      return reply(data);
    } catch (error) {
      const code = error?.code || "unavailable";
      console.error("Admin analytics:", code, error instanceof Error ? error.message.slice(0, 200) : "");
      return reply({ code, message: code === "ga_permission"
        ? "The service account doesn't have access to this GA4 property yet."
        : code === "google_auth" ? "Google rejected the service account key." : "Analytics are temporarily unavailable." }, 502);
    }
  };
}
