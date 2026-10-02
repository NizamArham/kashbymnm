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

// Every size below is written at an enlarged value and multiplied by
// this. generateWaybillLabelPdf picks the biggest scale, up to MAX_SCALE,
// at which the whole label still fits the page — so an ordinary order
// prints at a comfortable, easy-to-read size, while one with a long
// address, description and return block shrinks only as far as it must
// (never below MIN_SCALE) instead of running off the bottom edge.
// MAX_SCALE 0.9 puts the text roughly 8% above the label's original
// size (and the logo about 40% bigger) — the full 1.0 read as too big.
const MAX_SCALE = 0.9;
const MIN_SCALE = 0.7;
let SCALE = 1;
const fs = (size: number) => size * SCALE;

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
  doc.setFontSize(fs(16));
  const headerText = `[ ${data.shopCode || "SHOP CODE"} ]`;
  const headerDims = doc.getTextDimensions(headerText);
  if (draw) {
    doc.text(headerText, MARGIN, startY + y + headerDims.h * 0.78);
    doc.setFont("helvetica", "bolditalic");
    doc.setFontSize(fs(16));
    doc.text(data.date, RIGHT_X, startY + y + headerDims.h * 0.78, { align: "right" });
  }
  y += headerDims.h + 2;

  if (draw) divider(doc, startY + y);
  y += 4;

  const deliverTagH = draw ? blackTag(doc, "DELIVER [ TO ]", MARGIN, startY + y, fs(11.5)) : (() => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(fs(11.5));
    return doc.getTextDimensions("DELIVER [ TO ]").h + TAG_PAD_Y * 2;
  })();
  y += deliverTagH + 3;

  // Name/address/phone bumped up a size from before — the printed label
  // was reading noticeably smaller than the on-screen preview suggested.
  // The label's own layout budget is already tight (a long 3-line
  // address plus the return-address footer can nearly fill the page),
  // so the small fixed gaps around these lines (not the text itself)
  // are trimmed slightly to make room, rather than touching line
  // spacing that actually helps legibility.
  doc.setFont("helvetica", "bold");
  doc.setFontSize(fs(17));
  const nameDims = doc.getTextDimensions(data.customerName || "Customer Name");
  if (draw) doc.text(data.customerName || "Customer Name", MARGIN, startY + y + nameDims.h * 0.78);
  y += nameDims.h + 0.4;

  const addressJoined = data.addressLines.filter(Boolean).join(", ") || "Address line 1";
  const addressText = `${addressJoined},`;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(fs(12));
  const addressLines: string[] = doc.splitTextToSize(addressText, CONTENT_W).slice(0, 3);
  const addressLineBase = doc.getTextDimensions("Mg").h;
  const addressLineSpacing = addressLineBase * 1.3;
  for (const line of addressLines) {
    if (draw) doc.text(line, MARGIN, startY + y + addressLineBase * 0.78);
    y += addressLineSpacing;
  }
  y += 0.5;

  const cityLine = data.city ? (data.cityPostalCode ? `${data.city} [${data.cityPostalCode}].` : `${data.city}.`) : "City";
  doc.setFontSize(fs(12));
  const cityDims = doc.getTextDimensions(cityLine);
  if (draw) doc.text(cityLine, MARGIN, startY + y + cityDims.h * 0.78);
  y += cityDims.h + 1.0;

  const phonesText = data.phones.filter(Boolean).join(" / ") || "Telephone Number";
  doc.setFontSize(fs(11.5));
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
  doc.setFontSize(fs(11.5));
  const headingDims = doc.getTextDimensions("DELIVERY INSTRUCTION");
  const rowH = headingDims.h;
  if (draw) {
    doc.text("DELIVERY INSTRUCTION", MARGIN, startY + y + rowH * 0.78);
    if (data.paymentType === "COD" && data.codAmount > 0) {
      const codText = `${Math.round(data.codAmount).toLocaleString("en-US")} LKR`;
      blackTag(doc, codText, RIGHT_X, startY + y - 1, fs(13), "right");
    }
  }
  y += rowH + 3.3;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(fs(11.5));
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
  doc.setFontSize(fs(10));
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
  doc.setFontSize(fs(12.5));
  const trackingDims = doc.getTextDimensions(data.trackingNumber || "Tracking No:");
  if (draw) doc.text(data.trackingNumber || "Tracking No:", PAGE_W / 2, startY + y + trackingDims.h * 0.78, { align: "center" });
  y += trackingDims.h + 2.5;

  if (draw) divider(doc, startY + y);
  y += 4;

  const logoWidth = 34 * SCALE;
  const logoHeight = logoWidth / NAME_LOGO_ASPECT_RATIO;
  const returnTagH = draw ? blackTag(doc, "In case of non-delivery, [ Return ]", MARGIN, startY + y, fs(11)) : (() => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(fs(11));
    return doc.getTextDimensions("In case of non-delivery, [ Return ]").h + TAG_PAD_Y * 2;
  })();
  const returnBlockTop = y;
  y += returnTagH + 2.5;

  const returnTextMaxWidth = CONTENT_W - logoWidth - 3;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(fs(11));
  const bizDims = doc.getTextDimensions(data.returnBusinessName || "M&M Clothing");
  if (draw) doc.text(data.returnBusinessName || "M&M Clothing", MARGIN, startY + y + bizDims.h * 0.78);
  y += bizDims.h + 1.2;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(fs(9.5));
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

  const usableHeight = PAGE_H - MARGIN * 2;
  const baseGap = 3.7; // minimum breathing room between groups even when content is near the page limit

  // Largest scale at which the three groups plus their minimum gaps fit.
  let topHeight = 0;
  let middleHeight = 0;
  let bottomHeight = 0;
  for (SCALE = MAX_SCALE; ; SCALE = Math.round((SCALE - 0.02) * 100) / 100) {
    topHeight = layoutTopGroup(doc, data, 0, false);
    middleHeight = layoutMiddleGroup(doc, data, 0, false);
    bottomHeight = layoutBottomGroup(doc, data, 0, false);
    if (topHeight + middleHeight + bottomHeight + baseGap * 2 <= usableHeight || SCALE <= MIN_SCALE) break;
  }

  const fixedContent = topHeight + middleHeight + bottomHeight;
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
