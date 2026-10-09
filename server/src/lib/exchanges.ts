import { db } from "../db/connection";
import { ApiError } from "./errors";

// An ONLINE exchange: the customer already has one or more items from delivered
// orders and wants different ones. The replacement order is billed first (as an
// ordinary online order — it can hold as many pieces as they like, including extras
// they decide to buy) and goes out by courier; the courier brings the old items back
// on the same trip. The old items' value comes off the replacement order as each
// item is actually received — until then it's "exchange credit pending return".
//
// Who pays the courier's pickup charge is decided when the replacement is billed:
//   0   — we pay it (our mistake: wrong item, defect)
//   50  — split half and half
//   100 — the customer pays it all
// the customer's share is added to the COD the courier collects at the door; the
// whole charge is booked against the courier once the exchange is settled, so what
// the customer paid cancels out and we carry exactly our share. If the customer
// refuses the parcel at the door it all goes back (the existing returned-parcel
// flow, which we pay in full) and the exchange is cancelled.
//
// If the replacement costs less than the old items, the difference stays as store
// credit — or is refunded when the items are received (see routes/exchanges.ts).
//
// Additive lazy migration, like the other modules that grew the schema.
db.exec(`
  CREATE TABLE IF NOT EXISTS online_exchanges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    new_sale_id INTEGER NOT NULL UNIQUE REFERENCES sales(id),
    -- the first old item (the items themselves are in online_exchange_items)
    old_sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
    -- all the old items' value together, and how much of it comes off the replacement
    -- order's total (the replacement may cost less — the rest then stays as store credit)
    credit_amount REAL NOT NULL,
    applied_amount REAL NOT NULL,
    -- the courier's charge for the pickup leg, and the share of it the customer pays
    pickup_charge REAL NOT NULL DEFAULT 0,
    customer_share_pct INTEGER NOT NULL DEFAULT 0 CHECK (customer_share_pct BETWEEN 0 AND 100),
    -- what that share came to, collected inside the order's COD
    pickup_collected REAL NOT NULL DEFAULT 0,
    -- awaiting_pickup while any old item is still to come back; received once they've
    -- all been dealt with (and at least one came back); not_returned if none did
    status TEXT NOT NULL DEFAULT 'awaiting_pickup'
      CHECK (status IN ('awaiting_pickup', 'received', 'not_returned', 'cancelled')),
    item_condition TEXT CHECK (item_condition IN ('clean', 'damaged')),
    return_id INTEGER REFERENCES returns(id),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+330 minutes')),
    closed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS online_exchange_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange_id INTEGER NOT NULL REFERENCES online_exchanges(id) ON DELETE CASCADE,
    old_sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
    credit_amount REAL NOT NULL,
    -- the part of this item's value that comes off the replacement order once it's collected
    applied_share REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting' CHECK (status IN ('awaiting', 'received', 'not_returned', 'cancelled')),
    item_condition TEXT CHECK (item_condition IN ('clean', 'damaged')),
    return_id INTEGER REFERENCES returns(id),
    UNIQUE (exchange_id, old_sale_item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_online_exchanges_item ON online_exchanges(old_sale_item_id);
  CREATE INDEX IF NOT EXISTS idx_exchange_items_item ON online_exchange_items(old_sale_item_id);
`);
const deliveryColumns = db.prepare(`PRAGMA table_info(deliveries)`).all() as { name: string }[];
if (!deliveryColumns.some((c) => c.name === "pickup_collected")) {
  // The customer's share of an exchange pickup charge that rides along in this
  // delivery's COD. It is not payment for the order itself, so courier
  // settlement and the customer's balance both leave it out.
  db.exec(`ALTER TABLE deliveries ADD COLUMN pickup_collected REAL NOT NULL DEFAULT 0`);
}
const exchangeColumns = db.prepare(`PRAGMA table_info(online_exchanges)`).all() as { name: string }[];
if (!exchangeColumns.some((c) => c.name === "pickup_booked")) {
  // Set once the courier's pickup charge has been booked against them.
  db.exec(`ALTER TABLE online_exchanges ADD COLUMN pickup_booked INTEGER NOT NULL DEFAULT 0`);
}
// An exchange made before items had their own rows gets one from its own columns.
db.exec(`
  INSERT INTO online_exchange_items (exchange_id, old_sale_item_id, credit_amount, applied_share, status, item_condition, return_id)
  SELECT ox.id, ox.old_sale_item_id, ox.credit_amount, ox.applied_amount,
         CASE ox.status WHEN 'awaiting_pickup' THEN 'awaiting' WHEN 'received' THEN 'received'
                        WHEN 'not_returned' THEN 'not_returned' ELSE 'cancelled' END,
         ox.item_condition, ox.return_id
  FROM online_exchanges ox
  WHERE NOT EXISTS (SELECT 1 FROM online_exchange_items ei WHERE ei.exchange_id = ox.id)
`);

const ITEMS_SQL = `
  SELECT ei.*, os.invoice AS old_invoice, COALESCE(p.product_title, osi.product_snapshot) AS title,
         i.size AS size, i.color AS color
  FROM online_exchange_items ei
  JOIN sale_items osi ON osi.id = ei.old_sale_item_id
  JOIN sales os ON os.id = osi.sale_id
  LEFT JOIN inventory i ON i.id = osi.inventory_id
  LEFT JOIN products p ON p.id = i.product_id
`;

export interface ExchangeItemRow {
  id: number;
  exchange_id: number;
  old_sale_item_id: number;
  credit_amount: number;
  applied_share: number;
  status: "awaiting" | "received" | "not_returned" | "cancelled";
  item_condition: "clean" | "damaged" | null;
  return_id: number | null;
  old_invoice: string;
  title: string | null;
  size: string | null;
  color: string | null;
}

export function exchangeItems(exchangeId: number): ExchangeItemRow[] {
  return db.prepare(`${ITEMS_SQL} WHERE ei.exchange_id = ? ORDER BY ei.id`).all(exchangeId) as ExchangeItemRow[];
}

function withItems(row: any) {
  return row ? { ...row, items: exchangeItems(row.id) } : null;
}

export function exchangeById(id: number | string) {
  return withItems(db.prepare(`SELECT * FROM online_exchanges WHERE id = ?`).get(id));
}

export function exchangeForSale(saleId: number) {
  return withItems(db.prepare(`SELECT * FROM online_exchanges WHERE new_sale_id = ?`).get(saleId));
}

// Exchanges still waiting for old items, plus the ones closed in the last 30 days,
// by the replacement order they belong to — what the Deliveries list shows.
export function recentExchangesBySale(): Map<number, any> {
  const rows = db
    .prepare(
      `SELECT * FROM online_exchanges
       WHERE status = 'awaiting_pickup' OR closed_at > datetime('now', '+330 minutes', '-30 days')`
    )
    .all() as any[];
  return new Map(rows.map((r) => [r.new_sale_id, withItems(r)]));
}

// Columns to add to any query that selects FROM sales, saying how that invoice
// figures in an exchange — so a list or a search can show it without opening the sale:
//   exchange_out_*  the invoice's own items are being (or were) swapped for a replacement order
//   exchange_in_*   this invoice IS a replacement order, for items from those invoices
export const SALE_EXCHANGE_FLAGS_SQL = `
  (SELECT CASE WHEN SUM(ei.status = 'awaiting') > 0 THEN 'awaiting'
               WHEN SUM(ei.status = 'received') > 0 THEN 'received'
               WHEN SUM(ei.status = 'not_returned') > 0 THEN 'not_returned' END
   FROM online_exchange_items ei JOIN sale_items osi ON osi.id = ei.old_sale_item_id
   WHERE osi.sale_id = sales.id) AS exchange_out_status,
  (SELECT ns.invoice FROM online_exchange_items ei JOIN sale_items osi ON osi.id = ei.old_sale_item_id
     JOIN online_exchanges ox ON ox.id = ei.exchange_id JOIN sales ns ON ns.id = ox.new_sale_id
   WHERE osi.sale_id = sales.id AND ei.status <> 'cancelled' ORDER BY ox.id DESC LIMIT 1) AS exchange_out_invoice,
  (SELECT ns.id FROM online_exchange_items ei JOIN sale_items osi ON osi.id = ei.old_sale_item_id
     JOIN online_exchanges ox ON ox.id = ei.exchange_id JOIN sales ns ON ns.id = ox.new_sale_id
   WHERE osi.sale_id = sales.id AND ei.status <> 'cancelled' ORDER BY ox.id DESC LIMIT 1) AS exchange_out_sale_id,
  (SELECT status FROM online_exchanges WHERE new_sale_id = sales.id) AS exchange_in_status,
  (SELECT group_concat(DISTINCT os.invoice) FROM online_exchange_items ei
     JOIN online_exchanges ox ON ox.id = ei.exchange_id JOIN sale_items osi ON osi.id = ei.old_sale_item_id
     JOIN sales os ON os.id = osi.sale_id WHERE ox.new_sale_id = sales.id) AS exchange_in_from
`;

// The exchanges that took items out of this invoice, with each item's state — what
// the invoice's own page shows ("these items are being swapped, replacement is …").
export function exchangesOutOfSale(saleId: number) {
  const rows = db
    .prepare(
      `SELECT ox.id AS exchange_id, ox.new_sale_id, ns.invoice AS new_invoice, ox.status,
              ei.id, ei.old_sale_item_id, ei.status AS item_status, ei.item_condition, ei.credit_amount,
              COALESCE(p.product_title, osi.product_snapshot) AS title, i.size, i.color
       FROM online_exchange_items ei
       JOIN online_exchanges ox ON ox.id = ei.exchange_id
       JOIN sales ns ON ns.id = ox.new_sale_id
       JOIN sale_items osi ON osi.id = ei.old_sale_item_id
       LEFT JOIN inventory i ON i.id = osi.inventory_id
       LEFT JOIN products p ON p.id = i.product_id
       WHERE osi.sale_id = ?
       ORDER BY ox.id, ei.id`
    )
    .all(saleId) as any[];
  const byExchange = new Map<number, any>();
  for (const r of rows) {
    if (!byExchange.has(r.exchange_id)) {
      byExchange.set(r.exchange_id, { exchange_id: r.exchange_id, new_sale_id: r.new_sale_id, new_invoice: r.new_invoice, status: r.status, items: [] });
    }
    byExchange.get(r.exchange_id).items.push({
      id: r.id,
      old_sale_item_id: r.old_sale_item_id,
      status: r.item_status,
      item_condition: r.item_condition,
      credit_amount: r.credit_amount,
      title: r.title,
      size: r.size,
      color: r.color,
    });
  }
  return Array.from(byExchange.values());
}

// A sale item that is part of an online exchange still waiting for it (or one it
// went through) can't also be returned another way — that would credit it twice.
export function itemInActiveExchange(saleItemId: number): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM online_exchange_items WHERE old_sale_item_id = ? AND status IN ('awaiting', 'received') LIMIT 1`
    )
    .get(saleItemId);
}

// Ends an exchange that will never happen (the parcel came back, or the replacement
// invoice was voided): the customer keeps the old items, nothing comes off anything.
export function cancelExchangeForSale(saleId: number, note: string): boolean {
  const open = db.prepare(`SELECT id FROM online_exchanges WHERE new_sale_id = ? AND status = 'awaiting_pickup'`).get(saleId) as
    | { id: number }
    | undefined;
  if (!open) return false;
  db.prepare(`UPDATE online_exchange_items SET status = 'cancelled' WHERE exchange_id = ? AND status = 'awaiting'`).run(open.id);
  db.prepare(
    `UPDATE online_exchanges SET status = 'cancelled', closed_at = datetime('now', '+330 minutes'), note = COALESCE(note, ?) WHERE id = ?`
  ).run(note, open.id);
  return true;
}

// The replacement parcel came back to the shop, so its pieces are on the shelf
// again. Only pieces this order still holds as sold are touched. Returns how many
// went back.
export function restockSaleUnits(saleId: number): number {
  return db
    .prepare(
      `UPDATE inventory SET status = 'available'
       WHERE status = 'sold' AND id IN (SELECT inventory_id FROM sale_items WHERE sale_id = ? AND inventory_id IS NOT NULL)`
    )
    .run(saleId).changes;
}

// The delivered, not-yet-returned items of a customer's online orders — what an
// exchange can start from.
export function eligibleExchangeItems(customerId: number) {
  return db
    .prepare(
      `SELECT si.id AS sale_item_id, s.id AS sale_id, s.invoice, s.date, si.unit_price,
              COALESCE(p.product_title, si.product_snapshot) AS product_title, i.size, i.color, i.sku,
              COALESCE(dp.name, d.delivery_partner) AS partner_name, d.delivery_partner, d.address_id, d.package_weight_kg
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN deliveries d ON d.sale_id = s.id
       LEFT JOIN delivery_partners dp ON dp.code = d.delivery_partner
       LEFT JOIN inventory i ON i.id = si.inventory_id
       LEFT JOIN products p ON p.id = i.product_id
       WHERE s.customer_id = ? AND s.is_voided = 0 AND s.status = 'completed' AND s.sale_type = 'online'
         AND d.delivery_status = 'delivered'
         AND NOT EXISTS (SELECT 1 FROM returns r WHERE r.sale_item_id = si.id)
         AND NOT EXISTS (SELECT 1 FROM online_exchange_items ei WHERE ei.old_sale_item_id = si.id AND ei.status IN ('awaiting', 'received'))
       ORDER BY s.date DESC, si.id`
    )
    .all(customerId);
}

export interface ExchangeSource {
  sale_item_id: number;
  sale_id: number;
  invoice: string;
  unit_price: number;
  product_title: string | null;
  size: string | null;
  color: string | null;
  address_id: number | null;
}

// Checks every item being exchanged is one that can be, and returns what's needed to
// bill the replacement. Throws a plain explanation if any isn't.
export function checkExchangeSources(oldSaleItemIds: number[], customerId: number | undefined): ExchangeSource[] {
  if (!customerId) throw new ApiError(400, "An exchange needs a customer — pick the customer who is exchanging the items.");
  if (new Set(oldSaleItemIds).size !== oldSaleItemIds.length) throw new ApiError(400, "The same item is listed twice.");
  const eligible = eligibleExchangeItems(customerId) as ExchangeSource[];
  return oldSaleItemIds.map((id) => {
    const item = eligible.find((i) => i.sale_item_id === id);
    if (!item) {
      throw new ApiError(
        409,
        "One of those items can't be exchanged online — each must be on one of this customer's delivered online orders, and not already returned or in another exchange."
      );
    }
    return item;
  });
}
