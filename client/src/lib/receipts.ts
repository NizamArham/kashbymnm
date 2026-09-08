import jsPDF from "jspdf";
import { Sale } from "./types";

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function money(n: number): string {
  return `Rs. ${n.toLocaleString()}`;
}

// "bank_transfer" -> "Bank Transfer", "cash" -> "Cash", etc. — used
// anywhere a stored payment_method value is shown to a person, since the
// raw snake_case value is only meant for the database, not a receipt.
function formatPaymentMethod(method: string | null | undefined): string {
  if (!method) return "—";
  return method
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------
// A4 invoice PDF — one clean page, matching the shop's existing A4
// invoice layout: header, metadata, itemized table, totals, footer.
// Drawn directly with jsPDF (no DOM screenshot) so the output stays
// crisp and small regardless of screen zoom or device pixel ratio.
// ---------------------------------------------------------------------
export function generateA4Pdf(sale: Sale): jsPDF {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = 210;
  const marginX = 18;
  let y = 20;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("M&M Clothing", marginX, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text("Invoice", pageWidth - marginX, y, { align: "right" });
  y += 8;

  doc.setDrawColor(230);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 8;

  doc.setFontSize(9.5);
  doc.setTextColor(90);
  const metaLeft = [
    ["Invoice", sale.invoice],
    ["Date", formatDate(sale.date)],
    ["Bill to", sale.customer_name ?? "Walk-in"],
  ];
  const metaRight = [
    ["Status", sale.payment_status],
    ["Payment", formatPaymentMethod(sale.payment_method)],
    ["Type", sale.sale_type === "online" ? "Online order" : "In-store"],
  ];
  let metaY = y;
  for (const [label, value] of metaLeft) {
    doc.setTextColor(150);
    doc.text(`${label}`, marginX, metaY);
    doc.setTextColor(30);
    doc.text(String(value), marginX + 22, metaY);
    metaY += 5.5;
  }
  metaY = y;
  const rightColX = pageWidth / 2 + 10;
  for (const [label, value] of metaRight) {
    doc.setTextColor(150);
    doc.text(`${label}`, rightColX, metaY);
    doc.setTextColor(30);
    doc.text(String(value), rightColX + 20, metaY);
    metaY += 5.5;
  }
  y += 22;

  // Delivery address — only relevant for online/COD orders, and only
  // shown when one is actually on file.
  const addr = sale.delivery_address;
  const hasAddress = addr && (addr.address_line1 || addr.city);
  if (sale.sale_type === "online" && hasAddress) {
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text("DELIVER TO", marginX, y);
    y += 5;
    doc.setFontSize(9.5);
    doc.setTextColor(30);
    const addressParts = [addr!.address_line1, addr!.address_line2, addr!.city].filter(Boolean);
    doc.text(addressParts.join(", "), marginX, y);
    y += 10;
  }

  // Items table header
  doc.setFillColor(248, 248, 248);
  doc.rect(marginX, y, pageWidth - marginX * 2, 7, "F");
  doc.setFontSize(8);
  doc.setTextColor(140);
  doc.text("ITEM", marginX + 2, y + 4.8);
  doc.text("QTY", pageWidth - marginX - 55, y + 4.8, { align: "right" });
  doc.text("PRICE", pageWidth - marginX - 30, y + 4.8, { align: "right" });
  doc.text("TOTAL", pageWidth - marginX - 2, y + 4.8, { align: "right" });
  y += 11;

  doc.setFontSize(9.5);
  const items = sale.items ?? [];
  for (const item of items) {
    doc.setTextColor(20);
    doc.text(item.product_title ?? "Item", marginX + 2, y);
    doc.setFontSize(7.5);
    doc.setTextColor(150);
    const subLine = [item.sku, item.size, item.color].filter(Boolean).join("  ·  ");
    doc.text(subLine, marginX + 2, y + 4);
    doc.setFontSize(9.5);
    doc.setTextColor(90);
    doc.text(String(item.quantity), pageWidth - marginX - 55, y, { align: "right" });

    const wasDiscounted = item.original_selling_price != null && item.original_selling_price > item.unit_price;
    const priceX = pageWidth - marginX - 30;
    if (wasDiscounted) {
      // Original price struck through just above the actual sold price —
      // a small, honest touch that reads as "you got a good rate" rather
      // than hiding that a discount was given.
      doc.setFontSize(7);
      doc.setTextColor(160);
      const originalText = money(item.original_selling_price!);
      doc.text(originalText, priceX, y - 3, { align: "right" });
      const textWidth = doc.getTextWidth(originalText);
      doc.setDrawColor(160);
      doc.setLineWidth(0.2);
      doc.line(priceX - textWidth, y - 4, priceX, y - 4);
      doc.setFontSize(9.5);
      doc.setTextColor(90);
    }
    doc.text(money(item.unit_price), priceX, y, { align: "right" });

    doc.setTextColor(20);
    doc.text(money(item.line_total), pageWidth - marginX - 2, y, { align: "right" });
    y += 9;

    if (y > 260) {
      doc.addPage();
      y = 20;
    }
  }

  y += 4;
  doc.setDrawColor(220);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 8;

  const totalsX = pageWidth - marginX - 60;
  doc.setFontSize(9.5);
  doc.setTextColor(90);
  doc.text("Subtotal", totalsX, y);
  doc.text(money(sale.subtotal), pageWidth - marginX - 2, y, { align: "right" });
  y += 6;

  if (sale.discount > 0) {
    doc.text("Discounts & Coupons", totalsX, y);
    doc.text(`- ${money(sale.discount)}`, pageWidth - marginX - 2, y, { align: "right" });
    y += 6;
    if (sale.coupon_code) {
      doc.setFontSize(7.5);
      doc.setTextColor(150);
      doc.text(`Coupon: ${sale.coupon_code}`, totalsX, y);
      doc.setFontSize(9.5);
      doc.setTextColor(90);
      y += 5;
    }
  }

  y += 2;
  doc.setDrawColor(200);
  doc.line(totalsX, y, pageWidth - marginX, y);
  y += 6;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(20);
  doc.text("Total", totalsX, y);
  doc.text(money(sale.total), pageWidth - marginX - 2, y, { align: "right" });

  // Footer
  const footerY = 285;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(160);
  doc.text(`Cashier: ${sale.salesperson ?? "—"}`, marginX, footerY);
  doc.text("System generated — no signature required", pageWidth / 2, footerY, { align: "center" });
  doc.text(sale.invoice, pageWidth - marginX, footerY, { align: "right" });

  return doc;
}

export function downloadA4Pdf(sale: Sale) {
  const doc = generateA4Pdf(sale);
  doc.save(`${sale.invoice}.pdf`);
}

// ---------------------------------------------------------------------
// 80mm thermal receipt PDF — a genuinely different, narrow till-receipt
// layout: condensed monospace-style text, no logo/barcode image, just
// what a real thermal printer would produce. Height grows with content
// since thermal rolls aren't a fixed page size.
// ---------------------------------------------------------------------
export function generateThermalPdf(sale: Sale): jsPDF {
  const widthMm = 80;
  const marginX = 4;
  const contentWidth = widthMm - marginX * 2;
  const items = sale.items ?? [];
  const addr = sale.delivery_address;
  const hasAddress = sale.sale_type === "online" && addr && (addr.address_line1 || addr.city);

  // Estimate height: header + meta + optional address line + one line per
  // item (plus a possible wrapped SKU line) + totals + footer, with
  // generous line spacing.
  const estimatedHeight = 55 + (hasAddress ? 8 : 0) + items.length * 10 + 40;

  const doc = new jsPDF({ unit: "mm", format: [widthMm, estimatedHeight] });
  let y = 8;

  doc.setFont("courier", "bold");
  doc.setFontSize(11);
  doc.text("M&M CLOTHING", widthMm / 2, y, { align: "center" });
  y += 5;
  doc.setFont("courier", "normal");
  doc.setFontSize(7.5);
  doc.text("Kash by M&M — POS Receipt", widthMm / 2, y, { align: "center" });
  y += 6;

  doc.setLineDashPattern([0.5, 0.5], 0);
  doc.line(marginX, y, widthMm - marginX, y);
  y += 5;

  doc.setFontSize(8);
  doc.text(`Invoice: ${sale.invoice}`, marginX, y);
  y += 4;
  doc.text(`Date: ${formatDate(sale.date)}`, marginX, y);
  y += 4;
  doc.text(`Customer: ${sale.customer_name ?? "Walk-in"}`, marginX, y);
  y += 4;
  doc.text(`Type: ${sale.sale_type === "online" ? "Online" : "In-store"}`, marginX, y);
  y += 4;
  if (hasAddress) {
    const addressParts = [addr!.address_line1, addr!.address_line2, addr!.city].filter(Boolean);
    const addressLines = doc.splitTextToSize(`Deliver to: ${addressParts.join(", ")}`, contentWidth);
    doc.text(addressLines, marginX, y);
    y += addressLines.length * 3.6;
  }
  y += 1;

  doc.line(marginX, y, widthMm - marginX, y);
  y += 5;

  for (const item of items) {
    doc.setFont("courier", "bold");
    doc.setFontSize(8);
    const titleLines = doc.splitTextToSize(item.product_title ?? "Item", contentWidth);
    doc.text(titleLines, marginX, y);
    y += titleLines.length * 3.6;

    doc.setFont("courier", "normal");
    doc.setFontSize(7);
    const detail = [item.size, item.color].filter(Boolean).join("/");
    doc.text(detail || "—", marginX, y);
    doc.text(`x${item.quantity}`, widthMm - marginX - 18, y);
    doc.text(money(item.line_total), widthMm - marginX, y, { align: "right" });
    y += 4.2;

    const wasDiscounted = item.original_selling_price != null && item.original_selling_price > item.unit_price;
    if (wasDiscounted) {
      doc.setFontSize(6);
      doc.setTextColor(140);
      doc.text(`(was ${money(item.original_selling_price!)})`, widthMm - marginX, y, { align: "right" });
      doc.setTextColor(0);
      y += 3.5;
    }
    y += 1.3;
  }

  doc.line(marginX, y, widthMm - marginX, y);
  y += 5;

  doc.setFontSize(8);
  doc.text("Subtotal", marginX, y);
  doc.text(money(sale.subtotal), widthMm - marginX, y, { align: "right" });
  y += 4.5;

  if (sale.discount > 0) {
    doc.text("Discounts & Coupons", marginX, y);
    doc.text(`-${money(sale.discount)}`, widthMm - marginX, y, { align: "right" });
    y += 4.5;
    if (sale.coupon_code) {
      doc.setFontSize(6.5);
      doc.text(`(${sale.coupon_code})`, marginX, y);
      doc.setFontSize(8);
      y += 4;
    }
  }

  doc.setFont("courier", "bold");
  doc.setFontSize(10);
  doc.text("TOTAL", marginX, y);
  doc.text(money(sale.total), widthMm - marginX, y, { align: "right" });
  y += 6;

  doc.setFont("courier", "normal");
  doc.setFontSize(7);
  doc.text(`Paid (${formatPaymentMethod(sale.payment_method)})`, marginX, y);
  doc.text(money(sale.amount_paid), widthMm - marginX, y, { align: "right" });
  y += 6;

  doc.line(marginX, y, widthMm - marginX, y);
  y += 5;

  doc.setFontSize(7);
  doc.text("Thank you for shopping with us!", widthMm / 2, y, { align: "center" });
  y += 4;
  doc.text("No returns without this receipt.", widthMm / 2, y, { align: "center" });

  return doc;
}

export function downloadThermalPdf(sale: Sale) {
  const doc = generateThermalPdf(sale);
  doc.save(`${sale.invoice}-receipt.pdf`);
}

// ---------------------------------------------------------------------
// WhatsApp text bill — a plain-text order summary opened in wa.me,
// pre-filled and ready to send to the customer's saved phone number.
// ---------------------------------------------------------------------
export function buildWhatsAppMessage(sale: Sale): string {
  const items = sale.items ?? [];
  const lines: string[] = [];

  lines.push(`*M&M Clothing — Receipt*`);
  lines.push(`Invoice: ${sale.invoice}`);
  lines.push(`Date: ${formatDate(sale.date)}`);
  const addr = sale.delivery_address;
  if (sale.sale_type === "online" && addr && (addr.address_line1 || addr.city)) {
    const addressParts = [addr.address_line1, addr.address_line2, addr.city].filter(Boolean);
    lines.push(`Deliver to: ${addressParts.join(", ")}`);
  }
  lines.push("");
  for (const item of items) {
    const detail = [item.size, item.color].filter(Boolean).join("/");
    const wasDiscounted = item.original_selling_price != null && item.original_selling_price > item.unit_price;
    const wasNote = wasDiscounted ? ` _(was ${money(item.original_selling_price!)})_` : "";
    lines.push(`${item.product_title ?? "Item"}${detail ? ` (${detail})` : ""} x${item.quantity} — ${money(item.line_total)}${wasNote}`);
  }
  lines.push("");
  lines.push(`Subtotal: ${money(sale.subtotal)}`);
  if (sale.discount > 0) {
    const couponNote = sale.coupon_code ? ` (${sale.coupon_code})` : "";
    lines.push(`Discounts & Coupons: -${money(sale.discount)}${couponNote}`);
  }
  lines.push(`*Total: ${money(sale.total)}*`);
  lines.push(`Paid: ${money(sale.amount_paid)} (${formatPaymentMethod(sale.payment_method)})`);
  lines.push("");
  lines.push("Thank you for shopping with us!");

  return lines.join("\n");
}

// Opens WhatsApp (web or app) with the bill pre-filled to the customer's
// saved phone number. Assumes a Sri Lankan local number and strips a
// leading 0 before prefixing the country code, matching the pattern
// already used for the WhatsApp icon on the Customers page.
export function sendWhatsAppBill(sale: Sale, phone: string) {
  const digitsOnly = phone.replace(/\D/g, "").replace(/^0/, "");
  const text = encodeURIComponent(buildWhatsAppMessage(sale));
  window.open(`https://wa.me/94${digitsOnly}?text=${text}`, "_blank");
}
