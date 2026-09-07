import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

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
        `INSERT INTO products (product_title, brand, category, cost_price, selling_price, supplier_id, image_path, is_public)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.product_title,
        data.brand ?? null,
        data.category ?? null,
        data.cost_price,
        data.selling_price,
        data.supplier_id ?? null,
        data.image_path ?? null,
        data.is_public === false ? 0 : 1
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
    const existing = db.prepare(`SELECT * FROM products WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Product not found");

    const merged = { ...existing, ...data };
    db.prepare(
      `UPDATE products SET product_title = ?, brand = ?, category = ?, cost_price = ?,
       selling_price = ?, supplier_id = ?, image_path = ?, is_public = ? WHERE id = ?`
    ).run(
      merged.product_title,
      merged.brand,
      merged.category,
      merged.cost_price,
      merged.selling_price,
      merged.supplier_id,
      merged.image_path,
      merged.is_public === false || merged.is_public === 0 ? 0 : 1,
      req.params.id
    );

    const updated = db.prepare(`SELECT * FROM products WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// DELETE /api/products/:id — blocked if inventory units exist for it
productsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM products WHERE id = ?`).get(req.params.id);
    if (!existing) throw new ApiError(404, "Product not found");

    const hasInventory = db
      .prepare(`SELECT COUNT(*) as cnt FROM inventory WHERE product_id = ?`)
      .get(req.params.id) as { cnt: number };

    if (hasInventory.cnt > 0) {
      throw new ApiError(
        409,
        "Cannot delete a product that has inventory units. Remove or reassign inventory first."
      );
    }

    db.prepare(`DELETE FROM products WHERE id = ?`).run(req.params.id);
    res.status(204).send();
  })
);
