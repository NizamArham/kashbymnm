import jsPDF from "jspdf";
import { Sale } from "./types";
import { NAME_LOGO_PNG_BASE64, NAME_LOGO_ASPECT_RATIO } from "./logoAsset";
import { barcodePng } from "./waybillLabelPdf";
import { DELIVERY_PARTNERS, waybillShopCode } from "./delivery";

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

// The A4 invoice states its currency once, in a footnote, rather than
// repeating "Rs." on every line — so most amounts print as plain
// numbers, and only a real "total" figure (the grand total, and the
// amount owed on a credit bill) carries an explicit LKR marker, since
// those are the numbers most likely to be read on their own.
function amountOnly(n: number): string {
  return `${n.toLocaleString()}/-`;
}

function amountLKR(n: number): string {
  return `LKR ${n.toLocaleString()}/-`;
}

// The shop's own account — shown on the invoice only when there's an
// actual credit balance to pay off, so a customer with an unpaid
// credit bill knows exactly where to send it without having to ask.
const SHOP_ACCOUNT_NAME = "M&M Clothing";
const SHOP_ACCOUNT_NUMBER = "028010029170";
const SHOP_BANK_NAME = "Hatton National Bank";

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

// "unpaid" -> "Unpaid", etc. — same reasoning as formatPaymentMethod:
// payment_status is a raw database value, not something to print as-is
// on a document a customer actually sees.
function formatStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

// Which "Shipping" line to print — matches how the sale actually left
// (or didn't leave) the shop. Just the courier's own name (or "Own
// Delivery" when no courier partner is set) — the actual address, when
// there is one, already gets its own line right below this.
function shippingLabel(sale: Sale): string {
  if (sale.sale_type !== "online") return "In-Store Pickup";
  const partner = DELIVERY_PARTNERS.find((p) => p.value === sale.delivery_partner);
  return partner ? partner.label : "Own Delivery";
}

// What to show as "Payment". A COD order's payment_method is stored as
// the method that WILL eventually collect it (usually "cash") even
// though nothing has actually been paid yet — printed as-is, that reads
// as a contradiction next to Status: Unpaid. Anything online that isn't
// fully paid is still awaiting COD collection, so it's shown as exactly
// that, with the same shop/courier code already used on the waybill
// (e.g. "MNM X CPAK") rather than a payment method that hasn't happened.
function paymentDisplay(sale: Sale): string {
  if (sale.sale_type === "online" && sale.payment_status !== "paid") {
    return `COD [${waybillShopCode(sale.delivery_partner)}]`;
  }
  return formatPaymentMethod(sale.payment_method);
}

// ---------------------------------------------------------------------
// A4 invoice PDF — barcode + wordmark up top, a stacked key/value
// summary, then a bordered item table and totals. Matches the shop's
// own preferred invoice layout (an existing manually-made design),
// redrawn with jsPDF's own primitives rather than a screenshot so the
// output stays crisp regardless of screen zoom or device pixel ratio.
// ---------------------------------------------------------------------
export function generateA4Pdf(sale: Sale): jsPDF {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = 210;
  const marginX = 18;
  const rightX = pageWidth - marginX;
  let y = 14;

  // A one-line summary right at the very top, styled like the footer
  // (small, gray, factual) rather than part of the main content — no
  // live "generated at" timestamp: re-downloading the same invoice
  // later would print a different one each time without the sale
  // itself having changed, and no date at all here since the Date row
  // below already covers that — just the customer's ID, their name,
  // and the invoice number, same stacking convention as the item
  // subline below (sku · size · color).
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(160);
  const billToName = sale.customer_name ?? (sale.deleted_customer_snapshot ? sale.deleted_customer_snapshot : "Walk-in");
  const headerParts = [sale.customer_code, billToName, sale.invoice].filter(Boolean);
  doc.text(headerParts.join("  ·  "), marginX, y);
  y += 10;

  // Header: barcode (encodes the invoice number) on the left, the
  // shop's own logo on the right — a real image, not a text wordmark.
  const barcode = barcodePng(sale.invoice);
  if (barcode) {
    const bcWidth = 55;
    const bcHeight = Math.min(14, bcWidth / barcode.aspect);
    doc.addImage(barcode.dataUrl, "PNG", marginX, y - 6, bcWidth, bcHeight, undefined, "FAST");
  }
  const logoWidth = 42;
  const logoHeight = logoWidth / NAME_LOGO_ASPECT_RATIO;
  doc.addImage(NAME_LOGO_PNG_BASE64, "PNG", rightX - logoWidth, y - 8, logoWidth, logoHeight, undefined, "SLOW");
  y += 20;

  // Key/value summary — one shared value column wide enough for the
  // longest label ("Bill To"), so every value lines up regardless of
  // how short its own label is.
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

  kvRow("Status", (x, yy) => doc.text(formatStatus(sale.payment_status), x, yy));
  kvRow("Payment", (x, yy) => doc.text(paymentDisplay(sale), x, yy));
  kvRow("Invoice", (x, yy) => doc.text(sale.invoice, x, yy));
  kvRow("Date", (x, yy) => doc.text(formatDate(sale.date), x, yy));
  kvRow("Bill To", (x, yy) => {
    const name = sale.customer_name ?? (sale.deleted_customer_snapshot ? sale.deleted_customer_snapshot : "Walk-in");
    doc.text(name, x, yy);
    if (sale.customer_phone) {
      doc.setFont("helvetica", "italic");
      doc.text(sale.customer_phone, x + doc.getTextWidth(name) + 3, yy);
      doc.setFont("helvetica", "normal");
    }
  });
  kvRow("Shipping", (x, yy) => doc.text(shippingLabel(sale), x, yy));

  const addr = sale.delivery_address;
  const hasAddress = addr && (addr.address_line1 || addr.city);
  if (sale.sale_type === "online" && hasAddress) {
    const addressParts = [addr!.address_line1, addr!.address_line2, addr!.city].filter(Boolean);
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(addressParts.join(", "), valueX, y);
    doc.setFontSize(12);
    y += 5.8;
  }

  y += 6;

  // Item table — back to the plain hairline style: a rule under the
  // header, then a single hairline under each item, no box, no grid.
  // Each row uses the same top padding before its title, and the
  // divider is drawn exactly at the row's own boundary (not offset a
  // few mm short of it) — so the gap from one item's content down to
  // the line is the same as the gap from that line down to the next
  // item's title, instead of the line sitting flush against whatever
  // comes after it. Customer-facing content only: no SKU, no row
  // numbers — those are internal stock-tracking details.
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(140);
  doc.text("ITEM", marginX + 2, y);
  doc.text("QTY", rightX - 55, y, { align: "right" });
  doc.text("UNIT PRICE", rightX - 30, y, { align: "right" });
  doc.text("LINE TOTAL", rightX, y, { align: "right" });
  y += 3;
  doc.setDrawColor(190);
  doc.setLineWidth(0.3);
  doc.line(marginX, y, rightX, y);

  const items = sale.items ?? [];
  // Main line (name, qty, price, total) at 10.5pt, the color/size
  // subline at 9pt — bigger than before on both, but the same 1.5pt
  // gap between them, so the subline stays clearly secondary rather
  // than competing with the name.
  const rowHeight = 17.5;
  const topPadding = 6.5;
  const sublineGap = 4.5;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (y + rowHeight > 275) {
      doc.addPage();
      y = 20;
    }

    const textY = y + topPadding;
    doc.setFontSize(10.5);
    doc.setTextColor(20);
    doc.text(item.product_title ?? "Item", marginX + 2, textY);

    doc.setFontSize(9);
    doc.setTextColor(150);
    const colorSize = [item.color, item.size].filter(Boolean).join(" · ");
    doc.text(colorSize, marginX + 2, textY + sublineGap);

    doc.setFontSize(10.5);
    doc.setTextColor(90);
    doc.text(String(item.quantity), rightX - 55, textY, { align: "right" });

    // Unit price always the same weight and color whether or not this
    // row is discounted — a column should read as one rhythm top to
    // bottom, not switch between bold and plain row by row. The struck
    // original, when there is one, sits below it — level with the
    // color/size line, safely inside this row's own top padding.
    const wasDiscounted = item.original_selling_price != null && item.original_selling_price > item.unit_price;
    const priceX = rightX - 30;
    doc.setFontSize(10.5);
    doc.setTextColor(20);
    doc.text(amountOnly(item.unit_price), priceX, textY, { align: "right" });

    if (wasDiscounted) {
      doc.setFontSize(9);
      doc.setTextColor(150);
      const originalText = amountOnly(item.original_selling_price!);
      doc.text(originalText, priceX, textY + sublineGap, { align: "right" });
      const textWidth = doc.getTextWidth(originalText);
      doc.setDrawColor(150);
      doc.setLineWidth(0.2);
      doc.line(priceX - textWidth, textY + sublineGap - 0.8, priceX, textY + sublineGap - 0.8);
    }

    doc.setFontSize(10.5);
    doc.setTextColor(0);
    doc.text(amountOnly(item.line_total), rightX, textY, { align: "right" });

    y += rowHeight;
    doc.setDrawColor(230);
    doc.setLineWidth(0.2);
    doc.line(marginX, y, rightX, y);
  }

  // What buying at today's marked-down price actually saved them,
  // summed across every discounted line — shown once, near the end of
  // the totals, as a closing "here's what you got" rather than buried
  // per-line where it's easy to skim past.
  const totalSavings = items.reduce((sum, it) => {
    if (it.original_selling_price != null && it.original_selling_price > it.unit_price) {
      return sum + (it.original_selling_price - it.unit_price) * it.quantity;
    }
    return sum;
  }, 0);

  y += 4;
  // The totals block (and, below it, a possible Pay Here block) has a
  // variable height depending on discounts/coupons/savings/loyalty
  // points — with enough items already pushing y close to the page
  // bottom, this guards against either one running into the fixed
  // footer position.
  if (y + 46 > 270) {
    doc.addPage();
    y = 20;
  }
  // No rule opening this block — the last item's own hairline already
  // closes the table off; a second line right under it just doubled up.
  const totalsX = rightX - 60;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(90);
  y += 6;
  doc.text("Subtotal", totalsX, y);
  doc.text(amountOnly(sale.subtotal), rightX, y, { align: "right" });
  y += 6;

  if (sale.discount > 0) {
    doc.text("Discounts & Coupons", totalsX, y);
    doc.text(`- ${amountOnly(sale.discount)}`, rightX, y, { align: "right" });
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
  doc.line(totalsX, y, rightX, y);
  y += 6.5;
  // Total kept at the same weight as everything above it — the rule
  // and its position already mark it as the total — except the amount
  // itself, sized up a couple points so the one number that matters
  // most still stands out without going back to bold.
  doc.setFontSize(10);
  doc.setTextColor(20);
  doc.text("Total", totalsX, y);
  doc.setFontSize(12);
  doc.text(amountLKR(sale.total), rightX, y, { align: "right" });
  doc.setFontSize(10);

  if (totalSavings > 0) {
    y += 6;
    doc.setFontSize(9.5);
    doc.setTextColor(90);
    doc.text("Inline Discount", totalsX, y);
    doc.text(amountOnly(totalSavings), rightX, y, { align: "right" });
  }

  // Only a real loyalty customer earns points on a sale — a walk-in or
  // guest checkout leaves this at 0, so the line simply doesn't print.
  if (sale.loyalty_points_earned > 0) {
    y += 6;
    doc.setFontSize(9.5);
    doc.setTextColor(90);
    doc.text("Loyalty Points", totalsX, y);
    doc.text(`+${sale.loyalty_points_earned.toLocaleString()}pts`, rightX, y, { align: "right" });
  }
  // Once the right-side summary is done, a plain recap in the same
  // key/value style as the header (Status, Payment, Bill To) — left
  // aligned, not a second right-aligned column — closes the invoice
  // out. "Pay Here" only for an actual credit sale with a real
  // balance still owed — not a COD order (collected by the courier,
  // not bank transfer) and not anything already settled.
  const amountOwed = sale.total - sale.amount_paid;
  const needsPayHere = sale.payment_method === "credit" && sale.payment_status !== "paid" && amountOwed > 0;
  // Needs about 30mm for Total alone, or 42mm with Pay Here — start a
  // fresh page rather than let it run into the footer.
  if (y + (needsPayHere ? 42 : 30) > 270) {
    doc.addPage();
    y = 20;
  }
  y += 10;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  kvRow("Total", (x, yy) => doc.text(`${sale.total.toLocaleString()}LKR`, x, yy));

  if (needsPayHere) {
    kvRow("Pay Here", (x, yy) => doc.text(SHOP_ACCOUNT_NAME, x, yy));
    doc.setTextColor(20);
    doc.text(SHOP_ACCOUNT_NUMBER, valueX, y);
    y += 5.8;
    doc.text(SHOP_BANK_NAME, valueX, y);
    y += 5.8;
  }

  y += 4;
  doc.setFont("helvetica", "italic");
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text("Thank you for shopping with M&M Clothing!", marginX, y);
  doc.setFont("helvetica", "normal");

  // Footer — stamped on every page (not just the last), since a
  // multi-item order can spill onto a second page. "Page X of N"
  // replaces the invoice number here — that's already on every page
  // via the barcode/header, so repeating it in the footer was just
  // noise; the page count is the thing that actually changes per page.
  const footerY = 285;
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(160);
    doc.text(`Cashier: ${sale.salesperson ?? "—"}`, marginX, footerY);
    doc.text("System generated — no signature required", pageWidth / 2, footerY, { align: "center" });
    doc.text(`Page ${p} of ${totalPages}`, rightX, footerY, { align: "right" });
  }

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
  const estimatedHeight = 60 + (hasAddress ? 8 : 0) + items.length * 10 + 40;

  const doc = new jsPDF({ unit: "mm", format: [widthMm, estimatedHeight] });
  let y = 8;

  const logoWidth = 40;
  const logoHeight = logoWidth / NAME_LOGO_ASPECT_RATIO;
  doc.addImage(NAME_LOGO_PNG_BASE64, "PNG", (widthMm - logoWidth) / 2, y, logoWidth, logoHeight, undefined, "SLOW");
  y += logoHeight + 3;
  doc.setFont("courier", "normal");
  doc.setFontSize(7.5);
  doc.text("POS Receipt", widthMm / 2, y, { align: "center" });
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
