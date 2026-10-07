import { useEffect, useRef, useState, FormEvent, Fragment } from "react";
import { Landmark, Pencil, X, Check, Loader2, ArrowLeftRight, Plus, Minus, Wallet, Building2, ArrowUpRight, ArrowDownLeft, ChevronDown, ChevronRight, Download } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { CashBookEntry } from "../lib/types";
import { cleanMoney } from "../lib/numberInput";
import { downloadTabularReport, rangeLabelFor, buildReportFilename, todayLongDate } from "../lib/reportPdf";
import { PageHeader, Card, Input, Label, FormGroup, ErrorText, SuccessText, Button, EmptyState, Dropdown, DateRangePicker, HelpHint, RefLink, Modal } from "../components/ui";

// Row geometry used to work out how many entries fit on screen: a row with
// its date and transaction code on two lines, and the header row above them.
const DEFAULT_PAGE_SIZE = 7;
const TABLE_ROW_HEIGHT = 53;
const TABLE_HEAD_HEIGHT = 37;

const PAYMENT_METHOD_OPTIONS = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "cheque", label: "Cheque" },
  { value: "bank_transfer", label: "Bank Transfer" },
  { value: "other", label: "Other" },
];

const TYPE_OPTIONS = [
  { value: "expense", label: "Debit" },
  { value: "income", label: "Credit" },
];

const EDIT_WINDOW_HOURS = 24;

function isWithinEditWindow(entryDate: string): boolean {
  const hoursSince = (Date.now() - new Date(entryDate).getTime()) / (1000 * 60 * 60);
  return hoursSince <= EDIT_WINDOW_HOURS;
}

function defaultDateRange(): { start: string; end: string } {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  const toIso = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  return { start: toIso(start), end: toIso(end) };
}

function methodLabel(raw: string | null | undefined): string {
  if (!raw) return "—";
  const map: Record<string, string> = {
    cash: "Cash",
    card: "Card",
    bank_transfer: "Bank transfer",
    cheque: "Cheque",
    other: "Other",
    chq_deposit: "Cheque",
    chq_debited: "Cheque",
    cheque_deposit: "Cheque",
    cheque_received: "Cheque",
    cheque_issued: "Cheque",
    cheque_clearing: "Cheque",
  };
  return map[raw] ?? raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function typeLabel(t: string): string {
  if (t === "income") return "Credit";
  if (t === "expense") return "Debit";
  return t;
}

// Thousands commas while typing, keeping a typed decimal point and cents
// exactly as entered ("1,250." stays "1,250." until the cents arrive).
function formatAmountInput(raw: string): string {
  if (!raw) return "";
  const [whole, cents] = raw.split(".");
  const wholeText = whole ? parseInt(whole, 10).toLocaleString("en-US") : "0";
  return cents === undefined ? wholeText : `${wholeText}.${cents}`;
}

// An inline-edit control that sits exactly where the text it replaces was.
// The original text stays in the cell (invisible) so the column keeps its
// width and the row keeps its height; the control floats over it, as wide
// as that column (a few pixels into the cell padding so it isn't cramped).
// It never stretches the table, and neighbouring controls never overlap.
function InPlace({ original, children }: { original: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="relative">
      <div className="invisible" aria-hidden="true">
        {original}
      </div>
      <div className="absolute top-1/2 -translate-y-1/2 -inset-x-1.5">{children}</div>
    </div>
  );
}

// Digits with at most one decimal point — a plain text box (no number-
// spinner arrows) for typing an amount.
function cleanDecimal(raw: string): string {
  const digits = raw.replace(/[^\d.]/g, "");
  const [whole, ...rest] = digits.split(".");
  return rest.length > 0 ? `${whole}.${rest.join("")}` : whole;
}

export default function CashBookPage() {
  const initialRange = defaultDateRange();

  const [entries, setEntries] = useState<CashBookEntry[]>([]);
  const [entriesTotal, setEntriesTotal] = useState(0);
  const [entriesPage, setEntriesPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateStart, setDateStart] = useState(initialRange.start);
  const [dateEnd, setDateEnd] = useState(initialRange.end);
  // How many entries a page holds. On desktop the page fits the screen, so
  // this follows the room the table has (see the observer below); on a
  // phone it stays at a short fixed page.
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const tableBodyRef = useRef<HTMLDivElement>(null);
  const PAGE_SIZE = pageSize;

  const [stats, setStats] = useState<{
    current_balance: number;
    cash_total: number;
    bank_total: number;
    unspecified_total: number;
  } | null>(null);

  const [type, setType] = useState<"income" | "expense">("expense");
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [showTransfer, setShowTransfer] = useState(false);
  const [transferDirection, setTransferDirection] = useState<"cash_to_bank" | "bank_to_cash">("cash_to_bank");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferNotes, setTransferNotes] = useState("");
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferSuccess, setTransferSuccess] = useState<string | null>(null);
  const [transferSubmitting, setTransferSubmitting] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editType, setEditType] = useState<"income" | "expense">("expense");
  const [editAmount, setEditAmount] = useState("");
  const [editMethod, setEditMethod] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);

  const [expandedNotesId, setExpandedNotesId] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function loadStats() {
    try {
      const result = await api.get<{
        current_balance: number;
        cash_total: number;
        bank_total: number;
        unspecified_total: number;
      }>("/cash-book/summary");
      setStats(result);
    } catch {
      // stats are supporting info — a failure here shouldn't block the page
    }
  }

  async function loadEntries() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(entriesPage), pageSize: String(PAGE_SIZE) });
      if (dateStart) params.set("start", dateStart);
      if (dateEnd) params.set("end", dateEnd);
      const result = await api.get<{ rows: CashBookEntry[]; total: number }>(`/cash-book?${params.toString()}`);
      setEntries(result.rows);
      setEntriesTotal(result.total);

      const lastValidPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
      if (entriesPage > lastValidPage) {
        setEntriesPage(lastValidPage);
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load cash book");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadEntries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entriesPage, dateStart, dateEnd, pageSize]);

  // Fill the table area with as many rows as fit — never fewer than 5. The
  // area keeps the same height whether it is loading, empty or full (the
  // footer is always there), so this can't flip back and forth.
  useEffect(() => {
    const el = tableBodyRef.current;
    if (!el) return;
    const fit = () => {
      if (!window.matchMedia("(min-width: 1024px)").matches) return setPageSize(DEFAULT_PAGE_SIZE);
      const rows = Math.floor((el.clientHeight - TABLE_HEAD_HEIGHT) / TABLE_ROW_HEIGHT);
      setPageSize(Math.min(30, Math.max(5, rows)));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  useEffect(() => {
    loadStats();
  }, []);

  async function refreshAll() {
    await Promise.all([loadEntries(), loadStats()]);
  }

  const REPORT_ROW_CAP = 500;

  async function downloadPdf() {
    setDownloadError(null);
    setDownloading(true);
    try {
      const params = new URLSearchParams({ page: "1", pageSize: String(REPORT_ROW_CAP) });
      if (dateStart) params.set("start", dateStart);
      if (dateEnd) params.set("end", dateEnd);
      const result = await api.get<{ rows: CashBookEntry[]; total: number }>(`/cash-book?${params.toString()}`);
      const rangeLabel = rangeLabelFor(dateStart || null, dateEnd || null);
      const truncated = result.total > result.rows.length;

      downloadTabularReport({
        headerLabel: "M&M Clothing — Cash Book Report",
        headerFields: [
          { label: "Report", value: "Cash Book" },
          { label: "Period", value: rangeLabel },
          { label: "Generated", value: todayLongDate() },
        ],
        rangeLabel,
        columns: [
          { label: "Code", width: 70 },
          { label: "Date", width: 95 },
          { label: "Type", width: 60 },
          { label: "Method", width: 90 },
          { label: "Amount", width: 105, align: "right" },
          { label: "Balance", width: 105, align: "right" },
        ],
        rows: result.rows.map((entry) => ({
          cells: [
            entry.transaction_code ?? "—",
            entry.entry_date.slice(0, 16).replace("T", " "),
            typeLabel(entry.type),
            methodLabel(entry.payment_method),
            `${entry.type === "income" ? "+" : "-"} Rs. ${entry.amount.toLocaleString()}`,
            `Rs. ${entry.running_balance.toLocaleString()}`,
          ],
          styles: [undefined, undefined, undefined, undefined, { color: entry.type === "income" ? ([21, 128, 61] as [number, number, number]) : ([220, 38, 38] as [number, number, number]) }, undefined],
        })),
        summaryLines: truncated
          ? [{ text: `Showing the latest ${result.rows.length} of ${result.total} entries — narrow the date range for a complete report.` }]
          : undefined,
        totalSummary: {
          label: "Closing balance for this range",
          amount: `Rs. ${(result.rows[0]?.running_balance ?? 0).toLocaleString()}`,
        },
        filename: buildReportFilename("Cash Book", `${dateStart || "all"}-to-${dateEnd || "now"}`),
      });
    } catch (err) {
      setDownloadError(err instanceof ApiRequestError ? err.message : "Failed to generate report");
    } finally {
      setDownloading(false);
    }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);
    if (!amount || parseFloat(amount) <= 0) {
      setFormError("Enter a valid amount");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/cash-book", {
        type,
        category: "other",
        payment_method: paymentMethod,
        amount: parseFloat(amount),
        notes: notes.trim() || undefined,
      });
      setAmount("");
      setNotes("");
      setFormSuccess("Entry added.");
      setEntriesPage(1);
      refreshAll();
      setTimeout(() => setFormSuccess(null), 2000);
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? err.message : "Failed to add entry");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTransfer() {
    setTransferError(null);
    setTransferSuccess(null);
    if (!transferAmount || parseFloat(transferAmount) <= 0) {
      setTransferError("Enter a valid amount");
      return;
    }
    setTransferSubmitting(true);
    try {
      await api.post("/cash-book/transfer", {
        direction: transferDirection,
        amount: parseFloat(transferAmount),
        notes: transferNotes.trim() || undefined,
      });
      setTransferSuccess("Transfer recorded.");
      setTransferAmount("");
      setTransferNotes("");
      refreshAll();
      setTimeout(() => {
        setShowTransfer(false);
        setTransferSuccess(null);
      }, 900);
    } catch (err) {
      setTransferError(err instanceof ApiRequestError ? err.message : "Failed to record transfer");
    } finally {
      setTransferSubmitting(false);
    }
  }

  function toggleNotesRow(entryId: number) {
    if (editingId === entryId) setEditingId(null);
    setExpandedNotesId((prev) => (prev === entryId ? null : entryId));
  }

  function startEdit(entry: CashBookEntry, e?: React.MouseEvent) {
    if (e) e.stopPropagation();
    setExpandedNotesId(null);
    setEditingId(entry.id);
    setEditType(entry.type === "income" ? "income" : "expense");
    setEditAmount(String(entry.amount));
    setEditMethod(entry.payment_method ?? "");
    setEditNotes(entry.notes ?? "");
    setEditError(null);
  }

  async function saveEdit(id: number) {
    setEditError(null);
    if (!editAmount || parseFloat(editAmount) <= 0) {
      setEditError("Enter a valid amount");
      return;
    }
    setEditSubmitting(true);
    try {
      await api.put(`/cash-book/${id}`, {
        type: editType,
        amount: parseFloat(editAmount),
        payment_method: editMethod || undefined,
        notes: editNotes.trim() || undefined,
      });
      setEditingId(null);
      refreshAll();
    } catch (err) {
      setEditError(err instanceof ApiRequestError ? err.message : "Failed to save changes");
    } finally {
      setEditSubmitting(false);
    }
  }

  const currentBalance = stats?.current_balance ?? 0;
  const cashTotal = stats?.cash_total ?? 0;
  const bankTotal = stats?.bank_total ?? 0;
  const unspecifiedTotal = stats?.unspecified_total ?? 0;

  const totalPages = Math.max(1, Math.ceil(entriesTotal / PAGE_SIZE));

  const rangeStart = entriesTotal === 0 ? 0 : (entriesPage - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(entriesPage * PAGE_SIZE, entriesTotal);

  const isFiltered = !!(dateStart || dateEnd);

  return (
    <div className="flex flex-col lg:flex-1 lg:min-h-0">
      <div className="flex-shrink-0">
        <PageHeader
          title="Cash book"
          subtitle="Sales, returns, purchases, supplier payments, cheques, and courier settlements are logged here automatically."
          action={
            <Button onClick={() => setShowTransfer(true)} className="inline-flex items-center gap-1.5">
              <ArrowLeftRight size={14} />
              Move cash / bank
            </Button>
          }
        />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4 flex-shrink-0">
        <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3.5">
          <div className="flex items-center gap-2 mb-1">
            <Landmark size={14} className="text-gray-400" />
            <p className="text-xs text-gray-500">Current balance</p>
          </div>
          <p className="text-lg font-semibold text-gray-900 tabular-nums">
            Rs. {currentBalance.toLocaleString()}
          </p>
        </div>
        <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3.5">
          <div className="flex items-center gap-2 mb-1">
            <Wallet size={14} className="text-gray-400" />
            <p className="text-xs text-gray-500">Cash in hand</p>
          </div>
          <p className="text-lg font-semibold text-gray-900 tabular-nums">
            Rs. {cashTotal.toLocaleString()}
          </p>
        </div>
        <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3.5">
          <div className="flex items-center gap-2 mb-1">
            <Building2 size={14} className="text-gray-400" />
            <p className="text-xs text-gray-500">Bank [HNB]</p>
          </div>
          <p className="text-lg font-semibold text-gray-900 tabular-nums">
            Rs. {bankTotal.toLocaleString()}
          </p>
        </div>
        {unspecifiedTotal !== 0 ? (
          <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3.5">
            <div className="flex items-center gap-2 mb-1">
              <Landmark size={14} className="text-gray-400" />
              <p className="text-xs text-gray-500">Unspecified</p>
            </div>
            <p className="text-lg font-semibold text-gray-900 tabular-nums">
              Rs. {unspecifiedTotal.toLocaleString()}
            </p>
          </div>
        ) : (
          <div className="bg-white border border-dashed border-gray-200 rounded-2xl px-4 py-3.5 flex items-center justify-center">
            <p className="text-xs text-gray-300">No unspecified entries</p>
          </div>
        )}
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] lg:grid-rows-[minmax(0,1fr)] gap-4 items-start lg:items-stretch lg:flex-1 lg:min-h-0">
        <Card className="lg:min-h-0 lg:overflow-y-auto">
          <div className="flex items-center gap-2 mb-4">
            <Plus size={14} className="text-gray-400" />
            <h2 className="text-sm font-semibold text-gray-900">Add manual entry</h2>
            <HelpHint text="For anything with no other source — rent, utilities, misc income." />
          </div>

          <form onSubmit={handleAdd}>
            <FormGroup>
              <Label>Type</Label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setType("expense")}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded-xl border py-2 text-sm font-medium transition ${
                    type === "expense"
                      ? "border-red-500 bg-red-50 text-red-700"
                      : "border-gray-200 text-gray-600 hover:border-gray-300"
                  }`}
                >
                  <Minus size={14} />
                  Debit
                </button>
                <button
                  type="button"
                  onClick={() => setType("income")}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded-xl border py-2 text-sm font-medium transition ${
                    type === "income"
                      ? "border-green-600 bg-green-50 text-green-700"
                      : "border-gray-200 text-gray-600 hover:border-gray-300"
                  }`}
                >
                  <Plus size={14} />
                  Credit
                </button>
              </div>
            </FormGroup>

            <FormGroup>
              <Label>Amount (Rs.)</Label>
              <input
                type="text"
                inputMode="decimal"
                value={formatAmountInput(amount)}
                onChange={(e) => setAmount(cleanMoney(e.target.value))}
                placeholder="0"
                className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-lg font-medium tabular-nums text-right placeholder:text-right text-black focus:outline-none focus:border-gray-400"
              />
            </FormGroup>

            <FormGroup>
              <Label>Payment method</Label>
              <Dropdown value={paymentMethod} onChange={setPaymentMethod} options={PAYMENT_METHOD_OPTIONS} />
            </FormGroup>

            <FormGroup>
              <Label>Notes (optional)</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </FormGroup>

            {formError && <ErrorText>{formError}</ErrorText>}
            {formSuccess && <SuccessText>{formSuccess}</SuccessText>}

            <Button type="submit" variant="primary" disabled={submitting} className="w-full mt-1">
              {submitting ? "Adding..." : "Add entry"}
            </Button>
          </form>
        </Card>

        <div className="min-w-0 flex flex-col lg:min-h-0">
          <Card className="p-0 overflow-hidden flex flex-col lg:flex-1 lg:min-h-0">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap flex-shrink-0">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">All entries</h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  {entriesTotal === 0 ? "No entries in this range" : `${entriesTotal.toLocaleString()} total`}
                  {isFiltered && (
                    <>
                      {" · "}
                      <span className="text-gray-500">
                        {dateStart && dateEnd
                          ? `${dateStart} to ${dateEnd}`
                          : dateStart
                          ? `from ${dateStart}`
                          : `until ${dateEnd}`}
                      </span>
                    </>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {isFiltered && (
                  <button
                    onClick={() => {
                      setDateStart("");
                      setDateEnd("");
                      setEntriesPage(1);
                    }}
                    className="text-xs text-gray-500 hover:text-gray-800 underline"
                  >
                    Clear filter
                  </button>
                )}
                <DateRangePicker
                  startDate={dateStart || null}
                  endDate={dateEnd || null}
                  onChange={(s, e) => {
                    setDateStart(s ?? "");
                    setDateEnd(e ?? "");
                    setEntriesPage(1);
                  }}
                />
                <Button onClick={downloadPdf} disabled={downloading || entries.length === 0} className="inline-flex items-center gap-1.5">
                  <Download size={14} />
                  {downloading ? "Preparing..." : "Download PDF"}
                </Button>
              </div>
            </div>
            {downloadError && (
              <div className="px-4 pt-3 flex-shrink-0">
                <ErrorText>{downloadError}</ErrorText>
              </div>
            )}

            <div ref={tableBodyRef} className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
            {loading ? (
              <div className="p-4">
                <p className="text-sm text-gray-400">Loading...</p>
              </div>
            ) : entries.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  icon={Landmark}
                  title={isFiltered ? "No entries in this date range" : "No cash book entries yet"}
                />
              </div>
            ) : (
              <>
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-gray-50 shadow-[inset_0_-1px_0_0_#f3f4f6]">
                    <tr className="bg-gray-50">
                      <th className="w-[24px] px-2 py-2.5"></th>
                      <th className="text-left px-3 py-2.5 text-xs font-medium text-gray-400">Date</th>
                      <th className="text-left px-3 py-2.5 text-xs font-medium text-gray-400 min-w-[84px]">Type</th>
                      <th className="text-left px-3 py-2.5 text-xs font-medium text-gray-400 min-w-[128px]">Method</th>
                      <th className="text-right px-3 py-2.5 text-xs font-medium text-gray-400">Amount</th>
                      <th className="text-right px-3 py-2.5 text-xs font-medium text-gray-400">Balance</th>
                      <th className="w-[90px] px-2 py-2.5"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {entries.map((entry) => {
                      const editable = isWithinEditWindow(entry.entry_date);
                      const isEditing = editingId === entry.id;
                      const isExpanded = expandedNotesId === entry.id;
                      const hasNotes = !!(entry.notes && entry.notes.trim());

                      if (isEditing) {
                        return (
                          <tr
                            key={entry.id}
                            className="bg-gray-50"
                            onKeyDown={(e) => {
                              if (e.key === "Escape") setEditingId(null);
                              else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && !editSubmitting) saveEdit(entry.id);
                            }}
                          >
                            <td className="px-2 py-2.5"></td>
                            <td className="px-3 py-2.5 text-gray-500 text-xs whitespace-nowrap">
                              {entry.entry_date.slice(0, 16).replace("T", " ")}
                              {entry.transaction_code && (
                                <span className="block text-[10px] text-gray-300 font-mono">{entry.transaction_code}</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5">
                              <InPlace
                                original={
                                  <span className="inline-flex items-center gap-1 text-xs font-medium">
                                    {entry.type === "income" ? <ArrowDownLeft size={12} /> : <ArrowUpRight size={12} />}
                                    {typeLabel(entry.type)}
                                  </span>
                                }
                              >
                                <Dropdown
                                  value={editType}
                                  onChange={(v) => setEditType(v as "income" | "expense")}
                                  options={TYPE_OPTIONS}
                                  size="sm"
                                />
                              </InPlace>
                            </td>
                            <td className="px-3 py-2.5 text-xs">
                              <InPlace original={methodLabel(entry.payment_method)}>
                                <Dropdown
                                  value={editMethod}
                                  onChange={setEditMethod}
                                  placeholder="—"
                                  options={PAYMENT_METHOD_OPTIONS}
                                  size="sm"
                                />
                              </InPlace>
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                              <InPlace
                                original={
                                  <span className="font-medium">
                                    {entry.type === "income" ? "+" : "−"} Rs. {entry.amount.toLocaleString()}
                                  </span>
                                }
                              >
                                <Input
                                  type="text"
                                  inputMode="decimal"
                                  value={editAmount}
                                  onChange={(e) => setEditAmount(cleanDecimal(e.target.value))}
                                  className="text-right tabular-nums font-medium !h-7 !py-0 !px-2 !text-sm !rounded-lg"
                                />
                              </InPlace>
                            </td>
                            <td className="px-3 py-2.5 text-right text-gray-500 tabular-nums whitespace-nowrap">
                              Rs. {entry.running_balance.toLocaleString()}
                            </td>
                            <td className="px-2 py-2.5">
                              {/* Two matching 28px buttons, the same height and corner
                                  radius as the dropdowns and amount box beside them. */}
                              <div className="-my-1 flex items-center justify-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => saveEdit(entry.id)}
                                  disabled={editSubmitting}
                                  title="Save changes (Enter)"
                                  aria-label="Save changes"
                                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-gray-900 text-white shadow-sm transition hover:bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {editSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingId(null)}
                                  disabled={editSubmitting}
                                  title="Cancel (Esc)"
                                  aria-label="Cancel editing"
                                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 transition hover:border-gray-300 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 focus-visible:ring-offset-1 disabled:opacity-60"
                                >
                                  <X size={14} />
                                </button>
                              </div>
                              {editError && <p className="text-[10px] text-red-500 mt-0.5">{editError}</p>}
                            </td>
                          </tr>
                        );
                      }

                      return (
                        <Fragment key={entry.id}>
                          <tr
                            onClick={() => toggleNotesRow(entry.id)}
                            className={`cursor-pointer transition-colors ${
                              isExpanded ? "bg-gray-50" : "hover:bg-gray-50"
                            }`}
                          >
                            <td className="px-2 py-2.5 text-gray-400">
                              {hasNotes ? (
                                isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
                              ) : null}
                            </td>
                            <td className="px-3 py-2.5 text-gray-500 text-xs whitespace-nowrap">
                              {entry.entry_date.slice(0, 16).replace("T", " ")}
                              {entry.transaction_code && (
                                <span className="block text-[10px] text-gray-300 font-mono">{entry.transaction_code}</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5">
                              <span className={`inline-flex items-center gap-1 text-xs font-medium ${
                                entry.type === "income" ? "text-green-600" : "text-red-500"
                              }`}>
                                {entry.type === "income" ? <ArrowDownLeft size={12} /> : <ArrowUpRight size={12} />}
                                {typeLabel(entry.type)}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-gray-600 text-xs">
                              {methodLabel(entry.payment_method)}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                              <span className={entry.type === "income" ? "text-green-700 font-medium" : "text-red-600 font-medium"}>
                                {entry.type === "income" ? "+" : "−"} Rs. {entry.amount.toLocaleString()}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-gray-500 whitespace-nowrap">
                              Rs. {entry.running_balance.toLocaleString()}
                            </td>
                            <td className="px-2 py-2.5 text-center">
                              {editable && (
                                <button
                                  onClick={(e) => startEdit(entry, e)}
                                  className="text-gray-400 hover:text-gray-800 transition"
                                  title="Edit (within 24 hours only)"
                                >
                                  <Pencil size={14} />
                                </button>
                              )}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-gray-50">
                              <td colSpan={7} className="px-4 py-3 border-t border-gray-100">
                                <div className="flex items-start gap-2">
                                  <div className="text-[10px] uppercase tracking-wide text-gray-400 font-medium pt-0.5 flex-shrink-0">
                                    Notes
                                  </div>
                                  <p className="text-xs text-gray-700 whitespace-pre-wrap leading-relaxed">
                                    {!hasNotes ? (
                                      <span className="text-gray-400 italic">No notes on this entry</span>
                                    ) : (entry.category === "sale" || entry.category === "sale_void") && entry.reference_id ? (
                                      <RefLink to={`/sales/${entry.reference_id}`}>{entry.notes}</RefLink>
                                    ) : (
                                      entry.notes
                                    )}
                                  </p>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
            </div>

            {/* Always shown, so the table area above keeps one height whether it is loading, empty or full. */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 bg-gray-50/50 flex-shrink-0">
              <p className="text-xs text-gray-500">
                Showing <span className="text-gray-700">{rangeStart}–{rangeEnd}</span> of{" "}
                <span className="text-gray-700">{entriesTotal.toLocaleString()}</span>
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setEntriesPage((p) => Math.max(1, p - 1))}
                  disabled={entriesPage === 1}
                  className="px-2.5 py-1 text-xs border border-gray-200 rounded-lg hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed bg-white"
                >
                  Previous
                </button>
                <span className="px-2 text-xs text-gray-500 tabular-nums">
                  Page {entriesPage} of {totalPages}
                </span>
                <button
                  onClick={() => setEntriesPage((p) => p + 1)}
                  disabled={entriesPage >= totalPages}
                  className="px-2.5 py-1 text-xs border border-gray-200 rounded-lg hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed bg-white"
                >
                  Next
                </button>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {showTransfer && (
        <Modal
          size="md"
          onClose={() => setShowTransfer(false)}
          title="Move cash / bank"
          subtitle="This isn't credit or debit — it's the same money, just held differently. Both sides are recorded together so totals stay correct."
          footer={
            <>
              <Button onClick={() => setShowTransfer(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleTransfer} disabled={transferSubmitting}>
                {transferSubmitting ? "Recording..." : "Record transfer"}
              </Button>
            </>
          }
        >
        <FormGroup>
          <Label>Direction</Label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setTransferDirection("cash_to_bank")}
              className={`flex-1 border rounded-xl px-3 py-2.5 text-sm text-left ${
                transferDirection === "cash_to_bank" ? "border-black bg-black text-white" : "border-gray-200 text-gray-700 hover:border-gray-400"
              }`}
            >
              Cash → Bank
              <div className={`text-xs mt-0.5 ${transferDirection === "cash_to_bank" ? "text-gray-300" : "text-gray-400"}`}>
                Depositing cash in hand
              </div>
            </button>
            <button
              type="button"
              onClick={() => setTransferDirection("bank_to_cash")}
              className={`flex-1 border rounded-xl px-3 py-2.5 text-sm text-left ${
                transferDirection === "bank_to_cash" ? "border-black bg-black text-white" : "border-gray-200 text-gray-700 hover:border-gray-400"
              }`}
            >
              Bank → Cash
              <div className={`text-xs mt-0.5 ${transferDirection === "bank_to_cash" ? "text-gray-300" : "text-gray-400"}`}>
                Withdrawing to cash in hand
              </div>
            </button>
          </div>
        </FormGroup>
        <FormGroup>
          <Label>Amount (Rs.)</Label>
          <Input type="number" min="0" value={transferAmount} onChange={(e) => setTransferAmount(e.target.value)} />
        </FormGroup>
        <FormGroup>
          <Label>Notes (optional)</Label>
          <Input value={transferNotes} onChange={(e) => setTransferNotes(e.target.value)} />
        </FormGroup>
        {transferError && <ErrorText>{transferError}</ErrorText>}
        {transferSuccess && <SuccessText>{transferSuccess}</SuccessText>}
        </Modal>
      )}
    </div>
  );
}