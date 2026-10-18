import jsPDF from "jspdf";
import { api } from "./api";
import { BusinessInfo } from "./types";
import { NAME_LOGO_PNG_BASE64, NAME_LOGO_ASPECT_RATIO } from "./logoAsset";
import { amountOnly, amountLKR } from "./receipts";
import { barcodePng } from "./waybillLabelPdf";
import { amountInWords } from "./amountInWords";
import { previewPdf } from "./pdfPreview";

// The "Refund payment done" receipt — laid out like the shop's A4 invoice — handed to (or kept for) a customer whose refund for a return has
// been paid: who was paid, how (and to which bank account), what for, what was held back, the cash-book
// transaction IDs and who paid it. Opened in the usual PDF preview, where it can be printed or downloaded.

export interface RefundSlipItem {
  title: string | null;
  size: string | null;
  color: string | null;
  invoice: string;
  price: number;
  delivery_share: number;
  inspection_hold: number;
  not_paid: number;
  refunded: number;
}

export interface RefundSlipData {
  key: string;
  kind: "courier_return" | "in_store_return";
  paid_at: string;
  customer: { id: number; name: string; customer_code: string | null; phone: string | null } | null;
  invoices: string[];
  reason: string | null;
  method: string;
  bank: { bank_name: string; account_name: string; account_number: string; branch: string | null } | null;
  items: RefundSlipItem[];
  total: number;
  transaction_codes: string[];
  paid_by: string | null;
  sale_id: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2 Oct 2026  ·  3:06 PM" from "2026-10-02 15:06:11".
function dayAndTime(stamp: string): string {
  const [y, m, d] = stamp.slice(0, 10).split("-").map(Number);
  const day = y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : stamp.slice(0, 10);
  const t = /[ T](\d{2}):(\d{2})/.exec(stamp);
  if (!t) return day;
  const h = Number(t[1]);
  return `${day}  ·  ${h % 12 || 12}:${t[2]} ${h < 12 ? "AM" : "PM"}`;
}

// Only the last four digits of a bank account number go on paper, the rest hidden — for the customer's privacy.
export function maskAccount(accountNumber: string): string {
  const digits = accountNumber.replace(/\s+/g, "");
  return digits.length > 4 ? `****${digits.slice(-4)}` : "****";
}

// What an item was refundable for, before the delivery charge share and anything an inspection held back come off (those are shown below the
// table): what was actually refunded plus those holds. A part that was never paid for isn't refundable, so it isn't in it.
const refundableOf = (i: RefundSlipItem) => Math.round((i.refunded + i.delivery_share + i.inspection_hold) * 100) / 100;

const variantOf = (i: RefundSlipItem) => [i.size, i.color].filter(Boolean).join(" · ");

// The refund receipt is laid out exactly like the shop's A4 invoice (see generateA4Pdf in receipts.ts): the same quiet line at the top, barcode
// left and logo right, the same Key / Value block, the same hairline item table and right-aligned totals, and the same footer — so a refund
// reads as the invoice's twin. The barcode carries the cash-book transaction ID.
export function generateRefundSlip(slip: RefundSlipData, businessInfo: BusinessInfo | null): jsPDF {
  const businessName = businessInfo?.business_name || "M&M Clothing";
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = 210;
  const marginX = 18;
  const rightX = pageWidth - marginX;
  let y = 14;
  const reference = slip.transaction_codes[0] ?? slip.invoices[0] ?? slip.key;

  // The quiet one-line summary at the very top: customer ID, name, and what this is.
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(160);
  doc.text([slip.customer?.customer_code, slip.customer?.name ?? "Walk-in", reference].filter(Boolean).join("  ·  "), marginX, y);
  y += 10;

  // Barcode (encodes the reference) on the left, the shop's logo on the right.
  const barcode = barcodePng(reference);
  if (barcode) {
    const bcWidth = 55;
    const bcHeight = Math.min(14, bcWidth / barcode.aspect);
    doc.addImage(barcode.dataUrl, "PNG", marginX, y - 6, bcWidth, bcHeight, undefined, "FAST");
  }
  const logoWidth = 42;
  doc.addImage(NAME_LOGO_PNG_BASE64, "PNG", rightX - logoWidth, y - 8, logoWidth, logoWidth / NAME_LOGO_ASPECT_RATIO, undefined, "SLOW");
  y += 20;

  // A quiet title, like the payment request's — regular weight, sentence case.
  doc.setFont("helvetica", "normal");
  doc.setFontSize(14);
  doc.setTextColor(60);
  doc.text("Refund Payment", marginX, y);
  y += 8;

  // Key / value summary, one shared value column.
  const labelX = marginX;
  const valueX = marginX + 31;
  doc.setFontSize(12);
  function kvRow(label: string, draw: (x: number, yy: number) => void) {
    doc.setTextColor(150);
    doc.text(label, labelX, y);
    doc.setTextColor(20);
    draw(valueX, y);
    y += 5.8;
  }
  const methodText = slip.method === "bank_transfer" ? "Bank Transfer" : slip.method === "cash" ? "Cash" : slip.method.replace(/_/g, " ");
  kvRow("Status", (x, yy) => doc.text("Successful", x, yy));
  kvRow("Payment", (x, yy) => doc.text(methodText, x, yy));
  kvRow(slip.invoices.length > 1 ? "Invoices" : "Invoice", (x, yy) => doc.text(slip.invoices.join(", "), x, yy));
  kvRow("Date", (x, yy) => doc.text(dayAndTime(slip.paid_at), x, yy));
  // Who was paid: name / phone on one line.
  kvRow("Paid To", (x, yy) => doc.text([slip.customer?.name ?? "Walk-in", slip.customer?.phone].filter(Boolean).join(" / "), x, yy));
  if (slip.transaction_codes.length > 0) kvRow(slip.transaction_codes.length > 1 ? "Transaction IDs" : "Transaction ID", (x, yy) => doc.text(slip.transaction_codes.join(", "), x, yy));

  y += 6;

  // Item table — the invoice's plain hairline style.
  doc.setFontSize(8.5);
  doc.setTextColor(140);
  doc.text("ITEM", marginX + 2, y);
  doc.text("QTY", rightX - 55, y, { align: "right" });
  doc.text("UNIT PRICE", rightX - 30, y, { align: "right" });
  doc.text("REFUNDABLE", rightX, y, { align: "right" });
  y += 3;
  doc.setDrawColor(190);
  doc.setLineWidth(0.3);
  doc.line(marginX, y, rightX, y);

  const rowHeight = 17.5;
  const topPadding = 6.5;
  const sublineGap = 4.5;
  for (const item of slip.items) {
    if (y + rowHeight > 275) {
      doc.addPage();
      y = 20;
    }
    const textY = y + topPadding;
    doc.setFontSize(10.5);
    doc.setTextColor(20);
    doc.text(item.title ?? "Item", marginX + 2, textY);
    doc.setFontSize(9);
    doc.setTextColor(150);
    doc.text(variantOf(item), marginX + 2, textY + sublineGap);
    doc.setFontSize(10.5);
    doc.setTextColor(90);
    doc.text("1", rightX - 55, textY, { align: "right" });
    doc.setTextColor(20);
    doc.text(amountOnly(item.price), rightX - 30, textY, { align: "right" });
    doc.setTextColor(0);
    doc.text(amountOnly(refundableOf(item)), rightX, textY, { align: "right" });
    y += rowHeight;
    doc.setDrawColor(230);
    doc.setLineWidth(0.2);
    doc.line(marginX, y, rightX, y);
  }

  // Totals, right-aligned like the invoice's.
  const heldDelivery = slip.items.reduce((sum, i) => sum + i.delivery_share, 0);
  const heldInspection = slip.items.reduce((sum, i) => sum + i.inspection_hold, 0);
  const lines = 1 + (heldDelivery > 0 ? 1 : 0) + (heldInspection > 0 ? 1 : 0);
  if (y + 40 + lines * 6 > 270) {
    doc.addPage();
    y = 20;
  }
  const totalsX = rightX - 60;
  y += 10;
  doc.setFontSize(9.5);
  doc.setTextColor(90);
  doc.text("Refundable", totalsX, y);
  doc.text(amountOnly(slip.items.reduce((sum, i) => sum + refundableOf(i), 0)), rightX, y, { align: "right" });
  if (heldDelivery > 0) {
    y += 6;
    doc.text("Delivery Charge (your share)", totalsX, y);
    doc.text(`- ${amountOnly(heldDelivery)}`, rightX, y, { align: "right" });
  }
  if (heldInspection > 0) {
    y += 6;
    doc.text("Held Back (inspection)", totalsX, y);
    doc.text(`- ${amountOnly(heldInspection)}`, rightX, y, { align: "right" });
  }
  y += 3;
  doc.setDrawColor(200);
  doc.setLineWidth(0.3);
  doc.line(totalsX, y, rightX, y);
  y += 6.5;
  doc.setFontSize(10);
  doc.setTextColor(20);
  doc.text("Total Refunded", totalsX, y);
  doc.setFontSize(12);
  doc.text(amountLKR(slip.total), rightX, y, { align: "right" });
  y += 5.5;
  doc.setFont("helvetica", "italic");
  doc.setFontSize(8);
  doc.setTextColor(140);
  doc.text(`Rupees ${amountInWords(slip.total)}`, rightX, y, { align: "right" });
  doc.setFont("helvetica", "normal");

  // The closing recap, in the same key / value style as the header.
  if (y + 54 > 270) {
    doc.addPage();
    y = 20;
  }
  y += 12;
  doc.setFontSize(12);
  kvRow("Refunded", (x, yy) => doc.text(`${slip.total.toLocaleString()}LKR`, x, yy));
  // Where a transfer went — the account's name, then only the last four digits of its number, then the bank. (No branch or full number on
  // paper.)
  if (slip.method === "bank_transfer" && slip.bank) {
    kvRow("Paid Into", (x, yy) => doc.text(slip.bank!.account_name, x, yy));
    doc.setTextColor(20);
    doc.text(maskAccount(slip.bank.account_number), valueX, y);
    y += 5.8;
    doc.text(slip.bank.bank_name, valueX, y);
    y += 5.8;
  }
  // (Who paid is in the footer, as on the invoice — no "Paid By" row here.)

  y += 4;
  doc.setFont("helvetica", "italic");
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`This refund has been paid in full. Thank you for shopping with ${businessName}!`, marginX, y);
  doc.setFont("helvetica", "normal");

  // Footer on every page, as on the invoice.
  const footerY = 285;
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFontSize(7.5);
    doc.setTextColor(160);
    doc.text(`Paid by: ${slip.paid_by ?? "—"}`, marginX, footerY);
    doc.text("System generated — no signature required", pageWidth / 2, footerY, { align: "center" });
    doc.text(`Page ${p} of ${totalPages}`, rightX, footerY, { align: "right" });
  }
  return doc;
}

// One click: fetches the refund payment and opens its slip in the preview (Print / Download there).
export async function printRefundSlip(key: string): Promise<void> {
  const [slip, businessInfo] = await Promise.all([
    api.get<RefundSlipData>(`/returns/refund-slips/${encodeURIComponent(key)}`),
    api.get<BusinessInfo | null>("/business-info").catch(() => null),
  ]);
  const who = slip.customer?.customer_code ?? "customer";
  previewPdf(generateRefundSlip(slip, businessInfo), `RefundReceipt-${who}-${slip.paid_at.slice(0, 10)}-${slip.key}.pdf`);
}
