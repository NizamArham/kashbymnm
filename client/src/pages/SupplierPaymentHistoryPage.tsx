import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft, Receipt, Download, CreditCard } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Supplier, BusinessInfo, ChequeInfo } from "../lib/types";
import { downloadTabularReport, rangeLabelFor } from "../lib/reportPdf";
import { PageHeader, Card, Table, Th, Td, EmptyState, ErrorText, DateRangePicker, Button } from "../components/ui";
import ChequePreviewModal from "../components/ChequePreviewModal";

interface LedgerEntry {
  date: string;
  type: "purchase" | "payment" | "credit" | "return";
  label: string;
  amount: number;
  effect: number;
  running_balance: number;
  id?: number;
  cheque?: ChequeInfo;
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

  const [businessInfo, setBusinessInfo] = useState<BusinessInfo | null>(null);
  const [chequePreview, setChequePreview] = useState<LedgerEntry | null>(null);

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

  useEffect(() => {
    api
      .get<BusinessInfo | null>("/business-info")
      .then((info) => setBusinessInfo(info))
      .catch(() => {});
  }, []);

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
  // filter), never the unfiltered full history, per the confirmed design.
  function downloadPdf() {
    if (!supplier) return;
    downloadTabularReport({
      headerLabel: "M&M Clothing — Payment History Statement",
      headerRight: supplier.name,
      title: "Payment History",
      subjectLines: [
        `for Supplier: ${supplier.name}`,
        // Deliberately no phone number here — a supplier statement is
        // something that leaves the building, and their number isn't
        // something to print on a document that could end up anywhere.
        `${supplier.supplier_code}${supplier.city ? ` · ${supplier.city}` : ""}`,
      ],
      rangeLabel: rangeLabelFor(startDate, endDate),
      columns: [
        { label: "Date", width: 70 },
        { label: "Description", width: 245 },
        { label: "Amount", width: 100, align: "right" },
        { label: "Balance", width: 100, align: "right" },
      ],
      rows: displayEntries.map((entry) => {
        const isPositive = entry.effect > 0;
        return {
          cells: [
            entry.date.slice(0, 10),
            entry.label.length > 48 ? entry.label.slice(0, 45) + "..." : entry.label,
            formatEntryAmount(entry),
            `Rs. ${entry.running_balance.toLocaleString()}`,
          ],
          styles: [undefined, undefined, { color: isPositive ? 20 : entry.effect < 0 ? 0 : 150 }, undefined],
        };
      }),
      summaryLines: [{ text: `Current balance owed: Rs. ${finalBalance.toLocaleString()}`, bold: true }],
      filename: `payment-history-${supplier.supplier_code}-${toISODate(new Date())}.pdf`,
    });
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
              {displayEntries.map((entry, i) => {
                const clickable = !!entry.cheque;
                return (
                  <tr
                    key={entry.id ?? `${entry.type}-${entry.date}-${i}`}
                    className={`${i % 2 === 1 ? "bg-gray-50/60" : ""} ${clickable ? "cursor-pointer hover:bg-sky-50/60" : ""}`}
                    onClick={clickable ? () => setChequePreview(entry) : undefined}
                  >
                    <Td>{entry.date.slice(0, 10)}</Td>
                    <Td>
                      {entry.label}
                      {clickable && (
                        <span className="inline-flex items-center gap-1 ml-2 text-[11px] text-sky-600 align-middle">
                          <CreditCard size={12} />
                          View cheque
                        </span>
                      )}
                    </Td>
                    <Td className={`font-medium ${typeTone(entry.type)}`}>{formatEntryAmount(entry)}</Td>
                    <Td>Rs. {entry.running_balance.toLocaleString()}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}

      {chequePreview?.cheque && supplier && (
        <ChequePreviewModal
          cheque={chequePreview.cheque}
          supplierName={supplier.name}
          businessName={businessInfo?.business_name || "M&M Clothing"}
          onClose={() => setChequePreview(null)}
        />
      )}
    </div>
  );
}
