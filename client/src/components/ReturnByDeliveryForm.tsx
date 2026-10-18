import { useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { Sale } from "../lib/types";
import { AUTO_APPROVED } from "../lib/returnFlow";
import { useAuth } from "../context/AuthContext";
import { NoReturnsWarning } from "./ReturnRequestPanel";
import { Button, ErrorText, FormGroup, Label, ReasonPicker, SuccessText } from "./ui";

const money = (n: number) => `Rs. ${Math.round(n).toLocaleString()}`;
const variant = (size?: string | null, color?: string | null) => [size, color].filter(Boolean).join(" / ");
const REASONS = ["Wrong size", "Wrong color", "Changed mind", "Defective / damaged", "Not as described"];

// A COURIER RETURN request: the customer of a delivered online order wants to send items back. Only the items, how they'd like to be paid
// back and why are asked here — whether to take it back is the admin's call (an admin's own request is approved on the spot, a cashier's
// waits in Returns ▸ To approve), and what happens after that follows from the parcel itself: the customer sends it with any service, we
// mark it received (service, tracking number, what we paid), inspect it and file a report, an admin approves that, and the refund is paid.
// The delivery charge and who pays it are settled in that report, not here — nothing is known yet.
export default function ReturnByDeliveryForm({ sale, onBooked }: { sale: Sale; onBooked: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const returnable = (sale.items ?? []).filter((i) => (i.is_returned ?? 0) === 0);
  const [ticked, setTicked] = useState<number[]>([]);
  const [resolution, setResolution] = useState<"refund" | "store_credit">("refund");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const chosen = returnable.filter((i) => ticked.includes(i.id));
  const itemsTotal = chosen.reduce((sum, i) => sum + i.unit_price, 0);
  const noCustomer = !sale.customer_id;
  const noReturns = chosen.filter((i) => i.allow_returns === 0);

  function toggle(id: number) {
    setTicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function book() {
    setError(null);
    if (chosen.length === 0) return setError("Tick the item(s) being sent back.");
    if (!reason.trim()) return setError("A reason is required.");
    setBusy(true);
    try {
      await api.post("/return-pickups", {
        sale_id: sale.id,
        sale_item_ids: chosen.map((i) => i.id),
        resolution,
        reason: reason.trim(),
      });
      const what = `${chosen.length} item${chosen.length === 1 ? "" : "s"}`;
      setDone(
        isAdmin
          ? `Recorded — ${AUTO_APPROVED.toLowerCase()}: ${what}. The customer can send it back now; when it arrives, mark it received under Returns ▸ On the way back.`
          : `Sent for approval: ${what}. Once an admin approves it you can tell the customer to send it; it then shows under Returns ▸ On the way back.`
      );
      setTicked([]);
      setReason("");
      onBooked();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't record the return");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <FormGroup>
        <div className="flex items-baseline justify-between gap-3">
          <Label>Tick the items being sent back</Label>
          {returnable.length > 1 && (
            <button
              type="button"
              onClick={() => setTicked(ticked.length === returnable.length ? [] : returnable.map((i) => i.id))}
              className="text-xs text-gray-500 underline hover:text-gray-800"
            >
              {ticked.length === returnable.length ? "Clear" : "Select all"}
            </button>
          )}
        </div>
        <div className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200">
          {returnable.length === 0 && <p className="px-3 py-3 text-sm text-gray-500">Everything on this invoice has already been returned.</p>}
          {returnable.map((i) => (
            <label key={i.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50">
              <input type="checkbox" checked={ticked.includes(i.id)} onChange={() => toggle(i.id)} className="h-4 w-4 accent-black" />
              <span className="min-w-0 flex-1 truncate text-gray-900">
                {i.product_title ?? "Item"}
                {variant(i.size, i.color) && <span className="text-gray-500"> · {variant(i.size, i.color)}</span>}
                {i.allow_returns === 0 && <span className="ml-2 text-xs text-amber-700">Final Sale</span>}
              </span>
              <span className="tabular-nums text-gray-600">{money(i.unit_price)}</span>
            </label>
          ))}
        </div>
      </FormGroup>

      <div className="grid gap-5 md:grid-cols-2">
        <FormGroup>
          <Label>The customer would like to be paid back as</Label>
          <div className="flex gap-2">
            {([
              ["refund", "Refund"],
              ["store_credit", "Store credit"],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                disabled={key === "store_credit" && noCustomer}
                onClick={() => setResolution(key)}
                className={`flex-1 rounded-xl border py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  resolution === key ? "border-black bg-black text-white" : "border-gray-200 bg-white text-gray-600 hover:border-gray-400"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {noCustomer && <p className="mt-1 text-xs text-gray-400">This sale has no customer attached, so store credit isn't available.</p>}
          <p className="mt-1 text-xs text-gray-400">It's settled after the parcel has been inspected.</p>
        </FormGroup>

        <FormGroup>
          <Label>Reason (required)</Label>
          <ReasonPicker value={reason} onChange={setReason} presets={REASONS} />
        </FormGroup>
      </div>

      <p className="text-xs text-gray-400">
        Approving only means "yes, send it back" — we don't know what state it will come back in. The customer can use any delivery service; the delivery charge and who pays it are decided after it
        arrives and has been checked.
        {chosen.length > 0 && ` The items come to ${money(itemsTotal)}.`}
      </p>

      {noReturns.length > 0 && (
        <div className="mt-4">
          <NoReturnsWarning>
            {isAdmin
              ? `${noReturns.map((i) => i.product_title ?? "An item").join(", ")} — Final Sale. Recording it is your override; the reason above is kept with it.`
              : `${noReturns.map((i) => i.product_title ?? "An item").join(", ")} — Final Sale. An admin has to approve it, with a reason.`}
          </NoReturnsWarning>
        </div>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      {done && <SuccessText>{done}</SuccessText>}
      <Button variant="primary" onClick={book} disabled={busy || chosen.length === 0} className="mt-4">
        {busy ? "Saving…" : isAdmin ? "Record the return" : "Send for approval"}
      </Button>
      {chosen.length > 0 && <p className="mt-1.5 text-xs text-gray-400">{isAdmin ? `${AUTO_APPROVED}.` : "An admin approves it first; the customer is told to send it after that."}</p>}
    </div>
  );
}
