import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";

export const productsRouter = Router();

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

// GET /api/products — list all with live qty and supplier name
productsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT products.*, ${QTY_SUBQUERY}, suppliers.name as supplier_name, suppliers.supplier_code
         FROM products
         LEFT JOIN suppliers ON suppliers.id = products.supplier_id
         ORDER BY products.id DESC`
      )
      .all();
    res.json(rows);
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
    res.json(row);
  })
);

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
