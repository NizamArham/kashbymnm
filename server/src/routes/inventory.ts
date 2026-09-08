import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { nextSku } from "../lib/codes";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const inventoryRouter = Router();

// Everyone using this API must be logged in.
inventoryRouter.use(requireAuth);

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
        `SELECT inventory.*, products.product_title, products.brand, products.category,
                products.selling_price AS product_selling_price,
                suppliers.id AS batch_supplier_id, suppliers.name AS batch_supplier_name
         FROM inventory
         JOIN products ON products.id = inventory.product_id
         LEFT JOIN purchase_items ON purchase_items.id = inventory.purchase_item_id
         LEFT JOIN purchases ON purchases.id = purchase_items.purchase_id
         LEFT JOIN suppliers ON suppliers.id = purchases.supplier_id
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
        `SELECT inventory.*, products.product_title, products.brand, products.category,
                products.selling_price AS product_selling_price
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
        `SELECT inventory.*, products.product_title, products.brand, products.category,
                products.selling_price AS product_selling_price
         FROM inventory
         JOIN products ON products.id = inventory.product_id
         WHERE inventory.barcode = ?`
      )
      .get(req.params.barcode);
    if (!row) throw new ApiError(404, "No inventory unit found with that barcode");
    res.json(row);
  })
);

// Everything below (add/edit/delete units) is admin-only — staff can view
// and sell via POS, but not manage inventory records directly.
inventoryRouter.use(requireRole("admin"));

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

const removalReasons = ["Damaged", "Gifted", "Staff Use", "Stolen", "Lost", "Other"] as const;

const removalInput = z.object({
  reason: z.enum(removalReasons),
  note: z.string().optional(),
});

// PUT /api/inventory/:id/remove — take one specific unit out of sellable
// stock for a non-sale reason (damage, gift, staff use, theft, loss, etc).
// The unit's status becomes a reason-specific value so it's never confused
// with a real sale, and the reason + note are kept permanently for that
// unit's record.
inventoryRouter.put(
  "/:id/remove",
  asyncHandler(async (req, res) => {
    const data = removalInput.parse(req.body);
    const existing = db.prepare(`SELECT * FROM inventory WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Inventory unit not found");

    if (existing.status !== "available") {
      throw new ApiError(409, `This unit is already ${existing.status} — only available units can be removed.`);
    }

    // Map the reason to a storable status. Damage keeps the existing
    // 'damaged' status (already used elsewhere, e.g. returns); the rest
    // map onto their own explicit statuses, with 'Staff Use'/'Other'
    // sharing the general 'removed' status since neither is a distinct
    // stock-tracking category on its own.
    const statusByReason: Record<(typeof removalReasons)[number], string> = {
      Damaged: "damaged",
      Gifted: "gifted",
      Stolen: "stolen",
      Lost: "lost",
      "Staff Use": "removed",
      Other: "removed",
    };

    db.prepare(
      `UPDATE inventory SET status = ?, removal_reason = ?, removal_note = ? WHERE id = ?`
    ).run(statusByReason[data.reason], data.reason, data.note ?? null, req.params.id);

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
