import { useEffect, useState, FormEvent, Fragment } from "react";
import { Landmark, Pencil, X, ArrowLeftRight, Plus, TrendingUp, TrendingDown, Wallet, Building2, ArrowUpRight, ArrowDownLeft, ChevronDown, ChevronRight } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { CashBookEntry } from "../lib/types";
import { PageHeader, Card, Input, Select, Label, FormGroup, ErrorText, SuccessText, Button, Table, Th, Td, EmptyState, Dropdown, DateRangePicker } from "../components/ui";

const PAYMENT_METHOD_OPTIONS = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cheque", label: "Cheque" },
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
    // Legacy values from earlier iterations — kept so any rows already
    // written still render as "Cheque" instead of a raw underscored string.
    chq_deposit: "Cheque",
    chq_debited: "Cheque",
    cheque_deposit: "Cheque",
    cheque_received: "Cheque",
    cheque_issued: "Cheque",
    cheque_clearing: "Cheque",
  };
  return map[raw] ?? raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Same idea as methodLabel, for the type column: display Credit/Debit,
// but the underlying value is still income/expense.
function typeLabel(t: string): string {
  if (t === "income") return "Credit";
  if (t === "expense") return "Debit";
  return t;
}

// Formats a plain digit string like "100000" as "100,000" for display.
// The underlying state always holds the raw digits — this runs only on
// the way INTO the input, so the value sent to the API stays numeric.
function formatAmountInput(raw: string): string {
  if (!raw) return "";
  const n = parseInt(raw, 10);
  if (isNaN(n)) return "";
  return n.toLocaleString("en-US");
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
  const PAGE_SIZE = 7;

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
  const [editAmount, setEditAmount] = useState("");
  const [editMethod, setEditMethod] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);

  const [expandedNotesId, setExpandedNotesId] = useState<number | null>(null);

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
  }, [entriesPage, dateStart, dateEnd]);

  useEffect(() => {
    loadStats();
  }, []);

  async function refreshAll() {
    await Promise.all([loadEntries(), loadStats()]);
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
    <div>
      <PageHeader
        title="Cash book"
        subtitle="Sales, supplier payments, and courier payments are logged here automatically."
        action={
          <Button onClick={() => setShowTransfer(true)} className="inline-flex items-center gap-1.5">
            <ArrowLeftRight size={15} />
            Move cash / bank
          </Button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
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
            <Wallet size={14} className="text-amber-600" />
            <p className="text-xs text-gray-500">Cash in hand</p>
          </div>
          <p className="text-lg font-semibold text-gray-900 tabular-nums">
            Rs. {cashTotal.toLocaleString()}
          </p>
        </div>
        <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3.5">
          <div className="flex items-center gap-2 mb-1">
            <Building2 size={14} className="text-blue-600" />
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

      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4 items-start">
        <Card className="lg:sticky lg:top-6">
          <div className="flex items-center gap-2 mb-1">
            <Plus size={15} className="text-gray-400" />
            <h2 className="text-sm font-semibold text-gray-900">Add manual entry</h2>
          </div>
          <p className="text-xs text-gray-400 mb-4">
            For anything with no other source — rent, utilities, misc income.
          </p>

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
                  <TrendingDown size={14} />
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
                  <TrendingUp size={14} />
                  Credit
                </button>
              </div>
            </FormGroup>

            <FormGroup>
              <Label>Amount (Rs.)</Label>
              <input
                type="text"
                inputMode="numeric"
                value={formatAmountInput(amount)}
                onChange={(e) => {
                  const raw = e.target.value.replace(/[^\d]/g, "");
                  setAmount(raw);
                }}
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
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Reference, remarks, etc." />
            </FormGroup>

            {formError && <ErrorText>{formError}</ErrorText>}
            {formSuccess && <SuccessText>{formSuccess}</SuccessText>}

            <Button type="submit" variant="primary" disabled={submitting} className="w-full mt-1">
              {submitting ? "Adding..." : "Add entry"}
            </Button>
          </form>
        </Card>

        <div className="min-w-0">
          <Card className="p-0 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
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
              </div>
            </div>

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
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-100">
                      <th className="w-[24px] px-2 py-2.5"></th>
                      <th className="text-left px-3 py-2.5 text-xs font-medium text-gray-400">Date</th>
                      <th className="text-left px-3 py-2.5 text-xs font-medium text-gray-400">Type</th>
                      <th className="text-left px-3 py-2.5 text-xs font-medium text-gray-400">Method</th>
                      <th className="text-right px-3 py-2.5 text-xs font-medium text-gray-400">Amount</th>
                      <th className="text-right px-3 py-2.5 text-xs font-medium text-gray-400">Balance</th>
                      <th className="w-[36px] px-2 py-2.5"></th>
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
                          <tr key={entry.id} className="bg-gray-50">
                            <td className="px-2 py-2"></td>
                            <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">
                              {entry.entry_date.slice(0, 16).replace("T", " ")}
                            </td>
                            <td className="px-3 py-2">
                              <span className={`inline-flex items-center gap-1 text-xs font-medium ${
                                entry.type === "income" ? "text-green-600" : "text-red-500"
                              }`}>
                                {entry.type === "income" ? <ArrowDownLeft size={12} /> : <ArrowUpRight size={12} />}
                                {typeLabel(entry.type)}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              <Dropdown value={editMethod} onChange={setEditMethod} placeholder="—" options={PAYMENT_METHOD_OPTIONS} />
                            </td>
                            <td className="px-3 py-2">
                              <Input
                                type="number"
                                min="0"
                                value={editAmount}
                                onChange={(e) => setEditAmount(e.target.value)}
                                className="w-full text-right tabular-nums"
                              />
                            </td>
                            <td className="px-3 py-2 text-right text-gray-500 tabular-nums whitespace-nowrap">
                              Rs. {entry.running_balance.toLocaleString()}
                            </td>
                            <td className="px-2 py-2">
                              <div className="flex items-center gap-1">
                                <Button size="sm" variant="primary" disabled={editSubmitting} onClick={() => saveEdit(entry.id)}>
                                  Save
                                </Button>
                                <button onClick={() => setEditingId(null)} className="text-gray-400 hover:text-gray-600">
                                  <X size={13} />
                                </button>
                              </div>
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
                                isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />
                              ) : null}
                            </td>
                            <td className="px-3 py-2.5 text-gray-500 text-xs whitespace-nowrap">
                              {entry.entry_date.slice(0, 16).replace("T", " ")}
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
                                    {hasNotes ? entry.notes : <span className="text-gray-400 italic">No notes on this entry</span>}
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

                <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 bg-gray-50/50">
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
              </>
            )}
          </Card>
        </div>
      </div>

      {showTransfer && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Move cash / bank</h2>
              <button onClick={() => setShowTransfer(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5">
              <p className="text-xs text-gray-400 mb-3">
                Moving money between cash-in-hand and the bank isn't credit or debit — it's the same money, just held
                differently. This records both sides together so your totals stay correct.
              </p>
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
              <div className="flex justify-end gap-2 mt-2">
                <Button onClick={() => setShowTransfer(false)}>Cancel</Button>
                <Button variant="primary" onClick={handleTransfer} disabled={transferSubmitting}>
                  {transferSubmitting ? "Recording..." : "Record transfer"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}