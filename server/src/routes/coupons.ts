import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const couponsRouter = Router();

couponsRouter.use(requireAuth);

const couponInput = z.object({
  code: z.string().min(2),
  discount_type: z.enum(["percent", "fixed"]),
  discount_value: z.number().positive(),
  is_active: z.boolean().default(true),
  expires_at: z.string().optional(),
});

// GET /api/coupons — admin-only: manage the list of codes
couponsRouter.get(
  "/",
  requireRole("admin"),
  asyncHandler(async (_req, res) => {
    const rows = db.prepare(`SELECT * FROM coupons ORDER BY id DESC`).all();
    res.json(rows);
  })
);

// POST /api/coupons — admin-only: create a new code
couponsRouter.post(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const data = couponInput.parse(req.body);
    const code = data.code.trim().toUpperCase();

    const existing = db.prepare(`SELECT id FROM coupons WHERE code = ?`).get(code);
    if (existing) throw new ApiError(409, "A coupon with this code already exists");

    const result = db
      .prepare(
        `INSERT INTO coupons (code, discount_type, discount_value, is_active, expires_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(code, data.discount_type, data.discount_value, data.is_active ? 1 : 0, data.expires_at ?? null);

    const created = db.prepare(`SELECT * FROM coupons WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(created);
  })
);

// PUT /api/coupons/:id — admin-only: edit a code (e.g. deactivate it)
couponsRouter.put(
  "/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM coupons WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Coupon not found");

    const data = couponInput.partial().parse(req.body);
    const merged = { ...existing, ...data };

    db.prepare(
      `UPDATE coupons SET discount_type = ?, discount_value = ?, is_active = ?, expires_at = ? WHERE id = ?`
    ).run(
      merged.discount_type,
      merged.discount_value,
      merged.is_active === false || merged.is_active === 0 ? 0 : 1,
      merged.expires_at,
      req.params.id
    );

    const updated = db.prepare(`SELECT * FROM coupons WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// DELETE /api/coupons/:id — admin-only
couponsRouter.delete(
  "/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT id FROM coupons WHERE id = ?`).get(req.params.id);
    if (!existing) throw new ApiError(404, "Coupon not found");
    db.prepare(`DELETE FROM coupons WHERE id = ?`).run(req.params.id);
    res.status(204).send();
  })
);

// GET /api/coupons/validate/:code — POS calls this to check a code before
// applying it. Open to staff (not admin-only), since applying a coupon
// at checkout is a normal cashier action.
couponsRouter.get(
  "/validate/:code",
  asyncHandler(async (req, res) => {
    const code = req.params.code.trim().toUpperCase();
    const coupon = db.prepare(`SELECT * FROM coupons WHERE code = ?`).get(code) as any;

    if (!coupon) throw new ApiError(404, "No coupon with that code");
    if (!coupon.is_active) throw new ApiError(400, "This coupon is no longer active");
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      throw new ApiError(400, "This coupon has expired");
    }

    res.json(coupon);
  })
);
