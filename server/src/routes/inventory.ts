import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { nextSku } from "../lib/codes";
import { ApiError, asyncHandler } from "../lib/errors";

export const inventoryRouter = Router();

const inventoryInput = z.object({
  product_id: z.number().int().positive(),
  size: z.string().optional(),
  color: z.string().optional(),
  barcode: z.string().optional(), // optional: scan a real barcode or let it be blank
});

// GET /api/inventory — list all units, optionally filtered by ?status= or ?product_id=
inventoryRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const conditions: string[] = [];
    const params: any[] = [];

    if (req.query.status) {
      conditions.push("inventory.status = ?");
      params.push(req.query.status);
    }
    if (req.query.product_id) {
      conditions.push("inventory.product_id = ?");
      params.push(req.query.product_id);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = db
      .prepare(
        `SELECT inventory.*, products.product_title, products.brand, products.selling_price
         FROM inventory
         JOIN products ON products.id = inventory.product_id
         ${where}
         ORDER BY inventory.id DESC`
      )
      .all(...params);

    res.json(rows);
  })
);

// GET /api/inventory/:id
inventoryRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = db
      .prepare(
        `SELECT inventory.*, products.product_title, products.brand, products.selling_price
         FROM inventory
         JOIN products ON products.id = inventory.product_id
         WHERE inventory.id = ?`
      )
      .get(req.params.id);
    if (!row) throw new ApiError(404, "Inventory unit not found");
    res.json(row);
  })
);

// GET /api/inventory/barcode/:barcode — for barcode-scanner lookups at POS
inventoryRouter.get(
  "/barcode/:barcode",
  asyncHandler(async (req, res) => {
    const row = db
      .prepare(
        `SELECT inventory.*, products.product_title, products.brand, products.selling_price
         FROM inventory
         JOIN products ON products.id = inventory.product_id
         WHERE inventory.barcode = ?`
      )
      .get(req.params.barcode);
    if (!row) throw new ApiError(404, "No inventory unit found with that barcode");
    res.json(row);
  })
);

// POST /api/inventory — add a single physical unit (also used internally when receiving a purchase)
inventoryRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = inventoryInput.parse(req.body);

    const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(data.product_id);
    if (!product) throw new ApiError(400, "Referenced product does not exist");

    const sku = nextSku(data.product_id);

    const result = db
      .prepare(
        `INSERT INTO inventory (product_id, size, color, sku, barcode, status)
         VALUES (?, ?, ?, ?, ?, 'available')`
      )
      .run(data.product_id, data.size ?? null, data.color ?? null, sku, data.barcode ?? null);

    const created = db.prepare(`SELECT * FROM inventory WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(created);
  })
);

// PUT /api/inventory/:id — edit size/color/barcode (not status — that's driven by sales)
inventoryRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const data = inventoryInput.partial().omit({ product_id: true }).parse(req.body);
    const existing = db.prepare(`SELECT * FROM inventory WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Inventory unit not found");

    const merged = { ...existing, ...data };
    db.prepare(`UPDATE inventory SET size = ?, color = ?, barcode = ? WHERE id = ?`).run(
      merged.size,
      merged.color,
      merged.barcode,
      req.params.id
    );

    const updated = db.prepare(`SELECT * FROM inventory WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// DELETE /api/inventory/:id — only allowed if never sold (no sale_items reference it)
inventoryRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM inventory WHERE id = ?`).get(req.params.id);
    if (!existing) throw new ApiError(404, "Inventory unit not found");

    const hasSale = db
      .prepare(`SELECT COUNT(*) as cnt FROM sale_items WHERE inventory_id = ?`)
      .get(req.params.id) as { cnt: number };

    if (hasSale.cnt > 0) {
      throw new ApiError(409, "Cannot delete an inventory unit that is part of a recorded sale.");
    }

    db.prepare(`DELETE FROM inventory WHERE id = ?`).run(req.params.id);
    res.status(204).send();
  })
);
