import { useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { cleanMoney } from "../lib/numberInput";
import { Button, ErrorText, FormGroup, Input, Label, Modal } from "./ui";

const money = (n: number) => `Rs. ${Math.round(n).toLocaleString()}`;

// Pays some of a customer's store credit back out as money instead of leaving it to
// be spent — for example the difference left after an exchange for something cheaper.
// It comes off their credit and goes in the cash book as an expense.
export default function StoreCreditRefundModal({
  customer,
  onClose,
  onDone,
}: {
  customer: { id: number; name: string; store_credit_balance: number };
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [amount, setAmount] = useState(String(Math.round(customer.store_credit_balance)));
  const [method, setMethod] = useState<"cash" | "bank_transfer">("cash");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = Number(amount) || 0;
  const valid = value > 0 && value <= customer.store_credit_balance + 0.009;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/customers/${customer.id}/store-credit-refund`, { amount: value, method, note: note.trim() || undefined });
      await onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't refund the credit");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      size="sm"
      onClose={onClose}
      title="Refund store credit"
      subtitle={`${customer.name} has ${money(customer.store_credit_balance)} of store credit`}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!valid || busy}>
            {busy ? "Refunding…" : `Refund ${valid ? money(value) : ""}`.trim()}
          </Button>
        </>
      }
    >
      {error && <ErrorText>{error}</ErrorText>}
      <FormGroup>
        <Label>Amount to refund (Rs.)</Label>
        <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(cleanMoney(e.target.value))} />
        {value > customer.store_credit_balance + 0.009 && <p className="mt-1 text-xs text-red-500">That's more than their store credit.</p>}
      </FormGroup>
      <FormGroup>
        <Label>Paid out as</Label>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["cash", "Cash", "From the till"],
              ["bank_transfer", "Bank transfer", "You transfer it"],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMethod(value)}
              className={`rounded-xl border px-3 py-2.5 text-left transition ${method === value ? "border-black bg-gray-50" : "border-gray-200 hover:border-gray-300"}`}
            >
              <span className="block text-sm font-medium text-gray-900">{label}</span>
              <span className="block text-xs text-gray-500">{hint}</span>
            </button>
          ))}
        </div>
      </FormGroup>
      <FormGroup>
        <Label>Note (optional)</Label>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. exchanged for a cheaper item" />
      </FormGroup>
    </Modal>
  );
}
