import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";
import { logAudit } from "../lib/auditLog";

export const productsRouter = Router();

// Everyone using this API must be logged in; role checks happen per-route below.
productsRouter.use(requireAuth);

// Staff can view products (needed for POS) but never see cost_price —
// that's financial data reserved for admin.
function stripCostPriceIfStaff(req: any, row: any) {
  if (!row) return row;
  if (req.user?.role === "staff") {
    const { cost_price, ...rest } = row;
    return rest;
  }
  return row;
}

const productInput = z.object({
  product_title: z.string().min(1),
  brand: z.string().optional(),
  category: z.string().optional(),
  cost_price: z.number().nonnegative(),
  selling_price: z.number().nonnegative(),
  supplier_id: z.number().int().positive().optional(),
  image_path: z.string().optional(),
  is_public: z.boolean().optional(),
  allow_returns: z.boolean().optional(),
  product_type: z.enum(["FO", "OG", "OR", "OP", "IM"]).default("OG"),
});

// qty = live count of this product's available inventory rows
const QTY_SUBQUERY = `
  (SELECT COUNT(*) FROM inventory WHERE inventory.product_id = products.id AND inventory.status = 'available')
  AS qty
`;

// Below this many available units, a product (or category) is flagged
// low-stock in the UI. Kept as one shared constant so the threshold is
// consistent everywhere it's checked.
const LOW_STOCK_THRESHOLD = 5;

// GET /api/products — list all with live qty and supplier name.
// Staff see everything except cost_price.
productsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = db
      .prepare(
        `SELECT products.*, ${QTY_SUBQUERY}, suppliers.name as supplier_name, suppliers.supplier_code
         FROM products
         LEFT JOIN suppliers ON suppliers.id = products.supplier_id
         ORDER BY products.id DESC`
      )
      .all();
    res.json(rows.map((row) => stripCostPriceIfStaff(req, row)));
  })
);

// GET /api/products/low-stock-by-category — total available units summed
// per category (the part before " / " in the stored category string),
// so a category can be flagged low even when no single product in it is
// critically low on its own.
productsRouter.get(
  "/low-stock-by-category",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT products.category as raw_category, ${QTY_SUBQUERY}
         FROM products`
      )
      .all() as { raw_category: string | null; qty: number }[];

    const totals = new Map<string, number>();
    for (const row of rows) {
      if (!row.raw_category) continue;
      const category = row.raw_category.split(" / ")[0].trim();
      totals.set(category, (totals.get(category) ?? 0) + row.qty);
    }

    const result = Array.from(totals.entries())
      .map(([category, total_available]) => ({
        category,
        total_available,
        low_stock: total_available < LOW_STOCK_THRESHOLD,
      }))
      .sort((a, b) => a.category.localeCompare(b.category));

    res.json(result);
  })
);

// GET /api/products/check-title?title=... — used by Add Product to warn
// if a product with this exact title already exists, so the person can
// use "add to existing product" (restock) instead of creating a duplicate.
productsRouter.get(
  "/check-title",
  asyncHandler(async (req, res) => {
    const title = String(req.query.title ?? "").trim();
    if (!title) return res.json({ exists: false });

    const existing = db
      .prepare(`SELECT id, product_title FROM products WHERE LOWER(product_title) = LOWER(?)`)
      .get(title);

    res.json({ exists: !!existing, product: existing ?? null });
  })
);

// GET /api/products/:id/sales — admin-only. Every piece of this product that
// has been sold, newest first: the invoice and date it went out on, which
// size/colour, who bought it and what that piece sold for. A voided sale or a
// returned piece stays in the list (flagged) so the history is complete, but
// only live ones are counted in the totals.
productsRouter.get(
  "/:id/sales",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const product = db.prepare(`SELECT id, product_title FROM products WHERE id = ?`).get(req.params.id) as
      | { id: number; product_title: string }
      | undefined;
    if (!product) throw new ApiError(404, "Product not found");

    const rows = db
      .prepare(
        `SELECT sale_items.id AS sale_item_id, sales.id AS sale_id, sales.invoice, sales.date, sales.sale_type,
                sales.is_voided, inventory.sku, inventory.size, inventory.color,
                sale_items.quantity, sale_items.unit_price, sale_items.line_total,
                customers.name AS customer_name,
                (SELECT COUNT(*) FROM returns WHERE returns.sale_item_id = sale_items.id) AS is_returned
         FROM sale_items
         JOIN inventory ON inventory.id = sale_items.inventory_id
         JOIN sales ON sales.id = sale_items.sale_id
         LEFT JOIN customers ON customers.id = sales.customer_id
         WHERE inventory.product_id = ? AND sales.status <> 'quotation'
         ORDER BY sales.date DESC, sale_items.id DESC`
      )
      .all(product.id) as { quantity: number; line_total: number; is_voided: number; is_returned: number }[];

    const live = rows.filter((r) => !r.is_voided && !r.is_returned);
    res.json({
      product,
      rows,
      pieces: live.reduce((sum, r) => sum + r.quantity, 0),
      amount: live.reduce((sum, r) => sum + r.line_total, 0),
    });
  })
);

// GET /api/products/:id
productsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = db
      .prepare(
        `SELECT products.*, ${QTY_SUBQUERY}, suppliers.name as supplier_name, suppliers.supplier_code
         FROM products
         LEFT JOIN suppliers ON suppliers.id = products.supplier_id
         WHERE products.id = ?`
      )
      .get(req.params.id);
    if (!row) throw new ApiError(404, "Product not found");
    res.json(stripCostPriceIfStaff(req, row));
  })
);

// Everything below (create/update/delete) is admin-only.
productsRouter.use(requireRole("admin"));

// POST /api/products — create a new product style
productsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = productInput.parse(req.body);

    const result = db
      .prepare(
        `INSERT INTO products (product_title, brand, category, cost_price, selling_price, supplier_id, image_path, is_public, allow_returns, product_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.product_title,
        data.brand ?? null,
        data.category ?? null,
        data.cost_price,
        data.selling_price,
        data.supplier_id ?? null,
        data.image_path ?? null,
        data.is_public === false ? 0 : 1,
        data.allow_returns === false ? 0 : 1,
        data.product_type
      );

    const created = db.prepare(`SELECT * FROM products WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(created);
  })
);

// PUT /api/products/:id — update
productsRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const data = productInput.partial().parse(req.body);
    // Every piece of stock remembers the price IT was stocked at (two batches
    // can differ), so changing the product's price alone leaves units already
    // in stock untouched. apply_to_stock also sets the new price on the units
    // still available — never on ones already sold.
    const { apply_to_stock } = z.object({ apply_to_stock: z.boolean().optional() }).parse(req.body);
    const existing = db.prepare(`SELECT * FROM products WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Product not found");

    const merged = { ...existing, ...data };
    let unitsUpdated = 0;
    db.transaction(() => {
      db.prepare(
        `UPDATE products SET product_title = ?, brand = ?, category = ?, cost_price = ?,
         selling_price = ?, supplier_id = ?, image_path = ?, is_public = ?, allow_returns = ? WHERE id = ?`
      ).run(
        merged.product_title,
        merged.brand,
        merged.category,
        merged.cost_price,
        merged.selling_price,
        merged.supplier_id,
        merged.image_path,
        merged.is_public === false || merged.is_public === 0 ? 0 : 1,
        merged.allow_returns === false || merged.allow_returns === 0 ? 0 : 1,
        req.params.id
      );
      if (apply_to_stock && data.selling_price !== undefined) {
        unitsUpdated = db
          .prepare(`UPDATE inventory SET selling_price = ? WHERE product_id = ? AND status = 'available' AND COALESCE(selling_price, -1) <> ?`)
          .run(data.selling_price, req.params.id, data.selling_price).changes;
      }
    })();

    if (data.selling_price !== undefined && (data.selling_price !== existing.selling_price || unitsUpdated > 0)) {
      logAudit(
        req.user!,
        "product_price_change",
        "product",
        existing.id,
        `${merged.product_title}: selling price Rs. ${existing.selling_price.toLocaleString()} → Rs. ${data.selling_price.toLocaleString()}${
          apply_to_stock ? `, also set on ${unitsUpdated} unit${unitsUpdated === 1 ? "" : "s"} in stock` : " (units in stock keep their own prices)"
        }`
      );
    }

    const updated = db.prepare(`SELECT * FROM products WHERE id = ?`).get(req.params.id) as any;
    res.json({ ...updated, units_updated: unitsUpdated });
  })
);

// DELETE /api/products/:id — blocked if inventory units exist for it
productsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(req.params.id) as any;
    if (!product) throw new ApiError(404, "Product not found");

    // A confirmed, deliberate hard delete — the owner's own explicit
    // instruction: inventory and sales history no longer block this.
    // Purchase history is kept (never deleted), but detached via a
    // snapshot so it survives the product itself being gone. This is
    // NOT the same as the customer-deletion "warn then confirm" flow —
    // here the caller has already made the call, so this goes straight
    // through in one transaction.
    const runDelete = db.transaction(() => {
      // Snapshot this product's info onto every purchase_items row that
      // references it — real purchase/spend history, explicitly kept
      // per the owner's instruction, just no longer linked to a live
      // product row once this is done.
      const snapshot = `${product.product_title}${product.brand ? ` (${product.brand})` : ""}`;
      db.prepare(`UPDATE purchase_items SET product_snapshot = ? WHERE product_id = ?`).run(snapshot, req.params.id);
      db.prepare(`UPDATE purchase_items SET product_id = NULL WHERE product_id = ?`).run(req.params.id);

      // Every inventory unit under this product — for any that were
      // ever sold, snapshot enough onto the sale_item first (with its
      // actual size/color, since a sale can span several variants of
      // the same product) so the original receipt still reads
      // correctly once the unit itself is gone.
      const units = db.prepare(`SELECT * FROM inventory WHERE product_id = ?`).all(req.params.id) as any[];
      for (const unit of units) {
        const variantSnapshot = `${product.product_title}${unit.color || unit.size ? ` — ${[unit.color, unit.size].filter(Boolean).join(" / ")}` : ""}`;
        db.prepare(`UPDATE sale_items SET product_snapshot = ? WHERE inventory_id = ?`).run(variantSnapshot, unit.id);
      }

      // Now safe to delete every unit — sale_items.inventory_id cascades
      // to NULL automatically (ON DELETE SET NULL), same for any
      // return/exchange records still pointing at these units.
      db.prepare(`DELETE FROM inventory WHERE product_id = ?`).run(req.params.id);

      db.prepare(`DELETE FROM products WHERE id = ?`).run(req.params.id);
    });

    runDelete();

    logAudit(req.user!, "product_delete", "product", Number(req.params.id), `Deleted product ${product.product_title}`);

    res.status(204).send();
  })
);
