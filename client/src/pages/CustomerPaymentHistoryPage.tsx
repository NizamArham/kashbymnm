import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Receipt, Download, Copy, Check, Wallet } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Customer } from "../lib/types";
import { downloadTabularReport, rangeLabelFor, buildReportFilename, todayLongDate } from "../lib/reportPdf";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";
import { downloadBalanceSlip } from "../lib/balanceSlip";
import { PageHeader, Card, Table, Th, Td, EmptyState, ErrorText, DateRangePicker, Button, RefLink, Badge, BadgeTone } from "../components/ui";

interface LedgerEntry {
  date: string;
  type: "sale" | "payment" | "cheque" | "credit";
  // What the Type column shows. A store credit granted for a return is
  // its own kind so returns stand out from other credit.
  kind: "sale" | "payment" | "cheque" | "credit" | "return";
  // The row's short main text; label is the same thing as a sentence.
  title: string;
  label: string;
  amount: number;
  // How much this row moves the balance: + owes more, − owes less.
  effect: number;
  running_balance: number;
  // Cash-book transaction ID, on payment rows.
  transaction_code?: string | null;
  // Lines shown under an invoice: how store credit paid for it.
  details?: string[];
  sale_id?: number;
  sale_invoice?: string;
}

const money = (n: number) => `Rs. ${n.toLocaleString()}`;
// Table cells drop the repeated "Rs." — the table says all amounts are in Rs.
const num = (n: number) => n.toLocaleString();

const PILL: Record<LedgerEntry["kind"], { text: string; tone: BadgeTone }> = {
  sale: { text: "Sale", tone: "neutral" },
  payment: { text: "Payment", tone: "success" },
  cheque: { text: "Cheque", tone: "success" },
  return: { text: "Return", tone: "outline" },
  credit: { text: "Credit", tone: "outline" },
};

// One signed figure per row: + adds to what they owe (a sale), − takes
// away from it (a payment, or credit for a return).
function signedAmount(effect: number, pdf = false): string {
  if (effect === 0) return "";
  return `${effect > 0 ? "+" : pdf ? "-" : "−"}${Math.abs(effect).toLocaleString()}`;
}

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ninetyDaysAgoISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return toISODate(d);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-10-02 15:06:11" → "2 Oct 2026"
function formatDay(date: string): string {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : date.slice(0, 10);
}

// The time of day, when the record has one. A courier-settled payment is
// stamped 23:59 only to sort it after its day's other rows — not a real time.
function formatTime(date: string): string | null {
  const t = /[ T](\d{2}:\d{2})/.exec(date)?.[1];
  return t && t !== "23:59" ? t : null;
}

// What the balance means in words: positive = they owe, negative = they
// hold credit, zero = nothing outstanding.
function balanceText(balance: number, withCurrency = true): { text: string; className: string } {
  const fmt = withCurrency ? money : num;
  if (balance > 0) return { text: fmt(balance), className: "text-gray-900 font-semibold" };
  if (balance < 0) return { text: `${fmt(-balance)} credit`, className: "text-gray-900 font-semibold" };
  return { text: "Settled", className: "text-gray-500 font-medium" };
}

function TransactionId({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy transaction ID"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          // Clipboard blocked — the ID is still on screen to copy by hand.
        }
      }}
      className="inline-flex items-center gap-1 text-[11px] font-mono text-gray-500 hover:text-gray-800 mt-0.5"
    >
      {code}
      {copied ? <Check size={12} className="text-gray-900" /> : <Copy size={12} className="text-gray-300" />}
    </button>
  );
}

export default function CustomerPaymentHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [allEntries, setAllEntries] = useState<LedgerEntry[]>([]);
  const [finalBalance, setFinalBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slipping, setSlipping] = useState(false);

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

  const owed = customer?.balance_due ?? Math.max(finalBalance, 0);
  const credit = customer?.store_credit_balance ?? Math.max(-finalBalance, 0);
  const headline = balanceText(finalBalance);

  // "How much is my balance?" — one click for a slip with what they owe
  // right now and our bank details.
  async function handleBalanceSlip() {
    if (!id) return;
    setSlipping(true);
    setError(null);
    try {
      await downloadBalanceSlip(Number(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the balance slip");
    } finally {
      setSlipping(false);
    }
  }

  function downloadPdf() {
    if (!customer) return;
    // A statement reads oldest to newest, so the balance builds down the
    // page and the closing balance is the last thing on it. If the date
    // range cuts off earlier history, the balance at that point is carried
    // in as the first line.
    const firstShown = filteredEntries.length > 0 ? allEntries.indexOf(filteredEntries[0]) : -1;
    const broughtForward = firstShown > 0 ? allEntries[firstShown - 1].running_balance : null;
    // (Statement figures are plain numbers — the column headings say Rs.)
    const rows = [
      ...(broughtForward !== null
        ? [{ cells: ["", "Balance brought forward", "", "", balanceText(broughtForward, false).text], styles: [undefined, { bold: true }, undefined, undefined, { bold: true }] }]
        : []),
      ...filteredEntries.map((entry) => {
        // Sale notes (how store credit paid for it) go one per line; other
        // rows' small print runs along a single line.
        const isSale = entry.kind === "sale";
        const detailParts = [
          entry.transaction_code ? `Transaction ID ${entry.transaction_code}` : "",
          ...(entry.details ?? []).map((line) => (isSale ? `Note: ${line}` : line)),
        ].filter(Boolean);
        return {
          cells: [entry.date.slice(0, 10), entry.title, PILL[entry.kind].text, signedAmount(entry.effect, true), balanceText(entry.running_balance, false).text],
          styles: [undefined, undefined, undefined, undefined, undefined],
          ...(detailParts.length > 0 ? { detail: detailParts.join(isSale ? "\n" : "   |   ") } : {}),
        };
      }),
    ];
    downloadTabularReport({
      headerLabel: "M&M Clothing — Customer Statement",
      headerFields: [
        { label: "Report", value: "Customer Statement" },
        { label: "Customer", value: `${customer.name} (${customer.customer_code})${customer.phone ? ` · ${customer.phone}` : ""}` },
        { label: "Period", value: rangeLabelFor(startDate, endDate) },
        { label: "Generated", value: todayLongDate() },
      ],
      rangeLabel: rangeLabelFor(startDate, endDate),
      columns: [
        { label: "Date", width: 62 },
        { label: "Description", width: 208, wrap: true },
        { label: "Type", width: 52 },
        { label: "Amount (Rs.)", width: 90, align: "right" },
        { label: "Balance (Rs.)", width: 103, align: "right" },
      ],
      rows,
      totalSummary: {
        label: "Closing balance",
        amount: finalBalance > 0 ? money(finalBalance) : finalBalance < 0 ? `${money(-finalBalance)} credit` : "Settled",
        note: `Owed on invoices ${money(owed)}  |  Store credit available ${money(credit)}`,
      },
      filename: buildReportFilename("Customer Statement", `${customer.customer_code}-${toISODate(new Date())}`),
    });
  }

  useKeyboardShortcut("d", downloadPdf, { ctrlOrCmd: true, shift: true, enabled: !!customer && filteredEntries.length > 0 });

  return (
    <div>
      <button
        onClick={() => navigate(-1)}
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-3"
      >
        <ArrowLeft size={14} />
        Back
      </button>

      <PageHeader
        title={customer ? `${customer.name}'s payment history` : "Payment history"}
        subtitle={customer ? `${filteredEntries.length} of ${allEntries.length} record${allEntries.length === 1 ? "" : "s"} shown` : undefined}
        action={
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              onClick={handleBalanceSlip}
              disabled={!customer || slipping}
              className="inline-flex items-center gap-1.5"
              title="Quick slip: what they owe right now, with our bank details"
            >
              <Wallet size={14} />
              {slipping ? "Preparing..." : "Balance slip"}
            </Button>
            <Button
              variant="primary"
              onClick={downloadPdf}
              disabled={!customer || filteredEntries.length === 0}
              className="inline-flex items-center gap-1.5"
              title="Download PDF (Ctrl/Cmd+Shift+D)"
            >
              <Download size={14} />
              Download PDF
            </Button>
          </div>
        }
      />

      {customer && (
        <Card className="mb-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-0 sm:divide-x sm:divide-gray-100">
            <div className="sm:pr-6">
              <p className="text-xs text-gray-400">Balance now</p>
              <p className="text-2xl mt-0.5 tabular-nums text-gray-900 font-semibold">
                {headline.text}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                {finalBalance > 0 ? "still to be paid" : finalBalance < 0 ? "available to spend" : "nothing owed"}
              </p>
            </div>
            <div className="sm:px-6">
              <p className="text-xs text-gray-400">Owed on invoices</p>
              <p className="text-lg font-medium text-gray-900 mt-1 tabular-nums">{money(owed)}</p>
            </div>
            <div className="sm:pl-6">
              <p className="text-xs text-gray-400">Store credit available</p>
              <p className="text-lg font-medium text-gray-900 mt-1 tabular-nums">{money(credit)}</p>
            </div>
          </div>
          {credit > 0 && owed > 0 && (
            <p className="text-xs text-gray-400 mt-3 pt-3 border-t border-gray-100">
              Balance = {money(owed)} owed − {money(credit)} store credit. The credit comes off automatically at the next payment or invoice.
            </p>
          )}
        </Card>
      )}

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
          <p className="text-[11px] text-gray-400 text-right px-4 pt-3">All amounts in Rs.</p>
          <Table>
            <thead>
              <tr>
                <Th className="w-px whitespace-nowrap">Date</Th>
                <Th className="w-full">Description</Th>
                <Th className="w-px whitespace-nowrap">Type</Th>
                <Th className="w-px whitespace-nowrap text-right">Amount</Th>
                <Th className="w-px whitespace-nowrap text-right">Balance</Th>
              </tr>
            </thead>
            <tbody>
              {displayEntries.map((entry, i) => {
                const pill = PILL[entry.kind];
                const time = formatTime(entry.date);
                const bal = balanceText(entry.running_balance, false);
                return (
                  <tr key={i} className="align-top">
                    <Td className="whitespace-nowrap">
                      <div className="text-gray-900">{formatDay(entry.date)}</div>
                      {time && <div className="text-[11px] text-gray-400 tabular-nums">{time}</div>}
                    </Td>
                    <Td>
                      <div className="text-gray-900">
                        {entry.sale_id ? <RefLink to={`/sales/${entry.sale_id}`}>{entry.title}</RefLink> : entry.title}
                      </div>
                      {entry.transaction_code && <TransactionId code={entry.transaction_code} />}
                      {entry.details?.map((line) =>
                        entry.kind === "sale" ? (
                          // How store credit paid for this invoice, and which
                          // return it came from — a note on the sale.
                          <div key={line} className="mt-1.5 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600">
                            <span className="font-medium text-gray-800">Note:</span> {line}
                          </div>
                        ) : (
                          <div key={line} className="text-xs text-gray-500 mt-0.5">
                            {line}
                          </div>
                        )
                      )}
                    </Td>
                    <Td>
                      <Badge label={pill.text} tone={pill.tone} />
                    </Td>
                    <Td className="text-right tabular-nums whitespace-nowrap font-medium text-gray-900">
                      {signedAmount(entry.effect)}
                    </Td>
                    <Td className={`text-right tabular-nums whitespace-nowrap ${bal.className}`}>{bal.text}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <p className="text-xs text-gray-400 px-4 py-3 border-t border-gray-100">
            <strong className="font-medium text-gray-500">+</strong> adds to what they owe (a sale) · <strong className="font-medium text-gray-500">−</strong> takes
            away from it (a payment, or store credit for a return) · <strong className="font-medium text-gray-500">Balance</strong> = what's owed after counting that credit.
          </p>
        </Card>
      )}
    </div>
  );
}
