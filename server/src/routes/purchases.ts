import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { nextPurchaseCode, nextSku } from "../lib/codes";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const purchasesRouter = Router();

// Purchasing is financial/supplier data — admin only.
purchasesRouter.use(requireAuth, requireRole("admin"));

const purchaseItemInput = z.object({
  product_id: z.number().int().positive(),
  quantity: z.number().int().positive(),
  unit_cost: z.number().nonnegative(),
  // Per-unit selling price for THIS batch — lets the same product sell at
  // different prices across older/newer stock. Falls back to the
  // product's current selling_price if not given.
  unit_selling_price: z.number().nonnegative().optional(),
  size: z.string().optional(),
  color: z.string().optional(),
});

const purchaseInput = z.object({
  supplier_id: z.number().int().positive(),
  items: z.array(purchaseItemInput).min(1),
  amount_paid: z.number().nonnegative().default(0),
});

// Barcodes are generated server-side, continuing from the highest
// existing barcode in the whole system (barcodes are globally unique, not
// per-product) — so a restock never restarts at a random, disconnected
// number, and there's never a race between client-generated codes and
// what the database actually has.
const BARCODE_PREFIX = "890";

function nextBarcodeBatch(count: number): string[] {
  const row = db
    .prepare(`SELECT barcode FROM inventory WHERE barcode LIKE ? ORDER BY barcode DESC LIMIT 1`)
    .get(`${BARCODE_PREFIX}%`) as { barcode: string } | undefined;

  let nextNum = 100_000_000; // same starting range as the previous client-side generator
  if (row?.barcode) {
    const numericPart = row.barcode.slice(BARCODE_PREFIX.length);
    const parsed = parseInt(numericPart, 10);
    if (!isNaN(parsed)) nextNum = parsed + 1;
  }

  return Array.from({ length: count }, (_, i) => `${BARCODE_PREFIX}${String(nextNum + i).padStart(10, "0")}`);
}

// Sizes are normalized to uppercase before storage so "m" and "M" are
// always treated as the exact same size — otherwise they'd silently
// split into two different inventory groups.
function normalizeSize(size: string | undefined): string | null {
  if (!size) return null;
  return size.trim().toUpperCase();
}

function normalizeColor(color: string | undefined): string | null {
  if (!color) return null;
  // Title-case the color for consistency (Black, not black/BLACK) without
  // being as strict as uppercasing, since color names read better this way.
  const trimmed = color.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}


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
        const size = normalizeSize(item.size);
        const color = normalizeColor(item.color);

        db.prepare(
          `INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_cost, size, color)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(purchaseId, item.product_id, item.quantity, item.unit_cost, size, color);

        // Look up the product's current selling_price as the fallback for
        // this batch's unit_selling_price, and continue barcodes from
        // wherever the whole system last left off.
        const product = db
          .prepare(`SELECT selling_price FROM products WHERE id = ?`)
          .get(item.product_id) as { selling_price: number };
        const unitSellingPrice = item.unit_selling_price ?? product.selling_price;
        const barcodes = nextBarcodeBatch(item.quantity);

        // Generate one inventory row per physical unit received, each
        // carrying its OWN cost and selling price for this batch — so an
        // older-cost batch and a newer-cost batch of the same product can
        // sit in stock and sell at their own real prices simultaneously.
        for (let i = 0; i < item.quantity; i++) {
          const sku = nextSku(item.product_id);
          const invResult = db
            .prepare(
              `INSERT INTO inventory (product_id, size, color, sku, barcode, cost_price, selling_price, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'available')`
            )
            .run(item.product_id, size, color, sku, barcodes[i], item.unit_cost, unitSellingPrice);
          createdInventoryIds.push(Number(invResult.lastInsertRowid));
        }

        // The product's own cost_price/selling_price become "current" —
        // i.e. what shows as the default for the NEXT restock and in
        // product listings — reflecting this latest batch. Historical
        // units keep their own real cost/price regardless of this update.
        db.prepare(`UPDATE products SET cost_price = ?, selling_price = ? WHERE id = ?`).run(
          item.unit_cost,
          unitSellingPrice,
          item.product_id
        );
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
      note: "New inventory units created as 'available' with server-generated sequential barcodes and this batch's cost/selling price.",
    });
  })
);
