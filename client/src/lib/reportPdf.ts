import jsPDF from "jspdf";
import { NAME_LOGO_PNG_BASE64, NAME_LOGO_ASPECT_RATIO } from "./logoAsset";

export interface ReportColumn {
  label: string;
  width: number;
  align?: "left" | "right";
  // Wraps this column's text onto up to 2 lines instead of truncating
  // it onto one — use for a field like "Reason" or "Notes" where the
  // full text matters more than keeping every row the same height.
  wrap?: boolean;
}

export interface ReportCellStyle {
  color?: number | [number, number, number];
  bold?: boolean;
  // Draws a line through the cell's text — e.g. an amount that wasn't
  // actually collected. Uses the cell's own color for the line.
  strikethrough?: boolean;
}

export interface ReportRow {
  cells: string[];
  styles?: (ReportCellStyle | undefined)[];
  // An extra line drawn below this row's own cells, spanning the full
  // table width — for a field like "Reason" that reads better as its
  // own line under the row than squeezed into a narrow column.
  detail?: string;
}

export interface ReportSummaryLine {
  text: string;
  bold?: boolean;
}

export interface TabularReportOptions {
  headerLabel: string;
  headerRight?: string;
  title: string;
  subjectLines?: string[];
  rangeLabel: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  summaryLines?: ReportSummaryLine[];
  filename: string;
  // Wide tables (many columns) read better in landscape. Defaults to
  // portrait, which suits the narrower ledger-style reports.
  orientation?: "portrait" | "landscape";
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function setColor(doc: jsPDF, color: number | [number, number, number] | undefined, fallback: number) {
  if (color === undefined) doc.setTextColor(fallback);
  else if (Array.isArray(color)) doc.setTextColor(color[0], color[1], color[2]);
  else doc.setTextColor(color);
}

function setDrawColorFrom(doc: jsPDF, color: number | [number, number, number] | undefined, fallback: number) {
  if (color === undefined) doc.setDrawColor(fallback);
  else if (Array.isArray(color)) doc.setDrawColor(color[0], color[1], color[2]);
  else doc.setDrawColor(color);
}

// Truncates text with an ellipsis so it never overflows into the next
// column — jsPDF draws text at whatever width it needs and does not
// clip or wrap on its own, so without this a long product name, reason,
// or note bleeds straight into the neighboring cell. Must be called
// with the cell's actual font/size already set, since width depends on
// both. Binary search keeps this cheap even for long strings.
function fitText(doc: jsPDF, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (doc.getTextWidth(text) <= maxWidth) return text;
  const ellipsis = "...";
  if (doc.getTextWidth(ellipsis) > maxWidth) return "";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.getTextWidth(text.slice(0, mid) + ellipsis) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + ellipsis;
}

const MAX_WRAP_LINES = 2;

// Wraps text to fit maxWidth, capped at MAX_WRAP_LINES — any remainder
// past that is folded into an ellipsis on the last line via fitText, so
// a wrapped column still can't overflow into its neighbor either. Must
// be called with the cell's actual font/size already set.
function wrapLines(doc: jsPDF, text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [""];
  const allLines = doc.splitTextToSize(text, maxWidth) as string[];
  if (allLines.length <= MAX_WRAP_LINES) return allLines;
  const lines = allLines.slice(0, MAX_WRAP_LINES);
  const lastIndex = MAX_WRAP_LINES - 1;
  lines[lastIndex] = fitText(doc, lines[lastIndex].trimEnd() + "...", maxWidth);
  return lines;
}

// Shared template for every "download PDF" report across the app —
// customer/supplier ledgers, cash book, sale/purchase history, etc.
// A4 portrait: a big title + subject block on page 1 only, then a small
// logo + running header/footer (page number, generated date, active
// filter) stamped on every page beneath it, with a paginated table in
// between and optional summary lines after it.
export function downloadTabularReport(opts: TabularReportOptions): void {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: opts.orientation ?? "portrait" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 40;
  const defaultLineWidth = doc.getLineWidth();

  const logoWidth = 16;
  const logoHeight = logoWidth / NAME_LOGO_ASPECT_RATIO;

  function drawHeaderFooter(pageNum: number, totalPages: number) {
    doc.addImage(NAME_LOGO_PNG_BASE64, "PNG", marginX, 16, logoWidth, logoHeight, undefined, "FAST");
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.setFont("helvetica", "normal");
    doc.text(opts.headerLabel, marginX + logoWidth + 6, 28);
    if (opts.headerRight) {
      doc.text(opts.headerRight, pageWidth - marginX, 28, { align: "right" });
    }

    doc.setDrawColor(220);
    doc.line(marginX, 34, pageWidth - marginX, 34);

    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(`Generated ${todayIso()} · ${opts.rangeLabel}`, marginX, pageHeight - 24);
    doc.text(`Page ${pageNum} of ${totalPages}`, pageWidth - marginX, pageHeight - 24, { align: "right" });
  }

  let y = 70;
  doc.setFontSize(20);
  doc.setTextColor(20);
  doc.setFont("helvetica", "bold");
  doc.text(opts.title, marginX, y);
  y += 22;

  doc.setFont("helvetica", "normal");
  (opts.subjectLines ?? []).forEach((line, i) => {
    doc.setFontSize(i === 0 ? 13 : 10);
    doc.setTextColor(i === 0 ? 20 : 100);
    doc.text(line, marginX, y);
    y += i === 0 ? 18 : 16;
  });
  y += 10;

  const tableWidth = opts.columns.reduce((sum, c) => sum + c.width, 0);
  const rowHeight = 20;
  const lineGap = 11;
  const headerBandBottom = 44;
  const footerBandTop = pageHeight - 40;

  function drawTableHeader(yPos: number): number {
    doc.setFillColor(245, 245, 245);
    doc.rect(marginX, yPos, tableWidth, rowHeight, "F");
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(80);
    let x = marginX + 6;
    for (const col of opts.columns) {
      const label = fitText(doc, col.label, col.width - 14);
      doc.text(label, x + (col.align === "right" ? col.width - 12 : 0), yPos + 14, col.align === "right" ? { align: "right" } : undefined);
      x += col.width;
    }
    return yPos + rowHeight;
  }

  y = drawTableHeader(y);

  let pageNum = 1;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);

  for (const row of opts.rows) {
    // First pass: work out how many lines each cell needs (wrapped
    // columns only — everything else is a single fitted line), set with
    // the row's real fonts since bold text measures wider than normal.
    const cellLines: string[][] = opts.columns.map((col, i) => {
      const style = row.styles?.[i];
      doc.setFont("helvetica", style?.bold ? "bold" : "normal");
      const raw = row.cells[i] ?? "";
      return col.wrap ? wrapLines(doc, raw, col.width - 14) : [fitText(doc, raw, col.width - 14)];
    });
    const linesInRow = Math.max(1, ...cellLines.map((lines) => lines.length));
    const lastMainBaseline = 14 + (linesInRow - 1) * lineGap;

    // The detail line, if any, wraps across the full table width (not
    // one column) in a smaller italic style, starting just below the
    // main row's own content.
    doc.setFont("helvetica", "italic");
    doc.setFontSize(8.5);
    const detailLines = row.detail ? wrapLines(doc, row.detail, tableWidth - 12) : [];
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);

    const detailStartOffset = lastMainBaseline + lineGap + 4;
    const thisRowHeight = detailLines.length > 0 ? detailStartOffset + (detailLines.length - 1) * lineGap + 6 : lastMainBaseline + 6;

    if (y + thisRowHeight > footerBandTop) {
      doc.addPage();
      pageNum++;
      y = headerBandBottom + 10;
      y = drawTableHeader(y);
    }

    let x = marginX + 6;
    for (let i = 0; i < opts.columns.length; i++) {
      const col = opts.columns[i];
      const style = row.styles?.[i];
      setColor(doc, style?.color, 30);
      doc.setFont("helvetica", style?.bold ? "bold" : "normal");
      cellLines[i].forEach((lineText, li) => {
        const ty = y + 14 + li * lineGap;
        if (col.align === "right") {
          doc.text(lineText, x + col.width - 12, ty, { align: "right" });
        } else {
          doc.text(lineText, x, ty);
        }
        if (style?.strikethrough && lineText) {
          const w = doc.getTextWidth(lineText);
          const lineY = ty - 3;
          const startX = col.align === "right" ? x + col.width - 12 - w : x;
          setDrawColorFrom(doc, style?.color, 30);
          doc.setLineWidth(0.6);
          doc.line(startX, lineY, startX + w, lineY);
          doc.setLineWidth(defaultLineWidth);
        }
      });
      x += col.width;
    }

    if (detailLines.length > 0) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(8.5);
      doc.setTextColor(130);
      detailLines.forEach((lineText, li) => {
        doc.text(lineText, marginX + 6, y + detailStartOffset + li * lineGap);
      });
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
    }

    doc.setDrawColor(235);
    doc.line(marginX, y + thisRowHeight, marginX + tableWidth, y + thisRowHeight);

    y += thisRowHeight;
  }

  if (opts.summaryLines && opts.summaryLines.length > 0) {
    y += 10;
    for (const line of opts.summaryLines) {
      doc.setFont("helvetica", line.bold ? "bold" : "normal");
      doc.setFontSize(10);
      doc.setTextColor(20);
      doc.text(line.text, marginX, y);
      y += 15;
    }
  }

  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    drawHeaderFooter(p, totalPages);
  }

  doc.save(opts.filename);
}

export function rangeLabelFor(startDate: string | null | undefined, endDate: string | null | undefined): string {
  if (startDate && endDate) return `${startDate} to ${endDate}`;
  if (startDate) return `From ${startDate}`;
  if (endDate) return `Through ${endDate}`;
  return "All records";
}
