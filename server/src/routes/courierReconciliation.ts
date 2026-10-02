import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { nextTransactionCode } from "../lib/codes";
import { requireAuth, requireRole } from "../lib/auth";
import { getPartner, tariffFor } from "../lib/deliveryPartners";

export const courierReconciliationRouter = Router();
courierReconciliationRouter.use(requireAuth, requireRole("admin"));

const DEFAULT_CHARGE = 450;

export function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS courier_reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id INTEGER NOT NULL UNIQUE REFERENCES deliveries(id),
      courier_partner TEXT NOT NULL,
      cod_amount REAL NOT NULL DEFAULT 0,
      courier_charge REAL NOT NULL DEFAULT 0,
      return_charge REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', '+330 minutes')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', '+330 minutes'))
    );
    CREATE TABLE IF NOT EXISTS courier_settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      courier_partner TEXT NOT NULL,
      week_start TEXT NOT NULL,
      week_end TEXT NOT NULL,
      amount_received REAL NOT NULL,
      received_date TEXT NOT NULL DEFAULT (date('now', '+330 minutes')),
      notes TEXT
    );
  `);
  // Additive column for installs where this table already existed before
  // return charges were tracked — CREATE TABLE IF NOT EXISTS above won't
  // add it to an existing table on its own.
  const columns = db.prepare(`PRAGMA table_info(courier_reconciliations)`).all() as { name: string }[];
  if (!columns.some((c) => c.name === "return_charge")) {
    db.exec(`ALTER TABLE courier_reconciliations ADD COLUMN return_charge REAL NOT NULL DEFAULT 0`);
  }
}

// The courier charges once to attempt delivery and, when the customer
// refuses or can't be reached, again to bring the package back — a
// return isn't free just because the sale fell through. Same formula
// both ways since it's the same parcel making the same trip in reverse.
function chargeFor(delivery: {
  delivery_partner: string | null;
  package_weight_kg: number | null;
  delivery_fee: number;
  is_free_delivery: number;
}): number {
  // Each courier bills on its own tariff (set on the Delivery Partners
  // page); a partner that's since been removed falls back to the
  // original flat default.
  const partner = getPartner(delivery.delivery_partner);
  const base = partner?.base_fee ?? DEFAULT_CHARGE;
  if (delivery.is_free_delivery) return base;
  const weight = delivery.package_weight_kg || 0;
  if (weight <= 0) return base;
  return tariffFor(partner, weight);
}

function syncDispatchedRows() {
  ensureTable();
  const deliveries = db.prepare(`
    SELECT id, delivery_partner, cod_amount, package_weight_kg, delivery_fee, is_free_delivery
    FROM deliveries
    WHERE delivery_status IN ('dispatched', 'delivered', 'returned')
      AND delivery_partner IS NOT NULL
      AND delivery_partner NOT IN (SELECT code FROM delivery_partners WHERE kind = 'on_demand')
  `).all() as Array<{ id: number; delivery_partner: string; cod_amount: number; package_weight_kg: number | null; delivery_fee: number; is_free_delivery: number }>;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO courier_reconciliations (delivery_id, courier_partner, cod_amount, courier_charge)
    VALUES (?, ?, ?, ?)
  `);
  for (const delivery of deliveries) {
    insert.run(delivery.id, delivery.delivery_partner, delivery.cod_amount, chargeFor(delivery));
  }
}

// Called when an order that was already dispatched (the courier
// physically had it) gets marked returned — adds the return-trip fee to
// its reconciliation row, creating the row first if dispatch never got
// synced into one yet. Doesn't touch courier_charge on an existing row,
// since that may have already been manually adjusted by an admin.
export function applyReturnCharge(delivery: {
  id: number;
  delivery_partner: string | null;
  cod_amount: number;
  package_weight_kg: number | null;
  delivery_fee: number;
  is_free_delivery: number;
}) {
  if (!delivery.delivery_partner) return;
  // An on-demand rider (Uber, PickMe...) isn't a courier we settle COD
  // with, so there's no reconciliation row to add a return charge to.
  if (getPartner(delivery.delivery_partner)?.kind === "on_demand") return;
  ensureTable();
  const charge = chargeFor(delivery);
  db.prepare(
    `INSERT INTO courier_reconciliations (delivery_id, courier_partner, cod_amount, courier_charge, return_charge)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(delivery_id) DO UPDATE SET return_charge = excluded.return_charge, updated_at = datetime('now', '+330 minutes')`
  ).run(delivery.id, delivery.delivery_partner, delivery.cod_amount, charge, charge);
}

courierReconciliationRouter.get("/", asyncHandler(async (_req, res) => {
  syncDispatchedRows();
  const summary = db.prepare(`
    SELECT courier_partner,
      COALESCE(SUM(CASE WHEN deliveries.delivery_status = 'delivered' THEN cr.cod_amount ELSE 0 END), 0) AS cod_collected,
      COALESCE(SUM(CASE WHEN deliveries.delivery_status IN ('delivered', 'returned') THEN cr.courier_charge + cr.return_charge ELSE 0 END), 0) AS courier_charges,
      COALESCE(SUM(CASE WHEN deliveries.delivery_status = 'delivered' THEN cr.cod_amount ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN deliveries.delivery_status IN ('delivered', 'returned') THEN cr.courier_charge + cr.return_charge ELSE 0 END), 0) AS expected_net,
      COUNT(CASE WHEN deliveries.delivery_status = 'delivered' THEN 1 END) AS delivered_orders
    FROM courier_reconciliations AS cr
    JOIN deliveries ON deliveries.id = cr.delivery_id
    GROUP BY courier_partner
  `).all();
  const settlements = db.prepare(`SELECT * FROM courier_settlements ORDER BY received_date DESC, id DESC`).all();
  const orders = db.prepare(`
    SELECT courier_reconciliations.*, deliveries.delivery_status, deliveries.tracking_number, deliveries.waybill_number,
      sales.id AS sale_id, sales.invoice, sales.date AS sale_date, customers.name AS customer_name
    FROM courier_reconciliations
    JOIN deliveries ON deliveries.id = courier_reconciliations.delivery_id
    JOIN sales ON sales.id = deliveries.sale_id
    LEFT JOIN customers ON customers.id = sales.customer_id
    ORDER BY deliveries.dispatched_at DESC, courier_reconciliations.id DESC
  `).all();
  res.json({ summary, settlements, orders });
}));

courierReconciliationRouter.post("/orders/:id", asyncHandler(async (req, res) => {
  syncDispatchedRows();
  const existing = db.prepare(`SELECT * FROM courier_reconciliations WHERE id = ?`).get(req.params.id) as any;
  if (!existing) throw new ApiError(404, "Reconciliation order not found");
  const data = z
    .object({ courier_charge: z.number().nonnegative(), return_charge: z.number().nonnegative().optional(), notes: z.string().optional() })
    .parse(req.body);
  db.prepare(`UPDATE courier_reconciliations SET courier_charge = ?, return_charge = ?, notes = ?, updated_at = datetime('now', '+330 minutes') WHERE id = ?`).run(
    data.courier_charge,
    data.return_charge ?? existing.return_charge,
    data.notes ?? null,
    req.params.id
  );
  res.json(db.prepare(`SELECT * FROM courier_reconciliations WHERE id = ?`).get(req.params.id));
}));

courierReconciliationRouter.post("/settlements", asyncHandler(async (req, res) => {
  ensureTable();
  const data = z.object({
    courier_partner: z.string().min(1),
    week_start: z.string().min(1),
    week_end: z.string().min(1),
    amount_received: z.number().nonnegative(),
    received_date: z.string().optional(),
    notes: z.string().optional(),
  }).parse(req.body);

  const runTransaction = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO courier_settlements (courier_partner, week_start, week_end, amount_received, received_date, notes) VALUES (?, ?, ?, ?, COALESCE(?, date('now', '+330 minutes')), ?)`
      )
      .run(data.courier_partner, data.week_start, data.week_end, data.amount_received, data.received_date ?? null, data.notes ?? null);

    // The money the courier pays back is real cash/bank income — without
    // this, Cash Book's current balance never reflects it even though
    // Courier Reconciliation's own balance does.
    db.prepare(
      `INSERT INTO cash_book (transaction_code, type, category, reference_id, amount, notes)
       VALUES (?, 'income', 'courier_settlement', ?, ?, ?)`
    ).run(nextTransactionCode(), result.lastInsertRowid, data.amount_received, data.notes ?? `Settlement from ${data.courier_partner}`);

    // A settlement means the courier has now actually paid the shop back
    // for everything they've delivered for this partner so far — so the
    // underlying sales should stop showing as still-owed, but ONLY for
    // the portion of the COD collection that was actually for the SALE.
    // cod_amount is (remaining sale balance at dispatch) + delivery_fee
    // (see the deliveries table comment) — so cod_amount - delivery_fee
    // is exactly what the sale itself received. For a normal COD order
    // that's the full remaining balance; for an online CREDIT order
    // where only the delivery fee is collected on delivery (the "OCR"
    // invoice category — merchandise stays on credit), that comes out
    // to zero, so the courier settling correctly does NOT mark the
    // credit sale as paid. Only 'delivered' orders (real COD collected)
    // qualify — a 'returned' one never had COD collected, so its sale
    // is left alone. No separate cash_book entry is made per sale: the
    // courier's lump remittance already covers this money, recorded
    // once, above.
    const unpaidDelivered = db
      .prepare(
        `SELECT sales.id, sales.total, sales.amount_paid, cr.cod_amount, deliveries.delivery_fee
         FROM courier_reconciliations cr
         JOIN deliveries ON deliveries.id = cr.delivery_id
         JOIN sales ON sales.id = deliveries.sale_id
         WHERE cr.courier_partner = ? AND deliveries.delivery_status = 'delivered' AND sales.payment_status != 'paid'
         ORDER BY deliveries.delivery_date ASC`
      )
      .all(data.courier_partner) as
      | { id: number; total: number; amount_paid: number; cod_amount: number; delivery_fee: number }[];

    const updateSale = db.prepare(`UPDATE sales SET amount_paid = ?, payment_status = ? WHERE id = ?`);
    for (const sale of unpaidDelivered) {
      const towardSale = Math.max(0, sale.cod_amount - sale.delivery_fee);
      const newAmountPaid = sale.amount_paid + towardSale;
      const newStatus: "paid" | "partial" | "unpaid" =
        newAmountPaid >= sale.total && sale.total > 0 ? "paid" : newAmountPaid > 0 ? "partial" : "unpaid";
      updateSale.run(newAmountPaid, newStatus, sale.id);
    }

    return result.lastInsertRowid;
  });

  const id = runTransaction();
  res.status(201).json(db.prepare(`SELECT * FROM courier_settlements WHERE id = ?`).get(id));
}));