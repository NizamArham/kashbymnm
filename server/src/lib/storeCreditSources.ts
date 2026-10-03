import { db } from "../db/connection";

// Where the store credit applied to one sale actually came from — e.g.
// "Return on invoice STR261X0240" — so a bill can say WHY a deduction
// was made, not just that it was. Credit is spent oldest-first (the same
// rule the customer's balance uses), so this replays the customer's
// credit ledger in order and records which grants this sale's
// redemption consumed.
export function storeCreditSources(saleId: number, customerId: number | null): { amount: number; label: string }[] {
  if (!customerId) return [];
  const rows = db
    .prepare(
      `SELECT id, amount, reason, reference_id, notes FROM store_credit_transactions
       WHERE customer_id = ? ORDER BY created_at ASC, id ASC`
    )
    .all(customerId) as { id: number; amount: number; reason: string; reference_id: number | null; notes: string | null }[];

  function labelFor(grant: { reason: string; reference_id: number | null; notes: string | null }): string {
    if (grant.reason === "return_exchange" && grant.reference_id) {
      const ret = db
        .prepare(
          `SELECT sales.invoice FROM returns
           JOIN sale_items ON sale_items.id = returns.sale_item_id
           JOIN sales ON sales.id = sale_items.sale_id
           WHERE returns.id = ?`
        )
        .get(grant.reference_id) as { invoice: string } | undefined;
      if (ret) return `Return on invoice ${ret.invoice}`;
    }
    if (grant.reason === "overpayment" && grant.reference_id) {
      const sale = db.prepare(`SELECT invoice FROM sales WHERE id = ?`).get(grant.reference_id) as { invoice: string } | undefined;
      if (sale) return `Overpayment on invoice ${sale.invoice}`;
    }
    if (grant.reason === "manual_adjustment") return "Manual credit adjustment";
    return grant.notes ?? "Store credit";
  }

  const grants: { remaining: number; label: string }[] = [];
  const used = new Map<string, number>();
  for (const row of rows) {
    if (row.amount > 0) {
      grants.push({ remaining: row.amount, label: labelFor(row) });
      continue;
    }
    let toSpend = -row.amount;
    const isThisSale = row.reason === "redemption" && row.reference_id === saleId;
    for (const g of grants) {
      if (toSpend <= 0) break;
      const taken = Math.min(g.remaining, toSpend);
      if (taken <= 0) continue;
      g.remaining -= taken;
      toSpend -= taken;
      if (isThisSale) used.set(g.label, (used.get(g.label) ?? 0) + taken);
    }
  }
  return Array.from(used, ([label, amount]) => ({ amount, label }));
}
