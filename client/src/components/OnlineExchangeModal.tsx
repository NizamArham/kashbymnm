import { ReactNode, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { InventoryUnit, Sale } from "../lib/types";
import { calculateDeliveryFee, useDeliveryPartners } from "../lib/delivery";
import { cleanDecimal, cleanMoney } from "../lib/numberInput";
import { useAuth } from "../context/AuthContext";
import { Button, Dropdown, DropdownOption, ErrorText, FormGroup, HelpHint, Input, Label, Modal } from "./ui";

interface EligibleItem {
  sale_item_id: number;
  sale_id: number;
  invoice: string;
  unit_price: number;
  product_title: string | null;
  size: string | null;
  color: string | null;
  delivery_partner: string | null;
  package_weight_kg: number | null;
}

interface NewLine {
  key: string; // the variant (product / size / colour / price) this line takes units of
  qty: string;
}

const money = (n: number) => `Rs. ${Math.round(n).toLocaleString()}`;
const variant = (size: string | null, color: string | null) => [size, color].filter(Boolean).join(" / ");

// Who pays the courier's charge for collecting the old items.
const SHARE_OPTIONS: { pct: number; label: string; hint: string }[] = [
  { pct: 0, label: "We pay", hint: "Our mistake — wrong item or a defect" },
  { pct: 50, label: "Half and half", hint: "The customer pays half, we pay half" },
  { pct: 100, label: "Customer pays", hint: "The customer pays all of it" },
];

// An exchange by delivery: the new items go out as a normal online order and the
// courier brings the old ones back on the same trip. Any number of old items can be
// swapped, and the new order can hold as many pieces as the customer likes (an extra
// size, something more). The old items' value comes off the new order once they're
// received; the pickup charge is split as chosen here.
export default function OnlineExchangeModal({
  sale,
  onClose,
  onCreated,
}: {
  sale: Sale;
  onClose: () => void;
  onCreated: (created: { id: number; invoice: string }) => void;
}) {
  const { user } = useAuth();
  const { activePartners } = useDeliveryPartners();
  const couriers = activePartners.filter((p) => p.kind === "courier");

  const [eligible, setEligible] = useState<EligibleItem[] | null>(null);
  const [units, setUnits] = useState<InventoryUnit[]>([]);
  const [oldIds, setOldIds] = useState<number[]>([]);
  const [lines, setLines] = useState<NewLine[]>([{ key: "", qty: "1" }]);
  const [partnerCode, setPartnerCode] = useState("");
  const [weight, setWeight] = useState("1");
  const [freeDelivery, setFreeDelivery] = useState(false);
  const [pickup, setPickup] = useState("");
  const [pickupEdited, setPickupEdited] = useState(false);
  const [sharePct, setSharePct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!sale.customer_id) return;
    api
      .get<EligibleItem[]>(`/exchanges/eligible?customer_id=${sale.customer_id}`)
      .then((items) => {
        setEligible(items);
        // Start with the items of the order this was opened from.
        const fromThisOrder = items.filter((i) => i.sale_id === sale.id);
        setOldIds((fromThisOrder.length ? fromThisOrder : items.slice(0, 1)).map((i) => i.sale_item_id));
      })
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Couldn't load this customer's delivered items"));
    api
      .get<InventoryUnit[]>("/inventory?status=available")
      .then(setUnits)
      .catch(() => setError("Couldn't load the stock list"));
  }, [sale.customer_id, sale.id]);

  const oldItems = (eligible ?? []).filter((i) => oldIds.includes(i.sale_item_id));
  const firstOld = oldItems[0] ?? null;

  // The new order goes by the same courier the old items came by, to start with.
  useEffect(() => {
    if (!firstOld || couriers.length === 0) return;
    setPartnerCode((cur) => (cur && couriers.some((c) => c.code === cur) ? cur : couriers.find((c) => c.code === firstOld.delivery_partner)?.code ?? couriers[0].code));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstOld?.sale_item_id, couriers.length]);

  // One entry per distinct variant at its price, with every unit available of it.
  const variants = useMemo(() => {
    const byKey = new Map<string, InventoryUnit[]>();
    for (const u of units) {
      const price = u.selling_price ?? u.product_selling_price ?? 0;
      const key = `${u.product_id}|${u.size ?? ""}|${u.color ?? ""}|${price}`;
      byKey.set(key, [...(byKey.get(key) ?? []), u]);
    }
    const options: DropdownOption[] = Array.from(byKey, ([key, list]) => {
      const u = list[0];
      return {
        value: key,
        label: `${u.product_title ?? "Item"}${variant(u.size, u.color) ? ` · ${variant(u.size, u.color)}` : ""}`,
        sublabel: `${money(u.selling_price ?? u.product_selling_price ?? 0)} · ${list.length} in stock`,
      };
    });
    return { byKey, options };
  }, [units]);

  const partner = couriers.find((c) => c.code === partnerCode);
  const weightNum = Number(weight) || 0;
  const deliveryFee = calculateDeliveryFee(weightNum, freeDelivery, partner);
  const tariffPickup = calculateDeliveryFee(weightNum, false, partner);

  // The pickup charge starts as the courier's tariff for this weight, until it's typed over.
  useEffect(() => {
    if (!pickupEdited) setPickup(tariffPickup ? String(tariffPickup) : "");
  }, [tariffPickup, pickupEdited]);

  // The pieces the new order will hold, with how many of each variant are in stock.
  const chosen = lines
    .map((l) => {
      const list = variants.byKey.get(l.key);
      const qty = Math.max(0, Math.floor(Number(l.qty) || 0));
      return list && qty > 0 ? { list, qty: Math.min(qty, list.length), wanted: qty } : null;
    })
    .filter((x): x is { list: InventoryUnit[]; qty: number; wanted: number } => x !== null);
  const pieces = chosen.reduce((sum, c) => sum + c.qty, 0);
  const newTotal = chosen.reduce((sum, c) => sum + c.qty * (c.list[0].selling_price ?? c.list[0].product_selling_price ?? 0), 0);
  const overStock = chosen.some((c) => c.wanted > c.list.length);

  const credit = oldItems.reduce((sum, i) => sum + i.unit_price, 0);
  const applied = Math.min(credit, newTotal);
  // Only once something is chosen to compare against.
  const leftover = pieces > 0 ? Math.max(0, credit - newTotal) : 0;
  const pickupCharge = Number(pickup) || 0;
  const customerShare = Math.round((pickupCharge * (sharePct ?? 0)) / 100);
  const weCarry = pickupCharge - customerShare;
  const toPayAtDoor = Math.max(0, newTotal - applied + deliveryFee + customerShare);

  function toggleOld(id: number) {
    setOldIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }
  function updateLine(i: number, patch: Partial<NewLine>) {
    setLines((cur) => cur.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function submit() {
    setError(null);
    if (!sale.customer_id || oldItems.length === 0 || pieces === 0) return;
    if (!partner) return setError("Pick the courier that will deliver it.");
    if (!(weightNum > 0)) return setError("Enter the parcel weight.");
    if (sharePct === null) return setError("Choose who pays the pickup charge.");
    if (overStock) return setError("There isn't enough stock for one of the lines — lower its quantity.");
    setSubmitting(true);
    try {
      const items = chosen.flatMap((c) =>
        c.list.slice(0, c.qty).map((u) => ({ inventory_id: u.id, unit_price: u.selling_price ?? u.product_selling_price ?? 0 }))
      );
      const created = await api.post<{ id: number; invoice: string }>("/sales", {
        customer_id: sale.customer_id,
        salesperson: user?.name ?? user?.username,
        items,
        sale_type: "online",
        delivery_partner: partner.code,
        package_weight_kg: weightNum,
        is_free_delivery: freeDelivery,
        amount_paid: 0,
        payment_method: "cash",
        exchange: { old_sale_item_ids: oldItems.map((i) => i.sale_item_id), pickup_charge: pickupCharge, customer_share_pct: sharePct },
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't create the exchange order");
    } finally {
      setSubmitting(false);
    }
  }

  const ready = oldItems.length > 0 && pieces > 0 && !overStock && !!partner && sharePct !== null && weightNum > 0;

  // One line in the footer says what's missing or went wrong, so nothing above it
  // ever has to make room for a message.
  const hint =
    error ??
    (eligible && eligible.length > 0 && !ready
      ? oldItems.length === 0
        ? "Tick the old item(s) coming back."
        : pieces === 0
        ? "Choose what the customer is getting instead."
        : overStock
        ? "Not enough in stock for a quantity."
        : sharePct === null
        ? "Choose who pays the pickup charge."
        : null
      : null);

  return (
    <Modal
      size="3xl"
      height="h-[min(44rem,calc(100dvh-2rem))]"
      flush
      onClose={onClose}
      title="Exchange by delivery"
      subtitle={`${sale.customer_name ?? "Customer"} — the courier brings the old items back with the new order`}
      footer={
        <>
          <span className={`mr-auto min-w-0 basis-full text-xs sm:basis-0 sm:flex-1 ${error ? "text-red-500" : "text-gray-400"}`}>{hint}</span>
          <Button onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!ready || submitting}>
            {submitting ? "Creating…" : "Create exchange order"}
          </Button>
        </>
      }
    >
      {!eligible && !error && <p className="px-6 py-5 text-sm text-gray-400">Loading…</p>}
      {!eligible && error && <p className="px-6 py-5 text-sm text-red-500">{error}</p>}
      {eligible && eligible.length === 0 && (
        <p className="px-6 py-5 text-sm text-gray-500">
          This customer has no delivered online item that can be exchanged this way — it has to be delivered already, and not returned or in another exchange.
        </p>
      )}

      {eligible && eligible.length > 0 && (
        // Two panes at a fixed size: what's being swapped on the left; the pickup charge
        // and the running figures on the right. Each pane scrolls on its own if the
        // screen is short — the popup itself never changes size. On a phone they stack.
        <div className="h-full overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:overflow-hidden">
          <div className="px-6 py-5 lg:overflow-y-auto">
            <Label>Old items coming back with the delivery</Label>
            <div className="mb-5 max-h-44 divide-y divide-gray-100 overflow-y-auto rounded-xl border border-gray-200">
              {eligible.map((i) => (
                <label key={i.sale_item_id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50">
                  <input type="checkbox" checked={oldIds.includes(i.sale_item_id)} onChange={() => toggleOld(i.sale_item_id)} className="h-4 w-4 accent-black" />
                  <span className="min-w-0 flex-1 truncate text-gray-900">
                    {i.product_title ?? "Item"}
                    {variant(i.size, i.color) && <span className="text-gray-500"> · {variant(i.size, i.color)}</span>}
                    <span className="ml-2 text-xs text-gray-400">{i.invoice}</span>
                  </span>
                  <span className="tabular-nums text-gray-600">{money(i.unit_price)}</span>
                </label>
              ))}
            </div>

            <Label>
              New items <HelpHint text="Everything the customer is now buying. It can be more pieces than they're returning — the old items' value comes off the total." />
            </Label>
            <div className="space-y-2">
              {lines.map((l, i) => {
                const list = variants.byKey.get(l.key);
                const over = list && Number(l.qty) > list.length;
                return (
                  <div key={i} className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <Dropdown value={l.key} onChange={(v) => updateLine(i, { key: v })} options={variants.options} searchable placeholder="Search the stock…" />
                    </div>
                    <div className="w-16 flex-shrink-0">
                      <Input inputMode="numeric" value={l.qty} onChange={(e) => updateLine(i, { qty: e.target.value.replace(/\D/g, "").slice(0, 3) })} className={over ? "!border-red-300" : ""} aria-label="Quantity" />
                    </div>
                    {lines.length > 1 && (
                      <button type="button" onClick={() => setLines((cur) => cur.filter((_, idx) => idx !== i))} className="mt-2.5 text-gray-400 hover:text-gray-700" title="Remove this line">
                        <X size={16} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <button type="button" onClick={() => setLines((cur) => [...cur, { key: "", qty: "1" }])} className="mt-2 mb-5 text-xs text-gray-500 underline hover:text-gray-800">
              + Add another item
            </button>

            <Label>Delivery</Label>
            <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-center gap-3 sm:grid-cols-[minmax(0,1fr)_6.5rem_auto]">
              <Dropdown value={partnerCode} onChange={setPartnerCode} options={couriers.map((c) => ({ value: c.code, label: c.name }))} />
              <div className="relative">
                <Input inputMode="decimal" value={weight} onChange={(e) => setWeight(cleanDecimal(e.target.value))} className="pr-9" aria-label="Parcel weight in kg" />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">kg</span>
              </div>
              <label className="col-span-2 flex items-center gap-2 whitespace-nowrap text-sm text-gray-700 sm:col-span-1">
                <input type="checkbox" checked={freeDelivery} onChange={(e) => setFreeDelivery(e.target.checked)} className="h-4 w-4 accent-black" />
                Free delivery <HelpHint text="We pay the courier's delivery charge for the new order. The pickup charge on the right is separate." />
              </label>
            </div>
          </div>

          <div className="border-t border-gray-100 bg-gray-50/70 px-5 py-3 lg:overflow-y-auto lg:border-l lg:border-t-0">
            <Label>
              Pickup charge (Rs.){" "}
              <HelpHint text="What the courier charges for bringing the old items back. It starts as their normal charge for this weight — change it if they quoted something else." />
            </Label>
            <Input
              inputMode="decimal"
              value={pickup}
              onChange={(e) => {
                setPickupEdited(true);
                setPickup(cleanMoney(e.target.value));
              }}
              className="mb-2"
            />

            <Label>Who pays it?</Label>
            <div className="mb-3 space-y-1.5">
              {SHARE_OPTIONS.map((o) => (
                <button
                  key={o.pct}
                  type="button"
                  onClick={() => setSharePct(o.pct)}
                  className={`flex w-full items-baseline justify-between gap-3 rounded-xl border bg-white px-3 py-1.5 text-left transition ${
                    sharePct === o.pct ? "border-black" : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <span className="text-sm font-medium text-gray-900">{o.label}</span>
                  <span className="text-right text-[11px] leading-tight text-gray-500">{o.hint}</span>
                </button>
              ))}
            </div>

            {/* Always the same rows, so the figures update in place and nothing moves. */}
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm">
              <Row label={`New items${pieces ? ` (${pieces})` : ""}`} value={pieces ? money(newTotal) : "—"} />
              <Row label="Old items' value" value={oldItems.length && pieces ? `− ${money(applied)}` : "—"} />
              <Row label="Delivery" value={weightNum ? (freeDelivery ? "Free" : `+ ${money(deliveryFee)}`) : "—"} />
              <Row label="Customer's pickup share" value={sharePct === null ? "—" : customerShare > 0 ? `+ ${money(customerShare)}` : "—"} />
              <div className="my-1.5 border-t border-gray-200" />
              <Row label="Collected at the door" value={oldItems.length && pieces ? money(toPayAtDoor) : "—"} strong />
              <div className="mt-1.5 border-t border-gray-100 pt-1.5">
                <Row
                  label={
                    <>
                      Left over for the customer{" "}
                      <HelpHint text="The new items cost less than the old ones. When the old items arrive you choose: keep the difference as store credit, or refund it." />
                    </>
                  }
                  value={leftover > 0 ? money(leftover) : "—"}
                  muted={leftover <= 0}
                />
                <Row label="Pickup charge we carry" value={sharePct === null ? "—" : weCarry > 0 ? money(weCarry) : "—"} muted />
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Row({ label, value, strong, muted }: { label: ReactNode; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-0.5 ${muted ? "text-gray-400" : "text-gray-600"}`}>
      <span>{label}</span>
      <span className={`tabular-nums ${strong ? "font-semibold text-gray-900" : ""}`}>{value}</span>
    </div>
  );
}
