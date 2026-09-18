import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft, Receipt, Download } from "lucide-react";
import jsPDF from "jspdf";
import { api, ApiRequestError } from "../lib/api";
import { Supplier } from "../lib/types";
import { PageHeader, Card, Table, Th, Td, EmptyState, ErrorText, DateRangePicker, Button } from "../components/ui";

interface LedgerEntry {
  date: string;
  type: "purchase" | "payment" | "credit" | "return";
  label: string;
  amount: number;
  effect: number;
  running_balance: number;
}

function typeTone(type: LedgerEntry["type"]): string {
  if (type === "purchase") return "text-gray-900";
  if (type === "return") return "text-gray-500";
  return "text-green-600";
}

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 90 days is the default window — matching how most supplier/vendor
// statements work (roughly a business quarter of recent activity),
// rather than showing unbounded history on every visit. The date
// filter below can always reach back further when needed.
function ninetyDaysAgoISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return toISODate(d);
}

export default function SupplierPaymentHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  // Which page actually linked here, passed explicitly as navigation
  // state rather than inferred from browser history — history alone is
  // unreliable (a refresh, a new tab, or a shared link all break it),
  // but the calling page always knows exactly where it sent the person
  // from. Falls back to plain browser-back if this page was reached
  // some other way (e.g. a bookmarked URL) and there's no state to read.
  const origin = (location.state as { from?: "suppliers" | "supplier-payments"; supplierId?: number } | null) ?? null;

  function goBack() {
    if (origin?.from === "suppliers") {
      navigate("/suppliers", { state: { expandSupplierId: origin.supplierId } });
    } else if (origin?.from === "supplier-payments") {
      navigate("/supplier-payments", { state: { expandSupplierId: origin.supplierId } });
    } else {
      navigate(-1);
    }
  }

  const [supplier, setSupplier] = useState<Supplier | null>(null);
  // The FULL, unfiltered history — always fetched in full and never
  // truncated, since the running balance for any row must reflect the
  // true cumulative total from the beginning of real history. The date
  // filter below only controls which of these rows are DISPLAYED —
  // recomputing the balance from a truncated starting point would show
  // a misleading number.
  const [allEntries, setAllEntries] = useState<LedgerEntry[]>([]);
  const [finalBalance, setFinalBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [startDate, setStartDate] = useState<string | null>(ninetyDaysAgoISO());
  const [endDate, setEndDate] = useState<string | null>(toISODate(new Date()));

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const result = await api.get<{ supplier: Supplier; entries: LedgerEntry[]; final_balance: number }>(
          `/supplier-payments/ledger/${id}`
        );
        if (cancelled) return;
        setSupplier(result.supplier);
        setAllEntries(result.entries);
        setFinalBalance(result.final_balance);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiRequestError ? err.message : "Failed to load payment history");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Entries within the active date filter — the running_balance on each
  // row is untouched, still the true cumulative figure from the backend.
  const filteredEntries = allEntries.filter((entry) => {
    const entryDate = entry.date.slice(0, 10);
    if (startDate && entryDate < startDate) return false;
    if (endDate && entryDate > endDate) return false;
    return true;
  });

  // Newest first for reading, even though the running balance was
  // computed chronologically (oldest first) on the backend — reversing
  // here for display doesn't touch the numbers, just the order shown.
  const displayEntries = [...filteredEntries].reverse();

  function formatEntryAmount(entry: LedgerEntry): string {
    if (entry.effect === 0) return "—";
    return `${entry.type === "purchase" ? "+" : "-"}Rs. ${entry.amount.toLocaleString()}`;
  }

  // PDF export — exactly what's on screen right now (the active date
  // filter), never the unfiltered full history, per the confirmed
  // design. A4, portrait: a genuinely large title on page 1 only, then
  // a small running header + footer on every page (including page 1,
  // beneath the big title) — matching a real printed statement rather
  // than a plain data dump.
  function downloadPdf() {
    if (!supplier) return;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const marginX = 40;
    const rangeLabel =
      startDate && endDate ? `${startDate} to ${endDate}` : startDate ? `From ${startDate}` : endDate ? `Through ${endDate}` : "All records";

    // Small header/footer drawn on EVERY page, including page 1 — the
    // big title (drawn separately, once) sits above this same header
    // band on page 1 only.
    function drawHeaderFooter(pageNum: number, totalPages: number) {
      doc.setFontSize(9);
      doc.setTextColor(120);
      doc.setFont("helvetica", "normal");
      doc.text("M&M Clothing — Payment History Statement", marginX, 28);
      doc.text(supplier!.name, pageWidth - marginX, 28, { align: "right" });

      doc.setDrawColor(220);
      doc.line(marginX, 34, pageWidth - marginX, 34);

      // Footer
      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text(`Generated ${toISODate(new Date())} · ${rangeLabel}`, marginX, pageHeight - 24);
      doc.text(`Page ${pageNum} of ${totalPages}`, pageWidth - marginX, pageHeight - 24, { align: "right" });
    }

    // ---- Page 1: the big title, page-1-only, sits ABOVE the shared
    // header band everything else uses ----
    let y = 70;
    doc.setFontSize(20);
    doc.setTextColor(20);
    doc.setFont("helvetica", "bold");
    doc.text("Payment History", marginX, y);
    y += 22;
    doc.setFontSize(13);
    doc.setFont("helvetica", "normal");
    doc.text(`for Supplier: ${supplier.name}`, marginX, y);
    y += 18;
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`${supplier.supplier_code}${supplier.phone ? ` · ${supplier.phone}` : ""}${supplier.city ? ` · ${supplier.city}` : ""}`, marginX, y);
    y += 28;

    // Table header row
    const columns = [
      { label: "Date", width: 70 },
      { label: "Description", width: 245 },
      { label: "Amount", width: 100 },
      { label: "Balance", width: 100 },
    ];
    const tableWidth = columns.reduce((sum, c) => sum + c.width, 0);
    const rowHeight = 20;
    const headerBandBottom = 44; // shared header band height, matches drawHeaderFooter's line at y=34 plus margin
    const footerBandTop = pageHeight - 40;

    function drawTableHeader(yPos: number): number {
      doc.setFillColor(245, 245, 245);
      doc.rect(marginX, yPos, tableWidth, rowHeight, "F");
      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(80);
      let x = marginX + 6;
      for (const col of columns) {
        doc.text(col.label, x, yPos + 14);
        x += col.width;
      }
      return yPos + rowHeight;
    }

    y = drawTableHeader(y);

    let pageNum = 1;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(30);

    for (const entry of displayEntries) {
      if (y + rowHeight > footerBandTop) {
        doc.addPage();
        pageNum++;
        y = headerBandBottom + 10;
        y = drawTableHeader(y);
      }

      let x = marginX + 6;
      doc.setTextColor(30);
      doc.text(entry.date.slice(0, 10), x, y + 14);
      x += columns[0].width;

      const label = entry.label.length > 48 ? entry.label.slice(0, 45) + "..." : entry.label;
      doc.text(label, x, y + 14);
      x += columns[1].width;

      const isPositive = entry.effect > 0;
      doc.setTextColor(isPositive ? 20 : entry.effect < 0 ? 0 : 150);
      doc.text(formatEntryAmount(entry), x, y + 14);
      x += columns[2].width;

      doc.setTextColor(30);
      doc.text(`Rs. ${entry.running_balance.toLocaleString()}`, x, y + 14);

      doc.setDrawColor(235);
      doc.line(marginX, y + rowHeight, marginX + tableWidth, y + rowHeight);

      y += rowHeight;
    }

    // Closing balance line
    y += 10;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(20);
    doc.text(`Current balance owed: Rs. ${finalBalance.toLocaleString()}`, marginX, y);

    // Now that we know the true page count, stamp the shared
    // header/footer band onto every page, including page 1.
    const totalPages = doc.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      drawHeaderFooter(p, totalPages);
    }

    doc.save(`payment-history-${supplier.supplier_code}-${toISODate(new Date())}.pdf`);
  }

  return (
    <div>
      <button
        onClick={goBack}
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-3"
      >
        <ArrowLeft size={15} />
        Back
      </button>

      <PageHeader
        title={supplier ? `${supplier.name}'s payment history` : "Payment history"}
        subtitle={
          supplier
            ? `${filteredEntries.length} of ${allEntries.length} record${allEntries.length === 1 ? "" : "s"} shown · Rs. ${finalBalance.toLocaleString()} currently owed`
            : undefined
        }
        action={
          <Button variant="primary" onClick={downloadPdf} disabled={!supplier || filteredEntries.length === 0} className="inline-flex items-center gap-1.5">
            <Download size={14} />
            Download PDF
          </Button>
        }
      />

      <Card className="mb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <p className="text-xs text-gray-500">Date range</p>
          <DateRangePicker startDate={startDate} endDate={endDate} onChange={(s, e) => { setStartDate(s); setEndDate(e); }} />
          <button
            onClick={() => {
              setStartDate(ninetyDaysAgoISO());
              setEndDate(toISODate(new Date()));
            }}
            className="text-xs text-gray-400 hover:text-gray-700 underline"
          >
            Reset to last 90 days
          </button>
          <button
            onClick={() => {
              setStartDate(null);
              setEndDate(null);
            }}
            className="text-xs text-gray-400 hover:text-gray-700 underline"
          >
            Show everything
          </button>
        </div>
      </Card>

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : allEntries.length === 0 ? (
        <EmptyState icon={Receipt} title="No records yet" subtitle="No purchases, payments, credits, or returns on file." />
      ) : filteredEntries.length === 0 ? (
        <EmptyState icon={Receipt} title="No records in this range" subtitle="Try widening the date filter above." />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Description</Th>
                <Th>Amount</Th>
                <Th>Balance</Th>
              </tr>
            </thead>
            <tbody>
              {displayEntries.map((entry, i) => (
                <tr key={i} className={i % 2 === 1 ? "bg-gray-50/60" : ""}>
                  <Td>{entry.date.slice(0, 10)}</Td>
                  <Td>{entry.label}</Td>
                  <Td className={`font-medium ${typeTone(entry.type)}`}>{formatEntryAmount(entry)}</Td>
                  <Td>Rs. {entry.running_balance.toLocaleString()}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
