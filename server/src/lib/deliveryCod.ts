// What a parcel will collect on delivery, kept in step with what the customer has paid.
//
// deliveries.cod_amount is set once, when the order is made: whatever was unpaid, plus the delivery fee
// (see POST /api/sales). If the customer then pays the order — "Mark as paid", an extra payment, a payment
// from their profile, a cheque — the sale and the cash book know, but that figure doesn't, and Shipping
// kept telling the rider to collect money the shop already had.
//
// So until the courier actually has the parcel (pending / packed) the figure that's shown, printed on the
// waybill and sent to the courier is the one below: the order part of the COD can only be as much as is
// still unpaid, the delivery-fee and pickup parts are left alone. It's worked out each time rather than
// written back, so undoing the payment or a bounced cheque brings the COD back by itself. Once the parcel
// is dispatched the courier holds the figure, so it is written into cod_amount at that moment and never
// moves again.

type CodSource = {
  delivery_status: string | null;
  cod_amount: number;
  delivery_fee: number;
  pickup_collected?: number | null;
};

export function liveCod(d: CodSource, sale: { total: number; amount_paid: number }): number {
  const cod = d.cod_amount ?? 0;
  if (d.delivery_status !== "pending" && d.delivery_status !== "packed") return cod;
  const toward = Math.max(0, cod - (d.delivery_fee ?? 0) - (d.pickup_collected ?? 0));
  const unpaid = Math.max(0, sale.total - sale.amount_paid);
  return cod - toward + Math.min(toward, unpaid);
}

// The same figure as a SQL expression, for the queries that join deliveries to sales.
export const LIVE_COD_SQL = `(CASE WHEN deliveries.delivery_status IN ('pending', 'packed') THEN
    deliveries.cod_amount
      - MAX(0, deliveries.cod_amount - COALESCE(deliveries.delivery_fee, 0) - COALESCE(deliveries.pickup_collected, 0))
      + MIN(MAX(0, deliveries.cod_amount - COALESCE(deliveries.delivery_fee, 0) - COALESCE(deliveries.pickup_collected, 0)), MAX(0, sales.total - sales.amount_paid))
  ELSE deliveries.cod_amount END)`;
