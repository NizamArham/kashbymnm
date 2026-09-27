import { useEffect, useState } from "react";
import { Package, Clock, Trash2, Download } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Supplier, Purchase, AvailableUnit } from "../lib/types";
import { downloadTabularReport, rangeLabelFor } from "../lib/reportPdf";
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
  TabToggle,
  RowCard,
  RowCardStats,
  RowCardStat,
  HelpHint,
} from "../components/ui";

type PurchasesTab = "record" | "pending" | "history" | "returns";

interface DraftLine {
  description: string;
  quantity: string;
  unit_cost: string;
  product_type: "FO" | "OG" | "OR" | "OP" | "IM";
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

  const [activeTab, setActiveTab] = useState<PurchasesTab>("pending");
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
  const [ownChequeBranch, setOwnChequeBranch] = useState("");
  const [ownChequeIsCrossed, setOwnChequeIsCrossed] = useState(true);
  // Most cheques we write are made out to "Cash", not the supplier by
  // name — defaults to that.
  const [ownChequePayCash, setOwnChequePayCash] = useState(true);
  const [ownChequePayeeName, setOwnChequePayeeName] = useState("");
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

  // Returns tab — folded in from what used to be its own page, since
  // it's really just another view of the same purchases data.
  const [returnsHistory, setReturnsHistory] = useState<any[]>([]);
  const [returnsDateStart, setReturnsDateStart] = useState<string | null>(null);
  const [returnsDateEnd, setReturnsDateEnd] = useState<string | null>(null);

  const [returnPurchaseCode, setReturnPurchaseCode] = useState("");
  const [returnPurchase, setReturnPurchase] = useState<any>(null);
  const [returnLookupError, setReturnLookupError] = useState<string | null>(null);
  const [returnScenario, setReturnScenario] = useState<"pending_line" | "in_stock" | null>(null);

  const [returnLineId, setReturnLineId] = useState("");
  const [returnLineQty, setReturnLineQty] = useState("");

  const [availableUnits, setAvailableUnits] = useState<AvailableUnit[]>([]);
  const [selectedUnitIds, setSelectedUnitIds] = useState<Set<number>>(new Set());

  const [returnReason, setReturnReason] = useState("");
  const [returnResolution, setReturnResolution] = useState<"cash_refund" | "supplier_credit">("cash_refund");
  const [returnNotes, setReturnNotes] = useState("");
  const [returnFormError, setReturnFormError] = useState<string | null>(null);
  const [returnFormSuccess, setReturnFormSuccess] = useState<string | null>(null);
  const [returnSubmitting, setReturnSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [p, pend, s, ret] = await Promise.all([
        api.get<Purchase[]>("/purchases"),
        api.get<Purchase[]>("/purchases/pending"),
        api.get<Supplier[]>("/suppliers"),
        api.get<any[]>("/purchases/returns"),
      ]);
      setPurchases(p.filter((x) => x.fulfillment_status === "fulfilled"));
      setPending(pend);
      setSuppliers(s);
      setReturnsHistory(ret);
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
      if (chequeKind === "own" && !ownChequePayCash && !ownChequePayeeName.trim()) {
        setFormError("Enter who the cheque is payable to, or switch back to Cash");
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
        cheque_branch:
          paidAmountNum > 0 && paymentMethod === "cheque" && chequeKind === "own" ? ownChequeBranch.trim() || undefined : undefined,
        cheque_is_crossed: paidAmountNum > 0 && paymentMethod === "cheque" && chequeKind === "own" ? ownChequeIsCrossed : undefined,
        cheque_payee_name:
          paidAmountNum > 0 && paymentMethod === "cheque" && chequeKind === "own" && !ownChequePayCash
            ? ownChequePayeeName.trim()
            : undefined,
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
      setOwnChequeBranch("");
      setOwnChequeIsCrossed(true);
      setOwnChequePayCash(true);
      setOwnChequePayeeName("");
      setOwnChequeDate("");
      setExpenses([]);
      setNotes("");
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

  function downloadPurchasesPdf() {
    const totalCost = filteredPurchases.reduce((sum, p) => sum + p.total_cost, 0);
    const totalPaid = filteredPurchases.reduce((sum, p) => sum + p.amount_paid, 0);

    downloadTabularReport({
      headerLabel: "M&M Clothing — Purchases Report",
      title: "Purchases",
      rangeLabel: rangeLabelFor(historyStart, historyEnd),
      columns: [
        { label: "Code", width: 90 },
        { label: "Date", width: 80 },
        { label: "Supplier", width: 150 },
        { label: "Total cost", width: 95, align: "right" },
        { label: "Paid", width: 95, align: "right" },
        { label: "Status", width: 65 },
      ],
      rows: filteredPurchases.map((p) => ({
        cells: [
          p.purchase_code,
          p.purchase_date.slice(0, 10),
          p.supplier_name,
          `Rs. ${p.total_cost.toLocaleString()}`,
          `Rs. ${p.amount_paid.toLocaleString()}`,
          p.payment_status,
        ],
      })),
      summaryLines: [
        { text: `Total cost: Rs. ${totalCost.toLocaleString()}  ·  Total paid: Rs. ${totalPaid.toLocaleString()}`, bold: true },
      ],
      filename: `purchases-${historyStart || "all"}-to-${historyEnd || "now"}.pdf`,
    });
  }

  async function handleReturnLookup() {
    setReturnLookupError(null);
    setReturnPurchase(null);
    setReturnScenario(null);
    setReturnLineId("");
    setSelectedUnitIds(new Set());
    const code = returnPurchaseCode.trim();
    if (!code) return;
    try {
      const all = await api.get<Purchase[]>("/purchases");
      const match = all.find((p) => p.purchase_code.toLowerCase() === code.toLowerCase());
      if (!match) {
        setReturnLookupError("No purchase found with that code");
        return;
      }
      const full = await api.get<any>(`/purchases/${match.id}`);
      setReturnPurchase(full);
      const units = await api.get<AvailableUnit[]>(`/purchases/${match.id}/available-units`);
      setAvailableUnits(units);
    } catch (err) {
      setReturnLookupError(err instanceof ApiRequestError ? err.message : "Lookup failed");
    }
  }

  function toggleUnit(id: number) {
    setSelectedUnitIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const returnLine = returnPurchase?.lines?.find((l: any) => String(l.id) === returnLineId);
  const returnLineQtyNum = parseInt(returnLineQty, 10) || 0;
  const scenarioBAmount = returnLine ? Math.min(returnLineQtyNum, returnLine.quantity) * returnLine.unit_cost : 0;
  const scenarioAAmount = availableUnits.filter((u) => selectedUnitIds.has(u.id)).reduce((sum, u) => sum + (u.cost_price ?? 0), 0);
  const returnTotalAmount = returnScenario === "pending_line" ? scenarioBAmount : scenarioAAmount;

  async function handleSubmitReturn() {
    setReturnFormError(null);
    setReturnFormSuccess(null);

    if (!returnPurchase) {
      setReturnFormError("Look up a purchase first");
      return;
    }
    if (!returnReason.trim()) {
      setReturnFormError("A reason is required");
      return;
    }

    let items: { pending_line_id?: number; inventory_id?: number; quantity?: number }[] = [];
    if (returnScenario === "pending_line") {
      if (!returnLineId || returnLineQtyNum <= 0) {
        setReturnFormError("Select a line and enter a quantity greater than 0");
        return;
      }
      items = [{ pending_line_id: parseInt(returnLineId, 10), quantity: returnLineQtyNum }];
    } else if (returnScenario === "in_stock") {
      if (selectedUnitIds.size === 0) {
        setReturnFormError("Select at least one unit to return");
        return;
      }
      items = Array.from(selectedUnitIds).map((id) => ({ inventory_id: id }));
    } else {
      setReturnFormError("Choose whether this stock was already added to inventory or not");
      return;
    }

    setReturnSubmitting(true);
    try {
      await api.post("/purchases/returns", {
        purchase_id: returnPurchase.id,
        items,
        reason: returnReason.trim(),
        resolution: returnResolution,
        notes: returnNotes.trim() || undefined,
      });
      setReturnFormSuccess(
        returnResolution === "cash_refund"
          ? "Recorded — cash refund added to the cash book."
          : "Recorded — credit added to this supplier's balance, applied automatically on their next purchase."
      );
      setReturnPurchaseCode("");
      setReturnPurchase(null);
      setReturnScenario(null);
      setReturnLineId("");
      setReturnLineQty("");
      setSelectedUnitIds(new Set());
      setReturnReason("");
      setReturnNotes("");
      load();
    } catch (err) {
      setReturnFormError(err instanceof ApiRequestError ? err.message : "Failed to record this return");
    } finally {
      setReturnSubmitting(false);
    }
  }

  const filteredReturns = returnsHistory.filter((r) => {
    if (!returnsDateStart || !returnsDateEnd) return true;
    const d = r.created_at?.slice(0, 10);
    return d >= returnsDateStart && d <= returnsDateEnd;
  });

  return (
    <div>
      <PageHeader
        title="Purchases"
        subtitle="Record incoming goods, then sort them into stock."
      />

      <TabToggle
        value={activeTab}
        onChange={setActiveTab}
        options={[
          { value: "record", label: "Record Purchase" },
          { value: "pending", label: `Awaiting Sorting${pending.length > 0 ? ` (${pending.length})` : ""}` },
          { value: "history", label: "History" },
          { value: "returns", label: "Returns" },
        ]}
      />
      <div className="mt-5">
        {error && <ErrorText>{error}</ErrorText>}
      </div>

      {activeTab === "record" && (
        <Card className="max-w-2xl mb-5">
          <h2 className="text-base font-semibold text-gray-900 mb-3">
            Goods just arrived
            <HelpHint text="Add one line per item in the delivery — you don't need to know the exact product/variant yet. Sort it into real stock later from Add Product or Manage Products." />
          </h2>
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
          <div className="space-y-3 lg:space-y-2 mb-2">
            {lines.map((line, i) => (
              <div
                key={i}
                className="grid grid-cols-2 gap-2 lg:flex lg:gap-2 lg:items-start border border-gray-100 rounded-xl p-2.5 lg:p-0 lg:border-0"
              >
                <div className="col-span-2 lg:flex-[2]">
                  <Input
                    value={line.description}
                    onChange={(e) => updateLine(i, "description", e.target.value)}
                    placeholder="Item description"
                  />
                </div>
                <div className="lg:w-24">
                  <Input
                    type="number"
                    min="1"
                    value={line.quantity}
                    onChange={(e) => updateLine(i, "quantity", e.target.value)}
                    placeholder="Qty"
                  />
                </div>
                <div className="lg:w-32">
                  <Input
                    type="number"
                    min="0"
                    value={line.unit_cost}
                    onChange={(e) => updateLine(i, "unit_cost", e.target.value)}
                    placeholder="Cost/pc"
                  />
                </div>
                <div className="col-span-2 lg:w-40">
                  <Dropdown
                    value={line.product_type}
                    onChange={(v) => updateLine(i, "product_type", v)}
                    options={[
                      { value: "FO", label: "FO — Factory Outlet" },
                      { value: "OG", label: "OG — Original" },
                      { value: "OR", label: "OR — Overrun" },
                      { value: "OP", label: "OP — Own Production" },
                      { value: "IM", label: "IM — Imported" },
                    ]}
                  />
                </div>
                {lines.length > 1 && (
                  <button
                    onClick={() => removeLine(i)}
                    className="col-span-2 lg:col-auto flex items-center justify-center lg:justify-start gap-1.5 text-gray-400 hover:text-red-500 lg:mt-2.5"
                  >
                    <Trash2 size={16} />
                    <span className="text-xs lg:hidden">Remove line</span>
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
            <Input type="number" min="0" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} placeholder="0" />
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
                        <Label>Branch (optional)</Label>
                        <Input value={ownChequeBranch} onChange={(e) => setOwnChequeBranch(e.target.value)} />
                      </FormGroup>
                      <FormGroup>
                        <Label>Cheque date</Label>
                        <DatePicker value={ownChequeDate || null} onChange={setOwnChequeDate} />
                      </FormGroup>
                      <FormGroup>
                        <Label>Payable to</Label>
                        <TabToggle
                          value={ownChequePayCash ? "cash" : "name"}
                          onChange={(v) => setOwnChequePayCash(v === "cash")}
                          options={[
                            { value: "cash", label: "Cash" },
                            { value: "name", label: "A specific name" },
                          ]}
                        />
                        <Input
                          className={`mt-2 ${ownChequePayCash ? "opacity-40 cursor-not-allowed" : ""}`}
                          placeholder="Who the cheque is made out to"
                          value={ownChequePayeeName}
                          onChange={(e) => setOwnChequePayeeName(e.target.value)}
                          disabled={ownChequePayCash}
                        />
                      </FormGroup>
                      <label className="flex items-center gap-1.5 text-xs text-gray-600 mb-3">
                        <input
                          type="checkbox"
                          checked={ownChequeIsCrossed}
                          onChange={(e) => setOwnChequeIsCrossed(e.target.checked)}
                          className="rounded border-gray-300"
                        />
                        Crossed cheque
                      </label>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          <div className="border-t border-gray-100 pt-3 mt-1">
            <Label>
              Other expenses
              <HelpHint text="Transport, commission, loading, or any other cost — NOT owed to this supplier. Each becomes its own separate cash book expense." />
            </Label>
            <div className="space-y-2 mb-2">
              {expenses.map((exp, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <div className="flex-[2]">
                    <Input value={exp.label} onChange={(e) => updateExpense(i, "label", e.target.value)} placeholder="Expense" />
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
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormGroup>

          {formError && <ErrorText>{formError}</ErrorText>}
          {formSuccess && <SuccessText>{formSuccess}</SuccessText>}
          <div className="flex gap-2 mt-2">
            <Button variant="primary" onClick={handleRecordPending} disabled={submitting}>
              {submitting ? "Recording..." : "Record purchase"}
            </Button>
          </div>
        </Card>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : activeTab === "pending" ? (
        pending.length === 0 ? (
          <EmptyState icon={Clock} title="Nothing pending" subtitle="Goods you record as arrived but haven't fully sorted yet will show here." />
        ) : (
          <div className="space-y-3">
            {pending.map((p) => (
              <Card key={p.id} className="bg-amber-50/40">
                <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3 mb-2">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">
                      {p.purchase_code} — {p.supplier_name}
                    </p>
                    <p className="text-xs text-gray-400">{p.purchase_date.slice(0, 10)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
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

                {/* Desktop: line-items table */}
                <table className="w-full text-sm hidden lg:table">
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

                {/* Mobile: stacked line items */}
                <div className="lg:hidden space-y-1.5">
                  {p.lines?.map((line) => (
                    <div
                      key={line.id}
                      className={`flex items-center justify-between gap-2 bg-white/70 rounded-lg px-3 py-2 ${line.is_fulfilled ? "opacity-50" : ""}`}
                    >
                      <div className={`min-w-0 ${line.is_fulfilled ? "line-through" : ""}`}>
                        <p className="text-sm text-gray-900 truncate">{line.description}</p>
                        <p className="text-xs text-gray-500">
                          {line.quantity} × Rs. {line.unit_cost.toLocaleString()} = Rs. {(line.quantity * line.unit_cost).toLocaleString()}
                        </p>
                      </div>
                      {line.is_fulfilled ? (
                        <span className="flex-shrink-0 text-xs font-medium border border-gray-300 rounded-full px-2.5 py-1">sorted</span>
                      ) : (
                        <span className="flex-shrink-0 text-xs text-gray-500 border border-gray-200 rounded-full px-2.5 py-1">awaiting</span>
                      )}
                    </div>
                  ))}
                </div>

                <div className="flex justify-between text-sm font-medium mt-2 pt-2 border-t border-amber-200">
                  <span>Goods total / Paid</span>
                  <span>
                    Rs. {p.total_cost.toLocaleString()} / Rs. {p.amount_paid.toLocaleString()}
                  </span>
                </div>
              </Card>
            ))}
          </div>
        )
      ) : activeTab === "history" ? (
        <>
          <div className="flex items-center justify-end gap-2 mb-3">
            <DateRangePicker
              startDate={historyStart}
              endDate={historyEnd}
              onChange={(s, e) => {
                setHistoryStart(s);
                setHistoryEnd(e);
              }}
            />
            <Button onClick={downloadPurchasesPdf} disabled={filteredPurchases.length === 0} className="inline-flex items-center gap-1.5">
              <Download size={14} />
              Download PDF
            </Button>
          </div>
          {filteredPurchases.length === 0 ? (
            <EmptyState icon={Package} title="No purchases recorded in this range" />
          ) : (
            <>
              {/* Desktop / tablet-landscape */}
              <Card className="p-0 overflow-hidden hidden lg:block">
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

              {/* Mobile / tablet-portrait */}
              <div className="lg:hidden space-y-2.5">
                {filteredPurchases.map((p) => (
                  <RowCard key={p.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-gray-900">{p.purchase_code}</p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {p.supplier_name} · {p.purchase_date.slice(0, 10)}
                        </p>
                      </div>
                      <div className="flex-shrink-0">{statusBadge(p.payment_status)}</div>
                    </div>

                    <RowCardStats>
                      <RowCardStat label="Total cost" value={`Rs. ${p.total_cost.toLocaleString()}`} />
                      <RowCardStat label="Paid" value={`Rs. ${p.amount_paid.toLocaleString()}`} />
                    </RowCardStats>

                    {isWithinEditWindow(p.purchase_date) && (
                      <div className="flex items-center gap-3 mt-2.5 pt-2.5 border-t border-gray-100">
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
                  </RowCard>
                ))}
              </div>
            </>
          )}
        </>
      ) : activeTab === "returns" ? (
        <>
          <Card className="max-w-2xl mb-5">
            <h2 className="text-base font-semibold text-gray-900 mb-3">
              Return goods to a supplier
              <HelpHint text="Whether it's still a pending line or already sitting in stock." />
            </h2>
            <div className="flex gap-2 mb-3">
              <Input
                placeholder="Purchase code"
                value={returnPurchaseCode}
                onChange={(e) => setReturnPurchaseCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleReturnLookup()}
              />
              <Button variant="primary" onClick={handleReturnLookup}>
                Find
              </Button>
            </div>
            {returnLookupError && <ErrorText>{returnLookupError}</ErrorText>}

            {returnPurchase && (
              <>
                <FormGroup>
                  <Label>Was this stock already added to inventory?</Label>
                  <div className="flex flex-col lg:flex-row gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setReturnScenario("pending_line");
                        setSelectedUnitIds(new Set());
                      }}
                      className={`flex-1 border rounded-xl px-3 py-2.5 text-sm text-left ${
                        returnScenario === "pending_line" ? "border-black bg-black text-white" : "border-gray-200 text-gray-700 hover:border-gray-400"
                      }`}
                    >
                      Not yet in inventory
                      <div className={`text-xs mt-0.5 ${returnScenario === "pending_line" ? "text-gray-300" : "text-gray-400"}`}>
                        Still a pending purchase line
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setReturnScenario("in_stock");
                        setReturnLineId("");
                        setReturnLineQty("");
                      }}
                      className={`flex-1 border rounded-xl px-3 py-2.5 text-sm text-left ${
                        returnScenario === "in_stock" ? "border-black bg-black text-white" : "border-gray-200 text-gray-700 hover:border-gray-400"
                      }`}
                    >
                      Already in inventory
                      <div className={`text-xs mt-0.5 ${returnScenario === "in_stock" ? "text-gray-300" : "text-gray-400"}`}>
                        Pick specific unsold units
                      </div>
                    </button>
                  </div>
                </FormGroup>

                {returnScenario === "pending_line" && (
                  <>
                    <FormGroup>
                      <Label>Which line?</Label>
                      <Dropdown
                        value={returnLineId}
                        onChange={setReturnLineId}
                        placeholder="— Select line —"
                        options={(returnPurchase.lines ?? [])
                          .filter((l: any) => l.quantity > 0)
                          .map((l: any) => ({
                            value: String(l.id),
                            label: `${l.description} — ${l.quantity} pcs remaining @ Rs. ${l.unit_cost.toLocaleString()}`,
                          }))}
                      />
                    </FormGroup>
                    {returnLine && (
                      <FormGroup>
                        <Label>Quantity being returned (of {returnLine.quantity} remaining)</Label>
                        <Input
                          type="number"
                          min="1"
                          max={returnLine.quantity}
                          value={returnLineQty}
                          onChange={(e) => setReturnLineQty(e.target.value)}
                        />
                        {returnLineQtyNum > 0 && (
                          <p className="text-xs text-gray-500 mt-1">
                            {returnLineQtyNum} × Rs. {returnLine.unit_cost.toLocaleString()} = Rs. {scenarioBAmount.toLocaleString()}
                          </p>
                        )}
                      </FormGroup>
                    )}
                  </>
                )}

                {returnScenario === "in_stock" && (
                  <FormGroup>
                    <Label>Select the specific units being returned</Label>
                    {availableUnits.length === 0 ? (
                      <p className="text-xs text-gray-400">No available (unsold) units found for this purchase.</p>
                    ) : (
                      <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 max-h-64 overflow-y-auto">
                        {availableUnits.map((u) => (
                          <label key={u.id} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
                            <input type="checkbox" checked={selectedUnitIds.has(u.id)} onChange={() => toggleUnit(u.id)} className="rounded" />
                            <span className="flex-1">
                              {u.product_title} — {u.color ?? "—"} / {u.size ?? "—"} ({u.sku})
                            </span>
                            <span className="text-gray-500">Rs. {(u.cost_price ?? 0).toLocaleString()}</span>
                          </label>
                        ))}
                      </div>
                    )}
                    {selectedUnitIds.size > 0 && (
                      <p className="text-xs text-gray-500 mt-1">
                        {selectedUnitIds.size} unit(s) selected — Rs. {scenarioAAmount.toLocaleString()}
                      </p>
                    )}
                  </FormGroup>
                )}

                {returnScenario && (
                  <>
                    <div className="flex justify-between text-sm font-semibold bg-gray-50 rounded-lg px-3 py-2 mb-3">
                      <span>Total</span>
                      <span>Rs. {returnTotalAmount.toLocaleString()}</span>
                    </div>

                    <FormGroup>
                      <Label>Reason</Label>
                      <Input value={returnReason} onChange={(e) => setReturnReason(e.target.value)} />
                    </FormGroup>

                    <FormGroup>
                      <Label>How is this being resolved?</Label>
                      <div className="flex flex-col lg:flex-row gap-2">
                        <button
                          type="button"
                          onClick={() => setReturnResolution("cash_refund")}
                          className={`flex-1 border rounded-xl px-3 py-2.5 text-sm text-left ${
                            returnResolution === "cash_refund" ? "border-black bg-black text-white" : "border-gray-200 text-gray-700 hover:border-gray-400"
                          }`}
                        >
                          Cash refund now
                          <div className={`text-xs mt-0.5 ${returnResolution === "cash_refund" ? "text-gray-300" : "text-gray-400"}`}>
                            Supplier pays back immediately — nothing carried forward
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => setReturnResolution("supplier_credit")}
                          className={`flex-1 border rounded-xl px-3 py-2.5 text-sm text-left ${
                            returnResolution === "supplier_credit" ? "border-black bg-black text-white" : "border-gray-200 text-gray-700 hover:border-gray-400"
                          }`}
                        >
                          Supplier credit
                          <div className={`text-xs mt-0.5 ${returnResolution === "supplier_credit" ? "text-gray-300" : "text-gray-400"}`}>
                            Reduces what you owe on their next purchase
                          </div>
                        </button>
                      </div>
                    </FormGroup>
                    <FormGroup>
                      <Label>Notes (optional)</Label>
                      <Input value={returnNotes} onChange={(e) => setReturnNotes(e.target.value)} />
                    </FormGroup>
                    {returnFormError && <ErrorText>{returnFormError}</ErrorText>}
                    {returnFormSuccess && <SuccessText>{returnFormSuccess}</SuccessText>}
                    <Button variant="primary" onClick={handleSubmitReturn} disabled={returnSubmitting} className="mt-1">
                      {returnSubmitting ? "Recording..." : "Record return"}
                    </Button>
                  </>
                )}
              </>
            )}
          </Card>

          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-gray-900">Return history</h2>
            <DateRangePicker
              startDate={returnsDateStart}
              endDate={returnsDateEnd}
              onChange={(s, e) => {
                setReturnsDateStart(s);
                setReturnsDateEnd(e);
              }}
            />
          </div>

          {filteredReturns.length === 0 ? (
            <EmptyState icon={Package} title="No returns recorded in this range" />
          ) : (
            <>
              {/* Desktop / tablet-landscape */}
              <Card className="p-0 overflow-hidden hidden lg:block">
                <Table>
                  <thead>
                    <tr>
                      <Th>Date</Th>
                      <Th>Purchase</Th>
                      <Th>Supplier</Th>
                      <Th>Amount</Th>
                      <Th>Reason</Th>
                      <Th>Resolution</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredReturns.map((r) => (
                      <tr key={r.id}>
                        <Td>{r.created_at?.slice(0, 16).replace("T", " ")}</Td>
                        <Td>{r.purchase_code}</Td>
                        <Td>{r.supplier_name}</Td>
                        <Td>Rs. {r.total_amount?.toLocaleString()}</Td>
                        <Td>{r.reason}</Td>
                        <Td className="capitalize">{r.resolution?.replace(/_/g, " ")}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>

              {/* Mobile / tablet-portrait */}
              <div className="lg:hidden space-y-2.5">
                {filteredReturns.map((r) => (
                  <RowCard key={r.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-gray-900">{r.purchase_code}</p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {r.supplier_name} · {r.created_at?.slice(0, 16).replace("T", " ")}
                        </p>
                      </div>
                      <p className="text-sm font-semibold text-gray-900 flex-shrink-0">Rs. {r.total_amount?.toLocaleString()}</p>
                    </div>
                    <div className="mt-2.5 pt-2.5 border-t border-gray-100 text-sm">
                      <p className="text-gray-900">{r.reason}</p>
                      <p className="text-xs text-gray-400 mt-0.5 capitalize">{r.resolution?.replace(/_/g, " ")}</p>
                    </div>
                  </RowCard>
                ))}
              </div>
            </>
          )}
        </>
      ) : null}

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
