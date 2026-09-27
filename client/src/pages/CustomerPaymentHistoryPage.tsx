import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Receipt, Download } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Customer } from "../lib/types";
import { downloadTabularReport, rangeLabelFor } from "../lib/reportPdf";
import { PageHeader, Card, Table, Th, Td, EmptyState, ErrorText, DateRangePicker, Button, RefLink } from "../components/ui";

interface LedgerEntry {
  date: string;
  type: "sale" | "payment" | "cheque" | "credit";
  label: string;
  amount: number;
  effect: number;
  running_balance: number;
  sale_id?: number;
  sale_invoice?: string;
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
    downloadTabularReport({
      headerLabel: "M&M Clothing — Payment History Statement",
      headerRight: customer.name,
      title: "Payment History",
      subjectLines: [
        `for Customer: ${customer.name}`,
        `${customer.customer_code}${customer.phone ? ` · ${customer.phone}` : ""}`,
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
      filename: `payment-history-${customer.customer_code}-${toISODate(new Date())}.pdf`,
    });
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
                  <Td>
                    {entry.type === "sale" && entry.sale_id && entry.sale_invoice ? (
                      <>
                        Sale <RefLink to={`/sales/${entry.sale_id}`}>{entry.sale_invoice}</RefLink>
                      </>
                    ) : entry.sale_id ? (
                      // No discrete invoice field on this row (it's a
                      // free-text note) — linking the whole label still
                      // gets to the sale in one click.
                      <RefLink to={`/sales/${entry.sale_id}`}>{entry.label}</RefLink>
                    ) : (
                      entry.label
                    )}
                  </Td>
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
