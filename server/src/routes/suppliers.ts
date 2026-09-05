import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { nextSupplierCode } from "../lib/codes";
import { ApiError, asyncHandler } from "../lib/errors";

export const suppliersRouter = Router();

const supplierInput = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  city: z.string().optional(),
  notes: z.string().optional(),
});

// balance_owed = total purchases from this supplier - total payments made
const BALANCE_SUBQUERY = `
  COALESCE((SELECT SUM(total_cost) FROM purchases WHERE supplier_id = suppliers.id), 0)
  -
  COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_id = suppliers.id), 0)
  AS balance_owed
`;

// GET /api/suppliers — list all, with live balance_owed
suppliersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(`SELECT suppliers.*, ${BALANCE_SUBQUERY} FROM suppliers ORDER BY id DESC`)
      .all();
    res.json(rows);
  })
);

// GET /api/suppliers/:id
suppliersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = db
      .prepare(`SELECT suppliers.*, ${BALANCE_SUBQUERY} FROM suppliers WHERE id = ?`)
      .get(req.params.id);
    if (!row) throw new ApiError(404, "Supplier not found");
    res.json(row);
  })
);

// POST /api/suppliers — create, auto-generating supplier_code
suppliersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = supplierInput.parse(req.body);
    const supplier_code = nextSupplierCode();

    const result = db
      .prepare(
        `INSERT INTO suppliers (supplier_code, name, phone, city, notes)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(supplier_code, data.name, data.phone ?? null, data.city ?? null, data.notes ?? null);

    const created = db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(created);
  })
);

// PUT /api/suppliers/:id — update editable fields (not the code)
suppliersRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const data = supplierInput.partial().parse(req.body);
    const existing = db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.id);
    if (!existing) throw new ApiError(404, "Supplier not found");

    const merged = { ...existing, ...data } as any;
    db.prepare(
      `UPDATE suppliers SET name = ?, phone = ?, city = ?, notes = ? WHERE id = ?`
    ).run(merged.name, merged.phone, merged.city, merged.notes, req.params.id);

    const updated = db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// DELETE /api/suppliers/:id — blocked if supplier has purchases/products (referential safety)
suppliersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.id);
    if (!existing) throw new ApiError(404, "Supplier not found");

    const hasProducts = db
      .prepare(`SELECT COUNT(*) as cnt FROM products WHERE supplier_id = ?`)
      .get(req.params.id) as { cnt: number };
    const hasPurchases = db
      .prepare(`SELECT COUNT(*) as cnt FROM purchases WHERE supplier_id = ?`)
      .get(req.params.id) as { cnt: number };

    if (hasProducts.cnt > 0 || hasPurchases.cnt > 0) {
      throw new ApiError(
        409,
        "Cannot delete supplier with existing products or purchases. Consider keeping the record for history."
      );
    }

    db.prepare(`DELETE FROM suppliers WHERE id = ?`).run(req.params.id);
    res.status(204).send();
  })
);
