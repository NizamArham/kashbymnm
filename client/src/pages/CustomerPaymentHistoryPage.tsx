import { useEffect, useState } from "react";
import { PageLoader } from "../components/Loader";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Receipt, Download, Copy, Check, Wallet, Truck } from "lucide-react";
import RefundSlipButton from "../components/RefundSlipButton";
import { api, ApiRequestError } from "../lib/api";
import { Customer } from "../lib/types";
import { downloadTabularReport, rangeLabelFor, buildReportFilename, todayLongDate } from "../lib/reportPdf";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";
import { downloadBalanceSlip } from "../lib/balanceSlip";
import { PageHeader, Card, Table, Th, Td, EmptyState, ErrorText, DateRangePicker, Button, RefLink, Badge, BadgeTone } from "../components/ui";
import { formatDate, formatTime } from "../lib/dates";

interface LedgerEntry {
  date: string;
  type: "sale" | "payment" | "cheque" | "credit" | "refund" | "returned" | "deduction";
  // What the Type column shows. A store credit granted for a return is
  // its own kind so returns stand out from other credit.
  // "courier": a COD order the courier delivered and collected — paid, with the
  // courier until they pay it over.
  // "on_delivery": a COD order still on its way — paid at the door, not owed on account.
  kind: "sale" | "payment" | "cheque" | "credit" | "return" | "refund" | "deduction" | "courier" | "on_delivery" | "exchange";
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
  // On a "paid out" row (money paid back for a return): the key its "Refund payment done" slip is fetched by.
  refund_key?: string;
  // Rows about a return paid back in money show their amount with this word under it (returned / paid for courier / paid out) instead of a + or −;
  // the Balance column still moves with them.
  amount_label?: string;
}

const money = (n: number) => `Rs. ${n.toLocaleString()}`;
// Table cells drop the repeated "Rs." — the table says all amounts are in Rs.
const num = (n: number) => n.toLocaleString();

const PILL: Record<LedgerEntry["kind"], { text: string; tone: BadgeTone }> = {
  sale: { text: "Sale", tone: "neutral" },
  payment: { text: "Payment", tone: "success" },
  cheque: { text: "Cheque", tone: "success" },
  return: { text: "Return", tone: "outline" },
  refund: { text: "Paid out", tone: "outline" },
  deduction: { text: "Deducted", tone: "outline" },
  credit: { text: "Credit", tone: "outline" },
  courier: { text: "With courier", tone: "success" },
  on_delivery: { text: "On delivery", tone: "outline" },
  exchange: { text: "Exchange", tone: "outline" },
};

// An order whose cash is not owed on account: paid to the courier at the door and
// not yet paid over to the shop (with_courier), or still to be paid at the door (on_delivery).
interface WithCourier {
  sale_id: number;
  invoice: string;
  partner: string;
  amount: number;
}

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

// The time of day, when the record has one. A courier-settled payment is
// stamped 23:59 only to sort it after its day's other rows — not a real time.
function timeOf(date: string): string | null {
  return /[ T]23:59/.test(date) ? null : formatTime(date);
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
      className="inline-flex items-center gap-1 text-xs font-mono text-gray-500 hover:text-gray-800 mt-0.5"
    >
      {code}
      {copied ? <Check size={12} className="text-gray-900" /> : <Copy size={12} className="text-gray-300" />}
    </button>
  );
}

// `customerId` set = shown as a tab on the customer's profile page: no Back button and no page title of its own.
export default function CustomerPaymentHistoryPage({ customerId }: { customerId?: number } = {}) {
  const params = useParams<{ id: string }>();
  const id = customerId !== undefined ? String(customerId) : params.id;
  const embedded = customerId !== undefined;
  const navigate = useNavigate();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [allEntries, setAllEntries] = useState<LedgerEntry[]>([]);
  const [finalBalance, setFinalBalance] = useState(0);
  // Refunds approved for returns but not paid out yet — part of a credit balance that is money to hand back, not store credit.
  const [refundOwed, setRefundOwed] = useState(0);
  const [withCourier, setWithCourier] = useState<WithCourier[]>([]);
  const [onDelivery, setOnDelivery] = useState<WithCourier[]>([]);
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
        const result = await api.get<{ customer: Customer; entries: LedgerEntry[]; final_balance: number; refund_owed?: number; with_courier: WithCourier[]; on_delivery: WithCourier[] }>(
          `/customers/${id}/payment-history`
        );
        if (cancelled) return;
        setCustomer(result.customer);
        setAllEntries(result.entries);
        setFinalBalance(result.final_balance);
        setRefundOwed(result.refund_owed ?? 0);
        setWithCourier(result.with_courier ?? []);
        setOnDelivery(result.on_delivery ?? []);
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

  // Cash a courier collected from this customer at the door and hasn't paid
  // over yet — the customer owes nothing for it. Said as good news, per courier.
  const courierTotal = withCourier.reduce((sum, w) => sum + w.amount, 0);
  const onDeliveryTotal = onDelivery.reduce((sum, w) => sum + w.amount, 0);
  const listOrders = (items: WithCourier[]) => {
    const byPartner = new Map<string, WithCourier[]>();
    for (const w of items) byPartner.set(w.partner, [...(byPartner.get(w.partner) ?? []), w]);
    return Array.from(byPartner, ([partner, list]) => `${partner} (${list.map((w) => w.invoice).join(", ")})`).join(" and ");
  };
  const courierSentence =
    withCourier.length === 0
      ? ""
      : `${money(courierTotal)} of order value is paid — collected by ${listOrders(withCourier)} on delivery. We're just waiting for the courier to send it over.`;
  const onDeliverySentence =
    onDelivery.length === 0
      ? ""
      : `${money(onDeliveryTotal)} of order value will be paid on delivery — ${listOrders(onDelivery)} ${onDelivery.length === 1 ? "is" : "are"} on the way.`;

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
          cells: [entry.date.slice(0, 10), entry.title, PILL[entry.kind].text, entry.amount_label ? `${num(entry.amount)} ${entry.amount_label}` : signedAmount(entry.effect, true), balanceText(entry.running_balance, false).text],
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
        note:
          `Owed on invoices ${money(owed)}  |  Store credit available ${money(credit)}` +
          (courierTotal > 0 ? `  |  Paid to courier, awaiting payout ${money(courierTotal)}` : "") +
          (onDeliveryTotal > 0 ? `  |  To pay on delivery (COD) ${money(onDeliveryTotal)}` : ""),
      },
      filename: buildReportFilename("Customer Statement", `${customer.customer_code}-${toISODate(new Date())}`),
    });
  }

  useKeyboardShortcut("d", downloadPdf, { ctrlOrCmd: true, shift: true, enabled: !!customer && filteredEntries.length > 0 });

  const dateRangeRow = (
    <div className="flex items-center gap-3 flex-wrap">
      <p className="text-xs text-gray-500">Date range</p>
      <DateRangePicker startDate={startDate} endDate={endDate} onChange={(s, e) => { setStartDate(s); setEndDate(e); }} />
      <button
        onClick={() => {
          setStartDate(ninetyDaysAgoISO());
          setEndDate(toISODate(new Date()));
        }}
        className="text-xs text-gray-500 hover:text-gray-700 underline"
      >
        Reset to last 90 days
      </button>
      <button
        onClick={() => {
          setStartDate(null);
          setEndDate(null);
        }}
        className="text-xs text-gray-500 hover:text-gray-700 underline"
      >
        Show everything
      </button>
    </div>
  );

  return (
    <div>
      {!embedded && (
        <button
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-3"
        >
          <ArrowLeft size={14} />
          Back
        </button>
      )}

      {embedded ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-gray-500">{customer ? `${filteredEntries.length} of ${allEntries.length} record${allEntries.length === 1 ? "" : "s"} shown` : ""}</p>
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
        </div>
      ) : (
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
      )}

      {/* As a tab on the profile the three numbers are already at the top of the page, so only the explanations remain. */}
      {customer && embedded && (courierTotal > 0 || onDeliveryTotal > 0 || refundOwed > 0 || (credit > 0 && owed > 0)) && (
        <div className="mb-3 space-y-1.5 text-xs text-gray-600">
          {refundOwed > 0 && <p>Balance includes {money(refundOwed)} refund still to be paid out.</p>}
          {courierTotal > 0 && (
            <p className="flex items-start gap-1.5">
              <Check size={13} className="mt-px flex-shrink-0 text-emerald-600" />
              <span>{courierSentence}</span>
            </p>
          )}
          {onDeliveryTotal > 0 && (
            <p className="flex items-start gap-1.5">
              <Truck size={13} className="mt-px flex-shrink-0 text-gray-500" />
              <span>{onDeliverySentence}</span>
            </p>
          )}
          {credit > 0 && owed > 0 && (
            <p className="text-gray-400">
              Balance = {money(owed)} owed − {money(credit)} store credit. The credit comes off automatically at the next payment or invoice.
            </p>
          )}
        </div>
      )}

      {customer && !embedded && (
        <Card className="mb-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-0 sm:divide-x sm:divide-gray-100">
            <div className="sm:pr-6">
              <p className="text-xs text-gray-500">Balance now</p>
              <p className="text-2xl mt-0.5 tabular-nums text-gray-900 font-semibold">
                {headline.text}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                {refundOwed > 0
                  ? `includes ${money(refundOwed)} refund still to be paid out`
                  : finalBalance > 0
                  ? "still to be paid"
                  : finalBalance < 0
                  ? "available to spend"
                  : "nothing owed"}
              </p>
            </div>
            <div className="sm:px-6">
              <p className="text-xs text-gray-500">Owed on invoices</p>
              <p className="text-lg font-medium text-gray-900 mt-1 tabular-nums">{money(owed)}</p>
            </div>
            <div className="sm:pl-6">
              <p className="text-xs text-gray-500">Store credit available</p>
              <p className="text-lg font-medium text-gray-900 mt-1 tabular-nums">{money(credit)}</p>
            </div>
          </div>
          {courierTotal > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-gray-600 mt-3 pt-3 border-t border-gray-100">
              <Check size={13} className="mt-px flex-shrink-0 text-emerald-600" />
              <span>{courierSentence}</span>
            </p>
          )}
          {onDeliveryTotal > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-gray-600 mt-3 pt-3 border-t border-gray-100">
              <Truck size={13} className="mt-px flex-shrink-0 text-gray-500" />
              <span>{onDeliverySentence}</span>
            </p>
          )}
          {credit > 0 && owed > 0 && (
            <p className="text-xs text-gray-500 mt-3 pt-3 border-t border-gray-100">
              Balance = {money(owed)} owed − {money(credit)} store credit. The credit comes off automatically at the next payment or invoice.
            </p>
          )}
        </Card>
      )}

      {embedded ? <div className="mb-3">{dateRangeRow}</div> : <Card className="mb-4">{dateRangeRow}</Card>}

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <PageLoader />
      ) : allEntries.length === 0 ? (
        <EmptyState icon={Receipt} title="No records yet" subtitle="No sales, payments, cheques, or credit on file." />
      ) : filteredEntries.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="No records in this range"
          subtitle="Try widening the date filter above."
          actions={[
            {
              label: "Show everything",
              onClick: () => {
                setStartDate(null);
                setEndDate(null);
              },
            },
          ]}
        />
      ) : (
        <Card className="p-0 overflow-clip">
          <p className="text-xs text-gray-500 text-right px-4 pt-3">All amounts in Rs.</p>
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
                const time = timeOf(entry.date);
                const bal = balanceText(entry.running_balance, false);
                return (
                  <tr key={i} className="align-top">
                    <Td className="whitespace-nowrap">
                      <div className="text-gray-900">{formatDate(entry.date)}</div>
                      {time && <div className="text-xs text-gray-500 tabular-nums">{time}</div>}
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
                      <div className="flex items-center gap-2">
                        <Badge label={pill.text} tone={pill.tone} />
                        {entry.refund_key && <RefundSlipButton slipKey={entry.refund_key} />}
                      </div>
                    </Td>
                    <Td className="text-right tabular-nums whitespace-nowrap font-medium text-gray-900">
                      {entry.amount_label ? (
                        // Goods returned, or money paid out for them — it doesn't change what they owe, so it has no + or −.
                        <>
                          <div>{num(entry.amount)}</div>
                          <div className="text-xs font-normal text-gray-500">{entry.amount_label}</div>
                        </>
                      ) : (
                        signedAmount(entry.effect)
                      )}
                    </Td>
                    <Td className={`text-right tabular-nums whitespace-nowrap ${bal.className}`}>{bal.text}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <p className="text-xs text-gray-500 px-4 py-3 border-t border-gray-100">
            <strong className="font-medium text-gray-500">+</strong> adds to what they owe (a sale) · <strong className="font-medium text-gray-500">−</strong> takes
            away from it (a payment, or store credit for a return) · a return paid back in money reads <strong className="font-medium text-gray-500">Returned</strong> (what the goods came to — the shop owes them that), then what is <strong className="font-medium text-gray-500">deducted</strong> (the delivery charge), then <strong className="font-medium text-gray-500">Paid out</strong> (with a printable receipt), and the balance is settled · <strong className="font-medium text-gray-500">Balance</strong> = what's owed after counting that credit.
          </p>
        </Card>
      )}
    </div>
  );
}
