import { db } from "../db/connection";

export interface DeliveryPartnerRow {
  code: string;
  name: string;
  kind: "courier" | "on_demand";
  waybill_code: string;
  tracking_url_template: string | null;
  base_fee: number;
  extra_kg_fee: number;
  is_active: number;
  sort_order: number;
}

export function getPartner(code: string | null | undefined): DeliveryPartnerRow | undefined {
  if (!code) return undefined;
  return db.prepare(`SELECT * FROM delivery_partners WHERE code = ?`).get(code) as DeliveryPartnerRow | undefined;
}

// A courier's tariff: base_fee for the first kg, extra_kg_fee for each
// additional kg (rounded up — couriers bill by whole kg increments).
// The defaults are what every partner used before tariffs became
// per-partner, so an unknown/legacy partner behaves exactly as before.
export function tariffFor(
  partner: Pick<DeliveryPartnerRow, "base_fee" | "extra_kg_fee"> | undefined,
  weightKg: number | null | undefined
): number {
  const base = partner?.base_fee ?? 450;
  const extra = partner?.extra_kg_fee ?? 100;
  if (!weightKg || weightKg <= 0) return base;
  return base + Math.max(0, Math.ceil(weightKg - 1)) * extra;
}

// What a courier charges the customer for delivery by weight (the
// partner's own tariff), 0 if it's free or no weight is known.
export function calculateDeliveryFee(
  weightKg: number | undefined,
  isFree: boolean,
  partner?: Pick<DeliveryPartnerRow, "base_fee" | "extra_kg_fee">
): number {
  if (isFree || !weightKg || weightKg <= 0) return 0;
  return tariffFor(partner, weightKg);
}

// What delivering an online order costs the customer, worked out once —
// the payment math needs to know the fee (a customer who prepays the
// order AND its delivery isn't overpaying), and the delivery record
// itself needs the same figures. Shared by checkout and by re-assigning
// an order to a different partner, so both price it identically.
// Ordinary courier: fee from its weight tariff, waived if free.
// On-demand (Uber, PickMe...): the typed-in fare is charged to the
// customer unless the shop is bearing it ('shop' = free delivery);
// 'shop_upfront' charges it too, since we've already paid the rider and
// it goes on their bill.
export function planDelivery(
  data: {
    package_weight_kg?: number;
    is_free_delivery: boolean;
    delivery_fare?: number;
    delivery_paid_by?: "customer" | "shop" | "shop_upfront";
  },
  partner: DeliveryPartnerRow | undefined
) {
  const isOnDemand = partner?.kind === "on_demand";
  const paidBy = isOnDemand ? data.delivery_paid_by ?? "customer" : null;
  const actualFare = isOnDemand ? data.delivery_fare ?? 0 : null;
  const isFree = isOnDemand ? paidBy === "shop" : data.is_free_delivery;
  const fee = isOnDemand
    ? paidBy === "shop"
      ? 0
      : actualFare ?? 0
    : calculateDeliveryFee(data.package_weight_kg, data.is_free_delivery, partner);
  return { isOnDemand, paidBy, actualFare, isFree, fee };
}
