import { db } from "../db/connection";

// A RETURN BY DELIVERY: the customer of a delivered online order sends items back — with one of our couriers collecting them, or
// by any other service (post, a bus, a third-party courier: it makes no difference). Same idea as an exchange by delivery's
// pickup leg, but with nothing going out — so it is its own record: which items are coming back, the delivery charge for sending
// them, who pays it (we do / half and half / the customer does), and whether the customer is paid back as a refund or as store credit.
//
// It goes through these stages (the `stage` column):
//   requested     the customer asked; waiting for an admin's yes (an admin's own request skips this)
//   approved      yes — the customer may send it back. We don't know yet how, or in what state it will arrive
//   on_the_way    the customer says it is sent (optional step: with which service / tracking number)
//   received      it is on hand — marked with the service, tracking number and what we paid; waiting for the inspection
//                 (on_the_way, "the customer says it is sent", is still understood but the screens skip it: it is marked received when it arrives)
//   report_pending the inspection report (per item: sellable / damaged / can't take back, who pays the delivery) waits for an admin
//   refund_due    the admin approved the report: stock is back, the refund is owed — paid once the customer's bank details are in
//   completed     refund paid and in the cash book (or store credit granted); declined / cancelled / rejected (the parcel came but the return
//                 was not accepted — nothing refunded) end it early
// Nothing about stock or money moves until the admin approves the report (routes/returnPickups.ts): then each item that is taken back
// is a normal return — stock, loyalty points, the credit — with the customer's share of the delivery charge held back; a cash or
// bank refund reaches the cash book only when it is marked paid.
//
// Additive lazy migration, like the other modules that grew the schema.
db.exec(`
  CREATE TABLE IF NOT EXISTS online_returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL REFERENCES sales(id),
    customer_id INTEGER REFERENCES customers(id),
    -- one of our couriers' codes, or '' when some other service carries it (then service_name says which)
    delivery_partner TEXT NOT NULL,
    package_weight_kg REAL,
    -- the delivery charge for sending it back, and the share of it the customer pays (held back from their refund)
    pickup_charge REAL NOT NULL DEFAULT 0,
    customer_share_pct INTEGER NOT NULL DEFAULT 0 CHECK (customer_share_pct BETWEEN 0 AND 100),
    -- how much of that share has been held back so far (items can be received on separate days)
    share_used REAL NOT NULL DEFAULT 0,
    resolution TEXT NOT NULL CHECK (resolution IN ('refund', 'store_credit')),
    reason TEXT NOT NULL,
    tracking_number TEXT,
    status TEXT NOT NULL DEFAULT 'awaiting_pickup'
      CHECK (status IN ('awaiting_pickup', 'received', 'not_returned', 'cancelled')),
    pickup_booked INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    requested_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+330 minutes')),
    closed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS online_return_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pickup_id INTEGER NOT NULL REFERENCES online_returns(id) ON DELETE CASCADE,
    sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
    status TEXT NOT NULL DEFAULT 'awaiting' CHECK (status IN ('awaiting', 'received', 'not_returned', 'cancelled')),
    item_condition TEXT CHECK (item_condition IN ('clean', 'damaged')),
    return_id INTEGER REFERENCES returns(id),
    -- what was held back from this item's refund / credit for the customer's share of the pickup charge
    deduction REAL NOT NULL DEFAULT 0,
    UNIQUE (pickup_id, sale_item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_online_return_items_item ON online_return_items(sale_item_id);
`);
if (!(db.prepare(`PRAGMA table_info(online_returns)`).all() as { name: string }[]).some((c) => c.name === "service_name")) {
  // The name of the service that carries it when it isn't one of our couriers ("Post", "Bus", "Pronto"…).
  db.exec(`ALTER TABLE online_returns ADD COLUMN service_name TEXT`);
}
if (!(db.prepare(`PRAGMA table_info(returns)`).all() as { name: string }[]).some((c) => c.name === "pickup_deduction")) {
  // What was held back from a refund / credit for the customer's share of a courier pickup (0 for an ordinary return).
  db.exec(`ALTER TABLE returns ADD COLUMN pickup_deduction REAL NOT NULL DEFAULT 0`);
}
if (!(db.prepare(`PRAGMA table_info(returns)`).all() as { name: string }[]).some((c) => c.name === "inspection_deduction")) {
  // What an inspection held back from a refund / credit beyond the delivery share (a damaged piece, say) — the proposed amount it approved.
  db.exec(`ALTER TABLE returns ADD COLUMN inspection_deduction REAL NOT NULL DEFAULT 0`);
}

// A return by delivery is a REQUEST first: a cashier's waits for an admin's yes ('pending') before the customer is told to send anything;
// an admin's own is approved on the spot (auto_approved — "recorded by admin"). Rows from before this existed were all approved.
// A declined one is closed like a cancelled one (its items are free again).
{
  const cols = (db.prepare(`PRAGMA table_info(online_returns)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("approval_status")) db.exec(`ALTER TABLE online_returns ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'`);
  if (!cols.includes("approved_by")) db.exec(`ALTER TABLE online_returns ADD COLUMN approved_by INTEGER REFERENCES users(id)`);
  if (!cols.includes("approved_at")) db.exec(`ALTER TABLE online_returns ADD COLUMN approved_at TEXT`);
  if (!cols.includes("auto_approved")) db.exec(`ALTER TABLE online_returns ADD COLUMN auto_approved INTEGER NOT NULL DEFAULT 0`);
  // Why it was declined — or, for a no-returns product that was approved anyway, the override reason.
  if (!cols.includes("decision_reason")) db.exec(`ALTER TABLE online_returns ADD COLUMN decision_reason TEXT`);
}

{
  const cols = (db.prepare(`PRAGMA table_info(online_returns)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("stage")) {
    db.exec(`ALTER TABLE online_returns ADD COLUMN stage TEXT NOT NULL DEFAULT 'approved'`);
    // Records made before stages existed: the old receive step did everything at once, so anything closed is completed.
    db.exec(`
      UPDATE online_returns SET stage = CASE
        WHEN approval_status = 'pending' THEN 'requested'
        WHEN approval_status = 'declined' THEN 'declined'
        WHEN status = 'cancelled' THEN 'cancelled'
        WHEN status IN ('received', 'not_returned') THEN 'completed'
        ELSE 'approved' END
    `);
  }
  const add = (name: string, ddl: string) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE online_returns ADD COLUMN ${name} ${ddl}`);
  };
  add("sent_at", "TEXT"); // the customer said it was sent
  add("received_at", "TEXT"); // it is on hand
  add("received_by", "INTEGER REFERENCES users(id)");
  // The inspection report: none → pending (waiting for an admin) → approved, or sent_back for another look.
  add("report_status", "TEXT NOT NULL DEFAULT 'none'"); // none / pending / approved / sent_back / rejected
  add("report_note", "TEXT");
  add("report_by", "INTEGER REFERENCES users(id)");
  add("report_at", "TEXT");
  add("report_decided_by", "INTEGER REFERENCES users(id)");
  add("report_decided_at", "TEXT");
  add("report_decision_reason", "TEXT");
  add("report_auto_approved", "INTEGER NOT NULL DEFAULT 0");
  // What is owed to the customer once the report is approved (a cash / bank refund), and how and when it was paid.
  add("refund_due", "REAL NOT NULL DEFAULT 0");
  add("refund_method", "TEXT");
  add("refund_account_id", "INTEGER REFERENCES customer_bank_accounts(id)");
  add("refunded_at", "TEXT");
  add("refunded_by", "INTEGER REFERENCES users(id)");
  // The customer shipped it without a tracking number — noted (and logged) as risk accepted: it is theirs until the parcel is received.
  add("sent_without_tracking", "INTEGER NOT NULL DEFAULT 0");
  // What the inspection proposed to pay the customer back in total (null = everything the items come to, less the delivery share).
  add("report_proposed", "REAL");
}
{
  const cols = (db.prepare(`PRAGMA table_info(online_return_items)`).all() as { name: string }[]).map((c) => c.name);
  // What the inspection said of this item: clean (sellable), damaged, or rejected (can't be taken back — worn, missing, outside policy).
  if (!cols.includes("verdict")) db.exec(`ALTER TABLE online_return_items ADD COLUMN verdict TEXT`);
  // The quick check when the parcel was opened — who ticked what and when: ok, damaged or missing (not in the parcel).
  if (!cols.includes("arrival_condition")) db.exec(`ALTER TABLE online_return_items ADD COLUMN arrival_condition TEXT`);
  if (!cols.includes("arrival_by")) db.exec(`ALTER TABLE online_return_items ADD COLUMN arrival_by INTEGER REFERENCES users(id)`);
  if (!cols.includes("arrival_at")) db.exec(`ALTER TABLE online_return_items ADD COLUMN arrival_at TEXT`);
  // An optional word on why it was marked bad (or good) — shown to whoever does the inspection.
  if (!cols.includes("arrival_note")) db.exec(`ALTER TABLE online_return_items ADD COLUMN arrival_note TEXT`);
}

// A sale item that is on its way back by delivery (or already came) can't also be returned another way — it would be paid twice.
export function itemInActivePickup(saleItemId: number): boolean {
  return !!db
    .prepare(`SELECT 1 FROM online_return_items WHERE sale_item_id = ? AND status IN ('awaiting', 'received') LIMIT 1`)
    .get(saleItemId);
}

// The customer's share of the pickup charge, whole rupees.
export const customerShareOf = (charge: number, pct: number) => Math.round((charge * pct) / 100);

const PICKUP_SELECT = `
  SELECT op.*, s.invoice, s.sale_type, c.name AS customer_name, c.phone AS customer_phone,
         CASE WHEN op.delivery_partner <> '' THEN COALESCE(dp.name, op.delivery_partner) ELSE NULLIF(op.service_name, '') END AS partner_name,
         u.name AS requested_by_name, ap.name AS approved_by_name, rb.name AS received_by_name, rp.name AS report_by_name,
         rd.name AS report_decided_by_name, rf.name AS refunded_by_name,
         CASE WHEN ba.id IS NULL THEN NULL ELSE ba.bank_name || ' · ' || ba.account_number END AS refund_account_label
  FROM online_returns op
  JOIN sales s ON s.id = op.sale_id
  LEFT JOIN customers c ON c.id = op.customer_id
  LEFT JOIN delivery_partners dp ON dp.code = op.delivery_partner
  LEFT JOIN users u ON u.id = op.requested_by
  LEFT JOIN users ap ON ap.id = op.approved_by
  LEFT JOIN users rb ON rb.id = op.received_by
  LEFT JOIN users rp ON rp.id = op.report_by
  LEFT JOIN users rd ON rd.id = op.report_decided_by
  LEFT JOIN users rf ON rf.id = op.refunded_by
  LEFT JOIN customer_bank_accounts ba ON ba.id = op.refund_account_id
`;

function itemsOf(pickupId: number) {
  return db
    .prepare(
      `SELECT oi.*, si.unit_price AS amount, si.inventory_id, COALESCE(p.product_title, si.product_snapshot) AS title,
              i.size, i.color, i.sku, COALESCE(p.allow_returns, 1) AS allow_returns,
              r.refund_amount
       FROM online_return_items oi
       JOIN sale_items si ON si.id = oi.sale_item_id
       LEFT JOIN inventory i ON i.id = si.inventory_id
       LEFT JOIN products p ON p.id = i.product_id
       LEFT JOIN returns r ON r.id = oi.return_id
       WHERE oi.pickup_id = ? ORDER BY oi.id`
    )
    .all(pickupId);
}

function withItems(row: any) {
  if (!row) return null;
  const items = itemsOf(row.id) as any[];
  return { ...row, customer_share: customerShareOf(row.pickup_charge, row.customer_share_pct), items };
}

export function pickupById(id: number | string) {
  return withItems(db.prepare(`${PICKUP_SELECT} WHERE op.id = ?`).get(id));
}

// The returns by delivery made for one invoice's items, newest first — shown on the invoice itself.
export function pickupsForSale(saleId: number) {
  return (db.prepare(`${PICKUP_SELECT} WHERE op.sale_id = ? ORDER BY op.id DESC`).all(saleId) as any[]).map(withItems);
}

// status: 'open' (approved and not finished — on its way, on hand, report or refund still to do), 'pending' (waiting for an admin's yes to
// the request), 'report' (an inspection report waiting for an admin), 'closed' (completed / declined / cancelled), or everything that
// has been approved or closed — a request still waiting is not "on the way back" yet, so it isn't in the general lists.
export function listPickups(status: "open" | "closed" | "all" | "pending" | "report") {
  const where =
    status === "open"
      ? "WHERE op.stage IN ('approved', 'on_the_way', 'received', 'report_pending', 'refund_due')"
      : status === "pending"
      ? "WHERE op.stage = 'requested'"
      : status === "report"
      ? "WHERE op.stage = 'report_pending'"
      : status === "closed"
      ? "WHERE op.stage IN ('completed', 'declined', 'cancelled', 'rejected')"
      : "WHERE op.stage <> 'requested'";
  return (db.prepare(`${PICKUP_SELECT} ${where} ORDER BY op.id DESC`).all() as any[]).map(withItems);
}
