import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const courierReconciliationRouter = Router();
courierReconciliationRouter.use(requireAuth, requireRole("admin"));

const DEFAULT_CHARGE = 450;

function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS courier_reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id INTEGER NOT NULL UNIQUE REFERENCES deliveries(id),
      courier_partner TEXT NOT NULL,
      cod_amount REAL NOT NULL DEFAULT 0,
      courier_charge REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS courier_settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      courier_partner TEXT NOT NULL,
      week_start TEXT NOT NULL,
      week_end TEXT NOT NULL,
      amount_received REAL NOT NULL,
      received_date TEXT NOT NULL DEFAULT (date('now')),
      notes TEXT
    );
  `);
}

function chargeFor(delivery: { package_weight_kg: number | null; delivery_fee: number; is_free_delivery: number }): number {
  if (delivery.is_free_delivery) return DEFAULT_CHARGE;
  const weight = delivery.package_weight_kg || 0;
  if (weight <= 0) return DEFAULT_CHARGE;
  return DEFAULT_CHARGE + Math.max(0, Math.ceil(weight - 1)) * 100;
}

function syncDispatchedRows() {
  ensureTable();
  const deliveries = db.prepare(`
    SELECT id, delivery_partner, cod_amount, package_weight_kg, delivery_fee, is_free_delivery
    FROM deliveries
    WHERE delivery_status IN ('dispatched', 'delivered')
      AND delivery_partner IS NOT NULL
      AND delivery_partner != 'D2D'
  `).all() as Array<{ id: number; delivery_partner: string; cod_amount: number; package_weight_kg: number | null; delivery_fee: number; is_free_delivery: number }>;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO courier_reconciliations (delivery_id, courier_partner, cod_amount, courier_charge)
    VALUES (?, ?, ?, ?)
  `);
  for (const delivery of deliveries) {
    insert.run(delivery.id, delivery.delivery_partner, delivery.cod_amount, chargeFor(delivery));
  }
}

courierReconciliationRouter.get("/", asyncHandler(async (_req, res) => {
  syncDispatchedRows();
  const summary = db.prepare(`
    SELECT courier_partner,
      COALESCE(SUM(CASE WHEN deliveries.delivery_status = 'delivered' THEN cr.cod_amount ELSE 0 END), 0) AS cod_collected,
      COALESCE(SUM(CASE WHEN deliveries.delivery_status = 'delivered' THEN cr.courier_charge ELSE 0 END), 0) AS courier_charges,
      COALESCE(SUM(CASE WHEN deliveries.delivery_status = 'delivered' THEN cr.cod_amount - cr.courier_charge ELSE 0 END), 0) AS expected_net,
      COUNT(CASE WHEN deliveries.delivery_status = 'delivered' THEN 1 END) AS delivered_orders
    FROM courier_reconciliations AS cr
    JOIN deliveries ON deliveries.id = cr.delivery_id
    GROUP BY courier_partner
  `).all();
  const settlements = db.prepare(`SELECT * FROM courier_settlements ORDER BY received_date DESC, id DESC`).all();
  const orders = db.prepare(`
    SELECT courier_reconciliations.*, deliveries.delivery_status, deliveries.tracking_number, deliveries.waybill_number,
      sales.invoice, sales.date AS sale_date, customers.name AS customer_name
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
  const data = z.object({ courier_charge: z.number().nonnegative(), notes: z.string().optional() }).parse(req.body);
  const row = db.prepare(`SELECT id FROM courier_reconciliations WHERE id = ?`).get(req.params.id);
  if (!row) throw new ApiError(404, "Reconciliation order not found");
  db.prepare(`UPDATE courier_reconciliations SET courier_charge = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`).run(data.courier_charge, data.notes ?? null, req.params.id);
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
  const result = db.prepare(`INSERT INTO courier_settlements (courier_partner, week_start, week_end, amount_received, received_date, notes) VALUES (?, ?, ?, ?, COALESCE(?, date('now')), ?)`).run(data.courier_partner, data.week_start, data.week_end, data.amount_received, data.received_date ?? null, data.notes ?? null);
  res.status(201).json(db.prepare(`SELECT * FROM courier_settlements WHERE id = ?`).get(result.lastInsertRowid));
}));