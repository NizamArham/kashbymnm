import { useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { Modal, Button, ErrorText } from "./ui";

// "Mark as paid / COD collected" — one step that records the money in the cash book and marks the order paid, for an order the
// shop delivered itself (or an on-demand rider). Shared by Sale History and the invoice's own page.
export default function ConfirmCodModal({
  sale,
  onClose,
  onDone,
}: {
  sale: { id: number; invoice: string; total: number; amount_paid: number };
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [method, setMethod] = useState<"cash" | "bank_transfer" | "card">("cash");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmCollected() {
    setError(null);
    setBusy(true);
    try {
      await api.put(`/sales/${sale.id}/confirm-cod`, { payment_method: method });
      await onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to confirm this payment");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      size="md"
      onClose={onClose}
      title="Confirm COD collected"
      subtitle="Marks the order as fully paid and records the amount in the cash book, together, in one step."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={confirmCollected} disabled={busy}>
            {busy ? "Confirming..." : "Confirm, collected"}
          </Button>
        </>
      }
    >
      <p className="text-sm text-gray-600 mb-1">Invoice {sale.invoice}</p>
      <p className="text-2xl font-semibold text-gray-900 mb-3">Rs. {(sale.total - sale.amount_paid).toLocaleString()}</p>
      <div className="mb-4">
        <p className="text-xs font-medium text-gray-500 mb-1.5">How was it collected?</p>
        <div className="flex gap-2">
          {(["cash", "bank_transfer", "card"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMethod(m)}
              className={`flex-1 border rounded-xl py-2 text-xs font-medium capitalize transition ${
                method === m ? "border-black bg-black text-white" : "border-gray-200 text-gray-600 hover:border-gray-400"
              }`}
            >
              {m.replace("_", " ")}
            </button>
          ))}
        </div>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
    </Modal>
  );
}
