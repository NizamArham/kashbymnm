import jsPDF from "jspdf";
import { Delivery } from "./types";

// Standard shipping-waybill layout: sender/receiver blocks, a large
// waybill number, package/item summary, and a signature line. This is a
// placeholder layout following common courier waybill conventions —
// intended to be restyled later to match a specific design reference
// without changing the underlying generation logic or data flow.
export function generateWaybillPdf(delivery: Delivery): jsPDF {
  const doc = new jsPDF({ unit: "mm", format: "a5" });
  const pageWidth = 148;
  const marginX = 10;
  let y = 14;

  // Header
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("M&M Clothing", marginX, y);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text("Waybill", pageWidth - marginX, y, { align: "right" });
  y += 6;

  doc.setDrawColor(0);
  doc.setLineWidth(0.4);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 8;

  // Large waybill number — the primary scannable/reference identifier
  doc.setFont("courier", "bold");
  doc.setFontSize(18);
  doc.text(delivery.waybill_number ?? "—", pageWidth / 2, y, { align: "center" });
  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text(`Invoice: ${delivery.invoice ?? "—"}`, pageWidth / 2, y, { align: "center" });
  y += 8;

  doc.setDrawColor(200);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 7;

  // Receiver block
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(20);
  doc.text("DELIVER TO", marginX, y);
  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(delivery.customer_name ?? "—", marginX, y);
  y += 5;
  doc.setFontSize(9);
  doc.setTextColor(60);
  if (delivery.address_line1) {
    doc.text(delivery.address_line1, marginX, y);
    y += 4.5;
  }
  if (delivery.address_line2) {
    doc.text(delivery.address_line2, marginX, y);
    y += 4.5;
  }
  if (delivery.city) {
    doc.text(delivery.city, marginX, y);
    y += 4.5;
  }
  if (delivery.customer_phone) {
    doc.text(`Tel: ${delivery.customer_phone}`, marginX, y);
    y += 4.5;
  }
  y += 4;

  doc.setDrawColor(200);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 7;

  // Package summary
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(20);
  doc.text("PACKAGE", marginX, y);
  y += 5;

  const items = delivery.items ?? [];
  const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(60);
  doc.text(`${items.length} item type(s), ${totalQty} piece(s) total`, marginX, y);
  y += 5;
  doc.text(`Declared value: Rs. ${(delivery.sale_total ?? 0).toLocaleString()}`, marginX, y);
  y += 5;
  if (delivery.courier_name) {
    doc.text(`Courier: ${delivery.courier_name}`, marginX, y);
    y += 5;
  }
  y += 3;

  doc.setDrawColor(200);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 10;

  // Signature line
  doc.setFontSize(8);
  doc.setTextColor(150);
  doc.text("Received by: ______________________", marginX, y);
  doc.text("Date: ____________", pageWidth - marginX - 30, y);

  return doc;
}

export function downloadWaybillPdf(delivery: Delivery) {
  const doc = generateWaybillPdf(delivery);
  doc.save(`${delivery.waybill_number ?? delivery.invoice ?? "waybill"}.pdf`);
}
