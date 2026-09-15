import { useEffect, useState, FormEvent } from "react";
import { Landmark, Pencil, X, ArrowLeftRight } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { CashBookEntry } from "../lib/types";
import { PageHeader, Card, StatCard, Input, Select, Label, FormGroup, ErrorText, SuccessText, Button, Table, Th, Td, EmptyState, Dropdown } from "../components/ui";

const PAYMENT_METHOD_OPTIONS = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "bank_transfer", label: "Bank transfer" },
];

// An entry can be edited/deleted only within this many hours of creation
// — matches the same rule enforced server-side, so the UI doesn't offer
// an action that would just be rejected.
const EDIT_WINDOW_HOURS = 24;

function isWithinEditWindow(entryDate: string): boolean {
  const hoursSince = (Date.now() - new Date(entryDate).getTime()) / (1000 * 60 * 60);
  return hoursSince <= EDIT_WINDOW_HOURS;
}

export default function CashBookPage() {
  const [entries, setEntries] = useState<CashBookEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState<"income" | "expense">("expense");
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Move cash <-> bank — a dedicated action, since a transfer is neither
  // real income nor a real expense, just money changing where it's held.
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferDirection, setTransferDirection] = useState<"cash_to_bank" | "bank_to_cash">("cash_to_bank");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferNotes, setTransferNotes] = useState("");
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferSuccess, setTransferSuccess] = useState<string | null>(null);
  const [transferSubmitting, setTransferSubmitting] = useState(false);

  // Inline edit — one row at a time, within the 24-hour window only.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editMethod, setEditMethod] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setEntries(await api.get<CashBookEntry[]>("/cash-book"));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load cash book");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
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
      load();
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
      load();
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

  function startEdit(entry: CashBookEntry) {
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
      load();
    } catch (err) {
      setEditError(err instanceof ApiRequestError ? err.message : "Failed to save changes");
    } finally {
      setEditSubmitting(false);
    }
  }

  const currentBalance = entries[0]?.running_balance ?? 0;

  // Cash-on-hand vs bank balance — card and bank_transfer both land in
  // the same HNB account, so they're combined into one real "Bank
  // Balance" figure. Cash stays separate since it's physically different
  // money. "Unspecified" (no payment_method recorded) is shown only when
  // it's genuinely non-zero, rather than as a permanent placeholder card.
  let cashTotal = 0;
  let bankTotal = 0;
  let unspecifiedTotal = 0;
  for (const e of entries) {
    const signedAmount = e.type === "income" ? e.amount : -e.amount;
    if (e.payment_method === "cash") cashTotal += signedAmount;
    else if (e.payment_method === "card" || e.payment_method === "bank_transfer") bankTotal += signedAmount;
    else unspecifiedTotal += signedAmount;
  }

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

      <div className="flex flex-wrap gap-3 mb-5">
        <StatCard label="Current balance" value={`Rs. ${currentBalance.toLocaleString()}`} />
        <StatCard label="Cash in hand" value={`Rs. ${cashTotal.toLocaleString()}`} />
        <StatCard label="Bank balance [HNB]" value={`Rs. ${bankTotal.toLocaleString()}`} />
        {unspecifiedTotal !== 0 && <StatCard label="Unspecified" value={`Rs. ${unspecifiedTotal.toLocaleString()}`} />}
      </div>

      <Card className="max-w-lg mb-5">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Add manual entry</h2>
        <p className="text-xs text-gray-400 mb-3">For anything with no other source — rent, utilities, misc income.</p>
        <form onSubmit={handleAdd}>
          <div className="grid grid-cols-2 gap-3">
            <FormGroup>
              <Label>Type</Label>
              <Select value={type} onChange={(e) => setType(e.target.value as "income" | "expense")}>
                <option value="expense">Expense</option>
                <option value="income">Income</option>
              </Select>
            </FormGroup>
            <FormGroup>
              <Label>Amount (Rs.)</Label>
              <Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FormGroup>
          </div>
          <FormGroup>
            <Label>Payment method</Label>
            <Dropdown value={paymentMethod} onChange={setPaymentMethod} options={PAYMENT_METHOD_OPTIONS} />
          </FormGroup>
          <FormGroup>
            <Label>Notes</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormGroup>
          {formError && <ErrorText>{formError}</ErrorText>}
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? "Adding..." : "Add entry"}
          </Button>
        </form>
      </Card>

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : entries.length === 0 ? (
        <EmptyState icon={Landmark} title="No cash book entries yet" />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Type</Th>
                <Th>Category</Th>
                <Th>Method</Th>
                <Th>Amount</Th>
                <Th>Running balance</Th>
                <Th>Notes</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const editable = isWithinEditWindow(entry.entry_date);
                const isEditing = editingId === entry.id;

                if (isEditing) {
                  return (
                    <tr key={entry.id} className="bg-gray-50">
                      <Td>{entry.entry_date.slice(0, 16).replace("T", " ")}</Td>
                      <Td className={entry.type === "income" ? "text-green-600" : "text-red-500"}>
                        {entry.type === "income" ? "+" : "-"} {entry.type}
                      </Td>
                      <Td className="capitalize">{entry.category}</Td>
                      <Td>
                        <Dropdown value={editMethod} onChange={setEditMethod} placeholder="—" options={PAYMENT_METHOD_OPTIONS} />
                      </Td>
                      <Td>
                        <Input type="number" min="0" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} className="w-28" />
                      </Td>
                      <Td>Rs. {entry.running_balance.toLocaleString()}</Td>
                      <Td>
                        <Input value={editNotes} onChange={(e) => setEditNotes(e.target.value)} className="w-40" />
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="primary" disabled={editSubmitting} onClick={() => saveEdit(entry.id)}>
                            Save
                          </Button>
                          <button onClick={() => setEditingId(null)} className="text-gray-400 hover:text-gray-600">
                            <X size={16} />
                          </button>
                        </div>
                        {editError && <ErrorText>{editError}</ErrorText>}
                      </Td>
                    </tr>
                  );
                }

                return (
                  <tr key={entry.id} className="hover:bg-gray-50">
                    <Td>{entry.entry_date.slice(0, 16).replace("T", " ")}</Td>
                    <Td className={entry.type === "income" ? "text-green-600" : "text-red-500"}>
                      {entry.type === "income" ? "+" : "-"} {entry.type}
                    </Td>
                    <Td className="capitalize">{entry.category}</Td>
                    <Td className="capitalize">{entry.payment_method?.replace("_", " ") ?? "—"}</Td>
                    <Td>Rs. {entry.amount.toLocaleString()}</Td>
                    <Td>Rs. {entry.running_balance.toLocaleString()}</Td>
                    <Td>{entry.notes ?? "—"}</Td>
                    <Td>
                      {editable && (
                        <button onClick={() => startEdit(entry)} className="text-gray-400 hover:text-gray-800" title="Edit (within 24 hours only)">
                          <Pencil size={14} />
                        </button>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}

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
                Moving money between cash-in-hand and the bank isn't income or an expense — it's the same money, just held
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
              <div className="flex gap-2 mt-2">
                <Button variant="primary" onClick={handleTransfer} disabled={transferSubmitting}>
                  {transferSubmitting ? "Recording..." : "Record transfer"}
                </Button>
                <Button onClick={() => setShowTransfer(false)}>Cancel</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
