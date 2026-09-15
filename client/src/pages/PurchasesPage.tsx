import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Package, Clock, Trash2, RotateCcw } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Supplier, Purchase } from "../lib/types";
import {
  PageHeader,
  Card,
  Input,
  Label,
  FormGroup,
  ErrorText,
  SuccessText,
  Button,
  Table,
  Th,
  Td,
  Dropdown,
  EmptyState,
  DateRangePicker,
  DatePicker,
} from "../components/ui";

interface DraftLine {
  description: string;
  quantity: string;
  unit_cost: string;
  product_type: "FO" | "OG" | "OR" | "OP";
}

interface DraftExpense {
  label: string;
  amount: string;
}

// A purchase can be edited/deleted only within this window of creation
// — matches the same rule enforced server-side.
const EDIT_WINDOW_HOURS = 24;

function isWithinEditWindow(dateStr: string): boolean {
  const hoursSince = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60);
  return hoursSince <= EDIT_WINDOW_HOURS;
}

export default function PurchasesPage() {
  const navigate = useNavigate();
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [pending, setPending] = useState<Purchase[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [markingSortedId, setMarkingSortedId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // Editing a purchase — one at a time, in a modal. Supplier/description
  // are always editable within the window; line quantity/cost only when
  // the purchase is still pending (see the backend for why).
  const [editingPurchase, setEditingPurchase] = useState<Purchase | null>(null);
  const [editSupplierId, setEditSupplierId] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editLines, setEditLines] = useState<{ id: number; description: string; quantity: string; unit_cost: string }[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);

  const [showRecord, setShowRecord] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ description: "", quantity: "", unit_cost: "", product_type: "OG" }]);
  const [amountPaid, setAmountPaid] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "bank_transfer" | "card" | "cheque">("cash");
  // Only relevant when paymentMethod is "cheque" — which kind:
  const [chequeKind, setChequeKind] = useState<"in_hand" | "own">("in_hand");
  const [chequeSearchNumber, setChequeSearchNumber] = useState("");
  const [chequeMatch, setChequeMatch] = useState<any | null>(null);
  const [chequeSearchError, setChequeSearchError] = useState<string | null>(null);
  const [ownChequeNumber, setOwnChequeNumber] = useState("");
  const [ownChequeBankName, setOwnChequeBankName] = useState("");
  const [ownChequeDate, setOwnChequeDate] = useState("");
  const [expenses, setExpenses] = useState<DraftExpense[]>([]);
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // History date range — defaults to no filter (everything), since a
  // brand-new shop won't have enough records yet for it to matter, but
  // narrows down cleanly once the list grows.
  const [historyStart, setHistoryStart] = useState<string | null>(null);
  const [historyEnd, setHistoryEnd] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [p, pend, s] = await Promise.all([
        api.get<Purchase[]>("/purchases"),
        api.get<Purchase[]>("/purchases/pending"),
        api.get<Supplier[]>("/suppliers"),
      ]);
      setPurchases(p.filter((x) => x.fulfillment_status === "fulfilled"));
      setPending(pend);
      setSuppliers(s);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load purchases");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function addLine() {
    setLines((l) => [...l, { description: "", quantity: "", unit_cost: "", product_type: "OG" }]);
  }

  function removeLine(index: number) {
    setLines((l) => l.filter((_, i) => i !== index));
  }

  function updateLine(index: number, field: keyof DraftLine, value: string) {
    setLines((l) => l.map((line, i) => (i === index ? { ...line, [field]: value } : line)));
  }

  function addExpense() {
    setExpenses((e) => [...e, { label: "", amount: "" }]);
  }

  function removeExpense(index: number) {
    setExpenses((e) => e.filter((_, i) => i !== index));
  }

  function updateExpense(index: number, field: keyof DraftExpense, value: string) {
    setExpenses((e) => e.map((exp, i) => (i === index ? { ...exp, [field]: value } : exp)));
  }

  const goodsTotal = lines.reduce((sum, l) => sum + (parseInt(l.quantity, 10) || 0) * (parseFloat(l.unit_cost) || 0), 0);
  const expensesTotal = expenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);

  const selectedSupplier = suppliers.find((s) => String(s.id) === supplierId);
  const availableCredit = selectedSupplier?.credit_balance ?? 0;

  async function handleChequeLookup() {
    setChequeSearchError(null);
    setChequeMatch(null);
    const number = chequeSearchNumber.trim();
    if (!number) return;
    try {
      const matches = await api.get<any[]>(`/cheques/search?number=${encodeURIComponent(number)}`);
      if (matches.length === 0) {
        setChequeSearchError("No in-hand cheque found with that number");
        return;
      }
      setChequeMatch(matches[0]);
    } catch (err) {
      setChequeSearchError(err instanceof ApiRequestError ? err.message : "Lookup failed");
    }
  }

  async function handleRecordPending() {
    setFormError(null);
    setFormSuccess(null);

    if (!supplierId) {
      setFormError("Select a supplier");
      return;
    }

    const validLines = lines.filter((l) => l.description.trim() && parseInt(l.quantity, 10) > 0 && parseFloat(l.unit_cost) >= 0);
    if (validLines.length === 0) {
      setFormError("Add at least one line with a description, quantity, and cost");
      return;
    }

    const paidAmountNum = parseFloat(amountPaid) || 0;
    if (paidAmountNum > 0 && paymentMethod === "cheque") {
      if (chequeKind === "in_hand" && !chequeMatch) {
        setFormError("Find and select an in-hand cheque first");
        return;
      }
      if (chequeKind === "own" && (!ownChequeNumber.trim() || !ownChequeBankName.trim() || !ownChequeDate)) {
        setFormError("Cheque number, bank name, and date are all required for your own cheque");
        return;
      }
    }

    setSubmitting(true);
    try {
      const validExpenses = expenses.filter((e) => e.label.trim() && parseFloat(e.amount) > 0);
      const result = await api.post<Purchase & { credit_applied: number }>("/purchases/pending", {
        supplier_id: parseInt(supplierId, 10),
        lines: validLines.map((l) => ({
          description: l.description.trim(),
          quantity: parseInt(l.quantity, 10),
          unit_cost: parseFloat(l.unit_cost),
          product_type: l.product_type,
        })),
        amount_paid: paidAmountNum,
        payment_method: paidAmountNum > 0 ? paymentMethod : undefined,
        cheque_kind: paidAmountNum > 0 && paymentMethod === "cheque" ? chequeKind : undefined,
        cheque_receipt_id: paidAmountNum > 0 && paymentMethod === "cheque" && chequeKind === "in_hand" ? chequeMatch?.id : undefined,
        cheque_number: paidAmountNum > 0 && paymentMethod === "cheque" && chequeKind === "own" ? ownChequeNumber.trim() : undefined,
        bank_name: paidAmountNum > 0 && paymentMethod === "cheque" && chequeKind === "own" ? ownChequeBankName.trim() : undefined,
        cheque_date: paidAmountNum > 0 && paymentMethod === "cheque" && chequeKind === "own" ? ownChequeDate : undefined,
        expenses: validExpenses.map((e) => ({ label: e.label.trim(), amount: parseFloat(e.amount) })),
        description: notes.trim() || undefined,
      });
      const creditNote =
        result.credit_applied > 0
          ? ` Rs. ${result.credit_applied.toLocaleString()} of this supplier's credit was applied automatically.`
          : "";
      setFormSuccess(
        `Recorded as ${result.purchase_code} — pending.${creditNote} Sort it into real products from Add Product or Manage Products' restock, then come back here and mark it fully sorted once everything's entered.`
      );
      setSupplierId("");
      setLines([{ description: "", quantity: "", unit_cost: "", product_type: "OG" }]);
      setAmountPaid("");
      setPaymentMethod("cash");
      setChequeKind("in_hand");
      setChequeSearchNumber("");
      setChequeMatch(null);
      setOwnChequeNumber("");
      setOwnChequeBankName("");
      setOwnChequeDate("");
      setExpenses([]);
      setNotes("");
      setShowRecord(false);
      load();
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? err.message : "Failed to record this purchase");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMarkSorted(p: Purchase) {
    if (!confirm(`Mark ${p.purchase_code} as fully sorted? This moves it to History.`)) return;
    setMarkingSortedId(p.id);
    setError(null);
    try {
      await api.put(`/purchases/${p.id}/mark-sorted`, {});
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to mark this purchase as sorted");
    } finally {
      setMarkingSortedId(null);
    }
  }

  function openEdit(p: Purchase) {
    setEditingPurchase(p);
    setEditSupplierId(String(p.supplier_id));
    setEditDescription(p.description ?? "");
    setEditLines((p.lines ?? []).map((l) => ({ id: l.id, description: l.description, quantity: String(l.quantity), unit_cost: String(l.unit_cost) })));
    setEditError(null);
  }

  function updateEditLine(index: number, field: "description" | "quantity" | "unit_cost", value: string) {
    setEditLines((lines) => lines.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
  }

  async function saveEdit() {
    if (!editingPurchase) return;
    setEditError(null);
    setEditSubmitting(true);
    try {
      const body: any = {
        supplier_id: parseInt(editSupplierId, 10),
        description: editDescription.trim() || undefined,
      };
      // Lines are only sent (and only accepted server-side) while the
      // purchase is still pending — sending them for a fulfilled
      // purchase would just be rejected, so skip it entirely.
      if (editingPurchase.fulfillment_status === "pending" && editLines.length > 0) {
        body.lines = editLines.map((l) => ({
          id: l.id,
          description: l.description.trim(),
          quantity: parseInt(l.quantity, 10),
          unit_cost: parseFloat(l.unit_cost),
        }));
      }
      await api.put(`/purchases/${editingPurchase.id}`, body);
      setEditingPurchase(null);
      load();
    } catch (err) {
      setEditError(err instanceof ApiRequestError ? err.message : "Failed to save changes");
    } finally {
      setEditSubmitting(false);
    }
  }

  async function handleDeletePurchase(p: Purchase) {
    if (!confirm(`Delete ${p.purchase_code} entirely? This removes it, its inventory units (if any), and related cash book entries. This cannot be undone.`)) return;
    setDeletingId(p.id);
    setError(null);
    try {
      await api.delete(`/purchases/${p.id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to delete this purchase");
    } finally {
      setDeletingId(null);
    }
  }

  function statusBadge(status: "paid" | "partial" | "unpaid") {
    return (
      <span className="inline-block px-2.5 py-1 rounded-full text-xs font-medium capitalize bg-gray-100 text-gray-800 border border-gray-300">
        {status}
      </span>
    );
  }

  const filteredPurchases = purchases.filter((p) => {
    if (!historyStart || !historyEnd) return true;
    const d = p.purchase_date.slice(0, 10);
    return d >= historyStart && d <= historyEnd;
  });

  return (
    <div>
      <PageHeader
        title="Purchases"
        subtitle="Record goods as soon as they arrive and are paid for — sort them into real products/variants whenever you're ready."
        action={
          <div className="flex gap-2">
            {!showRecord && (
              <Button variant="primary" onClick={() => setShowRecord(true)}>
                Record new purchase
              </Button>
            )}
            <Button onClick={() => navigate("/purchases/returns")} className="inline-flex items-center gap-1.5">
              <RotateCcw size={15} />
              Record Returns
            </Button>
          </div>
        }
      />

      {error && <ErrorText>{error}</ErrorText>}

      {showRecord && (
        <Card className="max-w-2xl mb-5">
          <h2 className="text-base font-semibold text-gray-900 mb-3">Goods just arrived</h2>
          <p className="text-xs text-gray-400 mb-3">
            Add one line per item in the delivery — you don't need to know the exact product/variant yet. Sort it into real stock later
            from Add Product or Manage Products.
          </p>
          <FormGroup>
            <Label>Supplier</Label>
            <Dropdown
              value={supplierId}
              onChange={setSupplierId}
              placeholder="— Select —"
              searchable
              options={suppliers.map((s) => ({ value: String(s.id), label: s.name, sublabel: s.supplier_code }))}
            />
          </FormGroup>

          <Label>Items in this delivery</Label>
          <div className="space-y-2 mb-2">
            {lines.map((line, i) => (
              <div key={i} className="flex gap-2 items-start">
                <div className="flex-[2]">
                  <Input
                    value={line.description}
                    onChange={(e) => updateLine(i, "description", e.target.value)}
                    placeholder='e.g. "BR Business Casual Pants"'
                  />
                </div>
                <div className="w-24">
                  <Input
                    type="number"
                    min="1"
                    value={line.quantity}
                    onChange={(e) => updateLine(i, "quantity", e.target.value)}
                    placeholder="Qty"
                  />
                </div>
                <div className="w-32">
                  <Input
                    type="number"
                    min="0"
                    value={line.unit_cost}
                    onChange={(e) => updateLine(i, "unit_cost", e.target.value)}
                    placeholder="Cost/pc"
                  />
                </div>
                <div className="w-40">
                  <Dropdown
                    value={line.product_type}
                    onChange={(v) => updateLine(i, "product_type", v)}
                    options={[
                      { value: "FO", label: "FO — Factory Outlet" },
                      { value: "OG", label: "OG — Original" },
                      { value: "OR", label: "OR — Overrun" },
                      { value: "OP", label: "OP — Own Production" },
                    ]}
                  />
                </div>
                {lines.length > 1 && (
                  <button onClick={() => removeLine(i)} className="text-gray-400 hover:text-red-500 mt-2.5">
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <button onClick={addLine} className="text-xs text-gray-500 hover:text-gray-800 mb-3">
            + Add another line
          </button>

          <div className="flex justify-between text-sm font-semibold bg-gray-50 rounded-lg px-3 py-2 mb-3">
            <span>Goods total (owed to supplier)</span>
            <span>Rs. {goodsTotal.toLocaleString()}</span>
          </div>

          {availableCredit > 0 && (
            <p className="text-xs text-gray-500 mb-3 border border-gray-200 rounded-lg px-3 py-2">
              This supplier has Rs. {availableCredit.toLocaleString()} in credit from a past damaged-goods return — it will be applied
              automatically against what's owed on this purchase.
            </p>
          )}

          <FormGroup>
            <Label>Amount paid to supplier now (Rs.)</Label>
            <Input type="number" min="0" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} placeholder="0 if fully on credit" />
          </FormGroup>

          {parseFloat(amountPaid) > 0 && (
            <>
              <FormGroup>
                <Label>Payment method</Label>
                <Dropdown
                  value={paymentMethod}
                  onChange={(v) => {
                    setPaymentMethod(v as typeof paymentMethod);
                    setChequeMatch(null);
                    setChequeSearchError(null);
                  }}
                  options={[
                    { value: "cash", label: "Cash" },
                    { value: "bank_transfer", label: "Bank transfer" },
                    { value: "card", label: "Card" },
                    { value: "cheque", label: "Cheque" },
                  ]}
                />
              </FormGroup>

              {paymentMethod === "cheque" && (
                <div className="border border-gray-200 rounded-xl p-3 mb-3">
                  <div className="flex gap-2 mb-3">
                    <button
                      type="button"
                      onClick={() => setChequeKind("in_hand")}
                      className={`flex-1 border rounded-xl py-2 text-xs font-medium transition ${
                        chequeKind === "in_hand" ? "border-black bg-black text-white" : "border-gray-200 text-gray-600 hover:border-gray-400"
                      }`}
                    >
                      Cheque in hand
                    </button>
                    <button
                      type="button"
                      onClick={() => setChequeKind("own")}
                      className={`flex-1 border rounded-xl py-2 text-xs font-medium transition ${
                        chequeKind === "own" ? "border-black bg-black text-white" : "border-gray-200 text-gray-600 hover:border-gray-400"
                      }`}
                    >
                      My own cheque
                    </button>
                  </div>

                  {chequeKind === "in_hand" ? (
                    <>
                      <p className="text-xs text-gray-400 mb-2">Use a cheque already received from a customer.</p>
                      <div className="flex gap-2 mb-2">
                        <Input
                          placeholder="Cheque number"
                          value={chequeSearchNumber}
                          onChange={(e) => setChequeSearchNumber(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && handleChequeLookup()}
                        />
                        <Button onClick={handleChequeLookup}>Find</Button>
                      </div>
                      {chequeSearchError && <ErrorText>{chequeSearchError}</ErrorText>}
                      {chequeMatch && (
                        <div className="bg-gray-50 rounded-lg px-3 py-2 text-sm">
                          <p className="font-medium text-gray-900">
                            #{chequeMatch.cheque_number} — {chequeMatch.bank_name}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Rs. {chequeMatch.amount.toLocaleString()} from {chequeMatch.customer_name} ({chequeMatch.customer_code})
                          </p>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="text-xs text-gray-400 mb-2">Write a new cheque from your own account.</p>
                      <FormGroup>
                        <Label>Cheque number</Label>
                        <Input value={ownChequeNumber} onChange={(e) => setOwnChequeNumber(e.target.value)} />
                      </FormGroup>
                      <FormGroup>
                        <Label>Bank name</Label>
                        <Input value={ownChequeBankName} onChange={(e) => setOwnChequeBankName(e.target.value)} />
                      </FormGroup>
                      <FormGroup>
                        <Label>Cheque date</Label>
                        <DatePicker value={ownChequeDate || null} onChange={setOwnChequeDate} />
                      </FormGroup>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          <div className="border-t border-gray-100 pt-3 mt-1">
            <p className="text-xs text-gray-400 mb-2">
              Transport, commission, loading, or any other cost — NOT owed to this supplier. Each becomes its own separate cash book
              expense.
            </p>
            <div className="space-y-2 mb-2">
              {expenses.map((exp, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <div className="flex-[2]">
                    <Input value={exp.label} onChange={(e) => updateExpense(i, "label", e.target.value)} placeholder="e.g. Transport" />
                  </div>
                  <div className="w-32">
                    <Input
                      type="number"
                      min="0"
                      value={exp.amount}
                      onChange={(e) => updateExpense(i, "amount", e.target.value)}
                      placeholder="Amount"
                    />
                  </div>
                  <button onClick={() => removeExpense(i)} className="text-gray-400 hover:text-black mt-2.5">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
            <button onClick={addExpense} className="text-xs text-gray-500 hover:text-black">
              + Add an expense
            </button>
            {expensesTotal > 0 && <p className="text-xs text-gray-500 mt-2">Other costs total: Rs. {expensesTotal.toLocaleString()}</p>}
          </div>

          <FormGroup>
            <Label>Notes (optional)</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything else about this delivery" />
          </FormGroup>

          {formError && <ErrorText>{formError}</ErrorText>}
          {formSuccess && <SuccessText>{formSuccess}</SuccessText>}
          <div className="flex gap-2 mt-2">
            <Button variant="primary" onClick={handleRecordPending} disabled={submitting}>
              {submitting ? "Recording..." : "Record purchase"}
            </Button>
            <Button onClick={() => setShowRecord(false)}>Cancel</Button>
          </div>
        </Card>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : (
        <>
          <h2 className="text-base font-semibold text-gray-900 mb-3">Awaiting sorting</h2>
          {pending.length === 0 ? (
            <EmptyState icon={Clock} title="Nothing pending" subtitle="Goods you record as arrived but haven't fully sorted yet will show here." />
          ) : (
            <div className="space-y-3 mb-6">
              {pending.map((p) => (
                <Card key={p.id} className="bg-amber-50/40">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">
                        {p.purchase_code} — {p.supplier_name}
                      </p>
                      <p className="text-xs text-gray-400">{p.purchase_date.slice(0, 10)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {statusBadge(p.payment_status)}
                      <Button size="sm" variant="primary" onClick={() => handleMarkSorted(p)} disabled={markingSortedId === p.id}>
                        {markingSortedId === p.id ? "Marking..." : "Mark fully sorted"}
                      </Button>
                      {isWithinEditWindow(p.purchase_date) && (
                        <>
                          <button onClick={() => openEdit(p)} className="text-gray-400 hover:text-black text-xs underline">
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeletePurchase(p)}
                            disabled={deletingId === p.id}
                            className="text-gray-400 hover:text-red-500 text-xs underline"
                          >
                            {deletingId === p.id ? "Deleting..." : "Delete"}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {p.description && <p className="text-xs text-gray-500 mb-2">{p.description}</p>}
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        <Th>Line</Th>
                        <Th>Qty</Th>
                        <Th>Cost/pc</Th>
                        <Th>Line total</Th>
                        <Th>Status</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.lines?.map((line) => (
                        <tr key={line.id} className={line.is_fulfilled ? "opacity-50" : ""}>
                          <Td className={line.is_fulfilled ? "line-through" : ""}>{line.description}</Td>
                          <Td>{line.quantity}</Td>
                          <Td>Rs. {line.unit_cost.toLocaleString()}</Td>
                          <Td>Rs. {(line.quantity * line.unit_cost).toLocaleString()}</Td>
                          <Td>
                            {line.is_fulfilled ? (
                              <span className="text-xs font-medium border border-gray-300 rounded-full px-2.5 py-1">sorted</span>
                            ) : (
                              <span className="text-xs text-gray-500 border border-gray-200 rounded-full px-2.5 py-1">awaiting</span>
                            )}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="flex justify-between text-sm font-medium mt-2 pt-2 border-t border-amber-200">
                    <span>Goods total / Paid</span>
                    <span>
                      Rs. {p.total_cost.toLocaleString()} / Rs. {p.amount_paid.toLocaleString()}
                    </span>
                  </div>
                </Card>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-gray-900">History</h2>
            <DateRangePicker
              startDate={historyStart}
              endDate={historyEnd}
              onChange={(s, e) => {
                setHistoryStart(s);
                setHistoryEnd(e);
              }}
            />
          </div>
          {filteredPurchases.length === 0 ? (
            <EmptyState icon={Package} title="No purchases recorded in this range" />
          ) : (
            <Card className="p-0 overflow-hidden">
              <Table>
                <thead>
                  <tr>
                    <Th>Code</Th>
                    <Th>Date</Th>
                    <Th>Supplier</Th>
                    <Th>Total cost</Th>
                    <Th>Paid</Th>
                    <Th>Status</Th>
                    <Th></Th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPurchases.map((p) => (
                    <tr key={p.id}>
                      <Td>{p.purchase_code}</Td>
                      <Td>{p.purchase_date.slice(0, 10)}</Td>
                      <Td>{p.supplier_name}</Td>
                      <Td>Rs. {p.total_cost.toLocaleString()}</Td>
                      <Td>Rs. {p.amount_paid.toLocaleString()}</Td>
                      <Td>{statusBadge(p.payment_status)}</Td>
                      <Td>
                        {isWithinEditWindow(p.purchase_date) && (
                          <div className="flex items-center gap-2">
                            <button onClick={() => openEdit(p)} className="text-gray-400 hover:text-black text-xs underline">
                              Edit
                            </button>
                            <button
                              onClick={() => handleDeletePurchase(p)}
                              disabled={deletingId === p.id}
                              className="text-gray-400 hover:text-red-500 text-xs underline"
                            >
                              {deletingId === p.id ? "Deleting..." : "Delete"}
                            </button>
                          </div>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </>
      )}

      {editingPurchase && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-2xl">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Edit {editingPurchase.purchase_code}</h2>
              <button onClick={() => setEditingPurchase(null)} className="text-gray-400 hover:text-gray-600">
                ✕
              </button>
            </div>
            <div className="p-5">
              <FormGroup>
                <Label>Supplier</Label>
                <Dropdown
                  value={editSupplierId}
                  onChange={setEditSupplierId}
                  searchable
                  options={suppliers.map((s) => ({ value: String(s.id), label: s.name, sublabel: s.supplier_code }))}
                />
              </FormGroup>
              <FormGroup>
                <Label>Description</Label>
                <Input value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
              </FormGroup>

              {editingPurchase.fulfillment_status === "pending" ? (
                <>
                  <Label>Lines</Label>
                  <div className="space-y-2 mb-2">
                    {editLines.map((line, i) => (
                      <div key={line.id} className="flex gap-2 items-start">
                        <div className="flex-[2]">
                          <Input value={line.description} onChange={(e) => updateEditLine(i, "description", e.target.value)} />
                        </div>
                        <div className="w-20">
                          <Input type="number" min="1" value={line.quantity} onChange={(e) => updateEditLine(i, "quantity", e.target.value)} />
                        </div>
                        <div className="w-28">
                          <Input type="number" min="0" value={line.unit_cost} onChange={(e) => updateEditLine(i, "unit_cost", e.target.value)} />
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-xs text-gray-400 mb-3 border border-gray-200 rounded-lg px-3 py-2">
                  This purchase is already fulfilled — its lines are frozen since real inventory units were created from them. Only supplier
                  and description can still be changed here.
                </p>
              )}

              {editError && <ErrorText>{editError}</ErrorText>}
              <div className="flex gap-2 mt-2">
                <Button variant="primary" onClick={saveEdit} disabled={editSubmitting}>
                  {editSubmitting ? "Saving..." : "Save changes"}
                </Button>
                <Button onClick={() => setEditingPurchase(null)}>Cancel</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
