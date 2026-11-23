// Printable A5 PDF ticket. pdf-lib is injected (npm:pdf-lib in Deno), so this module has no imports.
// qr: { size, isDark(row, col) } for the entry QR. logo: JPEG bytes of the gold-on-black wordmark, or null.

const W = 420;
const H = 595;
const M = 18; // page margin around the ticket card
const money = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The standard PDF fonts only cover WinAnsi (Latin-1). Map common symbols and replace anything else.
export function pdfText(value) {
  return String(value ?? "")
    .replace(/₹/g, "Rs. ")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
}

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function wrap(text, font, size, width) {
  const lines = [];
  let line = "";
  for (const word of pdfText(text).split(/\s+/).filter(Boolean)) {
    const next = line ? line + " " + word : word;
    if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

function fit(text, font, size, width) {
  let value = pdfText(text);
  if (font.widthOfTextAtSize(value, size) <= width) return value;
  while (value.length > 1 && font.widthOfTextAtSize(value + "...", size) > width) value = value.slice(0, -1);
  return value + "...";
}

export async function renderTicketPdf(PDFLib, ticket, env, { qr, logo } = {}) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const hex = (value) => rgb(...[1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16) / 255));
  const ink = hex("#1b1710");
  const muted = hex("#7a6a45");
  const gold = hex("#c9a54a");
  const goldLight = hex("#f3e08c");
  const cream = hex("#fffaf0");
  const black = hex("#000000");
  const white = hex("#ffffff");

  const label = ticket.ticket_label || "TICKET";
  const eventDate = env.TICKET_EVENT_DATE?.trim() || "7 February 2027";
  const venue = env.TICKET_EVENT_VENUE?.trim() || "Sir Mutha Venkatasubba Rao Concert Hall";
  const amount = "Rs. " + money.format(ticket.amount_paise / 100) + " (incl. GST)";

  const doc = await PDFDocument.create();
  doc.setTitle(pdfText(`${label} · ${ticket.pass_label} · Beyond the Limits Business Summit`));
  doc.setAuthor("Beyond the Limits Business Summit");
  doc.setSubject("Event ticket");
  const page = doc.addPage([W, H]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.CourierBold);
  const text = (value, x, y, size, font = regular, color = ink) =>
    page.drawText(pdfText(value), { x, y, size, font, color });
  const centered = (value, y, size, font, color) => {
    const clean = pdfText(value);
    text(clean, (W - font.widthOfTextAtSize(clean, size)) / 2, y, size, font, color);
  };

  // Ticket card
  const cardW = W - 2 * M;
  page.drawRectangle({ x: M, y: M, width: cardW, height: H - 2 * M, color: cream, borderColor: gold, borderWidth: 1.2 });

  // Header band with the wordmark
  const bandH = 150;
  const bandY = H - M - bandH;
  page.drawRectangle({ x: M, y: bandY, width: cardW, height: bandH, color: black });
  let logoDrawn = false;
  if (logo) {
    try {
      const image = await doc.embedJpg(logo);
      const width = 240;
      const height = width * image.height / image.width;
      page.drawImage(image, { x: (W - width) / 2, y: bandY + bandH - 18 - height, width, height });
      logoDrawn = true;
    } catch {
      // Fall back to the text wordmark.
    }
  }
  if (!logoDrawn) {
    centered("BEYOND THE LIMITS", bandY + 92, 26, bold, goldLight);
    centered("BUSINESS SUMMIT", bandY + 72, 10, bold, gold);
  }
  centered(eventDate, bandY + 28, 10.5, bold, goldLight);
  centered(venue, bandY + 13, 8, regular, gold);

  if (ticket.mode === "test") {
    page.drawRectangle({ x: M, y: bandY - 20, width: cardW, height: 20, color: hex("#b42318") });
    centered("TEST TICKET - NOT VALID FOR ENTRY", bandY - 14, 9, bold, white);
  }

  // Pass, admit-one badge, ticket number
  const left = M + 18;
  const right = W - M - 18;
  let y = bandY - (ticket.mode === "test" ? 52 : 38);
  text(fit(String(ticket.pass_label).toUpperCase(), bold, 20, 230), left, y, 20, bold);
  const badge = "ADMIT ONE";
  const badgeW = bold.widthOfTextAtSize(badge, 9) + 18;
  page.drawRectangle({ x: right - badgeW, y: y - 5, width: badgeW, height: 20, color: black });
  text(badge, right - badgeW + 9, y + 1.5, 9, bold, goldLight);

  y -= 30;
  text("TICKET NO.", left, y, 7.5, bold, muted);
  y -= 26;
  text(label, left, y, 26, mono);

  // Details
  const colW = (right - left - 16) / 2;
  const field = (name, value, x, top, width) => {
    text(name.toUpperCase(), x, top, 7, bold, muted);
    text(fit(value, regular, 10.5, width), x, top - 13, 10.5, regular);
  };
  y -= 30;
  field("Attendee", ticket.name, left, y, colW);
  field("Phone", ticket.phone || "-", left + colW + 16, y, colW);
  y -= 32;
  field("Email", ticket.email, left, y, right - left);
  y -= 32;
  field("Date & time", eventDate, left, y, colW);
  field("Amount paid", amount, left + colW + 16, y, colW);
  y -= 32;
  text("VENUE", left, y, 7, bold, muted);
  wrap(venue, regular, 10.5, right - left).slice(0, 2).forEach((line, i) => text(line, left, y - 13 - i * 13, 10.5));

  // Perforation
  const cutY = 160;
  page.drawLine({ start: { x: M + 12, y: cutY }, end: { x: W - M - 12, y: cutY }, thickness: 1, color: gold, dashArray: [5, 4] });
  for (const x of [M, W - M]) page.drawCircle({ x, y: cutY, size: 10, color: white, borderColor: gold, borderWidth: 1.2 });

  // Entry QR stub
  const qrSize = 118;
  const qrX = left;
  const qrY = M + 18;
  page.drawRectangle({ x: qrX, y: qrY, width: qrSize, height: qrSize, color: white, borderColor: hex("#e5d9b6"), borderWidth: 0.8 });
  if (qr?.size) {
    const cell = qrSize / (qr.size + 4);
    for (let row = 0; row < qr.size; row++) {
      for (let col = 0; col < qr.size; col++) {
        if (qr.isDark(row, col)) {
          page.drawRectangle({
            x: qrX + (col + 2) * cell, y: qrY + qrSize - (row + 3) * cell,
            width: cell + 0.05, height: cell + 0.05, color: black,
          });
        }
      }
    }
  }

  const noteX = qrX + qrSize + 18;
  const noteW = right - noteX;
  page.drawRectangle({ x: noteX - 6, y: qrY + qrSize - 30, width: noteW + 6, height: 30, color: black });
  text("1 TICKET ADMITS", noteX + 2, qrY + qrSize - 13, 10, bold, goldLight);
  text("ONLY 1 PERSON", noteX + 2, qrY + qrSize - 25, 10, bold, goldLight);
  const notes = [
    "Valid for a single entry. Show this QR code at the entrance; it is scanned once.",
    "Keep it private: the first scan is the one admitted.",
  ];
  let noteY = qrY + qrSize - 46;
  for (const note of notes) {
    for (const line of wrap(note, regular, 8.5, noteW)) {
      text(line, noteX, noteY, 8.5);
      noteY -= 11;
    }
    noteY -= 4;
  }
  text(fit(`Order ref: ${ticket.order_id}`, regular, 6.5, noteW), noteX, qrY + 2, 6.5, regular, muted);

  return toBase64(await doc.save());
}
