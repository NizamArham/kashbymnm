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

const settleManyInput = settleInput.extend({
  ids: z.array(z.number().int().positive()).min(1).max(200),
});

interface OpenUnit {
  id: number;
  sku: string;
  status: string;
  cost_price: number | null;
  manual_resolution: string | null;
  line_id: number;
  purchase_id: number;
  supplier_id: number;
  supplier_name: string;
  total_cost: number;
  amount_paid: number;
}

// Settles open pieces — one or many, from any number of suppliers' purchases — in a single transaction, so a batch is all or
// nothing. "paid": we pay the supplier each piece's cost; the pieces of one purchase go in one supplier payment (and one cash-book
// line) so that purchase reads paid in the ledger. "returned": each piece goes back to the supplier and its purchase line is
// reduced by one. Neither changes the customer's sale, so a piece the customer didn't keep is refunded or voided from Sale History
// as usual.
function settleUnits(ids: number[], data: z.infer<typeof settleInput>, actor: ReturnType<typeof actorOf>) {
  const unique = [...new Set(ids)];
  const units = unique.map((id) => {
    const unit = db
      .prepare(
        `SELECT i.id, i.sku, i.status, i.cost_price, i.manual_resolution, pl.id AS line_id, pl.purchase_id,
                pu.supplier_id, s.name AS supplier_name, pu.total_cost, pu.amount_paid
         FROM inventory i
         JOIN pending_purchase_lines pl ON pl.id = i.manual_pending_line_id
         JOIN purchases pu ON pu.id = pl.purchase_id
         JOIN suppliers s ON s.id = pu.supplier_id
         WHERE i.id = ?`
      )
      .get(id) as OpenUnit | undefined;
    if (!unit) throw new ApiError(404, "That item wasn't found");
    if (unit.manual_resolution) throw new ApiError(409, `${unit.sku} is already settled as ${unit.manual_resolution}`);
    // A supplier return only makes sense once the piece is back with us: a customer return (status
    // 'removed') or one that was never sold. A piece the customer still holds ('sold') can't go back.
    if (data.resolution === "returned" && unit.status !== "removed") {
      throw new ApiError(409, `${unit.sku} is still with the customer — only a piece we have back can be returned to the supplier`);
    }
    return unit;
  });

  let total = 0;
  db.transaction(() => {
    if (data.resolution === "paid") {
      const byPurchase = new Map<number, OpenUnit[]>();
      for (const u of units) byPurchase.set(u.purchase_id, [...(byPurchase.get(u.purchase_id) ?? []), u]);

      for (const [purchaseId, group] of byPurchase) {
        const first = group[0];
        const amount = group.reduce((sum, u) => sum + (u.cost_price ?? 0), 0);
        const skus = group.map((u) => u.sku).join(", ");
        total += amount;

        const payment = db
          .prepare(
            `INSERT INTO supplier_payments (supplier_id, purchase_id, amount, method, is_partial, notes)
             VALUES (?, ?, ?, ?, 0, ?)`
          )
          .run(first.supplier_id, purchaseId, amount, data.payment_method, `Not in stock ${skus}${data.note ? ` — ${data.note}` : ""}`);

        db.prepare(
          `INSERT INTO cash_book (transaction_code, type, category, payment_method, reference_id, amount, notes)
           VALUES (?, 'expense', 'supplier_payment', ?, ?, ?, ?)`
        ).run(
          nextTransactionCode(),
          data.payment_method,
          payment.lastInsertRowid,
          amount,
          `Not in stock ${skus} paid to ${first.supplier_name}`
        );

        const paidSoFar = first.amount_paid + amount;
        const status = paidSoFar >= first.total_cost && first.total_cost > 0 ? "paid" : paidSoFar > 0 ? "partial" : "unpaid";
        db.prepare(`UPDATE purchases SET amount_paid = ?, payment_status = ? WHERE id = ?`).run(paidSoFar, status, purchaseId);

        for (const u of group) db.prepare(`UPDATE inventory SET manual_resolution = 'paid' WHERE id = ?`).run(u.id);
      }
    } else {
      for (const u of units) {
        db.prepare(
          `UPDATE inventory SET status = 'removed', removal_reason = 'Returned to supplier', removal_note = ?, manual_resolution = 'returned' WHERE id = ?`
        ).run(data.note ?? null, u.id);

        // The purchase owes one piece less now.
        db.prepare(`UPDATE pending_purchase_lines SET quantity = MAX(0, quantity - 1) WHERE id = ?`).run(u.line_id);
        const newTotal = db
          .prepare(`SELECT COALESCE(SUM(quantity * unit_cost), 0) AS total FROM pending_purchase_lines WHERE purchase_id = ?`)
          .get(u.purchase_id) as { total: number };
        const current = db.prepare(`SELECT amount_paid FROM purchases WHERE id = ?`).get(u.purchase_id) as { amount_paid: number };
        const status =
          current.amount_paid >= newTotal.total && newTotal.total > 0 ? "paid" : current.amount_paid > 0 ? "partial" : "unpaid";
        db.prepare(`UPDATE purchases SET total_cost = ?, payment_status = ? WHERE id = ?`).run(newTotal.total, status, u.purchase_id);
        total += u.cost_price ?? 0;
      }
    }
  })();

  const suppliers = [...new Set(units.map((u) => u.supplier_name))].join(", ");
  const pieces = `${units.length} piece${units.length === 1 ? "" : "s"}`;
  logAudit(
    actor,
    "borrowed_item_settled",
    "inventory",
    units[0].id,
    `${pieces} (${units.map((u) => u.sku).join(", ")}) ${data.resolution === "paid" ? `paid to ${suppliers}, Rs. ${total.toLocaleString()}` : `returned to ${suppliers}`}${
      data.note ? ` (${data.note})` : ""
    }`
  );

  return { count: units.length, total };
}

// Settle one open piece.
manualItemsRouter.post(
  "/:id/settle",
  requireAdminOrApproval("Settling a piece that was not in stock"),
  asyncHandler(async (req, res) => {
    const data = settleInput.parse(req.body);
    const result = settleUnits([Number(req.params.id)], data, actorOf(req));
    res.json({ ok: true, resolution: data.resolution, ...result });
  })
);

// Settle several at once — "pay Krishan for everything he lent today". One admin password covers the lot.
manualItemsRouter.post(
  "/settle-many",
  requireAdminOrApproval("Settling pieces that were not in stock"),
  asyncHandler(async (req, res) => {
    const data = settleManyInput.parse(req.body);
    const result = settleUnits(data.ids, data, actorOf(req));
    res.json({ ok: true, resolution: data.resolution, ...result });
  })
);
