// What a customer really owes on a sale, as SQL fragments for a query that selects FROM sales. Shared by the customer balance and statement, the
// balance slip and the printed bill, so every one of them uses the same rule.

// How much of an unpaid online order its COD actually pays: cod_amount minus the
// delivery fee — exactly what courier settlement credits to the sale (see the
// settlement code in courierReconciliation.ts) — capped at what is unpaid. For an
// ordinary COD order that is the whole unpaid balance; for a CREDIT order the COD
// is only the delivery fee, so it comes to nothing and the product amount stays
// owed in full. Written for a query that selects FROM sales.
export const COD_TOWARD_SALE_SQL = `MAX(0, MIN(
  sales.total - sales.amount_paid,
  MAX(0, COALESCE((SELECT dc.cod_amount - dc.delivery_fee - dc.pickup_collected FROM deliveries dc WHERE dc.sale_id = sales.id), 0))
))`;
// A credit order is a real debt whoever delivers it, so it's never COD here.
export const IS_COD_ORDER_SQL = `(sales.sale_type = 'online' AND COALESCE(sales.payment_method, '') <> 'credit')`;

// COD a COURIER has already delivered and collected but not yet paid over: the
// customer paid it — to the courier, at the door — so it isn't owed; the cash is
// with the courier until they settle (Couriers page). Every courier counts —
// Dropp (code D2D) included, it settles like the rest. On-demand riders hand the
// cash straight over, so those stay owed until confirmed (confirm-cod in
// sales.ts); a returned parcel is not "delivered".
export const WITH_COURIER_SQL = `(CASE WHEN ${IS_COD_ORDER_SQL} AND EXISTS (
    SELECT 1 FROM deliveries hd LEFT JOIN delivery_partners hp ON hp.code = hd.delivery_partner
    WHERE hd.sale_id = sales.id AND hd.delivery_status = 'delivered' AND hd.delivery_partner IS NOT NULL
      AND COALESCE(hp.kind, '') <> 'on_demand'
  ) THEN ${COD_TOWARD_SALE_SQL} ELSE 0 END)`;

// COD still to be collected at the door (not delivered yet — being packed, or on
// its way). Nothing is owed on account for it; it's money collected on delivery.
export const ON_DELIVERY_SQL = `(CASE WHEN ${IS_COD_ORDER_SQL} AND EXISTS (
    SELECT 1 FROM deliveries od WHERE od.sale_id = sales.id AND od.delivery_status IN ('pending', 'packed', 'dispatched')
  ) THEN ${COD_TOWARD_SALE_SQL} ELSE 0 END)`;

// What the customer really owes on a sale: what's unpaid, less any part of it a COD is about to collect or has just collected.
// An exchange whose old items haven't come back is NOT netted off: until the items are received and checked the replacement order is
// owed in full, and the statement carries one short line saying what clears (or becomes store credit) when they arrive.
export const REAL_OWED_SQL = `(sales.total - sales.amount_paid - ${WITH_COURIER_SQL} - ${ON_DELIVERY_SQL})`;
