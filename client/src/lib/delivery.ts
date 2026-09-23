export type DeliveryPartner = "CPAK" | "D2D" | "DEX";

export const DELIVERY_PARTNERS: { value: DeliveryPartner; label: string; waybillCode: string }[] = [
  { value: "CPAK", label: "CityPak", waybillCode: "MNM X CPAK" },
  { value: "D2D", label: "Dropp", waybillCode: "MNM X D2D" },
  { value: "DEX", label: "DEX (Daraz Express)", waybillCode: "MNM X DEX" },
];

export function waybillShopCode(partner: DeliveryPartner | null | undefined): string {
  return DELIVERY_PARTNERS.find((p) => p.value === partner)?.waybillCode ?? "MNM";
}

// Deep-links to each courier's own tracking page. D2D is our own delivery
// — there's no external courier site to link out to for it.
export function courierTrackingUrl(partner: DeliveryPartner | null | undefined, trackingNumber: string | null | undefined): string | null {
  if (!trackingNumber) return null;
  const encoded = encodeURIComponent(trackingNumber);
  if (partner === "CPAK") return `https://track.citypak.lk/track?tracking_number=${encoded}`;
  if (partner === "DEX") return `https://www.dex.com.pk/tracking?references=${encoded}`;
  return null;
}

// Common courier pricing: Rs. 450 for the first kg, Rs. 100 for each
// additional kg (rounded up — couriers bill by whole kg increments).
export function calculateDeliveryFee(weightKg: number, isFree: boolean): number {
  if (isFree) return 0;
  if (!weightKg || weightKg <= 0) return 0;
  const extraKg = Math.max(0, Math.ceil(weightKg - 1));
  return 450 + extraKg * 100;
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
