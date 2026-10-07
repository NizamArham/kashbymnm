import { FormEvent, useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { CourierSummary } from "../lib/types";
import { partnerLabel } from "../lib/delivery";
import { cleanDecimal } from "../lib/numberInput";
import { Button, ErrorText, FormGroup, Input, Label, Modal, ReasonPicker } from "./ui";

const money = (n: number) => `Rs. ${n.toLocaleString()}`;
const describe = (n: number) => (n > 0 ? `${money(n)} due` : n < 0 ? `${money(-n)} credit` : "Rs. 0 (settled)");

const REASONS = [
  "Courier's statement shows a different amount",
  "The real charges differed from the estimates",
  "Customer paid the courier a different amount",
  "Courier short-paid the settlement",
  "Return-trip charge",
  "Opening balance",
];

type Mode = "set" | "adjust";

// Fix a courier's balance when it's wrong — type what their statement says it
// should be (or an amount to add / take off) and why. The difference is saved
// as a visible, undoable correction; no money moves and no order is changed.
export default function CourierBalanceModal({
  courier,
  onClose,
  onSaved,
}: {
  courier: CourierSummary;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>("set");
  const [direction, setDirection] = useState<1 | -1>(courier.balance < 0 ? -1 : 1); // 1 = they owe me, -1 = I owe them
  const [sign, setSign] = useState<1 | -1>(1); // + = they owe me more
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountNum = parseFloat(amount);
  const valid = Number.isFinite(amountNum);
  const target = !valid ? null : mode === "set" ? direction * amountNum : courier.balance + sign * amountNum;
  const delta = target === null ? null : Math.round((target - courier.balance) * 100) / 100;
  const canSave = delta !== null && Math.abs(delta) >= 0.005 && reason.trim().length >= 3 && !saving;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSave || target === null) return;
    setSaving(true);
    setError(null);
    try {
      await api.post("/courier-reconciliation/adjustments", {
        courier_partner: courier.courier_partner,
        reason: reason.trim(),
        ...(mode === "set" ? { target_balance: target } : { adjustment: sign * amountNum }),
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't save — try again");
    } finally {
      setSaving(false);
    }
  }

  const segment = (active: boolean) =>
    `flex-1 rounded-lg border px-3 py-2 text-sm transition ${active ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"}`;

  return (
    <form onSubmit={handleSubmit}>
      <Modal
        size="lg"
        stacked
        onClose={onClose}
        title={`Correct ${partnerLabel(courier.courier_partner)} balance`}
        subtitle="For when it doesn't match the courier's own statement."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!canSave}>
              {saving ? "Saving..." : "Save correction"}
            </Button>
          </>
        }
      >
        <div className="rounded-xl bg-gray-50 px-3.5 py-3 text-xs text-gray-600 space-y-1">
          <div className="flex justify-between">
            <span>Expected from delivered orders (COD − charges)</span>
            <span className="text-gray-900">{money(courier.expected_net)}</span>
          </div>
          <div className="flex justify-between">
            <span>Already received</span>
            <span className="text-gray-900">− {money(courier.settled_total)}</span>
          </div>
          {courier.adjustments_total !== 0 && (
            <div className="flex justify-between">
              <span>Earlier corrections</span>
              <span className="text-gray-900">
                {courier.adjustments_total > 0 ? "+" : "−"} {money(Math.abs(courier.adjustments_total))}
              </span>
            </div>
          )}
          <div className="flex justify-between border-t border-gray-200 pt-1.5 mt-1 text-sm">
            <span className="font-medium text-gray-900">Balance now</span>
            <span className="font-semibold text-gray-900">{describe(courier.balance)}</span>
          </div>
        </div>

        <div className="flex gap-2 mt-4 mb-1">
          <button type="button" className={segment(mode === "set")} onClick={() => setMode("set")}>
            Set the balance to…
          </button>
          <button type="button" className={segment(mode === "adjust")} onClick={() => setMode("adjust")}>
            Add / take off an amount
          </button>
        </div>

        <FormGroup>
          <Label>{mode === "set" ? "The balance should be" : "Change the balance by"}</Label>
          <div className="flex gap-2 mb-2">
            {mode === "set" ? (
              <>
                <button type="button" className={segment(direction === 1)} onClick={() => setDirection(1)}>
                  They owe me
                </button>
                <button type="button" className={segment(direction === -1)} onClick={() => setDirection(-1)}>
                  I owe them
                </button>
              </>
            ) : (
              <>
                <button type="button" className={segment(sign === 1)} onClick={() => setSign(1)}>
                  They owe me more (+)
                </button>
                <button type="button" className={segment(sign === -1)} onClick={() => setSign(-1)}>
                  They owe me less (−)
                </button>
              </>
            )}
          </div>
          <Input type="text" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(cleanDecimal(e.target.value))} placeholder="Rs. 0" className="text-right tabular-nums" />
        </FormGroup>

        {delta !== null && (
          <p className="text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2 mb-3">
            {Math.abs(delta) < 0.005 ? (
              "That's what it already is — nothing to correct."
            ) : (
              <>
                {describe(courier.balance)} → <span className="font-medium text-gray-900">{describe(target!)}</span> (a correction of {delta > 0 ? "+" : "−"}
                {money(Math.abs(delta))}).
              </>
            )}
          </p>
        )}

        <FormGroup>
          <Label>Why? (required)</Label>
          <ReasonPicker value={reason} onChange={setReason} presets={REASONS} placeholder="What's different…" />
        </FormGroup>

        <p className="text-xs text-gray-400 mb-3">
          No money moves — this only corrects what's owed. It's saved with your reason, shown on the Couriers page and in the Audit Log, and can be undone.
        </p>

        {error && <ErrorText>{error}</ErrorText>}
      </Modal>
    </form>
  );
}
