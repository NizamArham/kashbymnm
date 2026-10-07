import { db } from "../db/connection";

// Two ways loyalty points are withheld, both added to databases created
// before they existed (once, on first load):
//  - sales.is_wholesale: a wholesale order earns no points. Set at POS, or
//    afterwards on a sale that already earned some.
//  - customers.loyalty_blocked (+ reason): a customer who never earns points
//    (a wholesale buyer, say) — new sales for them earn nothing, and POS
//    ticks the wholesale box for them.
function addColumn(table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumn("sales", "is_wholesale", "INTEGER NOT NULL DEFAULT 0");
addColumn("customers", "loyalty_blocked", "INTEGER NOT NULL DEFAULT 0");
addColumn("customers", "loyalty_block_reason", "TEXT");
addColumn("customers", "loyalty_blocked_at", "TEXT");

// A customer's current points: the manually granted legacy bonus plus every
// entry in the loyalty ledger.
export function loyaltyBalance(customerId: number): number {
  const row = db
    .prepare(
      `SELECT customers.bonus_points + COALESCE((SELECT SUM(points) FROM loyalty_transactions WHERE customer_id = customers.id), 0) AS balance
       FROM customers WHERE customers.id = ?`
    )
    .get(customerId) as { balance: number } | undefined;
  return row?.balance ?? 0;
}
