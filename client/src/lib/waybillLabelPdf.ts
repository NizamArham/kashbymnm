import jsPDF from "jspdf";
import JsBarcode from "jsbarcode";
import { NAME_LOGO_PNG_BASE64, NAME_LOGO_ASPECT_RATIO } from "./logoAsset";
import { WaybillLabelData } from "../components/WaybillLabel";

// Renders the A6 waybill label by drawing directly into the PDF with
// jsPDF's own text/shape primitives, instead of screenshotting the live
// DOM with html2canvas. html2canvas rasterizes through the browser's own
// rendering engine, and that rendered corrupted (ghosted, overlapping)
// text specifically in Safari for this label while looking fine in
// Chromium — a browser-dependent bug that's very hard to chase down
// piecemeal. It also meant embedding one full-page raster screenshot per
// label (several MB at a print-quality scale). Drawing with jsPDF's own
// vector font engine sidesteps both problems: identical, tiny output
// regardless of which browser generated it — just text, rules, and two
// small bitmaps (the barcode and the logo).
const PAGE_W = 105;
const PAGE_H = 148;
const MARGIN = 5;
const CONTENT_W = PAGE_W - MARGIN * 2;
const RIGHT_X = PAGE_W - MARGIN;
const TAG_PAD_X = 1.6;
const TAG_PAD_Y = 1.1;

function divider(doc: jsPDF, y: number) {
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, y, RIGHT_X, y);
}

// A black filled tag sized to fit its text exactly (not a fixed-width
// bar). Returns its height so the caller can advance past it.
function blackTag(doc: jsPDF, text: string, x: number, y: number, fontSize: number, align: "left" | "right" = "left"): number {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(fontSize);
  const dims = doc.getTextDimensions(text);
  const width = dims.w + TAG_PAD_X * 2;
  const height = dims.h + TAG_PAD_Y * 2;
  const drawX = align === "right" ? x - width : x;
  doc.setFillColor(0, 0, 0);
  doc.rect(drawX, y, width, height, "F");
  doc.setTextColor(255, 255, 255);
  doc.text(text, drawX + TAG_PAD_X, y + TAG_PAD_Y + dims.h * 0.78);
  doc.setTextColor(0, 0, 0);
  return height;
}

export function barcodePng(value: string): { dataUrl: string; aspect: number } | null {
  try {
    const canvas = document.createElement("canvas");
    JsBarcode(canvas, value, { format: "CODE128", width: 2, height: 110, displayValue: false, margin: 0 });
    return { dataUrl: canvas.toDataURL("image/png"), aspect: canvas.width / canvas.height };
  } catch {
    // an invalid tracking number for CODE128 just leaves the barcode
    // blank rather than blocking the person over it
    return null;
  }
}

// Each group below is written as a single measure-then-draw pass: with
// `draw: false` it only walks through the font metrics to total up the
// height it needs; with `draw: true` (and a real `startY`) it performs
// the exact same walk but actually paints. Measuring first lets the
// three groups' real heights be known before any of them are placed, so
// the leftover vertical space can be split evenly between them —
// filling the label the way the DOM/flexbox version used to, instead of
// leaving dead space at the bottom for anything shorter than the
// longest possible content.

function layoutTopGroup(doc: jsPDF, data: WaybillLabelData, startY: number, draw: boolean): number {
  let y = 0;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  const headerText = `[ ${data.shopCode || "SHOP CODE"} ]`;
  const headerDims = doc.getTextDimensions(headerText);
  if (draw) {
    doc.text(headerText, MARGIN, startY + y + headerDims.h * 0.78);
    doc.setFont("helvetica", "bolditalic");
    doc.setFontSize(14);
    doc.text(data.date, RIGHT_X, startY + y + headerDims.h * 0.78, { align: "right" });
  }
  y += headerDims.h + 2;

  if (draw) divider(doc, startY + y);
  y += 4;

  const deliverTagH = draw ? blackTag(doc, "DELIVER [ TO ]", MARGIN, startY + y, 10) : (() => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    return doc.getTextDimensions("DELIVER [ TO ]").h + TAG_PAD_Y * 2;
  })();
  y += deliverTagH + 3;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  const nameDims = doc.getTextDimensions(data.customerName || "Customer Name");
  if (draw) doc.text(data.customerName || "Customer Name", MARGIN, startY + y + nameDims.h * 0.78);
  y += nameDims.h + 0.6;

  const addressJoined = data.addressLines.filter(Boolean).join(", ") || "Address line 1";
  const addressText = `${addressJoined},`;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  const addressLines: string[] = doc.splitTextToSize(addressText, CONTENT_W).slice(0, 3);
  const addressLineBase = doc.getTextDimensions("Mg").h;
  const addressLineSpacing = addressLineBase * 1.3;
  for (const line of addressLines) {
    if (draw) doc.text(line, MARGIN, startY + y + addressLineBase * 0.78);
    y += addressLineSpacing;
  }
  y += 0.8;

  const cityLine = data.city ? (data.cityPostalCode ? `${data.city} [${data.cityPostalCode}].` : `${data.city}.`) : "City";
  doc.setFontSize(9.5);
  const cityDims = doc.getTextDimensions(cityLine);
  if (draw) doc.text(cityLine, MARGIN, startY + y + cityDims.h * 0.78);
  y += cityDims.h + 1.3;

  const phonesText = data.phones.filter(Boolean).join(" / ") || "Telephone Number";
  doc.setFontSize(8.5);
  const phoneDims = doc.getTextDimensions(phonesText);
  if (draw) doc.text(phonesText, MARGIN, startY + y + phoneDims.h * 0.78);
  y += phoneDims.h;

  return y;
}

function layoutMiddleGroup(doc: jsPDF, data: WaybillLabelData, startY: number, draw: boolean): number {
  let y = 0;
  if (draw) divider(doc, startY + y);
  y += 4.5;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  const headingDims = doc.getTextDimensions("DELIVERY INSTRUCTION");
  const rowH = headingDims.h;
  if (draw) {
    doc.text("DELIVERY INSTRUCTION", MARGIN, startY + y + rowH * 0.78);
    if (data.paymentType === "COD" && data.codAmount > 0) {
      const codText = `${Math.round(data.codAmount).toLocaleString("en-US")} LKR`;
      blackTag(doc, codText, RIGHT_X, startY + y - 1, 11, "right");
    }
  }
  y += rowH + 3.3;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  const refText = `Ref: ${data.orderRef || "—"}`;
  const refDims = doc.getTextDimensions(refText);
  if (draw) {
    doc.text(refText, MARGIN, startY + y + refDims.h * 0.78);

    doc.setFont("helvetica", "bold");
    const weightText = data.weight ? `${data.weight} Kg` : "0.0 Kg";
    doc.text(weightText, RIGHT_X, startY + y + refDims.h * 0.78, { align: "right" });

    // The center "1 of N pcs" label only fits if it clears both
    // neighbors — an unusually long order ref shouldn't run into it.
    doc.setFont("helvetica", "normal");
    const pcsText = `1 of ${data.pcs || 1} pcs`;
    const pcsDims = doc.getTextDimensions(pcsText);
    const pcsLeft = PAGE_W / 2 - pcsDims.w / 2;
    const pcsRight = PAGE_W / 2 + pcsDims.w / 2;
    const weightDims = doc.getTextDimensions(weightText);
    const clearOfRef = pcsLeft > MARGIN + refDims.w + 3;
    const clearOfWeight = pcsRight < RIGHT_X - weightDims.w - 3;
    if (clearOfRef && clearOfWeight) {
      doc.text(pcsText, PAGE_W / 2, startY + y + refDims.h * 0.78, { align: "center" });
    }
  }
  y += refDims.h + 2.8;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  const descLines: string[] = doc.splitTextToSize(data.description || "—", CONTENT_W).slice(0, 2);
  const descLineH = doc.getTextDimensions("Mg").h;
  for (const line of descLines) {
    if (draw) doc.text(line, MARGIN, startY + y + descLineH * 0.78);
    y += descLineH;
  }

  return y;
}

function layoutBottomGroup(doc: jsPDF, data: WaybillLabelData, startY: number, draw: boolean): number {
  let y = 0;
  if (draw) divider(doc, startY + y);
  y += 5;

  const barcode = data.trackingNumber ? barcodePng(data.trackingNumber) : null;
  const bcWidth = 60;
  const bcHeight = barcode ? Math.min(15, bcWidth / barcode.aspect) : 15;
  if (draw && barcode) {
    doc.addImage(barcode.dataUrl, "PNG", (PAGE_W - bcWidth) / 2, startY + y, bcWidth, bcHeight, undefined, "FAST");
  }
  y += bcHeight + 2.5;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  const trackingDims = doc.getTextDimensions(data.trackingNumber || "Tracking No:");
  if (draw) doc.text(data.trackingNumber || "Tracking No:", PAGE_W / 2, startY + y + trackingDims.h * 0.78, { align: "center" });
  y += trackingDims.h + 3;

  if (draw) divider(doc, startY + y);
  y += 4.5;

  const logoWidth = 22;
  const logoHeight = logoWidth / NAME_LOGO_ASPECT_RATIO;
  const returnTagH = draw ? blackTag(doc, "In case of non-delivery, [ Return ]", MARGIN, startY + y, 10) : (() => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    return doc.getTextDimensions("In case of non-delivery, [ Return ]").h + TAG_PAD_Y * 2;
  })();
  const returnBlockTop = y;
  y += returnTagH + 2.5;

  const returnTextMaxWidth = CONTENT_W - logoWidth - 3;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  const bizDims = doc.getTextDimensions(data.returnBusinessName || "M&M Clothing");
  if (draw) doc.text(data.returnBusinessName || "M&M Clothing", MARGIN, startY + y + bizDims.h * 0.78);
  y += bizDims.h + 1.2;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  const returnLineH = doc.getTextDimensions("Mg").h;
  const returnLines = [
    ...data.returnAddressLines.filter(Boolean),
    [data.returnPhone].filter(Boolean).join(" / "),
    data.returnWebsite,
  ].filter(Boolean) as string[];
  for (const line of returnLines) {
    const wrapped: string[] = doc.splitTextToSize(line, returnTextMaxWidth);
    for (const sub of wrapped) {
      if (draw) doc.text(sub, MARGIN, startY + y + returnLineH * 0.78);
      y += returnLineH;
    }
  }

  if (draw) {
    // Vertically center the logo alongside the return text block.
    const textBlockHeight = y - returnBlockTop - returnTagH - 2.5;
    const logoY = startY + returnBlockTop + returnTagH + 2.5 + Math.max(0, (textBlockHeight - logoHeight) / 2);
    doc.addImage(NAME_LOGO_PNG_BASE64, "PNG", RIGHT_X - logoWidth, logoY, logoWidth, logoHeight, undefined, "FAST");
  }

  return y;
}

export function generateWaybillLabelPdf(data: WaybillLabelData): jsPDF {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: [PAGE_W, PAGE_H], compress: true });
  doc.setTextColor(0, 0, 0);

  const topHeight = layoutTopGroup(doc, data, 0, false);
  const middleHeight = layoutMiddleGroup(doc, data, 0, false);
  const bottomHeight = layoutBottomGroup(doc, data, 0, false);

  const usableHeight = PAGE_H - MARGIN * 2;
  const fixedContent = topHeight + middleHeight + bottomHeight;
  const baseGap = 4; // minimum breathing room between groups even when content is near the page limit
  const extraGap = Math.max(0, (usableHeight - fixedContent - baseGap * 2) / 2);
  const gap = baseGap + extraGap;

  const topStart = MARGIN;
  const middleStart = topStart + topHeight + gap;
  const bottomStart = middleStart + middleHeight + gap;

  layoutTopGroup(doc, data, topStart, true);
  layoutMiddleGroup(doc, data, middleStart, true);
  layoutBottomGroup(doc, data, bottomStart, true);

  return doc;
}
