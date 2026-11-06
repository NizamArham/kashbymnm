import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth } from "../lib/auth";
import { requireAdminOrApproval, actorOf } from "../lib/approval";
import { logAudit } from "../lib/auditLog";
import { nextTransactionCode } from "../lib/codes";

// Pieces sold at the till that were not in stock (borrowed, or not yet entered). Each one is a
// placeholder unit linked to a pending purchase line; this router lists the ones still open at
// end of day and settles them: paid to the supplier, or returned to them.
export const manualItemsRouter = Router();
manualItemsRouter.use(requireAuth);

// Suppliers for the till's picker. The full suppliers page stays admin-only; this gives staff just the names.
manualItemsRouter.get(
  "/suppliers",
  asyncHandler(async (_req, res) => {
    res.json(db.prepare(`SELECT id, name FROM suppliers ORDER BY name`).all());
  })
);

// Every not-in-stock piece not yet settled, newest first.
manualItemsRouter.get(
  "/open",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT i.id, i.sku, i.size, i.color, i.status, i.cost_price, i.selling_price,
                p.product_title, pl.id AS line_id, pu.id AS purchase_id, pu.purchase_code,
                pu.supplier_id, s.name AS supplier_name,
                sa.id AS sale_id, sa.invoice, sa.date AS sale_date
         FROM inventory i
         JOIN pending_purchase_lines pl ON pl.id = i.manual_pending_line_id
         JOIN purchases pu ON pu.id = pl.purchase_id
         JOIN suppliers s ON s.id = pu.supplier_id
         JOIN products p ON p.id = i.product_id
         LEFT JOIN sale_items si ON si.inventory_id = i.id
         LEFT JOIN sales sa ON sa.id = si.sale_id
         WHERE i.manual_resolution IS NULL
         ORDER BY i.id DESC`
      )
      .all();
    res.json(rows);
  })
);

const settleInput = z.object({
  resolution: z.enum(["paid", "returned"]),
  payment_method: z.enum(["cash", "card"]).default("cash"),
  note: z.string().trim().max(300).optional(),
});

// Settle one open piece. "paid": we pay the supplier its cost (a supplier payment, and an expense in the
// cash book). "returned": the piece goes back to the supplier and the purchase line is reduced by one.
// Neither changes the customer's sale, so a piece the customer didn't keep is refunded or voided from
// Sale History as usual.
manualItemsRouter.post(
  "/:id/settle",
  requireAdminOrApproval("Settling a borrowed item"),
  asyncHandler(async (req, res) => {
    const data = settleInput.parse(req.body);
    const unitId = Number(req.params.id);

    const unit = db
      .prepare(
        `SELECT i.id, i.sku, i.status, i.cost_price, i.manual_resolution, pl.id AS line_id, pl.purchase_id,
                pu.supplier_id, pu.total_cost, pu.amount_paid
         FROM inventory i
         JOIN pending_purchase_lines pl ON pl.id = i.manual_pending_line_id
         JOIN purchases pu ON pu.id = pl.purchase_id
         WHERE i.id = ?`
      )
      .get(unitId) as
      | {
          id: number;
          sku: string;
          status: string;
          cost_price: number | null;
          manual_resolution: string | null;
          line_id: number;
          purchase_id: number;
          supplier_id: number;
          total_cost: number;
          amount_paid: number;
        }
      | undefined;
    if (!unit) throw new ApiError(404, "That borrowed item wasn't found");
    if (unit.manual_resolution) throw new ApiError(409, `This item is already settled as ${unit.manual_resolution}`);

    // A supplier return only makes sense once the piece is back with us: a customer return (status
    // 'removed') or one that was never sold. A piece the customer still holds ('sold') can't go back.
    if (data.resolution === "returned" && unit.status !== "removed") {
      throw new ApiError(409, "This piece is still with the customer or on the shelf — only a piece we have back can be returned to the supplier");
    }

    const actor = actorOf(req);
    const cost = unit.cost_price ?? 0;

    db.transaction(() => {
      if (data.resolution === "paid") {
        const payment = db
          .prepare(
            `INSERT INTO supplier_payments (supplier_id, purchase_id, amount, method, is_partial, notes)
             VALUES (?, ?, ?, ?, 0, ?)`
          )
          .run(unit.supplier_id, unit.purchase_id, cost, data.payment_method, `Borrowed item ${unit.sku}${data.note ? ` — ${data.note}` : ""}`);

        db.prepare(
          `INSERT INTO cash_book (transaction_code, type, category, payment_method, reference_id, amount, notes)
           VALUES (?, 'expense', 'supplier_payment', ?, ?, ?, ?)`
        ).run(nextTransactionCode(), data.payment_method, payment.lastInsertRowid, cost, `Borrowed item ${unit.sku} paid to supplier`);

        const paidSoFar = unit.amount_paid + cost;
        const status = paidSoFar >= unit.total_cost && unit.total_cost > 0 ? "paid" : paidSoFar > 0 ? "partial" : "unpaid";
        db.prepare(`UPDATE purchases SET amount_paid = ?, payment_status = ? WHERE id = ?`).run(paidSoFar, status, unit.purchase_id);

        db.prepare(`UPDATE inventory SET manual_resolution = 'paid' WHERE id = ?`).run(unit.id);
      } else {
        db.prepare(
          `UPDATE inventory SET status = 'removed', removal_reason = 'Returned to supplier', removal_note = ?, manual_resolution = 'returned' WHERE id = ?`
        ).run(data.note ?? null, unit.id);

        // The purchase owes one piece less now.
        db.prepare(`UPDATE pending_purchase_lines SET quantity = MAX(0, quantity - 1) WHERE id = ?`).run(unit.line_id);
        const newTotal = db
          .prepare(`SELECT COALESCE(SUM(quantity * unit_cost), 0) AS total FROM pending_purchase_lines WHERE purchase_id = ?`)
          .get(unit.purchase_id) as { total: number };
        const status =
          unit.amount_paid >= newTotal.total && newTotal.total > 0 ? "paid" : unit.amount_paid > 0 ? "partial" : "unpaid";
        db.prepare(`UPDATE purchases SET total_cost = ?, payment_status = ? WHERE id = ?`).run(newTotal.total, status, unit.purchase_id);
      }
    })();

    logAudit(
      actor,
      "borrowed_item_settled",
      "inventory",
      unit.id,
      `${unit.sku} ${data.resolution === "paid" ? "paid to supplier" : "returned to supplier"}${data.note ? ` (${data.note})` : ""}`
    );

    res.json({ ok: true, resolution: data.resolution });
  })
);
