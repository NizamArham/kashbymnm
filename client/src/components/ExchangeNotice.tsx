import { useState } from "react";
import { Repeat } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { SaleExchange, SaleExchangeItem, SaleExchangeOut } from "../lib/types";
import { Badge, Button, ErrorText, Modal, RefLink } from "./ui";

const money = (n: number) => `Rs. ${Math.round(n).toLocaleString()}`;

const STATUS: Record<SaleExchange["status"], { label: string; tone: "warning" | "success" | "danger" | "neutral" }> = {
  awaiting_pickup: { label: "Waiting for the old items", tone: "warning" },
  received: { label: "Old items received", tone: "success" },
  not_returned: { label: "Old items not returned", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

type Outcome = "clean" | "damaged" | "not_returned";
type Leftover = "credit" | "refund_cash" | "refund_bank";

const itemName = (i: SaleExchangeItem) => `${i.title ?? "Item"}${[i.size, i.color].filter(Boolean).length ? ` (${[i.size, i.color].filter(Boolean).join(", ")})` : ""}`;

// What an online exchange order is doing: which old items the courier is bringing back,
// who pays the pickup charge, and — once the new order has been delivered — the button
// to say what came back. Shared by the sale page and the Deliveries list.
export default function ExchangeNotice({
  exchange,
  delivered,
  canAct,
  onChanged,
  className = "",
}: {
  exchange: SaleExchange;
  // The new order has been delivered — only then can the old items be received.
  delivered: boolean;
  // Admins only: receiving an item is a return (stock, credit, loyalty).
  canAct: boolean;
  onChanged?: () => void;
  className?: string;
}) {
  const [receiving, setReceiving] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<number, Outcome>>({});
  const [leftoverChoice, setLeftoverChoice] = useState<Leftover>("credit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = STATUS[exchange.status];
  const waiting = exchange.items.filter((i) => i.status === "awaiting");
  const weCarry = exchange.pickup_charge - exchange.pickup_collected;

  function startReceiving() {
    // Most of the time everything comes back fine — start there.
    setOutcomes(Object.fromEntries(waiting.map((i) => [i.old_sale_item_id, "clean" as Outcome])));
    setLeftoverChoice("credit");
    setError(null);
    setReceiving(true);
  }

  // What's left of the returned items' value once the new order has taken its part —
  // the customer's to keep as store credit, or to have refunded.
  const leftover = waiting
    .filter((i) => (outcomes[i.old_sale_item_id] ?? "clean") !== "not_returned")
    .reduce((sum, i) => sum + (i.credit_amount - i.applied_share), 0);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/exchanges/${exchange.id}/receive`, {
        items: waiting.map((i) => ({ sale_item_id: i.old_sale_item_id, outcome: outcomes[i.old_sale_item_id] ?? "clean" })),
        ...(leftover > 0.009
          ? {
              leftover:
                leftoverChoice === "credit"
                  ? { mode: "credit" }
                  : { mode: "refund", method: leftoverChoice === "refund_cash" ? "cash" : "bank_transfer" },
            }
          : {}),
      });
      setReceiving(false);
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "That didn't work — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm ${className}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium text-gray-900">
          <Repeat size={14} className="text-gray-500" />
          Exchange for {Array.from(new Set(exchange.items.map((i) => i.old_invoice))).join(", ")}
        </span>
        <Badge label={status.label} tone={status.tone} />
      </div>

      <ul className="mt-1.5 space-y-0.5">
        {exchange.items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-baseline gap-x-2 text-gray-600">
            <span className="text-gray-900">{itemName(i)}</span>
            <span className="text-xs text-gray-400">
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
          Pickup charge {money(exchange.pickup_charge)} —{" "}
          {exchange.customer_share_pct === 0
            ? "we pay it"
            : exchange.customer_share_pct === 100
            ? "the customer pays it"
            : `customer pays ${exchange.customer_share_pct}% (${money(exchange.pickup_collected)}), we carry ${money(weCarry)}`}
        </p>
      )}
      {exchange.status === "awaiting_pickup" && !delivered && (
        <p className="mt-0.5 text-xs text-gray-500">The courier collects {waiting.length === 1 ? "it" : "them"} when the new order is delivered.</p>
      )}
      {exchange.status === "cancelled" && (
        <p className="mt-0.5 text-xs text-gray-500">
          {exchange.note ?? "Cancelled"} — the customer keeps the old items.
          {exchange.note?.startsWith("Parcel returned")
            ? " The new items are back in stock. Void this invoice to clear what's owed on it."
            : ""}
        </p>
      )}

      {canAct && exchange.status === "awaiting_pickup" && delivered && (
        <div className="mt-2.5">
          <Button variant="primary" onClick={startReceiving}>
            Old items received
          </Button>
        </div>
      )}

      {receiving && (
        <Modal
          size="md"
          onClose={() => setReceiving(false)}
          title="What came back?"
          subtitle="Say what happened to each old item the courier was to collect"
          footer={
            <>
              <Button onClick={() => setReceiving(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" onClick={confirm} disabled={busy}>
                {busy ? "Saving…" : "Confirm"}
              </Button>
            </>
          }
        >
          {error && <ErrorText>{error}</ErrorText>}
          <div className="space-y-3">
            {waiting.map((i) => {
              const chosen = outcomes[i.old_sale_item_id] ?? "clean";
              return (
                <div key={i.id} className="rounded-xl border border-gray-200 px-3 py-2.5">
                  <p className="text-sm text-gray-900">
                    {itemName(i)} <span className="text-xs text-gray-400">· {i.old_invoice} · {money(i.credit_amount)}</span>
                  </p>
                  <div className="mt-2 grid grid-cols-3 gap-1.5">
                    {(
                      [
                        ["clean", "Clean", "Back on the shelf"],
                        ["damaged", "Damaged", "Recorded as damaged"],
                        ["not_returned", "Not handed back", `${money(i.applied_share)} stays unpaid`],
                      ] as const
                    ).map(([value, label, hint]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setOutcomes((cur) => ({ ...cur, [i.old_sale_item_id]: value }))}
                        className={`rounded-lg border px-2 py-1.5 text-left transition ${chosen === value ? "border-black bg-gray-50" : "border-gray-200 hover:border-gray-300"}`}
                      >
                        <span className="block text-xs font-medium text-gray-900">{label}</span>
                        <span className="block text-[11px] leading-tight text-gray-500">{hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {leftover > 0.009 && (
            <div className="mt-4">
              <p className="mb-1.5 text-sm font-medium text-gray-900">
                The new items cost less — {money(leftover)} is left over. What does the customer want?
              </p>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
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
                    className={`rounded-xl border px-3 py-2 text-left transition ${leftoverChoice === value ? "border-black bg-gray-50" : "border-gray-200 hover:border-gray-300"}`}
                  >
                    <span className="block text-sm font-medium text-gray-900">{label}</span>
                    <span className="block text-xs text-gray-500">{hint}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
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
                    <span className="text-xs text-gray-400">{money(i.credit_amount)}</span>
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
