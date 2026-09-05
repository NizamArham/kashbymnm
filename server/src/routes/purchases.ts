import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { nextPurchaseCode, nextSku } from "../lib/codes";
import { ApiError, asyncHandler } from "../lib/errors";

export const purchasesRouter = Router();

const purchaseItemInput = z.object({
  product_id: z.number().int().positive(),
  quantity: z.number().int().positive(),
  unit_cost: z.number().nonnegative(),
});

const purchaseInput = z.object({
  supplier_id: z.number().int().positive(),
  items: z.array(purchaseItemInput).min(1),
  amount_paid: z.number().nonnegative().default(0),
});

// GET /api/purchases
purchasesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT purchases.*, suppliers.name as supplier_name, suppliers.supplier_code
         FROM purchases
         JOIN suppliers ON suppliers.id = purchases.supplier_id
         ORDER BY purchases.id DESC`
      )
      .all();
    res.json(rows);
  })
);

// GET /api/purchases/:id — includes line items
purchasesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const purchase = db
      .prepare(
        `SELECT purchases.*, suppliers.name as supplier_name
         FROM purchases JOIN suppliers ON suppliers.id = purchases.supplier_id
         WHERE purchases.id = ?`
      )
      .get(req.params.id);
    if (!purchase) throw new ApiError(404, "Purchase not found");

    const items = db
      .prepare(
        `SELECT purchase_items.*, products.product_title
         FROM purchase_items JOIN products ON products.id = purchase_items.product_id
         WHERE purchase_items.purchase_id = ?`
      )
      .all(req.params.id);

    res.json({ ...purchase, items });
  })
);

// POST /api/purchases — record stock received. This is a transaction:
// it creates the purchase, its line items, AND one new inventory row per
// unit received (quantity=3 -> 3 new inventory rows, ready for you to
// assign size/color/barcode afterward via PUT /api/inventory/:id).
purchasesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = purchaseInput.parse(req.body);

    const supplier = db.prepare(`SELECT id FROM suppliers WHERE id = ?`).get(data.supplier_id);
    if (!supplier) throw new ApiError(400, "Referenced supplier does not exist");

    for (const item of data.items) {
      const product = db.prepare(`SELECT id FROM products WHERE id = ?`).get(item.product_id);
      if (!product) throw new ApiError(400, `Product ${item.product_id} does not exist`);
    }

    const total_cost = data.items.reduce((sum, item) => sum + item.unit_cost * item.quantity, 0);
    let payment_status: "paid" | "partial" | "unpaid" = "unpaid";
    if (data.amount_paid >= total_cost && total_cost > 0) payment_status = "paid";
    else if (data.amount_paid > 0) payment_status = "partial";

    const purchase_code = nextPurchaseCode();

    const createdInventoryIds: number[] = [];

    const runPurchaseTransaction = db.transaction(() => {
      const purchaseResult = db
        .prepare(
          `INSERT INTO purchases (purchase_code, supplier_id, total_cost, amount_paid, payment_status)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(purchase_code, data.supplier_id, total_cost, data.amount_paid, payment_status);

      const purchaseId = purchaseResult.lastInsertRowid;

      for (const item of data.items) {
        db.prepare(
          `INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_cost)
           VALUES (?, ?, ?, ?)`
        ).run(purchaseId, item.product_id, item.quantity, item.unit_cost);

        // Generate one inventory row per physical unit received.
        for (let i = 0; i < item.quantity; i++) {
          const sku = nextSku(item.product_id);
          const invResult = db
            .prepare(
              `INSERT INTO inventory (product_id, sku, status) VALUES (?, ?, 'available')`
            )
            .run(item.product_id, sku);
          createdInventoryIds.push(Number(invResult.lastInsertRowid));
        }
      }

      if (data.amount_paid > 0) {
        db.prepare(
          `INSERT INTO cash_book (type, category, reference_id, amount, notes)
           VALUES ('expense', 'purchase', ?, ?, ?)`
        ).run(purchaseId, data.amount_paid, `Payment for purchase ${purchase_code}`);

        db.prepare(
          `INSERT INTO supplier_payments (supplier_id, purchase_id, amount, is_partial, notes)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          data.supplier_id,
          purchaseId,
          data.amount_paid,
          payment_status === "partial" ? 1 : 0,
          `Payment recorded at time of purchase ${purchase_code}`
        );
      }

      return purchaseId;
    });

    const purchaseId = runPurchaseTransaction();

    const created = db
      .prepare(
        `SELECT purchases.*, suppliers.name as supplier_name
         FROM purchases JOIN suppliers ON suppliers.id = purchases.supplier_id
         WHERE purchases.id = ?`
      )
      .get(purchaseId);

    res.status(201).json({
      ...(created as object),
      new_inventory_ids: createdInventoryIds,
      note: "New inventory units created as 'available' with auto-generated SKUs. Edit each to assign size/color/barcode.",
    });
  })
);
