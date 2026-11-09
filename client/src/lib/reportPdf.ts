import jsPDF from "jspdf";
import { NAME_LOGO_PNG_BASE64, NAME_LOGO_ASPECT_RATIO } from "./logoAsset";
import { previewPdf } from "./pdfPreview";

export interface ReportColumn {
  label: string;
  width: number;
  align?: "left" | "right" | "center";
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

// The one number a report is actually for — rendered the same
// restrained way the invoice's own Total row is: a hairline rule, the
// label at normal weight, and just the amount itself sized up a couple
// points. No bold, no fill, no colored box.
export interface ReportTotalSummary {
  label: string;
  amount: string;
  note?: string;
}

// A label/value row in the page-1 header block — the exact same visual
// language as the invoice's own kvRow (gray label, near-black value,
// one shared value column wide enough for the longest label). This is
// what actually identifies the document (what it is, who/what it's
// for, what period) instead of one big standalone heading — the
// invoice itself never has a giant "INVOICE" title either, just this.
export interface ReportHeaderField {
  label: string;
  value: string;
}

export interface TabularReportOptions {
  headerLabel: string;
  headerRight?: string;
  // Preferred: a label/value block styled like the invoice's own
  // (Report, Customer, Period, Generated, ...). When given, this
  // replaces the plain title/subjectLines below entirely.
  headerFields?: ReportHeaderField[];
  // Legacy fallback for any report not yet moved to headerFields.
  title?: string;
  subjectLines?: string[];
  rangeLabel: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  summaryLines?: ReportSummaryLine[];
  totalSummary?: ReportTotalSummary;
  filename: string;
  // Wide tables (many columns) read better in landscape. Defaults to
  // portrait, which suits the narrower ledger-style reports. "auto"
  // picks landscape only when the columns don't fit a portrait page.
  orientation?: "portrait" | "landscape" | "auto";
  // When the columns are still too wide for the page, the table is split
  // sideways into parts (Part 1 of 3, ...), each starting on a fresh
  // page, and these columns are repeated on every part so each row stays
  // readable on its own: the first N (a name column, default 1) and the
  // last N (a TOTAL column, default 0).
  pinStartColumns?: number;
  pinEndColumns?: number;
  // Stretches the columns evenly so the table fills the full width of the
  // page (never more than 1.6x their given widths) instead of stopping
  // short of the right margin. Applies to each part of a split table.
  fillWidth?: boolean;
  // One short line printed above each part of a split table, after
  // "Part 1 of 3 · first column to last column" (e.g. what TOTAL means).
  splitNote?: string;
}

// Matches the invoice's own convention exactly (Invoice{number}.pdf) —
// compact, PascalCase, no spaces, no lowercase-and-dashes slug. `tag`
// is a short identifier for what's in this download (e.g. "Sep2026",
// "28Sep2026", "CashSales") — deliberately NOT the full descriptive
// range label shown on the page itself, since a filename needs to stay
// short and unique across repeats, while the on-page text is free to
// be as explicit as it needs to be.
export function buildReportFilename(reportName: string, tag: string): string {
  return `${reportName.replace(/\s+/g, "")}-${tag}.pdf`;
}

// The "Generated" field's value on every report's header block — one
// shared formatter so it reads identically everywhere instead of each
// page rolling its own date formatting.
export function formatLongDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export function todayLongDate(): string {
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return formatLongDate(iso);
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

const A4_PORTRAIT_WIDTH = 595.28;
// A table up to this much too wide is squeezed to fit the page instead of
// being split into parts (a few percent over is not worth a second page).
const MIN_FIT_SCALE = 0.88;
const MAX_STRETCH = 1.6;

// Splits a too-wide table into parts that each fit the page: the pinned
// start/end columns repeat in every part and the columns in between are
// shared out as evenly as possible. Returns column indexes per part.
function splitColumns(widths: number[], available: number, pinStart: number, pinEnd: number): number[][] {
  const n = widths.length;
  const all = widths.map((_, i) => i);
  if (widths.reduce((a, b) => a + b, 0) <= available + 0.5) return [all];
  const start = all.slice(0, pinStart);
  const end = all.slice(n - pinEnd);
  const mid = all.slice(pinStart, n - pinEnd);
  if (mid.length === 0) return [all];
  const pinnedWidth = [...start, ...end].reduce((sum, i) => sum + widths[i], 0);
  const room = available - pinnedWidth;
  const fits = (group: number[]) => group.reduce((sum, i) => sum + widths[i], 0) <= room + 0.5;

  // Greedy first, to learn how many parts are needed...
  const greedy: number[][] = [];
  let cur: number[] = [];
  for (const i of mid) {
    if (cur.length > 0 && !fits([...cur, i])) {
      greedy.push(cur);
      cur = [];
    }
    cur.push(i);
  }
  if (cur.length > 0) greedy.push(cur);

  // ...then even them out so the last part isn't one or two lonely columns.
  const per = Math.ceil(mid.length / greedy.length);
  const even: number[][] = [];
  for (let k = 0; k < mid.length; k += per) even.push(mid.slice(k, k + per));
  const groups = even.every(fits) ? even : greedy;
  return groups.map((g) => [...start, ...g, ...end]);
}

// Shared template for every "download PDF" report across the app —
// customer/supplier ledgers, cash book, sale/purchase history, etc.
// A4 portrait: a big title + subject block on page 1 only, then a small
// logo + running header/footer (page number, generated date, active
// filter) stamped on every page beneath it, with a paginated table in
// between and optional summary lines after it.
export function downloadTabularReport(opts: TabularReportOptions): void {
  const marginX = 40;
  const naturalWidth = opts.columns.reduce((sum, c) => sum + c.width, 0);
  const orientation =
    opts.orientation === "auto"
      ? naturalWidth * MIN_FIT_SCALE > A4_PORTRAIT_WIDTH - marginX * 2
        ? "landscape"
        : "portrait"
      : opts.orientation ?? "portrait";
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const defaultLineWidth = doc.getLineWidth();

  // Wider than the page: squeeze the columns a little if that is enough,
  // otherwise split the table sideways into parts (see splitColumns).
  const availableWidth = pageWidth - marginX * 2;
  let columns = opts.columns;
  if (naturalWidth > availableWidth && availableWidth / naturalWidth >= MIN_FIT_SCALE) {
    const k = availableWidth / naturalWidth;
    columns = columns.map((c) => ({ ...c, width: c.width * k }));
  }
  const pinStart = Math.min(opts.pinStartColumns ?? 1, columns.length);
  const pinEnd = Math.min(opts.pinEndColumns ?? 0, columns.length - pinStart);
  const parts = splitColumns(columns.map((c) => c.width), availableWidth, pinStart, pinEnd);
  // What to print after "Generated ... · range" in each page's footer,
  // by page number (empty unless the table was split into parts).
  const partLabels: string[] = [];

  function drawHeaderFooter(pageNum: number, totalPages: number) {
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.setFont("helvetica", "normal");
    doc.text(opts.headerLabel, marginX, 28);
    if (opts.headerRight) {
      doc.text(opts.headerRight, pageWidth - marginX, 28, { align: "right" });
    }

    doc.setDrawColor(220);
    doc.line(marginX, 34, pageWidth - marginX, 34);

    doc.setFontSize(8);
    doc.setTextColor(150);
    const partLabel = partLabels[pageNum - 1];
    doc.text(`Generated ${todayIso()} · ${opts.rangeLabel}${partLabel ? ` · ${partLabel}` : ""}`, marginX, pageHeight - 24);
    doc.text(`Page ${pageNum} of ${totalPages}`, pageWidth - marginX, pageHeight - 24, { align: "right" });
  }

  let y = 70;

  // The logo as a one-time hero mark, top-right — the exact placement
  // AND physical size the invoice itself uses (logo opposite the
  // barcode, "SLOW" quality for a crisp edge), translated here to sit
  // opposite the header block instead. Page 1 only, same as the
  // invoice never repeats its own logo on overflow pages.
  // The invoice draws its logo at 42mm on an "mm"-unit document; this
  // document's unit is "pt", so matching the invoice's real, physical
  // size means converting mm to points (1mm = 72/25.4pt) — using the
  // bare number 42 here would be 42pt, less than a third of the actual
  // invoice size, and exactly the "still too small" bug being fixed.
  const MM_TO_PT = 72 / 25.4;
  const logoWidth = 42 * MM_TO_PT;
  const logoHeight = logoWidth / NAME_LOGO_ASPECT_RATIO;
  doc.addImage(NAME_LOGO_PNG_BASE64, "PNG", pageWidth - marginX - logoWidth, y - 8, logoWidth, logoHeight, undefined, "SLOW");

  if (opts.headerFields && opts.headerFields.length > 0) {
    // Same visual language as the invoice's own kvRow: gray label,
    // near-black value, one shared value column sized to the longest
    // label actually used — no separate giant title text, since the
    // invoice itself never has one either.
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    const labelWidth = Math.max(...opts.headerFields.map((f) => doc.getTextWidth(f.label))) + 16;
    const valueX = marginX + labelWidth;
    for (const field of opts.headerFields) {
      doc.setTextColor(150);
      doc.text(field.label, marginX, y);
      doc.setTextColor(20);
      doc.text(field.value, valueX, y);
      y += 16;
    }
  } else if (opts.title) {
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
  }
  y += 10;

  const rowHeight = 20;
  const lineGap = 11;
  const headerBandBottom = 44;
  const footerBandTop = pageHeight - 40;
  const oneLine = (label: string) => label.replace(/\n/g, " ");
  let tableWidth = 0;
  let pageNum = 1;

  parts.forEach((colIdxs, partIdx) => {
    const baseCols = colIdxs.map((i) => columns[i]);
    const baseWidth = baseCols.reduce((sum, c) => sum + c.width, 0);
    const stretch = opts.fillWidth ? Math.max(1, Math.min(MAX_STRETCH, availableWidth / baseWidth)) : 1;
    const cols = stretch > 1 ? baseCols.map((c) => ({ ...c, width: c.width * stretch })) : baseCols;
    tableWidth = cols.reduce((sum, c) => sum + c.width, 0);
    const partLabel = parts.length > 1 ? `Part ${partIdx + 1} of ${parts.length}` : "";

    if (partIdx > 0) {
      doc.addPage();
      pageNum++;
      y = headerBandBottom + 10;
    }
    partLabels[pageNum - 1] = partLabel;

    if (parts.length > 1) {
      const middle = colIdxs.filter((i) => i >= pinStart && i < columns.length - pinEnd);
      const span = middle.length > 0 ? `${oneLine(columns[middle[0]].label)} to ${oneLine(columns[middle[middle.length - 1]].label)}` : "";
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(110);
      doc.text([partLabel, span, opts.splitNote].filter(Boolean).join(" · "), marginX, y + 4);
      y += 16;
    }

    // A header label may hold a line break ("28/29\nSLIM") so a narrow
    // column can stack its label instead of being cut off with "...".
    const headerLines = Math.max(1, ...cols.map((c) => c.label.split("\n").length));
    const headerHeight = headerLines > 1 ? 14 + (headerLines - 1) * lineGap + 8 : rowHeight;

    function drawTableHeader(yPos: number): number {
      doc.setFillColor(245, 245, 245);
      doc.rect(marginX, yPos, tableWidth, headerHeight, "F");
      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(80);
      let hx = marginX + 6;
      for (const col of cols) {
        const maxWidth = col.align === "center" ? col.width - 6 : col.width - 14;
        col.label.split("\n").forEach((part, li) => {
          const label = fitText(doc, part, maxWidth);
          const ty = yPos + 14 + li * lineGap;
          if (col.align === "right") {
            doc.text(label, hx + col.width - 12, ty, { align: "right" });
          } else if (col.align === "center") {
            doc.text(label, hx + col.width / 2, ty, { align: "center" });
          } else {
            doc.text(label, hx, ty);
          }
        });
        hx += col.width;
      }
      return yPos + headerHeight;
    }

    y = drawTableHeader(y);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);

    for (const row of opts.rows) {
      // First pass: work out how many lines each cell needs (wrapped
      // columns only — everything else is a single fitted line), set with
      // the row's real fonts since bold text measures wider than normal.
      const cellLines: string[][] = cols.map((col, k) => {
        const style = row.styles?.[colIdxs[k]];
        doc.setFont("helvetica", style?.bold ? "bold" : "normal");
        const raw = row.cells[colIdxs[k]] ?? "";
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
        partLabels[pageNum - 1] = partLabel;
        y = headerBandBottom + 10;
        y = drawTableHeader(y);
      }

      let x = marginX + 6;
      for (let k = 0; k < cols.length; k++) {
        const col = cols[k];
        const style = row.styles?.[colIdxs[k]];
        setColor(doc, style?.color, 30);
        doc.setFont("helvetica", style?.bold ? "bold" : "normal");
        cellLines[k].forEach((lineText, li) => {
          const ty = y + 14 + li * lineGap;
          if (col.align === "right") {
            doc.text(lineText, x + col.width - 12, ty, { align: "right" });
          } else if (col.align === "center") {
            doc.text(lineText, x + col.width / 2, ty, { align: "center" });
          } else {
            doc.text(lineText, x, ty);
          }
          if (style?.strikethrough && lineText) {
            const w = doc.getTextWidth(lineText);
            const lineY = ty - 3;
            const startX = col.align === "right" ? x + col.width - 12 - w : col.align === "center" ? x + col.width / 2 - w / 2 : x;
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
  });

  if (opts.totalSummary) {
    y += 8;
    doc.setDrawColor(200);
    doc.line(marginX, y, marginX + tableWidth, y);
    y += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(20);
    doc.text(opts.totalSummary.label, marginX, y);
    doc.setFontSize(13);
    const amountWidth = doc.getTextWidth(opts.totalSummary.amount);
    doc.text(opts.totalSummary.amount, marginX + tableWidth, y, { align: "right" });
    if (opts.totalSummary.note) {
      doc.setFontSize(9);
      doc.setTextColor(130);
      doc.text(opts.totalSummary.note, marginX + tableWidth - amountWidth - 8, y, { align: "right" });
    }
    y += 6;
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

  // Opens a preview (Download / Print inside) rather than saving at once.
  previewPdf(doc, opts.filename);
}

export function rangeLabelFor(startDate: string | null | undefined, endDate: string | null | undefined): string {
  if (startDate && endDate) return `${startDate} to ${endDate}`;
  if (startDate) return `From ${startDate}`;
  if (endDate) return `Through ${endDate}`;
  return "All records";
}
