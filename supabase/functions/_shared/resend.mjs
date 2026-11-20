const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const displaySender = /^[^<>\r\n]+ <([^<>]+)>$/;
const encoder = new TextEncoder();
const currency = new Intl.NumberFormat("en-IN", {
  style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2,
});

export function ticketEmailConfigured(env) {
  const from = env.RESEND_FROM_EMAIL || "";
  return Boolean(/^re_[A-Za-z0-9_-]+$/.test(env.RESEND_API_KEY || "")
    && emailPattern.test(from.match(displaySender)?.[1] || from)
    && /^[A-Za-z0-9_-]{32,}$/.test(env.TICKET_EMAIL_WORKER_SECRET || ""));
}

export async function authorizedWorker(received, expected) {
  if (!received || !expected || received.length > 256) return false;
  const [left, right] = await Promise.all(
    [received, expected].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))),
  );
  const receivedBytes = new Uint8Array(left);
  const expectedBytes = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < receivedBytes.length; i++) difference |= receivedBytes[i] ^ expectedBytes[i];
  return difference === 0;
}

function escape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function ticketEmailMessage(ticket, env) {
  if (!emailPattern.test(ticket.email)) return null;
  const eventDate = env.TICKET_EVENT_DATE?.trim() || "7 February 2027";
  const venue = env.TICKET_EVENT_VENUE?.trim() || "Sir Mutha Venkatasubba Rao Concert Hall";
  const amount = currency.format(ticket.amount_paise / 100);
  const brand = "Beyond the Limits Business Summit";
  const details = [
    ["Attendee", ticket.name],
    ["Event date", eventDate],
    ["Venue", venue],
    ["Amount paid", amount],
    ["Ticket reference", ticket.order_id],
  ];
  const rows = details.map(([label, value]) =>
    `<tr><th scope="row" style="text-align:left;padding:9px 12px 9px 0;color:#61533a;font-weight:normal">${escape(label)}</th><td style="padding:9px 0;overflow-wrap:anywhere">${escape(value)}</td></tr>`,
  ).join("");
  const replyTo = env.TICKET_REPLY_TO?.trim();
  return {
    from: env.RESEND_FROM_EMAIL,
    to: [ticket.email],
    ...(replyTo && emailPattern.test(replyTo) ? { reply_to: replyTo } : {}),
    subject: `Your ${ticket.pass_label} · Beyond the Limits`,
    text: [
      brand, `${ticket.pass_label} · Admit one`, "",
      `Hi ${ticket.name}, your booking is confirmed. Keep this email as your ticket.`, "",
      ...details.map(([label, value]) => `${label}: ${value}`), "",
      "Please bring this email or a printout to check-in.",
    ].join("\n"),
    html: `<!doctype html><html lang="en"><body style="margin:0;background:#efebe1;font-family:Arial,sans-serif;color:#1b1710">
      <table role="presentation" width="100%" style="background:#efebe1"><tr><td align="center" style="padding:24px 10px">
      <table role="presentation" width="100%" style="max-width:560px;background:#fff9e9;border:1px solid #dcc98c;border-radius:12px">
      <tr><td style="padding:24px;background:#17140d;color:#f3e08c;border-radius:11px 11px 0 0">
        <p style="margin:0;font-size:12px;letter-spacing:2px;text-transform:uppercase">${escape(brand)}</p>
        <h1 style="color:#fff9e9;margin:10px 0 4px;font-size:30px">${escape(ticket.pass_label)}</h1>
        <p style="margin:0;font-size:14px">Admit one</p>
      </td></tr><tr><td style="padding:24px">
        <p style="margin:0 0 14px;font-size:16px;line-height:1.5">Hi ${escape(ticket.name)}, your booking is confirmed. Keep this email as your ticket.</p>
        <table width="100%" style="border-top:1px dashed #9c7a2b;border-bottom:1px dashed #9c7a2b;font-size:14px">${rows}</table>
        <p style="margin:16px 0 0;font-size:14px">Please bring this email or a printout to check-in.</p>
      </td></tr></table>
      </td></tr></table></body></html>`,
  };
}

export async function sendTicketEmail(payload, orderId, apiKey, fetcher = fetch) {
  let response;
  try {
    response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        "Idempotency-Key": "summit-ticket/" + orderId,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { outcome: "retry", errorCode: "resend_network" };
  }
  const result = await response.json().catch(() => null);
  if (response.ok) {
    if (typeof result?.id === "string" && /^[A-Za-z0-9-]{5,96}$/.test(result.id)) {
      return { outcome: "sent", providerId: result.id };
    }
    return { outcome: "retry", errorCode: "resend_response" };
  }

  const concurrent = response.status === 409 && result?.name === "concurrent_idempotent_requests";
  const retry = concurrent || response.status >= 500 || [401, 403, 408, 429].includes(response.status);
  const retryHeader = Number(response.headers.get("retry-after"));
  return {
    outcome: retry ? "retry" : "failed",
    errorCode: "resend_" + response.status,
    retrySeconds: retryHeader > 0 && Number.isFinite(retryHeader) ? Math.ceil(Math.min(retryHeader, 3600)) : null,
  };
}
