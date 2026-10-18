import { db } from "../db/connection";
import { ApiError } from "./errors";

// A payment request can keep its pieces for the customer — free, and only until a set time (the end of today, or of
// tomorrow when asked) — so the same pieces aren't sold to someone else while the customer is on their way to paying.
// Nothing else about the pieces changes: they stay 'available' in the stock, and are simply not offered to, or accepted for,
// another sale until the hold ends. It ends by itself (the time passes, the request is paid / cancelled / released), so there
// is nothing to tidy up and a forgotten hold can never lock a piece for long.
//
// Additive lazy migration, like the other modules that grew the schema.
if (!(db.prepare(`PRAGMA table_info(inventory)`).all() as { name: string }[]).some((c) => c.name === "held_for_sale_id")) {
  db.exec(`ALTER TABLE inventory ADD COLUMN held_for_sale_id INTEGER`);
  db.exec(`ALTER TABLE inventory ADD COLUMN held_until TEXT`);
}

// True for a piece that is held RIGHT NOW: the hold hasn't run out and the payment request it was made for is still open.
// Written for a query that selects FROM inventory.
export const HELD_SQL = `(inventory.held_for_sale_id IS NOT NULL
  AND inventory.held_until > datetime('now', '+330 minutes')
  AND EXISTS (SELECT 1 FROM sales hs WHERE hs.id = inventory.held_for_sale_id AND hs.status = 'quotation'))`;

// When "today" ends, shop time: 23:59:59 of today, or of a later day.
export function endOfDay(daysAhead = 0): string {
  const row = db.prepare(`SELECT date('now', '+330 minutes', '+' || ? || ' days') || ' 23:59:59' AS t`).get(daysAhead) as { t: string };
  return row.t;
}

export function holdUnits(saleId: number, unitIds: number[], until: string) {
  const stmt = db.prepare(`UPDATE inventory SET held_for_sale_id = ?, held_until = ? WHERE id = ?`);
  for (const id of unitIds) stmt.run(saleId, until, id);
}

export function releaseHold(saleId: number) {
  db.prepare(`UPDATE inventory SET held_for_sale_id = NULL, held_until = NULL WHERE held_for_sale_id = ?`).run(saleId);
}

// "17 Oct, 11:59 pm"
export function describeUntil(until: string): string {
  const [date, time] = until.split(" ");
  const [h, m] = time.split(":").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [, mo, d] = date.split("-").map(Number);
  return `${d} ${months[mo - 1]}, ${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

// The payment request holding this piece for someone else right now, if any. A piece held for `ownSaleId` (the very request
// being edited or paid) is free for it.
export function heldByAnother(unitId: number, ownSaleId?: number | null) {
  return db
    .prepare(
      `SELECT hs.id AS sale_id, hs.invoice, inventory.held_until, inventory.sku, c.name AS customer
       FROM inventory
       JOIN sales hs ON hs.id = inventory.held_for_sale_id
       LEFT JOIN customers c ON c.id = hs.customer_id
       WHERE inventory.id = ? AND ${HELD_SQL} AND hs.id <> ?`
    )
    .get(unitId, ownSaleId ?? 0) as { sale_id: number; invoice: string; held_until: string; sku: string; customer: string | null } | undefined;
}

export function assertNotHeldByAnother(unitId: number, ownSaleId?: number | null) {
  const h = heldByAnother(unitId, ownSaleId);
  if (h) {
    throw new ApiError(
      409,
      `Piece ${h.sku} is being held for ${h.customer ? `${h.customer}'s ` : "a "}payment request (${h.invoice}) until ${describeUntil(h.held_until)} — it can't be sold to anyone else before then. Release that hold first if the sale should go ahead.`
    );
  }
}

// How long the pieces of a payment request are held for, if they are: the latest end among its still-held pieces.
export function holdEndOf(saleId: number): string | null {
  const row = db
    .prepare(
      `SELECT MAX(inventory.held_until) AS until FROM inventory
       WHERE inventory.held_for_sale_id = ? AND ${HELD_SQL}`
    )
    .get(saleId) as { until: string | null };
  return row.until;
}
