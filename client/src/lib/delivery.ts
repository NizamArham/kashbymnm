import { useEffect, useState } from "react";
import { api } from "./api";

// A partner code is whatever the admin set on the Delivery Partners page
// (CPAK, FDR, UBER...) — no longer a fixed list.
export type DeliveryPartner = string;

export interface DeliveryPartnerInfo {
  code: string;
  name: string;
  // 'courier' = a courier company (weight tariff, its own tracking
  // numbers, COD settled with us). 'on_demand' = a ride/dispatch app
  // (Uber, PickMe Flash...): fare typed in per order, invoice number
  // used as the tracking barcode, no COD settlement.
  kind: "courier" | "on_demand";
  waybill_code: string;
  tracking_url_template: string | null;
  base_fee: number;
  extra_kg_fee: number;
  is_active: number;
  sort_order: number;
}

export type DeliveryPaidBy = "customer" | "shop" | "rider_direct";

// Couriers this system can book a shipment with directly through their
// API (keyed by partner code) — the waybill window offers a "Create
// shipment" button for them. Everyone else gets a tracking number from
// their own portal and types it in.
export const COURIER_API: Record<string, { name: string; endpoint: string }> = {
  CPAK: { name: "CityPak", endpoint: "citypak-order" },
  FDR: { name: "Fardar", endpoint: "fardar-order" },
};

// The waybill's item line — one entry per product with its quantities
// added up ("Double Cotton Pant x25"), not one per physical unit (which
// printed "Double Cotton Pant x1, Double Cotton Pant x1, ..." 25 times
// and ran off the label), the same way the bill groups its items.
export function waybillItemsDescription(items: { product_title?: string; quantity: number }[] | undefined): string {
  const totals = new Map<string, number>();
  for (const item of items ?? []) {
    const name = item.product_title ?? "Item";
    totals.set(name, (totals.get(name) ?? 0) + item.quantity);
  }
  return Array.from(totals, ([name, quantity]) => `${name} x${quantity}`).join(", ");
}

export const DELIVERY_PAID_BY_OPTIONS: { value: DeliveryPaidBy; label: string; hint: string }[] = [
  { value: "customer", label: "Customer pays us", hint: "The fare is added to the customer's bill (collected on delivery)." },
  { value: "shop", label: "Free — we pay", hint: "Free delivery: we cover the fare, nothing is charged to the customer." },
  { value: "rider_direct", label: "Customer pays the rider", hint: "They settle with the rider themselves — no fare for us to enter or charge." },
];

// The fare / who-pays choice for an on-demand order (Uber, PickMe Flash…),
// shared by POS, "change courier" and "add fare". The fare can be left for
// later (billed or credited first, Flash booked afterwards): the order then
// waits, on hold, until it's entered.
export interface OnDemandFare {
  fare: string;
  paidBy: DeliveryPaidBy;
  fareLater: boolean;
}

export const EMPTY_ON_DEMAND_FARE: OnDemandFare = { fare: "", paidBy: "customer", fareLater: false };

// Whether the fare is still to be typed in right now.
export function onDemandNeedsFare(v: OnDemandFare): boolean {
  return v.paidBy !== "rider_direct" && !v.fareLater;
}

export function onDemandFareError(v: OnDemandFare, partnerName: string): string | null {
  if (onDemandNeedsFare(v) && !(parseFloat(v.fare) > 0)) {
    return `Enter the delivery fare for ${partnerName} — or tick "Not known yet" to add it later.`;
  }
  return null;
}

// What the server is sent. A fare that isn't known (later) or isn't ours to
// record (customer pays the rider) is simply left out.
export function onDemandPayload(v: OnDemandFare): { delivery_paid_by: DeliveryPaidBy; delivery_fare?: number } {
  return onDemandNeedsFare(v) ? { delivery_paid_by: v.paidBy, delivery_fare: parseFloat(v.fare) } : { delivery_paid_by: v.paidBy };
}

// Which way a saved delivery is being paid for: rider_direct lives in its
// own flag because it can't be stored in delivery_paid_by.
export function paidByOf(d: { delivery_paid_by?: string | null; rider_direct?: number | null }): DeliveryPaidBy | null {
  if (d.rider_direct) return "rider_direct";
  return (d.delivery_paid_by as DeliveryPaidBy | null | undefined) ?? null;
}

// An on-demand order whose ride isn't booked yet — no fare entered, and no
// "customer pays the rider" to make one unnecessary. It can't be packed.
export function isAwaitingFare(
  d: { delivery_partner: string | null; delivery_status?: string; actual_fare?: number | null; rider_direct?: number | null },
  partners: DeliveryPartnerInfo[]
): boolean {
  if (!d.delivery_partner || d.rider_direct || d.actual_fare != null) return false;
  if (d.delivery_status === "delivered" || d.delivery_status === "returned" || d.delivery_status === "cancelled") return false;
  return partners.find((p) => p.code === d.delivery_partner)?.kind === "on_demand";
}

// One shared copy of the partner list for the whole app — fetched once,
// then every screen that needs a name, waybill code, tariff or tracking
// link reads it from here instead of each carrying its own hardcoded
// list. Refetched (and every subscribed screen updated) after the admin
// edits a partner.
let cache: DeliveryPartnerInfo[] | null = null;
let inflight: Promise<DeliveryPartnerInfo[]> | null = null;
const listeners = new Set<() => void>();

export function loadDeliveryPartners(force = false): Promise<DeliveryPartnerInfo[]> {
  if (cache && !force) return Promise.resolve(cache);
  if (!inflight || force) {
    inflight = api
      .get<DeliveryPartnerInfo[]>("/delivery-partners")
      .then((list) => {
        cache = list;
        listeners.forEach((notify) => notify());
        return list;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function useDeliveryPartners() {
  const [, setVersion] = useState(0);

  useEffect(() => {
    const notify = () => setVersion((v) => v + 1);
    listeners.add(notify);
    loadDeliveryPartners().catch(() => {
      // the list failing to load leaves the pickers empty rather than
      // crashing the page; the screens already handle an empty list
    });
    return () => {
      listeners.delete(notify);
    };
  }, []);

  const partners = cache ?? [];
  return {
    partners,
    // What a picker offers for a NEW order — switched-off partners stay
    // out of it, but history screens use the full list so an old
    // delivery still shows its partner's real name.
    activePartners: partners.filter((p) => p.is_active),
    loaded: cache !== null,
    refresh: () => loadDeliveryPartners(true),
  };
}

export function findPartner(code: string | null | undefined): DeliveryPartnerInfo | undefined {
  return code ? cache?.find((p) => p.code === code) : undefined;
}

export function partnerLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return findPartner(code)?.name ?? code;
}

export function waybillShopCode(partner: DeliveryPartner | null | undefined): string {
  if (!partner) return "MNM";
  return findPartner(partner)?.waybill_code ?? `MNM X ${partner}`;
}

// Deep-link to a courier's own tracking page, from the template the
// admin set on the partner (e.g. https://track.example.com/?id={tracking}).
// A partner without one (own delivery, on-demand apps) has nowhere to
// link out to.
export function courierTrackingUrl(partner: DeliveryPartner | null | undefined, trackingNumber: string | null | undefined): string | null {
  if (!trackingNumber) return null;
  const template = findPartner(partner)?.tracking_url_template;
  if (!template) return null;
  return template.replace("{tracking}", encodeURIComponent(trackingNumber));
}

// Common courier pricing: the partner's base fee for the first kg, its
// per-kg fee for each additional kg (rounded up — couriers bill by whole
// kg increments). Defaults to Rs. 450 + Rs. 100/extra kg, which is what
// every courier charged before tariffs became per-partner.
export function calculateDeliveryFee(
  weightKg: number,
  isFree: boolean,
  partner?: Pick<DeliveryPartnerInfo, "base_fee" | "extra_kg_fee">
): number {
  if (isFree) return 0;
  if (!weightKg || weightKg <= 0) return 0;
  const base = partner?.base_fee ?? 450;
  const perKg = partner?.extra_kg_fee ?? 100;
  const extraKg = Math.max(0, Math.ceil(weightKg - 1));
  return base + extraKg * perKg;
}

// COD to collect on delivery = (order total + delivery fee) minus
// whatever was already paid, floored at 0. The amount paid is applied
// against the COMBINED total — so if a customer pays enough to cover
// both the product and the delivery fee, COD correctly comes out to 0,
// not the delivery fee alone. Example: product Rs.2000 + delivery
// Rs.450 = Rs.2450 payable; paying the full Rs.2450 leaves COD at 0;
// paying only Rs.2000 leaves COD at Rs.450 (just the delivery); paying
// less than that still leaves the shortfall plus the delivery fee.
export function calculateCodAmount(orderTotal: number, amountAlreadyPaid: number, deliveryFee: number): number {
  const combinedPayable = orderTotal + deliveryFee;
  return Math.max(0, combinedPayable - amountAlreadyPaid);
}
