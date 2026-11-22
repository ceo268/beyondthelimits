import qrcode from "npm:qrcode-generator@1.4.4";
import * as PDFLib from "npm:pdf-lib@1.17.1";
import { ticketEmailHandler } from "../_shared/ticket-worker.mjs";
import { qrPrefix } from "../_shared/resend.mjs";
import { renderTicketPdf } from "../_shared/ticket-pdf.mjs";

const env = Deno.env.toObject();
const logoUrl = env.TICKET_LOGO_URL || "https://www.beyondthelimits.co.in/assets/logo.jpg";

function makeQr(text: string) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr;
}

// Returns the QR as a base64 GIF (no data: prefix). GIF renders in every major email client.
function qrImage(text: string): string {
  return makeQr(text).createDataURL(8, 4).split(",")[1];
}

// The wordmark for the PDF header is fetched once per function instance and reused.
let logo: Promise<Uint8Array | null> | null = null;
function loadLogo(): Promise<Uint8Array | null> {
  logo ||= fetch(logoUrl, { signal: AbortSignal.timeout(5000) })
    .then(async (response) => (response.ok ? new Uint8Array(await response.arrayBuffer()) : null))
    .catch(() => null)
    .then((bytes) => {
      if (!bytes) logo = null;
      return bytes;
    });
  return logo;
}

async function renderPdf(ticket: Record<string, unknown>): Promise<string> {
  const qr = typeof ticket.ticket_code === "string" ? makeQr(qrPrefix + ticket.ticket_code) : null;
  return renderTicketPdf(PDFLib, ticket, env, {
    qr: qr && { size: qr.getModuleCount(), isDark: (row: number, col: number) => qr.isDark(row, col) },
    logo: await loadLogo(),
  });
}

Deno.serve(ticketEmailHandler(env, fetch, { qrImage, renderPdf }));
