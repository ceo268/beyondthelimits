"use strict";

window.SummitApi = (() => {
  const { supabaseUrl, supabasePublishableKey } = window.SUMMIT_CONFIG;
  const base = supabaseUrl.trim().replace(/\/$/, "");
  const configured = Boolean(base && supabasePublishableKey.trim());
  const currency = new Intl.NumberFormat("en-IN", {
    style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2,
  });

  async function request(path, { body, token, timeout = 24000 } = {}) {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        apikey: supabasePublishableKey,
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(timeout),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.message || data?.msg || "The request could not be completed.");
      error.status = response.status;
      error.code = data?.code || data?.error_code;
      throw error;
    }
    return data;
  }

  return {
    configured,
    request,
    money: (paise) => currency.format(paise / 100),
    checkout: (action, data = {}) => request("/functions/v1/checkout", { body: { action, ...data } }),
    admin: (functionName, body, token) => request("/rest/v1/rpc/" + functionName, { body, token }),
  };
})();
