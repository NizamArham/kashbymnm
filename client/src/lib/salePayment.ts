import type { Sale } from "./types";

// An online order that hasn't been fully paid yet is waiting to be collected
// on delivery. Its stored payment_method is only the method that WILL collect
// it (usually "cash"), so listing it as "Cash" next to Unpaid reads as a
// contradiction. Credit orders are not COD, and voided/quotation rows aren't
// waiting for anything.
export function isAwaitingCod(sale: Pick<Sale, "sale_type" | "payment_status" | "payment_method" | "is_voided" | "status">): boolean {
  return (
    sale.sale_type === "online" &&
    sale.payment_status !== "paid" &&
    sale.payment_method !== "credit" &&
    !sale.is_voided &&
    sale.status !== "quotation"
  );
}

// The status shown next to an invoice. An exchange replacement whose old item hasn't come back yet has
// no money on it — its value is covered by the item that's on its way — so it says that, instead of a
// bare "unpaid" that would read as the customer owing it (their payment history says "settled").
// Once the old item is received the credit is applied and it becomes Paid.
export function saleStatusLabel(sale: Pick<Sale, "payment_status" | "is_voided" | "exchange_in_status">): string {
  if (sale.is_voided) return "voided";
  if (sale.exchange_in_status === "awaiting_pickup" && sale.payment_status !== "paid") return "exchange pending";
  return sale.payment_status;
}

// What to show as a sale's "Payment": COD while the delivery is unpaid, the
// part-payment method plus COD when only some was paid up front, otherwise
// the method it was actually paid with.
export function salePaymentLabel(sale: Pick<Sale, "sale_type" | "payment_status" | "payment_method" | "is_voided" | "status">): string {
  const method = sale.payment_method ? sale.payment_method.replace(/_/g, " ") : null;
  if (!isAwaitingCod(sale)) return method ?? "—";
  if (sale.payment_status === "partial" && method) return `${method} + COD`;
  return "COD";
}
