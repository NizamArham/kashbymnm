import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";

export const supplierPaymentsRouter = Router();

const paymentInput = z.object({
  supplier_id: z.number().int().positive(),
  purchase_id: z.number().int().positive().optional(),
  amount: z.number().positive(),
  method: z.string().optional(),
  is_partial: z.boolean().optional(),
  notes: z.string().optional(),
});

// GET /api/supplier-payments — optionally filter by ?supplier_id=
supplierPaymentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const where = req.query.supplier_id ? "WHERE supplier_payments.supplier_id = ?" : "";
    const params = req.query.supplier_id ? [req.query.supplier_id] : [];

    const rows = db
      .prepare(
        `SELECT supplier_payments.*, suppliers.name as supplier_name
         FROM supplier_payments
         JOIN suppliers ON suppliers.id = supplier_payments.supplier_id
         ${where}
         ORDER BY supplier_payments.id DESC`
      )
      .all(...params);
    res.json(rows);
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
        `INSERT INTO cash_book (type, category, reference_id, amount, notes)
         VALUES ('expense', 'supplier_payment', ?, ?, ?)`
      ).run(result.lastInsertRowid, data.amount, data.notes ?? "Supplier payment");

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
// computed live rather than stored (purchases total vs payments total per supplier)
supplierPaymentsRouter.get(
  "/summary",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT
           suppliers.id, suppliers.supplier_code, suppliers.name,
           COALESCE((SELECT SUM(total_cost) FROM purchases WHERE supplier_id = suppliers.id), 0) as total_purchased,
           COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_id = suppliers.id), 0) as total_paid,
           COALESCE((SELECT SUM(total_cost) FROM purchases WHERE supplier_id = suppliers.id), 0) -
           COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_id = suppliers.id), 0) as balance_owed
         FROM suppliers
         ORDER BY suppliers.name ASC`
      )
      .all();
    res.json(rows);
  })
);
