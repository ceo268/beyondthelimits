import qrcode from "npm:qrcode-generator@1.4.4";
import { ticketEmailHandler } from "../_shared/ticket-worker.mjs";

// Returns the QR as a base64 GIF (no data: prefix). GIF renders in every major email client.
function qrImage(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createDataURL(8, 4).split(",")[1];
}

Deno.serve(ticketEmailHandler(Deno.env.toObject(), fetch, { qrImage }));
