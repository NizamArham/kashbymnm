import { useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { Customer } from "../lib/types";
import { Button, ErrorText, FormGroup, Input, Label, Modal, TabToggle } from "./ui";

// Admin-only loyalty controls for one customer, both with a reason that ends
// up in their points history and the audit log:
//  - take points away (earned on wholesale buying, say) or give some back;
//  - stop them earning points on new sales (a wholesale buyer), or allow it
//    again. Points they already have are untouched by that second one.
export default function LoyaltyAdjustModal({
  customer,
  onClose,
  onChanged,
}: {
  customer: Customer;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState<"points" | "earning">("points");
  const [mode, setMode] = useState<"remove" | "add">("remove");
  const [points, setPoints] = useState("");
  const [reason, setReason] = useState("");
  const [blockReason, setBlockReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const blocked = customer.loyalty_blocked === 1;
  const amount = parseInt(points, 10) || 0;
  const after = customer.loyalty_points + (mode === "remove" ? -amount : amount);

  async function run(action: () => Promise<unknown>, fallback: string) {
    setError(null);
    setBusy(true);
    try {
      await action();
      await onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  function saveChange() {
    if (amount <= 0) return setError("Enter how many points.");
    if (mode === "remove" && amount > customer.loyalty_points) return setError(`${customer.name} only has ${customer.loyalty_points} points.`);
    if (reason.trim().length < 3) return setError("Add a reason — it's kept in their points history.");
    void run(
      () => api.post(`/customers/${customer.id}/loyalty-adjust`, { points: mode === "remove" ? -amount : amount, reason: reason.trim() }),
      "Failed to change the points"
    );
  }

  function toggleBlock() {
    if (!blocked && blockReason.trim().length < 3) return setError("Add a reason, e.g. \"Wholesale buyer\".");
    void run(
      () => api.put(`/customers/${customer.id}/loyalty-block`, blocked ? { blocked: false } : { blocked: true, reason: blockReason.trim() }),
      "Failed to update this customer"
    );
  }

  return (
    <Modal
      size="md"
      onClose={onClose}
      title={`Loyalty — ${customer.name}`}
      subtitle={`${customer.loyalty_points} points now`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {tab === "points" ? (
            <Button variant="primary" onClick={saveChange} disabled={busy}>
              {busy ? "Saving..." : mode === "remove" ? "Remove points" : "Add points"}
            </Button>
          ) : (
            <Button variant="primary" onClick={toggleBlock} disabled={busy}>
              {busy ? "Saving..." : blocked ? "Allow earning again" : "Stop earning points"}
            </Button>
          )}
        </>
      }
    >
      <div className="mb-4">
        <TabToggle
          value={tab}
          onChange={(t) => {
            setTab(t);
            setError(null);
          }}
          options={[
            { value: "points", label: "Change points" },
            { value: "earning", label: "Earning points" },
          ]}
        />
      </div>

      {tab === "points" ? (
        <>
          <p className="text-xs text-gray-400 mb-3">
            Takes points away, or gives some back to fix a mistake. It's added to their points history with your reason — nothing earlier is edited.
          </p>
          <div className="flex gap-2 mb-3">
            {(["remove", "add"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 border rounded-xl py-2 text-xs font-medium transition ${
                  mode === m ? "border-black bg-black text-white" : "border-gray-200 text-gray-600 hover:border-gray-400"
                }`}
              >
                {m === "remove" ? "Remove points" : "Add points"}
              </button>
            ))}
          </div>
          <FormGroup>
            <Label>Points</Label>
            <Input inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value.replace(/\D/g, ""))} placeholder="0" />
          </FormGroup>
          <FormGroup>
            <Label>Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wholesale buying" />
          </FormGroup>
          {amount > 0 && <p className="text-xs text-gray-500">Leaves {Math.max(0, after)} points.</p>}
        </>
      ) : (
        <>
          <p className="text-xs text-gray-400 mb-3">
            For wholesale buyers: their new sales earn no points, and POS ticks Wholesale for them. Points they already have are untouched.
          </p>
          {blocked ? (
            <p className="text-sm text-gray-700 bg-gray-50 rounded-xl px-3.5 py-3">
              Not earning points{customer.loyalty_block_reason ? ` — ${customer.loyalty_block_reason}` : ""}.
            </p>
          ) : (
            <FormGroup>
              <Label>Reason</Label>
              <Input value={blockReason} onChange={(e) => setBlockReason(e.target.value)} placeholder="e.g. Wholesale buyer" />
            </FormGroup>
          )}
        </>
      )}

      {error && <ErrorText>{error}</ErrorText>}
    </Modal>
  );
}
