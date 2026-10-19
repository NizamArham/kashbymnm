import { ReactNode, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { InventoryUnit, Sale } from "../lib/types";
import { calculateDeliveryFee, useDeliveryPartners } from "../lib/delivery";
import { cleanDecimal } from "../lib/numberInput";
import { useAuth } from "../context/AuthContext";
import { useAdminApproval } from "./AdminApproval";
import { SHARE_OPTIONS } from "../lib/pickupShare";
import { clearExchangeDraft, exchangeDraftFor, saveExchangeDraft, setExchangePopupVisible } from "../lib/exchangeDraft";
import { Button, Dropdown, DropdownOption, ErrorText, FormGroup, HelpHint, Input, Label, Modal, MoneyInput } from "./ui";

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
  // 0 = a no-returns (final sale) product
  allow_returns?: number;
}

interface NewLine {
  key: string; // the variant (product / size / colour / price) this line takes units of
  qty: string;
  price: string; // what each piece is billed at; empty = the tag price
  unitId?: number; // set when one particular piece was scanned or typed by its SKU / barcode — the line is that piece
}

const money = (n: number) => `Rs. ${Math.round(n).toLocaleString()}`;
const variant = (size: string | null, color: string | null) => [size, color].filter(Boolean).join(" / ");
const tagOf = (u: InventoryUnit) => u.selling_price ?? u.product_selling_price ?? 0;
// One entry per product / size / colour / price — the key a new-item line is made of.
const variantKeyOf = (u: InventoryUnit) => `${u.product_id}|${u.size ?? ""}|${u.color ?? ""}|${tagOf(u)}`;


// How the customer is paying for the exchange: at the door (COD), or already — by bank transfer, card or cash.
type Payment = "cod" | "bank_transfer" | "card" | "cash";
const PAYMENTS: { key: Payment; label: string }[] = [
  { key: "cod", label: "On delivery" },
  { key: "bank_transfer", label: "Bank transfer" },
  { key: "card", label: "Card" },
  { key: "cash", label: "Cash" },
];

// An exchange by delivery: the new items go out as a normal online order and the
// courier brings the old ones back on the same trip. Any number of old items can be
// swapped, and the new order can hold as many pieces as the customer likes (an extra
// size, something more). The old items' value comes off the new order once they're
// received; the pickup charge is split as chosen here.
//
// Payment is either collected at the door (COD) or already received — and when it isn't confirmed yet, the exchange
// is held as a quotation instead (nothing reserved or booked) and turned into the order from the quotation's page.
// With `quote` set, `sale` IS that quotation and the popup confirms it.
//
// A delivery exchange is a request: an admin's own goes straight ahead, a cashier's is sent for approval — saved as a payment request
// with its pieces held for the day — and the order is made from it once an admin has said yes. (An admin standing at the till can also
// type their password to make it right away.)
export default function OnlineExchangeModal({
  sale,
  quote = false,
  onClose,
  onCreated,
  onQuoted,
}: {
  sale: Sale;
  quote?: boolean;
  onClose: () => void;
  onCreated: (created: { id: number; invoice: string }) => void;
  onQuoted?: (created: { id: number; invoice: string }) => void;
}) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { runWithApproval } = useAdminApproval();
  const { activePartners } = useDeliveryPartners();
  const couriers = activePartners.filter((p) => p.kind === "courier");

  // A popup that was left half-filled (page changed, reload) comes back as it was — see lib/exchangeDraft.ts.
  const [held] = useState(() => exchangeDraftFor(sale.id, quote, user?.id));

  const [eligible, setEligible] = useState<EligibleItem[] | null>(null);
  const [units, setUnits] = useState<InventoryUnit[]>([]);
  const [oldIds, setOldIds] = useState<number[]>(held?.oldIds ?? []);
  const [lines, setLines] = useState<NewLine[]>(held?.lines?.length ? held.lines : [{ key: "", qty: "1", price: "" }]);
  const [partnerCode, setPartnerCode] = useState(held?.partnerCode ?? "");
  const [weight, setWeight] = useState(held?.weight ?? "1");
  const [freeDelivery, setFreeDelivery] = useState(held?.freeDelivery ?? false);
  const [pickup, setPickup] = useState(held?.pickup ?? "");
  const [pickupEdited, setPickupEdited] = useState(held?.pickupEdited ?? false);
  const [sharePct, setSharePct] = useState<number | null>(held?.sharePct ?? null);
  const [payment, setPayment] = useState<Payment>((held?.payment as Payment | undefined) ?? "cod");
  // When held as a payment request: keep the pieces for the customer until closing today (free), so they aren't sold meanwhile.
  const [holdStock, setHoldStock] = useState(held?.holdStock ?? true);
  // The old items come back with the delivery of the new order (our courier collects them), or separately — sent by the customer
  // with any other service, which doesn't matter beyond its name and what it cost.
  const [returnVia, setReturnVia] = useState<"delivery" | "separate">(held?.returnVia ?? "delivery");
  const [returnService, setReturnService] = useState(held?.returnService ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A held popup already has what the quotation said (and whatever was changed since) — don't overwrite it.
  const [filledFromQuote, setFilledFromQuote] = useState(!!held);

  // Hold what's on the screen. Closing the popup only puts it aside; Cancel, creating the order or holding it as a quote
  // lets it go.
  useEffect(() => {
    saveExchangeDraft({
      userId: user?.id ?? null,
      saleId: sale.id,
      quote,
      customer: sale.customer_name ?? "Customer",
      invoice: sale.invoice,
      oldIds,
      lines,
      partnerCode,
      weight,
      freeDelivery,
      pickup,
      pickupEdited,
      sharePct,
      payment,
      holdStock,
      returnVia,
      returnService,
    });
  }, [user?.id, sale.id, sale.customer_name, sale.invoice, quote, oldIds, lines, partnerCode, weight, freeDelivery, pickup, pickupEdited, sharePct, payment, holdStock, returnVia, returnService]);
  useEffect(() => {
    setExchangePopupVisible(true);
    return () => setExchangePopupVisible(false);
  }, []);

  useEffect(() => {
    if (!sale.customer_id) return;
    api
      .get<EligibleItem[]>(`/exchanges/eligible?customer_id=${sale.customer_id}`)
      .then((items) => {
        setEligible(items);
        if (held) {
          // Back from being held: keep what was ticked, minus anything that can't be exchanged any more.
          setOldIds((cur) => cur.filter((id) => items.some((i) => i.sale_item_id === id)));
          return;
        }
        // Nothing is ticked to begin with — what's coming back is picked, not un-picked from everything.
      })
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Couldn't load this customer's delivered items"));
    api
      // Pieces held for another payment request aren't offered — except the ones held for the one being confirmed.
      .get<InventoryUnit[]>(`/inventory?status=available&sellable=1${quote ? `&for_sale=${sale.id}` : ""}`)
      .then(setUnits)
      .catch(() => setError("Couldn't load the stock list"));
  }, [sale.customer_id, sale.id]);

  // A scanned piece that was sold or removed while the popup was held can't stay on its line.
  useEffect(() => {
    if (units.length === 0) return;
    if (lines.some((l) => l.unitId && !units.some((u) => u.id === l.unitId))) {
      setLines((cur) => cur.map((l) => (l.unitId && !units.some((u) => u.id === l.unitId) ? { key: "", qty: "1", price: "" } : l)));
      setError("A piece on the list is no longer in stock — pick it again.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units]);

  const oldItems = (eligible ?? []).filter((i) => oldIds.includes(i.sale_item_id));
  const firstOld = oldItems[0] ?? null;

  // The new order goes by the same courier the old items came by, to start with — the one of the order this was opened from
  // until an old item is ticked.
  useEffect(() => {
    if (couriers.length === 0) return;
    const from = firstOld?.delivery_partner ?? sale.delivery_partner ?? null;
    setPartnerCode((cur) => (cur && couriers.some((c) => c.code === cur) ? cur : couriers.find((c) => c.code === from)?.code ?? couriers[0].code));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstOld?.sale_item_id, couriers.length]);

  // One entry per distinct variant at its price, with every unit available of it.
  const variants = useMemo(() => {
    const byKey = new Map<string, InventoryUnit[]>();
    for (const u of units) {
      const key = variantKeyOf(u);
      byKey.set(key, [...(byKey.get(key) ?? []), u]);
    }
    const options: DropdownOption[] = Array.from(byKey, ([key, list]) => {
      const u = list[0];
      return {
        value: key,
        label: `${u.product_title ?? "Item"}${variant(u.size, u.color) ? ` · ${variant(u.size, u.color)}` : ""}`,
        sublabel: `${money(tagOf(u))} · ${list.length} in stock`,
        // Typing (or scanning) a piece's SKU or barcode finds its variant too.
        keywords: list.map((x) => `${x.sku} ${x.barcode ?? ""}`).join(" "),
      };
    });
    return { byKey, options };
  }, [units]);

  // Confirming a quotation: start from what was quoted — the old items, the pieces and their prices, the courier, the
  // pickup split. Pieces that have since sold out are left off, with a note.
  useEffect(() => {
    const q = sale.exchange_quote;
    if (!quote || !q || filledFromQuote || !eligible || units.length === 0 || couriers.length === 0) return;
    setFilledFromQuote(true);
    setOldIds(q.old_sale_item_ids.filter((id) => eligible.some((e) => e.sale_item_id === id)));
    const byKey = new Map<string, NewLine>();
    let missing = 0;
    for (const item of sale.items ?? []) {
      const key = `${item.product_id}|${item.size ?? ""}|${item.color ?? ""}|${item.original_selling_price ?? ""}`;
      const list = variants.byKey.get(key);
      if (!list) {
        missing += 1;
        continue;
      }
      const price = item.original_selling_price != null && item.unit_price !== item.original_selling_price ? String(item.unit_price) : "";
      const cur = byKey.get(`${key}|${price}`);
      byKey.set(`${key}|${price}`, { key, qty: String(Number(cur?.qty ?? 0) + 1), price });
    }
    if (byKey.size > 0) setLines(Array.from(byKey.values()));
    setPartnerCode(q.delivery_partner);
    setWeight(String(q.package_weight_kg));
    setFreeDelivery(q.is_free_delivery);
    setPickup(String(q.pickup_charge));
    setPickupEdited(true);
    setSharePct(q.customer_share_pct);
    if (q.return_service) {
      setReturnVia("separate");
      setReturnService(q.return_service);
    }
    if (missing > 0) setError(`${missing} piece${missing === 1 ? "" : "s"} on the payment request ${missing === 1 ? "is" : "are"} no longer in stock — check the new items below.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote, sale.exchange_quote, eligible, units, couriers.length, variants]);

  const partner = couriers.find((c) => c.code === partnerCode);
  const weightNum = Number(weight) || 0;
  const deliveryFee = calculateDeliveryFee(weightNum, freeDelivery, partner);
  const tariffPickup = calculateDeliveryFee(weightNum, false, partner);

  // The return charge starts as our courier's tariff for this weight, until it's typed over — when another service carries the old
  // items back there is no tariff of ours to start from, so it's typed in.
  useEffect(() => {
    if (!pickupEdited) setPickup(returnVia === "delivery" && tariffPickup ? String(tariffPickup) : "");
  }, [tariffPickup, pickupEdited, returnVia]);

  // The pieces the new order will hold, with how many of each variant are in stock, and the
  // price each is billed at — the tag price unless it's been typed over (an exchange at the
  // price the customer paid the first time, say).
  const tagPriceOf = (list: InventoryUnit[]) => tagOf(list[0]);
  const chosen = lines
    .map((l) => {
      // A scanned piece is that one piece; anything else is a number of the variant, taken from its stock.
      const pinned = l.unitId ? units.find((u) => u.id === l.unitId) : undefined;
      const list = pinned ? [pinned] : variants.byKey.get(l.key);
      const qty = pinned ? 1 : Math.max(0, Math.floor(Number(l.qty) || 0));
      if (!list || qty <= 0) return null;
      const typed = l.price.trim() === "" ? NaN : Number(l.price);
      return { list, qty: Math.min(qty, list.length), wanted: qty, price: Number.isFinite(typed) && typed >= 0 ? typed : tagPriceOf(list) };
    })
    .filter((x): x is { list: InventoryUnit[]; qty: number; wanted: number; price: number } => x !== null);
  const pieces = chosen.reduce((sum, c) => sum + c.qty, 0);
  const newTotal = chosen.reduce((sum, c) => sum + c.qty * c.price, 0);
  const overStock = chosen.some((c) => c.wanted > c.list.length);

  const credit = oldItems.reduce((sum, i) => sum + i.unit_price, 0);
  const applied = Math.min(credit, newTotal);
  // Only once something is chosen to compare against.
  const leftover = pieces > 0 ? Math.max(0, credit - newTotal) : 0;
  const pickupCharge = Number(pickup) || 0;
  const customerShare = Math.round((pickupCharge * (sharePct ?? 0)) / 100);
  const weCarry = pickupCharge - customerShare;
  // What the customer owes before the old items come back — at the door, or up front if they've already paid.
  const dueNow = Math.max(0, newTotal - applied + deliveryFee + customerShare);
  const prepaid = payment !== "cod";
  const toPayAtDoor = prepaid ? 0 : dueNow;

  function toggleOld(id: number) {
    setOldIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }
  // A typed or scanned SKU / barcode that matches one available piece puts that exact piece on the line (the courier
  // packs that very one), and opens a fresh line below it ready for the next scan. Returns false when nothing matches.
  function pickByCode(lineIndex: number, raw: string): boolean {
    const code = raw.trim().toLowerCase();
    const unit = units.find((u) => u.sku.toLowerCase() === code || (u.barcode ?? "").toLowerCase() === code);
    if (!unit) return false;
    if (lines.some((l, idx) => idx !== lineIndex && l.unitId === unit.id)) {
      setError("That piece is already on the list.");
      return true;
    }
    setError(null);
    setLines((cur) => {
      const next = cur.map((l, idx) => (idx === lineIndex ? { key: variantKeyOf(unit), qty: "1", price: "", unitId: unit.id } : l));
      return lineIndex === cur.length - 1 ? [...next, { key: "", qty: "1", price: "" }] : next;
    });
    setTimeout(() => {
      const boxes = document.querySelectorAll<HTMLInputElement>("[data-stock-line] input");
      boxes[boxes.length - 1]?.focus();
    }, 0);
    return true;
  }
  function updateLine(i: number, patch: Partial<NewLine>) {
    setLines((cur) => cur.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  // The same checks whether the exchange is created now or held as a quotation.
  function checked(): { customerId: number; items: { inventory_id: number; unit_price: number }[]; courier: string } | null {
    setError(null);
    const stop = (message: string) => {
      setError(message);
      return null;
    };
    if (!sale.customer_id || oldItems.length === 0 || pieces === 0) return null;
    if (!partner) return stop("Pick the courier that will deliver it.");
    if (!(weightNum > 0)) return stop("Enter the parcel weight.");
    if (sharePct === null) return stop("Choose who pays the return charge.");
    if (returnVia === "separate" && !returnService.trim()) return stop("Name the service the old items are coming back with.");
    if (overStock) return stop("There isn't enough stock for one of the lines — lower its quantity.");
    const items = chosen.flatMap((c) => c.list.slice(0, c.qty).map((u) => ({ inventory_id: u.id, unit_price: c.price })));
    return { customerId: sale.customer_id, items, courier: partner.code };
  }

  const exchangeBody = () => ({
    old_sale_item_ids: oldItems.map((i) => i.sale_item_id),
    pickup_charge: pickupCharge,
    customer_share_pct: sharePct as number,
    ...(returnVia === "separate" ? { return_service: returnService.trim() } : {}),
  });

  async function submit() {
    const ok = checked();
    if (!ok) return;
    setSubmitting(true);
    try {
      // (An exchange that hasn't been approved asks for an admin's password here — typing it is the approval.)
      const created = await runWithApproval((approval) =>
        api.post<{ id: number; invoice: string }>(
          "/sales",
          {
            customer_id: ok.customerId,
            salesperson: user?.name ?? user?.username,
            items: ok.items,
            sale_type: "online",
            delivery_partner: ok.courier,
            package_weight_kg: weightNum,
            is_free_delivery: freeDelivery,
            // Paid up front: what's due before the old items come back is taken now, so nothing is left for the courier.
            amount_paid: prepaid ? dueNow : 0,
            payment_method: prepaid ? payment : "cash",
            exchange: exchangeBody(),
            ...(quote ? { quotation_id: sale.id } : {}),
          },
          { approval }
        )
      );
      clearExchangeDraft();
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't create the exchange order");
    } finally {
      setSubmitting(false);
    }
  }

  // Not paid yet, or the payment isn't confirmed: keep the exchange as a quotation. Nothing is reserved, charged or
  // recorded; it's turned into the order from its own page once the customer has paid.
  async function holdAsQuote() {
    const ok = checked();
    if (!ok) return;
    setSubmitting(true);
    try {
      const created = await api.post<{ id: number; invoice: string }>("/sales/quotations", {
        customer_id: ok.customerId,
        salesperson: user?.name ?? user?.username,
        items: ok.items,
        sale_type: "online",
        exchange: { ...exchangeBody(), delivery_partner: ok.courier, package_weight_kg: weightNum, is_free_delivery: freeDelivery },
        // A same-day request: the pieces are kept for the customer, and the request is good, until closing today. (One sent for
        // approval always keeps them, so they aren't sold while an admin decides.)
        hold_stock: isAdmin ? holdStock : true,
      });
      clearExchangeDraft();
      onQuoted?.(created);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : isAdmin ? "Couldn't save the payment request" : "Couldn't send it for approval");
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
        ? "Choose who pays the return charge."
        : null
      : null);

  return (
    <Modal
      size="3xl"
      height="h-[min(44rem,calc(100dvh-2rem))]"
      flush
      onClose={onClose}
      title={quote ? `Create exchange order — from ${sale.invoice}` : "Delivery Exchange"}
      subtitle={`${sale.customer_name ?? "Customer"} — the old items come back with the new order, or by another service`}
      footer={
        <>
          <span className={`mr-auto min-w-0 basis-full text-xs sm:basis-0 sm:flex-1 ${error ? "text-red-500" : "text-gray-400"}`}>{hint}</span>
          <Button
            onClick={() => {
              clearExchangeDraft();
              onClose();
            }}
            disabled={submitting}
            title="Cancel throws away what's filled in. Closing the popup with the X keeps it for later."
          >
            Cancel
          </Button>
          {!quote && onQuoted && isAdmin && (
            <Button onClick={holdAsQuote} disabled={!ready || submitting} title="Keep it as a payment request until the customer has paid — nothing is reserved or recorded">
              Hold as payment request
            </Button>
          )}
          {!quote && onQuoted && !isAdmin ? (
            <>
              <Button onClick={submit} disabled={!ready || submitting} title="An admin here can type their password to approve it and make the order right now">
                Create with admin password
              </Button>
              <Button variant="primary" onClick={holdAsQuote} disabled={!ready || submitting} title="An admin approves it first; the pieces are kept for the customer until closing today">
                {submitting ? "Sending…" : "Send for approval"}
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={submit} disabled={!ready || submitting}>
              {submitting ? "Creating…" : "Create exchange order"}
            </Button>
          )}
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
            <div className="flex items-baseline justify-between gap-3">
              <Label>Tick the old items coming back with the delivery</Label>
              {eligible.length > 1 && (
                <button
                  type="button"
                  onClick={() => setOldIds(oldIds.length === eligible.length ? [] : eligible.map((i) => i.sale_item_id))}
                  className="text-xs text-gray-500 underline hover:text-gray-800"
                >
                  {oldIds.length === eligible.length ? "Clear" : "Select all"}
                </button>
              )}
            </div>
            <div className="mb-5 max-h-44 divide-y divide-gray-100 overflow-y-auto rounded-xl border border-gray-200">
              {/* The items of the order this was opened from come first. */}
              {[...eligible].sort((a, b) => Number(b.sale_id === sale.id) - Number(a.sale_id === sale.id)).map((i) => (
                <label key={i.sale_item_id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50">
                  <input type="checkbox" checked={oldIds.includes(i.sale_item_id)} onChange={() => toggleOld(i.sale_item_id)} className="h-4 w-4 accent-black" />
                  <span className="min-w-0 flex-1 truncate text-gray-900">
                    {i.product_title ?? "Item"}
                    {variant(i.size, i.color) && <span className="text-gray-500"> · {variant(i.size, i.color)}</span>}
                    <span className="ml-2 text-xs text-gray-400">{i.invoice}</span>
                    {i.allow_returns === 0 && <span className="ml-2 text-xs text-amber-700">Final Sale</span>}
                  </span>
                  <span className="tabular-nums text-gray-600">{money(i.unit_price)}</span>
                </label>
              ))}
            </div>

            <Label>
              New items <HelpHint text="Everything the customer is now buying. It can be more pieces than they're returning — the old items' value comes off the total. The price box starts empty (the tag price); type one to bill a piece at something else, such as the price they paid before." />
            </Label>
            <div className="space-y-2">
              {lines.map((l, i) => {
                const pinned = l.unitId ? units.find((u) => u.id === l.unitId) : undefined;
                const list = pinned ? [pinned] : variants.byKey.get(l.key);
                const over = !pinned && list && Number(l.qty) > list.length;
                const tag = list ? tagPriceOf(list) : 0;
                const now = l.price.trim() === "" ? tag : Number(l.price) || 0;
                // The same product, already in this customer's old items, at the price they paid for it.
                const paid = list ? oldItems.find((o) => o.product_title && o.product_title === list[0].product_title && o.unit_price !== now) : undefined;
                return (
                  <div key={i}>
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1" data-stock-line>
                        <Dropdown
                          value={l.key}
                          onChange={(v) => updateLine(i, { key: v, price: "", unitId: undefined })}
                          options={variants.options}
                          searchable
                          placeholder="Search the stock, or scan a barcode / SKU…"
                          onSearchEnter={(q) => pickByCode(i, q)}
                        />
                      </div>
                      <div className="w-16 flex-shrink-0">
                        <Input
                          inputMode="numeric"
                          value={pinned ? "1" : l.qty}
                          disabled={!!pinned}
                          onChange={(e) => updateLine(i, { qty: e.target.value.replace(/\D/g, "").slice(0, 3) })}
                          className={over ? "!border-red-300" : ""}
                          aria-label="Quantity"
                        />
                      </div>
                      <div className="w-28 flex-shrink-0">
                        <MoneyInput
                          value={l.price}
                          placeholder={list ? String(tag) : "Price"}
                          onChange={(v) => updateLine(i, { price: v })}
                          aria-label="Price of each piece, in rupees"
                          title="Price of each piece — leave empty for the tag price"
                        />
                      </div>
                      {lines.length > 1 && (
                        <button type="button" onClick={() => setLines((cur) => cur.filter((_, idx) => idx !== i))} className="mt-2.5 text-gray-400 hover:text-gray-700" title="Remove this line">
                          <X size={16} />
                        </button>
                      )}
                    </div>
                    {pinned && (
                      <p className="mt-1 text-xs text-gray-400">
                        This piece: {pinned.sku}
                        {pinned.barcode ? ` · ${pinned.barcode}` : ""} ·{" "}
                        <button type="button" onClick={() => updateLine(i, { unitId: undefined })} className="underline hover:text-gray-700">
                          use any piece of it
                        </button>
                      </p>
                    )}
                    {paid && (
                      <button type="button" onClick={() => updateLine(i, { price: String(paid.unit_price) })} className="mt-1 text-xs text-gray-500 underline hover:text-gray-800">
                        Same price they paid before — {money(paid.unit_price)} <span className="text-gray-400">(tag {money(tag)})</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <button type="button" onClick={() => setLines((cur) => [...cur, { key: "", qty: "1", price: "" }])} className="mt-2 mb-5 text-xs text-gray-500 underline hover:text-gray-800">
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
                Free delivery <HelpHint text="We pay the courier's delivery charge for the new order. The return charge on the right is separate." />
              </label>
            </div>

            <div className="mt-5">
              <Label>How do the old items come back?</Label>
            </div>
            <div className="mb-2 grid grid-cols-2 gap-1.5">
              {(
                [
                  ["delivery", "With the delivery"],
                  ["separate", "Sent back separately"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setReturnVia(key)}
                  className={`rounded-xl border px-2 py-1.5 text-xs font-medium transition ${
                    returnVia === key ? "border-black bg-black text-white" : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {returnVia === "separate" && (
              <Input className="mb-2" placeholder="Service they're sent with (post, bus, a courier…)" value={returnService} onChange={(e) => setReturnService(e.target.value)} />
            )}

            {!quote && onQuoted && !isAdmin && (
              <p className="mt-5 rounded-xl border border-gray-200 px-3.5 py-3 text-xs text-gray-500">
                <span className="block text-sm font-medium text-gray-900">An admin approves this first</span>
                Until they decide, the pieces are kept for the customer till closing today so nobody else can buy them.
                {oldItems.some((i) => i.allow_returns === 0) && " An old item here is Final Sale — the admin will need to give a reason to approve it."}
              </p>
            )}
            {!quote && onQuoted && isAdmin && (
              <label className="mt-5 flex cursor-pointer items-start gap-2.5 rounded-xl border border-gray-200 px-3.5 py-3 text-sm text-gray-700">
                <input type="checkbox" checked={holdStock} onChange={(e) => setHoldStock(e.target.checked)} className="mt-0.5 h-4 w-4 accent-black" />
                <span>
                  <span className="font-medium text-gray-900">If held as a payment request, keep the pieces for the customer until closing today</span>
                  <span className="mt-0.5 block text-xs text-gray-500">
                    Free, and it ends by itself tonight. The pieces can't be sold to anyone else meanwhile, and the request is for today only. Untick to leave them
                    for sale and keep the request open for a week.
                  </span>
                </span>
              </label>
            )}
          </div>

          <div className="border-t border-gray-100 bg-gray-50/70 px-5 py-3 lg:overflow-y-auto lg:border-l lg:border-t-0">
            <Label>
              Return charge (Rs.){" "}
              <HelpHint
                text={
                  returnVia === "delivery"
                    ? "What the courier charges for bringing the old items back on the delivery. It starts as their normal charge for this weight — change it if they quoted something else."
                    : "What it costs to send the old items back with that service — type it in. Our courier isn't charged for it; the customer's share is collected with the new order."
                }
              />
            </Label>
            <MoneyInput
              value={pickup}
              onChange={(v) => {
                setPickupEdited(true);
                setPickup(v);
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

            <Label>
              How is it being paid?{" "}
              <HelpHint text="On delivery: the courier collects it at the door. Bank transfer, card or cash: it's already been received, so nothing is collected at the door. Not confirmed yet? Use Hold as payment request — it's kept without recording anything." />
            </Label>
            <div className="mb-3 grid grid-cols-4 gap-1.5">
              {PAYMENTS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPayment(p.key)}
                  className={`rounded-xl border px-1 py-1.5 text-xs font-medium transition ${
                    payment === p.key ? "border-black bg-black text-white" : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Always the same rows, so the figures update in place and nothing moves. */}
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm">
              <Row label={`New items${pieces ? ` (${pieces})` : ""}`} value={pieces ? money(newTotal) : "—"} />
              <Row label="Old items' value" value={oldItems.length && pieces ? `− ${money(applied)}` : "—"} />
              <Row label="Delivery" value={weightNum ? (freeDelivery ? "Free" : `+ ${money(deliveryFee)}`) : "—"} />
              <Row label="Customer's share of the return charge" value={sharePct === null ? "—" : customerShare > 0 ? `+ ${money(customerShare)}` : "—"} />
              <div className="my-1.5 border-t border-gray-200" />
              {prepaid && <Row label={`Paid now (${PAYMENTS.find((p) => p.key === payment)?.label.toLowerCase()})`} value={oldItems.length && pieces ? money(dueNow) : "—"} strong />}
              <Row label="Collected at the door" value={oldItems.length && pieces ? money(toPayAtDoor) : "—"} strong={!prepaid} muted={prepaid} />
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
                <Row label="Return charge we carry" value={sharePct === null ? "—" : weCarry > 0 ? money(weCarry) : "—"} muted />
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
