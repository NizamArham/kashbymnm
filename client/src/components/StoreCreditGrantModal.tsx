import { useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { cleanMoney } from "../lib/numberInput";
import { Button, ErrorText, FormGroup, Input, Label, Modal } from "./ui";

const money = (n: number) => `Rs. ${Math.round(n).toLocaleString()}`;

const QUICK_REASONS = ["Paid extra on delivery", "Goodwill", "Price difference"];

// Gives a customer store credit by hand — for money that arrived with no invoice to
// attach it to, like a courier collecting a little more than the order at the door.
// Nothing goes in the cash book here: the money is already recorded wherever it came in.
export default function StoreCreditGrantModal({
  customer,
  onClose,
  onDone,
}: {
  customer: { id: number; name: string; store_credit_balance: number };
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = Number(amount) || 0;
  const days = Number(expiry) || 0;
  const valid = value > 0 && reason.trim().length >= 3;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/customers/${customer.id}/store-credit-grant`, {
        amount: value,
        reason: reason.trim(),
        ...(days > 0 ? { expiry_days: Math.round(days) } : {}),
      });
      await onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't add the credit");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      size="sm"
      onClose={onClose}
      title="Add store credit"
      subtitle={`${customer.name} has ${customer.store_credit_balance > 0 ? money(customer.store_credit_balance) : "no"} store credit now`}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!valid || busy}>
            {busy ? "Adding…" : `Add ${valid ? money(value) : ""}`.trim()}
          </Button>
        </>
      }
    >
      {error && <ErrorText>{error}</ErrorText>}
      <FormGroup>
        <Label>Amount (Rs.)</Label>
        <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(cleanMoney(e.target.value))} placeholder="e.g. 50" autoFocus />
      </FormGroup>
      <FormGroup>
        <Label>Why? (required)</Label>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. paid Rs. 3,500 on a Rs. 3,450 order (Dropp)" />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {QUICK_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setReason(r)}
              className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-200 transition"
            >
              {r}
            </button>
          ))}
        </div>
      </FormGroup>
      <FormGroup>
        <Label>Valid for (days, optional)</Label>
        <Input inputMode="numeric" value={expiry} onChange={(e) => setExpiry(e.target.value.replace(/\D/g, ""))} placeholder="Leave empty for no expiry" />
      </FormGroup>
      <p className="text-xs text-gray-400">No money is recorded here — the cash is already in the books wherever it came in (for example the courier's settlement).</p>
    </Modal>
  );
}
