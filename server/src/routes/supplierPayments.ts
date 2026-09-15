import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const supplierPaymentsRouter = Router();

// Financial data — admin only.
supplierPaymentsRouter.use(requireAuth, requireRole("admin"));

const paymentInput = z.object({
  supplier_id: z.number().int().positive(),
  purchase_id: z.number().int().positive().optional(),
  amount: z.number().positive(),
  method: z.string().optional(),
  is_partial: z.boolean().optional(),
  notes: z.string().optional(),
});

// GET /api/supplier-payments — optionally filter by ?supplier_id=,
// ?start=, ?end= (date range), paginated via ?page= and ?pageSize=.
// Default page size is small (5) for the everyday "just the recent
// ones" view; a date range typically comes with a larger page size
// (e.g. 50) from the frontend, since picking a range is already a
// deliberate, bounded query rather than "show me everything ever."
supplierPaymentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const conditions: string[] = [];
    const params: any[] = [];

    if (req.query.supplier_id) {
      conditions.push("supplier_payments.supplier_id = ?");
      params.push(req.query.supplier_id);
    }
    if (req.query.start) {
      conditions.push("supplier_payments.payment_date >= ?");
      params.push(req.query.start);
    }
    if (req.query.end) {
      conditions.push("supplier_payments.payment_date <= ?");
      params.push(`${req.query.end} 23:59:59`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.pageSize ?? "5"), 10) || 5));
    const offset = (page - 1) * pageSize;

    const totalRow = db
      .prepare(`SELECT COUNT(*) as count FROM supplier_payments ${where}`)
      .get(...params) as { count: number };

    const rows = db
      .prepare(
        `SELECT supplier_payments.*, suppliers.name as supplier_name
         FROM supplier_payments
         JOIN suppliers ON suppliers.id = supplier_payments.supplier_id
         ${where}
         ORDER BY supplier_payments.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);

    res.json({ rows, total: totalRow.count, page, pageSize });
  })
);

// POST /api/supplier-payments — record a standalone payment
supplierPaymentsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = paymentInput.parse(req.body);

    const supplier = db.prepare(`SELECT id FROM suppliers WHERE id = ?`).get(data.supplier_id);
    if (!supplier) throw new ApiError(400, "Referenced supplier does not exist");

    const runTransaction = db.transaction(() => {
      const result = db
        .prepare(
          `INSERT INTO supplier_payments (supplier_id, purchase_id, amount, method, is_partial, notes)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          data.supplier_id,
          data.purchase_id ?? null,
          data.amount,
          data.method ?? null,
          data.is_partial ? 1 : 0,
          data.notes ?? null
        );

      db.prepare(
        `INSERT INTO cash_book (type, category, payment_method, reference_id, amount, notes)
         VALUES ('expense', 'supplier_payment', ?, ?, ?, ?)`
      ).run(data.method ?? null, result.lastInsertRowid, data.amount, data.notes ?? "Supplier payment");

      // If tied to a specific purchase, keep that purchase's payment_status current.
      if (data.purchase_id) {
        const purchase = db
          .prepare(`SELECT * FROM purchases WHERE id = ?`)
          .get(data.purchase_id) as any;
        if (purchase) {
          const totalPaid = db
            .prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM supplier_payments WHERE purchase_id = ?`)
            .get(data.purchase_id) as { total: number };

          let status: "paid" | "partial" | "unpaid" = "unpaid";
          if (totalPaid.total >= purchase.total_cost && purchase.total_cost > 0) status = "paid";
          else if (totalPaid.total > 0) status = "partial";

          db.prepare(`UPDATE purchases SET amount_paid = ?, payment_status = ? WHERE id = ?`).run(
            totalPaid.total,
            status,
            data.purchase_id
          );
        }
      }

      return result.lastInsertRowid;
    });

    const id = runTransaction();
    const created = db.prepare(`SELECT * FROM supplier_payments WHERE id = ?`).get(id);
    res.status(201).json(created);
  })
);

// GET /api/supplier-payments/summary — the "Supplier Summary" report,
// computed live rather than stored (purchases total vs payments total
// vs available credit per supplier). Credit comes from damaged-goods
// returns the supplier agreed to cover as a future discount rather than
// an immediate cash refund — it reduces what's actually still owed, the
// same as a payment would.
supplierPaymentsRouter.get(
  "/summary",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT
           suppliers.id, suppliers.supplier_code, suppliers.name,
           COALESCE((SELECT SUM(total_cost) FROM purchases WHERE supplier_id = suppliers.id), 0) as total_purchased,
           COALESCE((SELECT SUM(amount_paid) FROM purchases WHERE supplier_id = suppliers.id), 0) as total_paid,
           COALESCE((SELECT SUM(amount) FROM supplier_credit_transactions WHERE supplier_id = suppliers.id), 0) as credit_balance,
           COALESCE((SELECT SUM(total_cost) FROM purchases WHERE supplier_id = suppliers.id), 0) -
           COALESCE((SELECT SUM(amount_paid) FROM purchases WHERE supplier_id = suppliers.id), 0) -
           COALESCE((SELECT SUM(amount) FROM supplier_credit_transactions WHERE supplier_id = suppliers.id), 0) as balance_owed
         FROM suppliers
         ORDER BY suppliers.name ASC`
      )
      .all();
    res.json(rows);
  })
);

// GET /api/supplier-payments/ledger/:supplierId — a single supplier's
// full running ledger: every purchase (increases what's owed), every
// payment (reduces it), and every credit from a return (also reduces
// it) — merged into one chronological timeline with a running balance
// computed as we go, so it reads like a real statement: "owed 8750, paid
// 5000 -> 3750 owed, credited 3000 -> 750 owed."
supplierPaymentsRouter.get(
  "/ledger/:supplierId",
  asyncHandler(async (req, res) => {
    const supplier = db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.supplierId);
    if (!supplier) throw new ApiError(404, "Supplier not found");

    const purchases = db
      .prepare(`SELECT id, purchase_code, purchase_date, total_cost FROM purchases WHERE supplier_id = ? ORDER BY purchase_date`)
      .all(req.params.supplierId) as any[];
    const payments = db
      .prepare(`SELECT id, payment_date, amount, method, purchase_id FROM supplier_payments WHERE supplier_id = ? ORDER BY payment_date`)
      .all(req.params.supplierId) as any[];
    const credits = db
      .prepare(
        `SELECT id, created_at, amount, reason, notes FROM supplier_credit_transactions WHERE supplier_id = ? ORDER BY created_at`
      )
      .all(req.params.supplierId) as any[];

    // Merge all three into one timeline, each entry tagged with its type
    // and the amount's effect on balance (+owed for a purchase, -owed
    // for a payment or credit).
    type LedgerEntry = { date: string; type: "purchase" | "payment" | "credit"; label: string; amount: number; effect: number };
    const entries: LedgerEntry[] = [
      ...purchases.map((p) => ({
        date: p.purchase_date,
        type: "purchase" as const,
        label: `Purchase ${p.purchase_code}`,
        amount: p.total_cost,
        effect: p.total_cost,
      })),
      ...payments.map((p) => ({
        date: p.payment_date,
        type: "payment" as const,
        label: `Payment${p.method ? ` (${p.method})` : ""}`,
        amount: p.amount,
        effect: -p.amount,
      })),
      ...credits
        .filter((c) => c.amount > 0) // only show credit GRANTS here, not the internal "applied to purchase" spend-down entries
        .map((c) => ({
          date: c.created_at,
          type: "credit" as const,
          label: c.notes || "Credit from return",
          amount: c.amount,
          effect: -c.amount,
        })),
    ].sort((a, b) => a.date.localeCompare(b.date));

    let runningBalance = 0;
    const withBalance = entries.map((entry) => {
      runningBalance += entry.effect;
      return { ...entry, running_balance: runningBalance };
    });

    res.json({ supplier, entries: withBalance, final_balance: runningBalance });
  })
);
