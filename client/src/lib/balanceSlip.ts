import jsPDF from "jspdf";
import { api } from "./api";
import { BusinessInfo } from "./types";
import { NAME_LOGO_PNG_BASE64, NAME_LOGO_ASPECT_RATIO } from "./logoAsset";
import { shopBankDetails, amountOnly, amountLKR } from "./receipts";
import { previewPdf } from "./pdfPreview";

interface AmountDue {
  customer: { id: number; name: string; customer_code: string; phone: string | null };
  invoices: { id: number; invoice: string; date: string; total: number; amount_paid: number; balance: number }[];
  owed: number;
  store_credit: number;
  amount_to_pay: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2 Oct 2026" — from a "YYYY-MM-DD ..." stamp or a Date.
function longDate(value: string | Date): string {
  if (typeof value === "string") {
    const [y, m, d] = value.slice(0, 10).split("-").map(Number);
    return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : value.slice(0, 10);
  }
  return `${value.getDate()} ${MONTHS[value.getMonth()]} ${value.getFullYear()}`;
}

function clockTime(d: Date): string {
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function localDateStamp(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// A quick "how much is my balance?" answer: what they owe as of right now,
// laid out like the shop's credit invoices — the unpaid invoices, the total,
// and the same "Pay Here" bank block.
export function generateBalanceSlip(due: AmountDue, businessInfo: BusinessInfo | null, now = new Date()): jsPDF {
  const { customer, invoices, owed, store_credit, amount_to_pay } = due;
  const creditApplied = Math.min(store_credit, owed);
  const creditLeft = Math.max(0, store_credit - creditApplied);
  const businessName = businessInfo?.business_name || "M&M Clothing";

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = 210;
  const marginX = 18;
  const rightX = pageWidth - marginX;
  let y = 14;

  // Same quiet one-line summary at the very top as the invoice.
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(160);
  doc.text([customer.customer_code, customer.name, "Balance Slip"].join("  ·  "), marginX, y);
  y += 10;

  const logoWidth = 42;
  doc.addImage(NAME_LOGO_PNG_BASE64, "PNG", rightX - logoWidth, y - 8, logoWidth, logoWidth / NAME_LOGO_ASPECT_RATIO, undefined, "SLOW");
  y += 20;

  const labelX = marginX;
  const valueX = marginX + 27;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  function kvRow(label: string, draw: (x: number, yy: number) => void) {
    doc.setTextColor(150);
    doc.text(label, labelX, y);
    doc.setTextColor(20);
    draw(valueX, y);
    y += 5.8;
  }

  kvRow("Report", (x, yy) => doc.text("Balance Slip", x, yy));
  kvRow("Status", (x, yy) => doc.text(amount_to_pay > 0 ? "Payment Due" : "Settled", x, yy));
  kvRow("As Of", (x, yy) => doc.text(`${longDate(now)}  ·  ${clockTime(now)}`, x, yy));
  kvRow("Bill To", (x, yy) => {
    doc.text(customer.name, x, yy);
    if (customer.phone) {
      doc.setFont("helvetica", "italic");
      doc.text(customer.phone, x + doc.getTextWidth(customer.name) + 3, yy);
      doc.setFont("helvetica", "normal");
    }
  });
  y += 6;

  // Unpaid invoices — the snapshot — in the invoice's hairline table style.
  doc.setFontSize(8.5);
  doc.setTextColor(140);
  doc.text("INVOICE", marginX + 2, y);
  doc.text("DATE", marginX + 52, y);
  doc.text("TOTAL", rightX - 62, y, { align: "right" });
  doc.text("PAID", rightX - 32, y, { align: "right" });
  doc.text("BALANCE", rightX, y, { align: "right" });
  y += 3;
  doc.setDrawColor(190);
  doc.setLineWidth(0.3);
  doc.line(marginX, y, rightX, y);

  const rowHeight = 10;
  if (invoices.length === 0) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(10);
    doc.setTextColor(150);
    doc.text("No unpaid invoices.", marginX + 2, y + 7);
    doc.setFont("helvetica", "normal");
    y += rowHeight;
    doc.setDrawColor(230);
    doc.setLineWidth(0.2);
    doc.line(marginX, y, rightX, y);
  }
  for (const inv of invoices) {
    if (y + rowHeight > 270) {
      doc.addPage();
      y = 20;
    }
    const textY = y + 6.5;
    doc.setFontSize(10.5);
    doc.setTextColor(20);
    doc.text(inv.invoice, marginX + 2, textY);
    doc.setTextColor(90);
    doc.text(longDate(inv.date), marginX + 52, textY);
    doc.text(amountOnly(inv.total), rightX - 62, textY, { align: "right" });
    doc.text(inv.amount_paid > 0 ? amountOnly(inv.amount_paid) : "-", rightX - 32, textY, { align: "right" });
    doc.setTextColor(0);
    doc.text(amountOnly(inv.balance), rightX, textY, { align: "right" });
    y += rowHeight;
    doc.setDrawColor(230);
    doc.setLineWidth(0.2);
    doc.line(marginX, y, rightX, y);
  }

  // Totals, right-aligned like the invoice's.
  const payHereRoom = amount_to_pay > 0 ? 36 : 0;
  if (y + 50 + (creditApplied > 0 ? 6 : 0) + (creditLeft > 0 ? 6 : 0) + payHereRoom > 270) {
    doc.addPage();
    y = 20;
  }
  const totalsX = rightX - 60;
  y += 10;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(90);
  doc.text("Outstanding", totalsX, y);
  doc.text(amountOnly(owed), rightX, y, { align: "right" });
  if (creditApplied > 0) {
    y += 6;
    doc.text("Store Credit", totalsX, y);
    doc.text(`- ${amountOnly(creditApplied)}`, rightX, y, { align: "right" });
  }
  y += 3;
  doc.setDrawColor(200);
  doc.line(totalsX, y, rightX, y);
  y += 6.5;
  doc.setFontSize(10);
  doc.setTextColor(20);
  doc.text("Total Due", totalsX, y);
  doc.setFontSize(12);
  doc.text(amountLKR(amount_to_pay), rightX, y, { align: "right" });
  if (creditLeft > 0) {
    y += 6.5;
    doc.setFontSize(9.5);
    doc.setTextColor(90);
    doc.text("Store Credit Left", totalsX, y);
    doc.text(amountOnly(creditLeft), rightX, y, { align: "right" });
  }

  // The invoice's own "Pay Here" block, as-is — plus the customer code as
  // the reference to quote when paying.
  y += 10;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  if (amount_to_pay > 0) {
    const { accountName, accountNumber, bankName } = shopBankDetails(businessInfo);
    kvRow("Pay Here", (x, yy) => doc.text(accountName, x, yy));
    doc.setTextColor(20);
    doc.text(accountNumber, valueX, y);
    y += 5.8;
    doc.text(bankName, valueX, y);
    y += 5.8;
    kvRow("Ref", (x, yy) => doc.text(customer.customer_code, x, yy));
  }

  y += 4;
  doc.setFont("helvetica", "italic");
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Balance as of ${longDate(now)}. Thank you for shopping with ${businessName}!`, marginX, y);
  doc.setFont("helvetica", "normal");

  const footerY = 285;
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFontSize(7.5);
    doc.setTextColor(160);
    doc.text("System generated — no signature required", pageWidth / 2, footerY, { align: "center" });
    doc.text(`Page ${p} of ${totalPages}`, rightX, footerY, { align: "right" });
  }

  return doc;
}

// One click: fetches what the customer owes right now and opens the slip in a preview.
export async function downloadBalanceSlip(customerId: number): Promise<void> {
  const [due, businessInfo] = await Promise.all([
    api.get<AmountDue>(`/customers/${customerId}/amount-due`),
    api.get<BusinessInfo | null>("/business-info").catch(() => null),
  ]);
  const now = new Date();
  previewPdf(generateBalanceSlip(due, businessInfo, now), `BalanceSlip-${due.customer.customer_code}-${localDateStamp(now)}.pdf`);
}
