import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { nextTransactionCode } from "../lib/codes";
import { requireAuth, requireRole } from "../lib/auth";
import { logAudit } from "../lib/auditLog";
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
  // courier_charge starts as the tariff's ESTIMATE for the weight entered at
  // dispatch; the courier's real bill can differ with the actual parcel.
  // charge_confirmed says someone has checked it (or entered the real figure),
  // estimated_charge keeps the original estimate for comparison, and
  // actual_weight_kg is the weight the courier really billed on, if different.
  if (!columns.some((c) => c.name === "charge_confirmed")) {
    db.exec(`ALTER TABLE courier_reconciliations ADD COLUMN charge_confirmed INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columns.some((c) => c.name === "estimated_charge")) {
    db.exec(`ALTER TABLE courier_reconciliations ADD COLUMN estimated_charge REAL`);
    db.exec(`UPDATE courier_reconciliations SET estimated_charge = courier_charge WHERE estimated_charge IS NULL`);
  }
  if (!columns.some((c) => c.name === "actual_weight_kg")) {
    db.exec(`ALTER TABLE courier_reconciliations ADD COLUMN actual_weight_kg REAL`);
  }
  // A signed correction to what a courier owes the shop, with the reason it
  // was made. Positive = they owe more, negative = they owe less. No money
  // moves — it only fixes the balance — so it never touches the cash book.
  db.exec(`
    CREATE TABLE IF NOT EXISTS courier_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      courier_partner TEXT NOT NULL,
      amount REAL NOT NULL,
      reason TEXT NOT NULL,
      balance_before REAL NOT NULL,
      balance_after REAL NOT NULL,
      staff_id INTEGER,
      staff_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', '+330 minutes'))
    );
  `);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

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
    INSERT OR IGNORE INTO courier_reconciliations (delivery_id, courier_partner, cod_amount, courier_charge, estimated_charge)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const delivery of deliveries) {
    const estimate = chargeFor(delivery);
    insert.run(delivery.id, delivery.delivery_partner, delivery.cod_amount, estimate, estimate);
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
    `INSERT INTO courier_reconciliations (delivery_id, courier_partner, cod_amount, courier_charge, estimated_charge, return_charge)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(delivery_id) DO UPDATE SET
       return_charge = CASE WHEN courier_reconciliations.charge_confirmed = 1 AND courier_reconciliations.return_charge > 0
                            THEN courier_reconciliations.return_charge ELSE excluded.return_charge END,
       updated_at = datetime('now', '+330 minutes')`
  ).run(delivery.id, delivery.delivery_partner, delivery.cod_amount, charge, charge, charge);
}

// An online exchange's pickup leg: the courier collected the old item on its way
// back, and charges for it. Added to the same return_charge the returned-parcel
// flow uses, so it's deducted from what they owe us; the customer's share of it was
// collected in the COD, which nets out in the same remittance.
export function addPickupCharge(
  delivery: {
    id: number;
    delivery_partner: string | null;
    cod_amount: number;
    package_weight_kg: number | null;
    delivery_fee: number;
    is_free_delivery: number;
  },
  amount: number
) {
  if (!(amount > 0) || !delivery.delivery_partner) return;
  if (getPartner(delivery.delivery_partner)?.kind === "on_demand") return;
  ensureTable();
  const estimate = chargeFor(delivery);
  db.prepare(
    `INSERT OR IGNORE INTO courier_reconciliations (delivery_id, courier_partner, cod_amount, courier_charge, estimated_charge)
     VALUES (?, ?, ?, ?, ?)`
  ).run(delivery.id, delivery.delivery_partner, delivery.cod_amount, estimate, estimate);
  db.prepare(
    `UPDATE courier_reconciliations SET return_charge = return_charge + ?, updated_at = datetime('now', '+330 minutes') WHERE delivery_id = ?`
  ).run(amount, delivery.id);
}

interface CourierSummary {
  courier_partner: string;
  cod_collected: number;
  courier_charges: number;
  expected_net: number;
  delivered_orders: number;
  // Delivered/returned orders whose charge is still the system's estimate.
  estimated_orders: number;
  settled_total: number;
  adjustments_total: number;
  // What the courier owes the shop right now: expected net, less what they've
  // already paid over, plus any corrections. Negative = the shop owes them.
  balance: number;
}

// One place that works out every courier's figures, so the page, the history
// report and the "correct balance" screen can never disagree.
function buildSummary(): CourierSummary[] {
  const byOrders = db.prepare(`
    SELECT cr.courier_partner,
      COALESCE(SUM(CASE WHEN d.delivery_status = 'delivered' THEN cr.cod_amount ELSE 0 END), 0) AS cod_collected,
      COALESCE(SUM(CASE WHEN d.delivery_status IN ('delivered', 'returned') THEN cr.courier_charge + cr.return_charge ELSE 0 END), 0) AS courier_charges,
      COUNT(CASE WHEN d.delivery_status = 'delivered' THEN 1 END) AS delivered_orders,
      COUNT(CASE WHEN d.delivery_status IN ('delivered', 'returned') AND cr.charge_confirmed = 0 THEN 1 END) AS estimated_orders
    FROM courier_reconciliations cr JOIN deliveries d ON d.id = cr.delivery_id
    GROUP BY cr.courier_partner
  `).all() as { courier_partner: string; cod_collected: number; courier_charges: number; delivered_orders: number; estimated_orders: number }[];
  const settled = new Map(
    (db.prepare(`SELECT courier_partner, SUM(amount_received) AS total FROM courier_settlements GROUP BY courier_partner`).all() as { courier_partner: string; total: number }[]).map((r) => [r.courier_partner, r.total])
  );
  const adjusted = new Map(
    (db.prepare(`SELECT courier_partner, SUM(amount) AS total FROM courier_adjustments GROUP BY courier_partner`).all() as { courier_partner: string; total: number }[]).map((r) => [r.courier_partner, r.total])
  );
  const orders = new Map(byOrders.map((r) => [r.courier_partner, r]));
  const codes = Array.from(new Set([...orders.keys(), ...settled.keys(), ...adjusted.keys()])).sort();
  return codes.map((code) => {
    const o = orders.get(code);
    const cod = o?.cod_collected ?? 0;
    const charges = o?.courier_charges ?? 0;
    const expected = round2(cod - charges);
    const settledTotal = round2(settled.get(code) ?? 0);
    const adjustmentsTotal = round2(adjusted.get(code) ?? 0);
    return {
      courier_partner: code,
      cod_collected: cod,
      courier_charges: charges,
      expected_net: expected,
      delivered_orders: o?.delivered_orders ?? 0,
      estimated_orders: o?.estimated_orders ?? 0,
      settled_total: settledTotal,
      adjustments_total: adjustmentsTotal,
      balance: round2(expected - settledTotal + adjustmentsTotal),
    };
  });
}

courierReconciliationRouter.get("/", asyncHandler(async (_req, res) => {
  syncDispatchedRows();
  const summary = buildSummary();
  const settlements = db.prepare(`SELECT * FROM courier_settlements ORDER BY received_date DESC, id DESC`).all();
  const adjustments = db.prepare(`SELECT * FROM courier_adjustments ORDER BY id DESC LIMIT 100`).all();
  const rows = db.prepare(`
    SELECT courier_reconciliations.*, deliveries.delivery_status, deliveries.tracking_number, deliveries.waybill_number,
      deliveries.package_weight_kg, deliveries.delivery_fee, deliveries.is_free_delivery,
      sales.id AS sale_id, sales.invoice, sales.date AS sale_date, customers.name AS customer_name
    FROM courier_reconciliations
    JOIN deliveries ON deliveries.id = courier_reconciliations.delivery_id
    JOIN sales ON sales.id = deliveries.sale_id
    LEFT JOIN customers ON customers.id = sales.customer_id
    ORDER BY deliveries.dispatched_at DESC, courier_reconciliations.id DESC
  `).all() as any[];
  // What the tariff says for the weight on record (the actual weight if one was
  // entered) — shown next to the charge so a difference is easy to spot.
  const orders = rows.map((row) => {
    const { delivery_fee, is_free_delivery, ...rest } = row;
    return {
      ...rest,
      tariff_charge: chargeFor({
        delivery_partner: row.courier_partner,
        package_weight_kg: row.actual_weight_kg ?? row.package_weight_kg,
        delivery_fee,
        is_free_delivery,
      }),
    };
  });
  res.json({ summary, settlements, adjustments, orders });
}));

// Tick several orders' charges as checked in one go ("the estimates were right").
// Must be declared before "/orders/:id", which would otherwise swallow "confirm".
courierReconciliationRouter.post("/orders/confirm", asyncHandler(async (req, res) => {
  ensureTable();
  const data = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) }).parse(req.body);
  const confirm = db.prepare(`UPDATE courier_reconciliations SET charge_confirmed = 1, updated_at = datetime('now', '+330 minutes') WHERE id = ? AND charge_confirmed = 0`);
  const changed = db.transaction(() => data.ids.reduce((n, id) => n + confirm.run(id).changes, 0))();
  if (changed > 0) {
    logAudit(req.user!, "courier_charge_edit", "courier_reconciliation", null, `Confirmed ${changed} courier charge${changed === 1 ? "" : "s"} as correct`);
  }
  res.json({ confirmed: changed });
}));

courierReconciliationRouter.post("/orders/:id", asyncHandler(async (req, res) => {
  syncDispatchedRows();
  const existing = db.prepare(`SELECT * FROM courier_reconciliations WHERE id = ?`).get(req.params.id) as any;
  if (!existing) throw new ApiError(404, "Reconciliation order not found");
  const data = z
    .object({
      courier_charge: z.number().nonnegative(),
      return_charge: z.number().nonnegative().optional(),
      // The weight the courier really billed on; null clears it.
      actual_weight_kg: z.number().positive().max(500).nullable().optional(),
      notes: z.string().optional(),
    })
    .parse(req.body);
  // Saving a charge — even unchanged — means someone has looked at it.
  db.prepare(
    `UPDATE courier_reconciliations
     SET courier_charge = ?, return_charge = ?, actual_weight_kg = ?, notes = ?, charge_confirmed = 1, updated_at = datetime('now', '+330 minutes')
     WHERE id = ?`
  ).run(
    data.courier_charge,
    data.return_charge ?? existing.return_charge,
    data.actual_weight_kg === undefined ? existing.actual_weight_kg : data.actual_weight_kg,
    data.notes === undefined ? existing.notes : data.notes.trim() || null,
    req.params.id
  );
  const invoice = (db.prepare(`SELECT sales.invoice FROM deliveries JOIN sales ON sales.id = deliveries.sale_id WHERE deliveries.id = ?`).get(existing.delivery_id) as { invoice: string } | undefined)?.invoice ?? `delivery ${existing.delivery_id}`;
  const parts = [`charge Rs. ${existing.courier_charge.toLocaleString()} → Rs. ${data.courier_charge.toLocaleString()}`];
  if (data.return_charge !== undefined && data.return_charge !== existing.return_charge) parts.push(`return charge Rs. ${existing.return_charge.toLocaleString()} → Rs. ${data.return_charge.toLocaleString()}`);
  if (data.actual_weight_kg !== undefined && data.actual_weight_kg !== existing.actual_weight_kg) parts.push(`actual weight ${data.actual_weight_kg ?? "cleared"}${data.actual_weight_kg ? " kg" : ""}`);
  logAudit(req.user!, "courier_charge_edit", "courier_reconciliation", existing.id, `${invoice} (${existing.courier_partner}): ${parts.join(", ")}${data.notes?.trim() ? ` — ${data.notes.trim()}` : ""}`);
  res.json(db.prepare(`SELECT * FROM courier_reconciliations WHERE id = ?`).get(req.params.id));
}));

// Correct what a courier owes the shop, with a reason. Give EITHER the balance
// it should be (positive = they owe you, negative = you owe them — straight from
// their statement) OR an amount to add/take off. The difference is recorded as an
// adjustment; the settlements and orders underneath stay exactly as they were.
courierReconciliationRouter.post("/adjustments", asyncHandler(async (req, res) => {
  ensureTable();
  const data = z
    .object({
      courier_partner: z.string().min(1),
      reason: z.string().trim().min(3, "A reason is needed — a few words is fine").max(200),
      target_balance: z.number().finite().optional(),
      adjustment: z.number().finite().optional(),
    })
    .refine((d) => (d.target_balance === undefined) !== (d.adjustment === undefined), { message: "Give either the balance it should be, or an amount to add or take off" })
    .parse(req.body);
  const partner = getPartner(data.courier_partner);
  if (!partner || partner.kind !== "courier") throw new ApiError(400, "That isn't a courier partner");

  const current = buildSummary().find((row) => row.courier_partner === data.courier_partner)?.balance ?? 0;
  const amount = round2(data.target_balance !== undefined ? data.target_balance - current : data.adjustment!);
  if (Math.abs(amount) < 0.005) throw new ApiError(400, "That's already the balance — nothing to correct");
  const after = round2(current + amount);

  const result = db
    .prepare(`INSERT INTO courier_adjustments (courier_partner, amount, reason, balance_before, balance_after, staff_id, staff_name) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(data.courier_partner, amount, data.reason, current, after, req.user!.id, req.user!.name ?? req.user!.username);
  const fmt = (n: number) => (n >= 0 ? `Rs. ${n.toLocaleString()} due` : `Rs. ${(-n).toLocaleString()} credit`);
  logAudit(req.user!, "courier_balance_adjust", "courier_adjustment", Number(result.lastInsertRowid), `${partner.name}: balance ${fmt(current)} → ${fmt(after)} (${amount > 0 ? "+" : "−"}Rs. ${Math.abs(amount).toLocaleString()}) — ${data.reason}`);
  res.status(201).json(db.prepare(`SELECT * FROM courier_adjustments WHERE id = ?`).get(result.lastInsertRowid));
}));

// Undo a correction made by mistake — the balance goes back to what the orders and
// settlements say. (Logged, so it's still visible who did what.)
courierReconciliationRouter.delete("/adjustments/:id", asyncHandler(async (req, res) => {
  ensureTable();
  const row = db.prepare(`SELECT * FROM courier_adjustments WHERE id = ?`).get(req.params.id) as any;
  if (!row) throw new ApiError(404, "Adjustment not found");
  db.prepare(`DELETE FROM courier_adjustments WHERE id = ?`).run(req.params.id);
  logAudit(req.user!, "courier_balance_adjust_undo", "courier_adjustment", row.id, `${getPartner(row.courier_partner)?.name ?? row.courier_partner}: undid a ${row.amount > 0 ? "+" : "−"}Rs. ${Math.abs(row.amount).toLocaleString()} correction ("${row.reason}")`);
  res.json({ ok: true });
}));

courierReconciliationRouter.post("/settlements", asyncHandler(async (req, res) => {
  ensureTable();
  // Every dispatched / delivered / returned order needs its reconciliation row before
  // a payout is applied to them — normally the Couriers page has created them, but
  // the payout must never depend on that page having been opened first.
  syncDispatchedRows();
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
        `SELECT sales.id, sales.total, sales.amount_paid, cr.cod_amount, deliveries.delivery_fee, deliveries.pickup_collected
         FROM courier_reconciliations cr
         JOIN deliveries ON deliveries.id = cr.delivery_id
         JOIN sales ON sales.id = deliveries.sale_id
         WHERE cr.courier_partner = ? AND deliveries.delivery_status = 'delivered' AND sales.payment_status != 'paid'
         ORDER BY deliveries.delivery_date ASC`
      )
      .all(data.courier_partner) as
      | { id: number; total: number; amount_paid: number; cod_amount: number; delivery_fee: number; pickup_collected: number }[];

    const updateSale = db.prepare(`UPDATE sales SET amount_paid = ?, payment_status = ? WHERE id = ?`);
    for (const sale of unpaidDelivered) {
      // (An exchange's pickup-charge share is collected in the COD too, but it
      // isn't payment for the order.)
      const towardSale = Math.max(0, sale.cod_amount - sale.delivery_fee - sale.pickup_collected);
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