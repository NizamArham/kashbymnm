import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Receipt, Download } from "lucide-react";
import jsPDF from "jspdf";
import { api, ApiRequestError } from "../lib/api";
import { Customer } from "../lib/types";
import { PageHeader, Card, Table, Th, Td, EmptyState, ErrorText, DateRangePicker, Button } from "../components/ui";

interface LedgerEntry {
  date: string;
  type: "sale" | "payment" | "cheque" | "credit";
  label: string;
  amount: number;
  effect: number;
  running_balance: number;
}

function typeTone(type: LedgerEntry["type"]): string {
  if (type === "sale") return "text-gray-900";
  return "text-green-600";
}

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ninetyDaysAgoISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return toISODate(d);
}

export default function CustomerPaymentHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [customer, setCustomer] = useState<Customer | null>(null);
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
        const result = await api.get<{ customer: Customer; entries: LedgerEntry[]; final_balance: number }>(
          `/customers/${id}/payment-history`
        );
        if (cancelled) return;
        setCustomer(result.customer);
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

  const filteredEntries = allEntries.filter((entry) => {
    const entryDate = entry.date.slice(0, 10);
    if (startDate && entryDate < startDate) return false;
    if (endDate && entryDate > endDate) return false;
    return true;
  });

  const displayEntries = [...filteredEntries].reverse();

  function formatEntryAmount(entry: LedgerEntry): string {
    if (entry.effect === 0) return "—";
    return `${entry.type === "sale" ? "+" : "-"}Rs. ${entry.amount.toLocaleString()}`;
  }

  function downloadPdf() {
    if (!customer) return;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const marginX = 40;
    const rangeLabel =
      startDate && endDate ? `${startDate} to ${endDate}` : startDate ? `From ${startDate}` : endDate ? `Through ${endDate}` : "All records";

    function drawHeaderFooter(pageNum: number, totalPages: number) {
      doc.setFontSize(9);
      doc.setTextColor(120);
      doc.setFont("helvetica", "normal");
      doc.text("M&M Clothing — Payment History Statement", marginX, 28);
      doc.text(customer!.name, pageWidth - marginX, 28, { align: "right" });

      doc.setDrawColor(220);
      doc.line(marginX, 34, pageWidth - marginX, 34);

      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text(`Generated ${toISODate(new Date())} · ${rangeLabel}`, marginX, pageHeight - 24);
      doc.text(`Page ${pageNum} of ${totalPages}`, pageWidth - marginX, pageHeight - 24, { align: "right" });
    }

    let y = 70;
    doc.setFontSize(20);
    doc.setTextColor(20);
    doc.setFont("helvetica", "bold");
    doc.text("Payment History", marginX, y);
    y += 22;
    doc.setFontSize(13);
    doc.setFont("helvetica", "normal");
    doc.text(`for Customer: ${customer.name}`, marginX, y);
    y += 18;
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`${customer.customer_code}${customer.phone ? ` · ${customer.phone}` : ""}`, marginX, y);
    y += 28;

    const columns = [
      { label: "Date", width: 70 },
      { label: "Description", width: 245 },
      { label: "Amount", width: 100 },
      { label: "Balance", width: 100 },
    ];
    const tableWidth = columns.reduce((sum, c) => sum + c.width, 0);
    const rowHeight = 20;
    const headerBandBottom = 44;
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

    y += 10;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(20);
    doc.text(`Current balance owed: Rs. ${finalBalance.toLocaleString()}`, marginX, y);

    const totalPages = doc.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      drawHeaderFooter(p, totalPages);
    }

    doc.save(`payment-history-${customer.customer_code}-${toISODate(new Date())}.pdf`);
  }

  return (
    <div>
      <button
        onClick={() => navigate(-1)}
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-3"
      >
        <ArrowLeft size={15} />
        Back
      </button>

      <PageHeader
        title={customer ? `${customer.name}'s payment history` : "Payment history"}
        subtitle={
          customer
            ? `${filteredEntries.length} of ${allEntries.length} record${allEntries.length === 1 ? "" : "s"} shown · Rs. ${finalBalance.toLocaleString()} currently owed`
            : undefined
        }
        action={
          <Button variant="primary" onClick={downloadPdf} disabled={!customer || filteredEntries.length === 0} className="inline-flex items-center gap-1.5">
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
        <EmptyState icon={Receipt} title="No records yet" subtitle="No sales, payments, cheques, or credit on file." />
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
