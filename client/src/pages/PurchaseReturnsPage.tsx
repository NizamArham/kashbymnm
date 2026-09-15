import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Package } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Purchase, AvailableUnit } from "../lib/types";
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
} from "../components/ui";

export default function PurchaseReturnsPage() {
  const navigate = useNavigate();
  const [returnsHistory, setReturnsHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [historyStart, setHistoryStart] = useState<string | null>(null);
  const [historyEnd, setHistoryEnd] = useState<string | null>(null);

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
      setReturnsHistory(await api.get<any[]>("/purchases/returns"));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load returns");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

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
    if (!historyStart || !historyEnd) return true;
    const d = r.created_at?.slice(0, 10);
    return d >= historyStart && d <= historyEnd;
  });

  return (
    <div>
      <PageHeader
        title="Purchase Returns"
        subtitle="Return goods to a supplier, whether they're still a pending line or already sitting in stock."
        action={
          <Button onClick={() => navigate("/purchases")} className="inline-flex items-center gap-1.5">
            <ArrowLeft size={15} />
            Back to Purchases
          </Button>
        }
      />

      {error && <ErrorText>{error}</ErrorText>}

      <Card className="max-w-2xl mb-5">
        <div className="flex gap-2 mb-3">
          <Input
            placeholder="Purchase code, e.g. P26090001"
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
              <div className="flex gap-2">
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
                  <Input value={returnReason} onChange={(e) => setReturnReason(e.target.value)} placeholder="Why is this being returned?" />
                </FormGroup>

                <FormGroup>
                  <Label>How is this being resolved?</Label>
                  <div className="flex gap-2">
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

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : filteredReturns.length === 0 ? (
        <EmptyState icon={Package} title="No returns recorded in this range" />
      ) : (
        <Card className="p-0 overflow-hidden">
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
                  <Td className="capitalize">{r.resolution?.replace("_", " ")}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
