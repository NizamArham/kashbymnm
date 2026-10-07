import jsPDF from "jspdf";
import JsBarcode from "jsbarcode";
import { NAME_LOGO_PNG_BASE64, NAME_LOGO_ASPECT_RATIO } from "./logoAsset";
import { WaybillLabelData } from "../components/WaybillLabel";
import { SaleExchange } from "./types";

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

  // An order that needs no address (Uber / PickMe) leaves these lines
  // empty rather than printing the blank template's placeholders.
  const addressJoined = data.addressLines.filter(Boolean).join(", ") || (data.addressNotNeeded ? "" : "Address line 1");
  const addressText = addressJoined ? `${addressJoined},` : "";
  doc.setFont("helvetica", "normal");
  doc.setFontSize(fs(12));
  const addressLines: string[] = addressText ? doc.splitTextToSize(addressText, CONTENT_W).slice(0, 3) : [];
  const addressLineBase = doc.getTextDimensions("Mg").h;
  const addressLineSpacing = addressLineBase * 1.3;
  for (const line of addressLines) {
    if (draw) doc.text(line, MARGIN, startY + y + addressLineBase * 0.78);
    y += addressLineSpacing;
  }
  y += 0.5;

  const cityLine = data.city ? (data.cityPostalCode ? `${data.city} [${data.cityPostalCode}].` : `${data.city}.`) : data.addressNotNeeded ? "" : "City";
  doc.setFontSize(fs(12));
  if (cityLine) {
    const cityDims = doc.getTextDimensions(cityLine);
    if (draw) doc.text(cityLine, MARGIN, startY + y + cityDims.h * 0.78);
    y += cityDims.h + 1.0;
  }

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

// Draws one A6 waybill label onto the doc's current page.
function drawWaybillLabel(doc: jsPDF, data: WaybillLabelData) {
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
}

export function generateWaybillLabelPdf(data: WaybillLabelData): jsPDF {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: [PAGE_W, PAGE_H], compress: true });
  drawWaybillLabel(doc, data);
  return doc;
}

// ---------------------------------------------------------------------------
// Exchange orders print THREE labels in one go (one A6 page each):
//   1. the ordinary waybill — pasted on the parcel going out
//   2. a delivery note — tells the delivery person to collect the return package
//      while delivering this one
//   3. the return waybill — goes in the same bag as the delivery note; the customer
//      sticks it on the return package and hands that over at the same visit
// The delivery note has NO barcode on purpose: it travels with the parcel, and a courier
// who scanned it instead of the waybill would add a status to the wrong thing. The
// return waybill carries the SAME waybill number as the parcel (an exchange parcel is one
// waybill at the courier — there is no second number).
// ---------------------------------------------------------------------------

export interface ExchangeReturnItem {
  title: string;
  variant: string; // "XS, Black" — may be empty
  invoice: string; // the invoice the item came from
}

// The old items the courier is to bring back, for an exchange that is still waiting
// for them; null for an ordinary order (or an exchange that's already settled).
export function returnItemsOf(exchange: SaleExchange | null | undefined): ExchangeReturnItem[] | null {
  if (!exchange || exchange.status !== "awaiting_pickup") return null;
  const items = exchange.items
    .filter((i) => i.status === "awaiting")
    .map((i) => ({ title: i.title ?? "Item", variant: [i.size, i.color].filter(Boolean).join(", "), invoice: i.old_invoice }));
  return items.length ? items : null;
}

interface TextOpts {
  x?: number;
  size: number;
  style?: "normal" | "bold" | "italic" | "bolditalic";
  align?: "left" | "center" | "right";
  maxWidth?: number;
  maxLines?: number;
  lineSpacing?: number;
}

// One block of text: measures it and, when `draw` is set, paints it at y. Returns the
// height used, so a layout is just a list of these with gaps — the same
// measure-then-draw idea as the groups above, so the page can be fitted by scaling.
function textBlock(doc: jsPDF, draw: boolean, y: number, text: string, o: TextOpts): number {
  doc.setFont("helvetica", o.style ?? "normal");
  doc.setFontSize(fs(o.size));
  const lines: string[] = o.maxWidth ? doc.splitTextToSize(text, o.maxWidth).slice(0, o.maxLines ?? 99) : [text];
  const base = doc.getTextDimensions("Mg").h;
  const step = base * (o.lineSpacing ?? 1.25);
  const align = o.align ?? "left";
  const x = o.x ?? (align === "center" ? PAGE_W / 2 : align === "right" ? RIGHT_X : MARGIN);
  if (draw) lines.forEach((line, i) => doc.text(line, x, y + i * step + base * 0.78, { align }));
  return lines.length ? base + (lines.length - 1) * step : 0;
}

function drawFitted(doc: jsPDF, layout: (startY: number, draw: boolean) => number) {
  const usable = PAGE_H - MARGIN * 2;
  for (SCALE = 1; ; SCALE = Math.round((SCALE - 0.02) * 100) / 100) {
    if (layout(0, false) <= usable || SCALE <= 0.6) break;
  }
  doc.setTextColor(0, 0, 0);
  layout(MARGIN, true);
}

// The header line every label starts with: shop code on the left, date on the right,
// then a rule.
function labelHeader(doc: jsPDF, draw: boolean, y: number, left: string, date: string): number {
  const h = textBlock(doc, draw, y, left, { size: 14, style: "bold" });
  if (draw) textBlock(doc, true, y, date, { size: 14, style: "bolditalic", align: "right" });
  if (draw) divider(doc, y + h + 2);
  return h + 2 + 4;
}

const MAX_LISTED = 4;

// 2/3 — the delivery note for the courier's rider. Deliberately plain: type, fine rules
// and one outlined box (no fills, no barcode), so the instruction is the thing you see.
function layoutCollectNote(doc: jsPDF, data: WaybillLabelData, items: ExchangeReturnItem[], startY: number, draw: boolean): number {
  let y = 0;
  const at = () => startY + y;
  const label = (text: string) => textBlock(doc, draw, at(), text, { size: 8.5, style: "bold" }) + 1.8;
  // A fine rule between sections, with the same air above and below every time.
  const section = () => {
    y += 4;
    if (draw) {
      doc.setDrawColor(0, 0, 0);
      doc.setLineWidth(0.2);
      doc.line(MARGIN, at(), RIGHT_X, at());
    }
    y += 4;
  };

  // Title, with the date at the right on the same line; a firm rule under it.
  const titleH = textBlock(doc, draw, at(), "DELIVERY NOTE", { size: 21, style: "bold" });
  if (draw) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(fs(10.5));
    const dateH = doc.getTextDimensions("Mg").h;
    textBlock(doc, true, at() + titleH - dateH, data.date, { size: 10.5, align: "right" });
  }
  y += titleH + 2.5;
  if (draw) divider(doc, at());
  y += 6;

  // The instruction, boxed — the one thing the rider must do.
  const boxTop = y;
  y += 3.5;
  const padX = 3.5;
  y += textBlock(doc, draw, at(), "INSTRUCTION", { size: 8.5, style: "bold", x: MARGIN + padX }) + 1.8;
  y += textBlock(doc, draw, at(), "Collect the return package when you deliver this parcel.", { size: 14, style: "bold", x: MARGIN + padX, maxWidth: CONTENT_W - padX * 2, maxLines: 3 }) + 2.5;
  y += textBlock(
    doc,
    draw,
    at(),
    "The return waybill is in the same bag as this note. The customer sticks it on the return package and hands it to you at the same time.",
    { size: 9.5, x: MARGIN + padX, maxWidth: CONTENT_W - padX * 2, maxLines: 4 }
  );
  y += 3.5;
  if (draw) {
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.4);
    doc.rect(MARGIN, startY + boxTop, CONTENT_W, y - boxTop);
  }
  y += 6;

  y += label("TO COLLECT");
  for (const i of items.slice(0, MAX_LISTED)) {
    y += textBlock(doc, draw, at(), `${i.title}${i.variant ? ` (${i.variant})` : ""}`, { size: 11.5, maxWidth: CONTENT_W, maxLines: 2 }) + 1.4;
  }
  if (items.length > MAX_LISTED) y += textBlock(doc, draw, at(), `+ ${items.length - MAX_LISTED} more`, { size: 11.5, style: "italic" }) + 1.4;

  section();
  y += label("CUSTOMER");
  y += textBlock(doc, draw, at(), data.customerName || "Customer", { size: 13, style: "bold", maxWidth: CONTENT_W, maxLines: 1 }) + 0.8;
  const addr = [data.addressLines.filter(Boolean).join(", "), data.city].filter(Boolean).join(", ");
  if (addr) y += textBlock(doc, draw, at(), addr, { size: 10.5, maxWidth: CONTENT_W, maxLines: 2 }) + 0.8;
  const phones = data.phones.filter(Boolean).join(" / ");
  if (phones) y += textBlock(doc, draw, at(), phones, { size: 10.5 }) + 0.8;

  if (data.paymentType === "COD" && data.codAmount > 0) {
    section();
    // Label at the left, the amount at the right, sharing one baseline.
    const amount = `${Math.round(data.codAmount).toLocaleString("en-US")} LKR`;
    const amountH = textBlock(doc, draw, at(), amount, { size: 20, style: "bold", align: "right" });
    doc.setFont("helvetica", "bold");
    doc.setFontSize(fs(8.5));
    const labelH = doc.getTextDimensions("Mg").h;
    if (draw) textBlock(doc, true, at() + amountH - labelH, "COD TO COLLECT", { size: 8.5, style: "bold" });
    y += amountH;
  }

  // Which parcel this belongs to — plain text only, never a barcode.
  section();
  y += textBlock(doc, draw, at(), `${data.orderRef}${data.trackingNumber ? ` · ${data.trackingNumber}` : ""}`, { size: 9.5 });

  return y;
}

// 3/3 — the return waybill that goes inside the parcel.
function layoutReturnWaybill(doc: jsPDF, data: WaybillLabelData, items: ExchangeReturnItem[], startY: number, draw: boolean): number {
  let y = 0;
  const at = () => startY + y;

  y += labelHeader(doc, draw, at(), "[ RETURN WAYBILL ]", data.date);

  // Going back to the shop.
  doc.setFont("helvetica", "bold");
  doc.setFontSize(fs(11.5));
  const tagH = draw ? blackTag(doc, "DELIVER [ TO ]", MARGIN, at(), fs(11.5)) : doc.getTextDimensions("DELIVER [ TO ]").h + TAG_PAD_Y * 2;
  y += tagH + 2.5;
  y += textBlock(doc, draw, at(), data.returnBusinessName || "M&M Clothing", { size: 17, style: "bold", maxWidth: CONTENT_W, maxLines: 1 }) + 0.8;
  for (const line of data.returnAddressLines.filter(Boolean)) {
    y += textBlock(doc, draw, at(), line, { size: 11.5, maxWidth: CONTENT_W, maxLines: 2 }) + 0.4;
  }
  if (data.returnPhone) y += textBlock(doc, draw, at(), data.returnPhone, { size: 11.5, style: "bold" }) + 0.8;
  y += 1.5;

  if (draw) divider(doc, at());
  y += 3.5;

  // Coming from the customer.
  y += textBlock(doc, draw, at(), "FROM", { size: 9, style: "bold" }) + 0.6;
  y += textBlock(doc, draw, at(), data.customerName || "Customer", { size: 13, style: "bold", maxWidth: CONTENT_W, maxLines: 1 }) + 0.6;
  const addr = [data.addressLines.filter(Boolean).join(", "), data.city].filter(Boolean).join(", ");
  if (addr) y += textBlock(doc, draw, at(), addr, { size: 10, maxWidth: CONTENT_W, maxLines: 2 }) + 0.6;
  const phones = data.phones.filter(Boolean).join(" / ");
  if (phones) y += textBlock(doc, draw, at(), phones, { size: 10 }) + 0.6;
  y += 1.5;

  if (draw) divider(doc, at());
  y += 3.5;

  const waybill = data.trackingNumber;
  const rowH = textBlock(doc, draw, at(), "EXCHANGE RETURN", { size: 11.5, style: "bold" });
  if (draw) textBlock(doc, true, at(), "No COD", { size: 11.5, style: "bold", align: "right" });
  y += rowH + 1.2;
  y += textBlock(doc, draw, at(), `Ref: ${data.orderRef}`, { size: 10.5, style: "bold" }) + 1.2;
  const listed = items.slice(0, MAX_LISTED).map((i) => `${i.title}${i.variant ? ` (${i.variant})` : ""}`);
  const more = items.length > MAX_LISTED ? ` + ${items.length - MAX_LISTED} more` : "";
  y += textBlock(doc, draw, at(), `Returning: ${listed.join(", ")}${more}`, { size: 9.5, maxWidth: CONTENT_W, maxLines: 3 }) + 2;

  if (draw) divider(doc, at());
  y += 3.5;

  // The same waybill number (and barcode) as the parcel that was sent out.
  const barcode = waybill ? barcodePng(waybill) : null;
  const bcWidth = 52;
  const bcHeight = barcode ? Math.min(11, bcWidth / barcode.aspect) : 0;
  if (draw && barcode) doc.addImage(barcode.dataUrl, "PNG", (PAGE_W - bcWidth) / 2, at(), bcWidth, bcHeight, undefined, "FAST");
  y += bcHeight + 1.5;
  y += textBlock(doc, draw, at(), waybill || data.orderRef, { size: 10.5, style: "bold", align: "center" }) + 3;

  // What the customer does with it, in a box so it's the thing they read.
  const stepsTop = y;
  y += 3;
  y += textBlock(doc, draw, at(), "WHAT TO DO", { size: 9.5, style: "bold", x: MARGIN + 3 }) + 1.6;
  y += textBlock(
    doc,
    draw,
    at(),
    "Stick this waybill on the return package and hand it to the delivery person when your exchange parcel is delivered.",
    { size: 11, x: MARGIN + 3, maxWidth: CONTENT_W - 6, maxLines: 4 }
  );
  y += 3;
  if (draw) {
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.4);
    doc.rect(MARGIN, startY + stepsTop, CONTENT_W, y - stepsTop);
  }

  return y;
}

export function generateExchangeWaybillsPdf(data: WaybillLabelData, returnItems: ExchangeReturnItem[]): jsPDF {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: [PAGE_W, PAGE_H], compress: true });
  drawWaybillLabel(doc, data);
  doc.addPage([PAGE_W, PAGE_H], "portrait");
  drawFitted(doc, (startY, draw) => layoutCollectNote(doc, data, returnItems, startY, draw));
  doc.addPage([PAGE_W, PAGE_H], "portrait");
  drawFitted(doc, (startY, draw) => layoutReturnWaybill(doc, data, returnItems, startY, draw));
  return doc;
}
