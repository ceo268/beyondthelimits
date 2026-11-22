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

// The QR carries only this prefix and the order's random ticket code. Scanning it in /admin/ admits the holder.
export const qrPrefix = "BTL1:";
const ticketCode = /^[0-9a-f]{32}$/;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function ticketNumber(code) {
  return code.slice(0, 4).toUpperCase() + "-" + code.slice(4, 8).toUpperCase();
}

// qrImage(text) returns a base64 GIF/PNG of a QR code. It is injected by the Deno entry point.
export function ticketEmailMessage(ticket, env, { qrImage } = {}) {
  if (!emailPattern.test(ticket.email)) return null;
  const eventDate = env.TICKET_EVENT_DATE?.trim() || "7 February 2027";
  const venue = env.TICKET_EVENT_VENUE?.trim() || "Sir Mutha Venkatasubba Rao Concert Hall";
  const amount = currency.format(ticket.amount_paise / 100);
  const brand = "Beyond the Limits Business Summit";
  const testTicket = ticket.mode === "test";
  const code = ticketCode.test(ticket.ticket_code || "") ? ticket.ticket_code : null;
  const number = code ? ticketNumber(code) : null;
  const qr = code && qrImage ? qrImage(qrPrefix + code) : null;
  const qrAttachment = typeof qr === "string" && base64.test(qr)
    ? { filename: "ticket-qr.gif", content: qr, content_type: qr.startsWith("iVBOR") ? "image/png" : "image/gif", content_id: "ticket-qr" }
    : null;
  const artBase = env.TICKET_ART_BASE_URL?.trim().replace(/\/$/, "");
  const art = artBase && /^https:\/\/[^\s"'<>]+$/.test(artBase) && /^[a-z]+$/.test(ticket.tier || "")
    ? `${artBase}/${ticket.tier}.png` : null;

  const details = [
    ["Attendee", ticket.name],
    ...(ticket.phone ? [["Phone", ticket.phone]] : []),
    ["Pass", ticket.pass_label],
    ["Event date", eventDate],
    ["Venue", venue],
    ["Amount paid", amount],
    ...(number ? [["Ticket no.", number]] : []),
    ["Order reference", ticket.order_id],
  ];
  const rows = details.map(([label, value]) =>
    `<tr><th scope="row" align="left" style="padding:8px 12px 8px 0;color:#7a6a45;font-weight:normal;font-size:13px;white-space:nowrap;vertical-align:top">${escape(label)}</th><td style="padding:8px 0;font-size:14px;color:#1b1710;overflow-wrap:anywhere">${escape(value)}</td></tr>`,
  ).join("");
  const replyTo = env.TICKET_REPLY_TO?.trim();
  const testBanner = testTicket
    ? `<tr><td style="padding:10px 24px;background:#b42318;color:#fff;font-size:13px;font-weight:bold;text-align:center;letter-spacing:1px;${art ? "" : "border-radius:11px 11px 0 0"}">TEST TICKET · NOT VALID FOR ENTRY</td></tr>` : "";
  const artRow = art
    ? `<tr><td style="padding:0;line-height:0"><img src="${escape(art)}" width="560" alt="${escape(ticket.pass_label)}" style="display:block;width:100%;max-width:560px;height:auto;border-radius:11px 11px 0 0"></td></tr>` : "";
  const qrRow = number ? `
      <tr><td style="padding:0 24px"><div style="border-top:2px dashed #c9b26a;height:0;line-height:0">&nbsp;</div></td></tr>
      <tr><td align="center" style="padding:22px 24px 26px">
        ${qrAttachment ? `<img src="cid:ticket-qr" width="220" height="220" alt="Entry QR code for ticket ${escape(number)}" style="display:block;width:220px;height:220px;border:8px solid #ffffff;border-radius:6px">` : ""}
        <p style="margin:14px 0 2px;font-size:12px;letter-spacing:2px;color:#7a6a45;text-transform:uppercase">Ticket no.</p>
        <p style="margin:0;font-size:24px;font-weight:bold;letter-spacing:3px;color:#1b1710;font-family:'Courier New',monospace">${escape(number)}</p>
        <p style="margin:12px 0 0;font-size:13px;line-height:1.5;color:#4a3f28">Show this QR code at the entrance. It admits one person, once.<br>Please don’t share it.</p>
      </td></tr>` : "";

  return {
    from: env.RESEND_FROM_EMAIL,
    to: [ticket.email],
    ...(replyTo && emailPattern.test(replyTo) ? { reply_to: replyTo } : {}),
    subject: `${testTicket ? "[TEST] " : ""}Your ${ticket.pass_label}${number ? ` (${number})` : ""} · Beyond the Limits`,
    text: [
      ...(testTicket ? ["TEST TICKET · NOT VALID FOR ENTRY", ""] : []),
      brand, `${ticket.pass_label} · Admit one`, "",
      `Hi ${ticket.name}, your booking is confirmed. Keep this email as your ticket.`, "",
      ...details.map(([label, value]) => `${label}: ${value}`), "",
      number ? "Show the QR code in this email at the entrance. It admits one person, once."
        : "Please bring this email or a printout to check-in.",
    ].join("\n"),
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
      <body style="margin:0;background:#efebe1;font-family:Arial,Helvetica,sans-serif;color:#1b1710">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efebe1"><tr><td align="center" style="padding:24px 10px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff9e9;border:1px solid #dcc98c;border-radius:12px">
      ${artRow}${testBanner}
      <tr><td style="padding:24px;background:#17140d;color:#f3e08c;${art || testTicket ? "" : "border-radius:11px 11px 0 0"}">
        <p style="margin:0;font-size:12px;letter-spacing:2px;text-transform:uppercase">${escape(brand)}</p>
        <h1 style="color:#fff9e9;margin:10px 0 4px;font-size:30px;line-height:1.15">${escape(ticket.pass_label)}</h1>
        <p style="margin:0;font-size:14px">Admit one · ${escape(eventDate)}</p>
      </td></tr>
      <tr><td style="padding:24px 24px 18px">
        <p style="margin:0 0 14px;font-size:16px;line-height:1.5">Hi ${escape(ticket.name)}, your booking is confirmed. Keep this email as your ticket.</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      </td></tr>${qrRow}
      </table>
      <p style="margin:14px 0 0;font-size:12px;color:#7a6a45">${escape(brand)} · ${escape(venue)}</p>
      </td></tr></table></body></html>`,
    ...(qrAttachment ? { attachments: [qrAttachment] } : {}),
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
