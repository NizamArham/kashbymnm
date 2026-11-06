import { db } from "../db/connection";

// What is really still to pay on each of a supplier's purchases.
//
// A purchase's own balance (total_cost − amount_paid) knows nothing about money that is already in elsewhere: a payment that ran past its
// own purchase, a general payment tied to no purchase, or supplier credit. The supplier's balance (the figure on the supplier list, the
// ledger and the dashboard — see BALANCE_SUBQUERY in routes/suppliers.ts) has all of it. So whatever the purchases' own balances add up to
// beyond that balance is already covered; it comes off the oldest purchases first, and what's left on each is what is really still to pay.
export function toPayByPurchase(supplierId: number): Map<number, number> {
  const purchases = db
    .prepare(`SELECT id, total_cost, amount_paid FROM purchases WHERE supplier_id = ? ORDER BY purchase_date, id`)
    .all(supplierId) as { id: number; total_cost: number; amount_paid: number }[];

  const { balance } = db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(total_cost) FROM purchases WHERE supplier_id = @s), 0)
         - COALESCE((SELECT SUM(amount_paid) FROM purchases WHERE supplier_id = @s), 0)
         - COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_id = @s AND purchase_id IS NULL), 0)
         - COALESCE((SELECT SUM(amount) FROM supplier_credit_transactions WHERE supplier_id = @s), 0) AS balance`
    )
    .get({ s: supplierId }) as { balance: number };

  const own = (p: { total_cost: number; amount_paid: number }) => Math.max(0, p.total_cost - p.amount_paid);
  const ownTotal = purchases.reduce((sum, p) => sum + own(p), 0);
  let covered = Math.max(0, ownTotal - Math.max(0, balance));

  const result = new Map<number, number>();
  for (const p of purchases) {
    const taken = Math.min(own(p), covered);
    covered -= taken;
    result.set(p.id, own(p) - taken);
  }
  return result;
}

// One purchase's figure, falling back to its own balance if it isn't found.
export function toPayFor(purchase: { id: number; supplier_id: number; total_cost: number; amount_paid: number }): number {
  return toPayByPurchase(purchase.supplier_id).get(purchase.id) ?? Math.max(0, purchase.total_cost - purchase.amount_paid);
}
