import { useState } from "react";
import { Repeat } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { SaleExchange, SaleExchangeItem, SaleExchangeOut } from "../lib/types";
import StepModal from "./StepModal";
import { Badge, Button, RefLink } from "./ui";
import { useAdminApproval } from "./AdminApproval";
import ArrivalChoice, { allGood, startGood } from "./ArrivalChoice";
import { useAuth } from "../context/AuthContext";
import { exchangeStage } from "../lib/returnFlow";

const money = (n: number) => `Rs. ${Math.round(n).toLocaleString()}`;

const STATUS: Record<SaleExchange["status"], { label: string; tone: "warning" | "success" | "danger" | "neutral" }> = {
  awaiting_pickup: { label: "Waiting for the old items", tone: "warning" },
  received: { label: "Completed — old items received", tone: "success" },
  not_returned: { label: "Completed — old items not returned", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

type Leftover = "credit" | "refund_cash" | "refund_bank";

const itemName = (i: SaleExchangeItem) => `${i.title ?? "Item"}${[i.size, i.color].filter(Boolean).length ? ` (${[i.size, i.color].filter(Boolean).join(", ")})` : ""}`;

// What an online exchange order is doing: which old items the courier is bringing back,
// who pays the pickup charge, and — once the new order has been delivered — the button
// to say what came back. Shared by the sale page and the Deliveries list.
export default function ExchangeNotice({
  exchange,
  delivered,
  deliveryStatus,
  canAct,
  onChanged,
  receiveLabel = "Mark Received",
  className = "",
}: {
  exchange: SaleExchange;
  // The new order has been delivered — only then can the old items be received.
  delivered: boolean;
  // Where the new order is (stock reserved / dispatched / delivered), for the stage shown. Falls back to `delivered`.
  deliveryStatus?: string | null;
  // Whether to offer the button that books the old items in (anyone at the shop can; a damaged or missing item asks for an admin's password).
  canAct: boolean;
  onChanged?: () => void;
  // What the button that says the old items have arrived is called.
  receiveLabel?: string;
  className?: string;
}) {
  const [receiving, setReceiving] = useState(false);
  // Store credit the old items will give that can be handed over now (their value beyond what the replacement still owes).
  const { runWithApproval } = useAdminApproval();
  const [confirmingAdvance, setConfirmingAdvance] = useState(false);
  const [advanceBusy, setAdvanceBusy] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const advance = exchange.status === "awaiting_pickup" ? exchange.advance_available ?? 0 : 0;
  async function giveAdvance() {
    setAdvanceBusy(true);
    setAdvanceError(null);
    try {
      await runWithApproval((approval) => api.post(`/exchanges/${exchange.id}/advance-credit`, {}, { approval }));
      setConfirmingAdvance(false);
      onChanged?.();
    } catch (err) {
      setAdvanceError(err instanceof ApiRequestError ? err.message : "That didn't work — try again");
    } finally {
      setAdvanceBusy(false);
    }
  }

  const status = STATUS[exchange.status];
  const stage = exchangeStage({ status: exchange.status, delivery_status: deliveryStatus ?? (delivered ? "delivered" : null) });
  const waiting = exchange.items.filter((i) => i.status === "awaiting");
  const weCarry = exchange.pickup_charge - exchange.pickup_collected;

  return (
    <div className={`rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm ${className}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium text-gray-900">
          <Repeat size={14} className="text-gray-500" />
          Exchange for {Array.from(new Set(exchange.items.map((i) => i.old_invoice))).join(", ")}
        </span>
        <Badge label={stage} tone={status.tone} />
      </div>

      <ul className="mt-1.5 space-y-0.5">
        {exchange.items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-baseline gap-x-2 text-gray-600">
            <span className="text-gray-900">{itemName(i)}</span>
            <span className="text-xs text-gray-500">
              {i.old_invoice} · worth {money(i.credit_amount)}
            </span>
            {i.status === "received" && <span className="text-xs text-emerald-700">received{i.item_condition === "damaged" ? " (damaged)" : ""}</span>}
            {i.status === "not_returned" && <span className="text-xs text-red-600">not handed back — {money(i.applied_share)} stays unpaid</span>}
            {i.status === "awaiting" && exchange.status === "awaiting_pickup" && <span className="text-xs text-amber-700">to collect</span>}
          </li>
        ))}
      </ul>

      {exchange.pickup_charge > 0 && (
        <p className="mt-1.5 text-xs text-gray-500">
          Return charge {money(exchange.pickup_charge)} —{" "}
          {exchange.customer_share_pct === 0
            ? "we pay it"
            : exchange.customer_share_pct === 100
            ? "the customer pays it"
            : `customer pays ${exchange.customer_share_pct}% (${money(exchange.pickup_collected)}), we carry ${money(weCarry)}`}
        </p>
      )}
      {exchange.status === "awaiting_pickup" && !delivered && (
        <p className="mt-0.5 text-xs text-gray-500">
          {exchange.return_service
            ? `${waiting.length === 1 ? "It's" : "They're"} coming back separately, with ${exchange.return_service}.`
            : `The courier collects ${waiting.length === 1 ? "it" : "them"} when the new order is delivered.`}
        </p>
      )}
      {exchange.status === "cancelled" && (
        <p className="mt-0.5 text-xs text-gray-500">
          {exchange.note ?? "Cancelled"} — the customer keeps the old items.
          {exchange.note?.startsWith("Parcel returned")
            ? " The new items are back in stock. Void this invoice to clear what's owed on it — or to refund what the customer already paid."
            : ""}
        </p>
      )}

      {canAct && advance > 0.009 && (
        <div className="mt-2.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
          <p>
            The old items are worth more than what is still owed on the new order: <span className="font-medium text-gray-900">{money(advance)}</span> of their value becomes store credit when they arrive.
          </p>
          {!confirmingAdvance ? (
            <Button className="mt-1.5" onClick={() => setConfirmingAdvance(true)}>
              Give {money(advance)} store credit now
            </Button>
          ) : (
            <div className="mt-1.5 space-y-1.5">
              <p className="text-gray-600">
                The old items haven't arrived yet. When they do, this {money(advance)} is taken off the credit they give, so it is never given twice.
              </p>
              <div className="flex gap-2">
                <Button variant="primary" onClick={giveAdvance} disabled={advanceBusy}>
                  {advanceBusy ? "Giving…" : "Yes, give it now"}
                </Button>
                <Button onClick={() => setConfirmingAdvance(false)} disabled={advanceBusy}>
                  Not now
                </Button>
              </div>
            </div>
          )}
          {advanceError && <p className="mt-1 text-red-600">{advanceError}</p>}
        </div>
      )}
      {exchange.status === "awaiting_pickup" && (exchange.advance_credit ?? 0) > 0.009 && (
        <p className="mt-1.5 text-xs text-gray-500">{money(exchange.advance_credit ?? 0)} store credit was already given in advance; it is taken off when the old items arrive.</p>
      )}

      {canAct && exchange.status === "awaiting_pickup" && delivered && (
        <div className="mt-2.5">
          <Button variant="primary" onClick={() => setReceiving(true)}>
            {receiveLabel}
          </Button>
        </div>
      )}

      {receiving && (
        <ExchangeReceiveModal
          exchange={exchange}
          onClose={() => setReceiving(false)}
          onDone={() => {
            setReceiving(false);
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

// Parcel received — the old items of an exchange have come back (the replacement has been delivered): each one good or bad, with an
// optional reason, and what to do with any value left over. One fixed size, two panes — the exchange on the left, what came back on the
// right (it scrolls when there are many). Used on the exchange's own page and in Returns on the way back.
export function ExchangeReceiveModal({
  exchange,
  invoice,
  customer,
  onClose,
  onDone,
}: {
  exchange: SaleExchange;
  invoice?: string;
  customer?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { runWithApproval } = useAdminApproval();
  const { user } = useAuth();
  const waiting = exchange.items.filter((i) => i.status === "awaiting");
  // Most of the time everything comes back fine — start there.
  const [arrival, setArrival] = useState(() => startGood(waiting.map((i) => i.old_sale_item_id)));
  const [leftoverChoice, setLeftoverChoice] = useState<Leftover>("credit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Everything that was ticked came back (good or bad), so what's left of the old items' value once the new order has taken its part is
  // the customer's to keep as store credit, or to have refunded.
  const worth = waiting.reduce((sum, i) => sum + i.credit_amount, 0);
  const comesOff = waiting.reduce((sum, i) => sum + i.applied_share, 0);
  const leftover = worth - comesOff;
  const needsAdmin = user?.role !== "admin" && (!allGood(arrival) || (leftover > 0.009 && leftoverChoice !== "credit"));

  async function confirm() {
    setBusy(true);
    setError(null);
    // The reasons given, as one note on the exchange.
    const note = waiting
      .filter((i) => arrival.reason[i.old_sale_item_id]?.trim())
      .map((i) => `${itemName(i)} (${arrival.condition[i.old_sale_item_id] === "bad" ? "bad" : "good"}): ${arrival.reason[i.old_sale_item_id].trim()}`)
      .join("; ");
    try {
      await runWithApproval((approval) =>
        api.put(
          `/exchanges/${exchange.id}/receive`,
          {
            items: waiting.map((i) => ({ sale_item_id: i.old_sale_item_id, outcome: arrival.condition[i.old_sale_item_id] === "bad" ? "damaged" : "clean" })),
            ...(note ? { note } : {}),
            ...(leftover > 0.009
              ? {
                  leftover:
                    leftoverChoice === "credit"
                      ? { mode: "credit" }
                      : { mode: "refund", method: leftoverChoice === "refund_cash" ? "cash" : "bank_transfer" },
                }
              : {}),
          },
          { approval }
        )
      );
      onDone();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "That didn't work — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepModal
      title={`Parcel received${invoice ? ` — ${invoice}` : ""}`}
      subtitle={`${customer ?? "Customer"} · the old items are back`}
      onClose={onClose}
      message={error}
      buttons={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={confirm} disabled={busy}>
            {busy ? "Saving…" : "Mark Received"}
          </Button>
        </>
      }
      left={
        <>
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm">
            <div className="flex justify-between py-0.5 text-gray-600">
              <span>Old items ({waiting.length})</span>
              <span className="tabular-nums">{money(worth)}</span>
            </div>
            <div className="flex justify-between py-0.5 text-gray-600">
              <span>Comes off the new order</span>
              <span className="tabular-nums">{money(comesOff)}</span>
            </div>
            <div className={`mt-1 flex justify-between border-t border-gray-100 pt-1.5 ${leftover > 0.009 ? "font-semibold text-gray-900" : "text-gray-400"}`}>
              <span>Left over for the customer</span>
              <span className="tabular-nums">{leftover > 0.009 ? money(leftover) : "—"}</span>
            </div>
          </div>

          {leftover > 0.009 && (
            <div className="mt-4">
              <p className="mb-1.5 text-sm font-medium text-gray-900">The new items cost less. What does the customer want with the {money(leftover)}?</p>
              <div className="space-y-1.5">
                {(
                  [
                    ["credit", "Keep as store credit", "Spend it next time"],
                    ["refund_cash", "Refund in cash", "From the till"],
                    ["refund_bank", "Refund by bank transfer", "You transfer it"],
                  ] as const
                ).map(([value, label, hint]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setLeftoverChoice(value)}
                    className={`block w-full rounded-xl border bg-white px-3 py-2 text-left transition ${leftoverChoice === value ? "border-black" : "border-gray-200 hover:border-gray-300"}`}
                  >
                    <span className="block text-sm font-medium text-gray-900">{label}</span>
                    <span className="block text-xs text-gray-500">{hint}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {needsAdmin && <p className="mt-3 text-xs text-gray-500">A bad item, or paying the difference out, needs an admin's password — you'll be asked for it when you confirm.</p>}
        </>
      }
    >
      <ArrivalChoice
        items={waiting.map((i) => ({
          id: i.old_sale_item_id,
          name: itemName(i),
          detail: `· ${i.old_invoice} · ${money(i.credit_amount)}`,
          badNote: "Recorded as damaged stock — it isn't put back for sale. Its value still comes off the new order.",
        }))}
        state={arrival}
        onChange={setArrival}
      />
    </StepModal>
  );
}

const OUT_ITEM_STATUS: Record<SaleExchangeItem["status"], { text: string; className: string }> = {
  awaiting: { text: "to be collected with the replacement", className: "text-amber-700" },
  received: { text: "received — exchanged", className: "text-emerald-700" },
  not_returned: { text: "not handed back", className: "text-red-600" },
  cancelled: { text: "exchange cancelled — the customer keeps it", className: "text-gray-400" },
};

// On the OLD invoice: its items are being (or were) swapped for a replacement order — so
// anyone opening it, or finding it in a search, sees that straight away and can jump to
// the replacement. One block per exchange that took items out of it.
export function ExchangedOutNotice({ exchanges, className = "" }: { exchanges: SaleExchangeOut[]; className?: string }) {
  if (exchanges.length === 0) return null;
  return (
    <div className={`space-y-2 ${className}`}>
      {exchanges.map((x) => {
        const status = STATUS[x.status];
        return (
          <div key={x.exchange_id} className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1.5 font-medium text-gray-900">
                <Repeat size={14} className="text-gray-500" />
                {x.status === "received" ? "Exchanged" : x.status === "cancelled" ? "Exchange cancelled" : "Being exchanged"} — replacement{" "}
                <RefLink to={`/sales/${x.new_sale_id}`}>{x.new_invoice}</RefLink>
              </span>
              <Badge label={status.label} tone={status.tone} />
            </div>
            <ul className="mt-1.5 space-y-0.5">
              {x.items.map((i) => {
                const s = OUT_ITEM_STATUS[i.status];
                const v = [i.size, i.color].filter(Boolean).join(", ");
                return (
                  <li key={i.id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-gray-900">
                      {i.title ?? "Item"}
                      {v ? ` (${v})` : ""}
                    </span>
                    <span className="text-xs text-gray-500">{money(i.credit_amount)}</span>
                    <span className={`text-xs ${s.className}`}>{s.text}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
