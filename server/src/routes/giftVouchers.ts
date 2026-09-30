import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";
import { logAudit } from "../lib/auditLog";

export const giftVouchersRouter = Router();

// Admin-only, same access model as coupons — creating/editing a stored
// balance is a financial action.
giftVouchersRouter.use(requireAuth, requireRole("admin"));

const createInput = z.object({
  code: z.string().min(2),
  initial_value: z.number().positive(),
  validity_days: z.number().int().positive(),
  notes: z.string().optional(),
});

const editInput = z.object({
  remaining_value: z.number().min(0).optional(),
  validity_days: z.number().int().positive().optional(),
  is_enabled: z.boolean().optional(),
  notes: z.string().optional(),
});

// GET /api/gift-vouchers — admin-only: manage the list of codes
giftVouchersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db.prepare(`SELECT * FROM gift_vouchers ORDER BY id DESC`).all();
    res.json(rows);
  })
);

// POST /api/gift-vouchers — admin-only: print/issue a new voucher.
// Dormant on creation — activated_at and expires_at stay NULL until
// it's actually sold at POS (not wired up yet). remaining_value starts
// equal to initial_value.
giftVouchersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = createInput.parse(req.body);
    const code = data.code.trim().toUpperCase();

    const existing = db.prepare(`SELECT id FROM gift_vouchers WHERE code = ?`).get(code);
    if (existing) throw new ApiError(409, "A gift voucher with this code already exists");

    const result = db
      .prepare(
        `INSERT INTO gift_vouchers (code, initial_value, remaining_value, validity_days, notes)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(code, data.initial_value, data.initial_value, data.validity_days, data.notes ?? null);

    const created = db.prepare(`SELECT * FROM gift_vouchers WHERE id = ?`).get(result.lastInsertRowid);

    logAudit(
      req.user!,
      "gift_voucher_create",
      "gift_voucher",
      Number(result.lastInsertRowid),
      `Issued gift voucher ${code} (Rs. ${data.initial_value.toLocaleString()}, valid ${data.validity_days} days once sold)`
    );

    res.status(201).json(created);
  })
);

// PUT /api/gift-vouchers/:id — admin-only: edit a voucher (balance,
// validity, enabled state, notes). Code and initial_value are fixed
// once issued. Changing validity_days recomputes expires_at when the
// voucher has already been activated (e.g. to extend or shorten a
// live voucher); while still dormant it just changes what will be
// used once it's eventually sold.
giftVouchersRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM gift_vouchers WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Gift voucher not found");

    const data = editInput.parse(req.body);

    if (data.remaining_value !== undefined && data.remaining_value > existing.initial_value) {
      throw new ApiError(400, "Remaining value can't exceed the voucher's original value");
    }

    const validityDays = data.validity_days ?? existing.validity_days;

    // expires_at is only ever derived from activated_at + validity_days,
    // computed here in SQL (not JS Date math) so it stays in exactly the
    // same local-offset string form the rest of the schema uses — no
    // risk of drifting against the server's own system timezone.
    db.prepare(
      `UPDATE gift_vouchers
       SET remaining_value = ?, validity_days = ?,
           expires_at = CASE WHEN activated_at IS NOT NULL THEN datetime(activated_at, '+' || ? || ' days') ELSE NULL END,
           is_enabled = ?, notes = ?
       WHERE id = ?`
    ).run(
      data.remaining_value ?? existing.remaining_value,
      validityDays,
      validityDays,
      data.is_enabled === false ? 0 : data.is_enabled === true ? 1 : existing.is_enabled,
      data.notes !== undefined ? data.notes : existing.notes,
      req.params.id
    );

    logAudit(req.user!, "gift_voucher_edit", "gift_voucher", Number(req.params.id), `Edited gift voucher ${existing.code}`);

    const updated = db.prepare(`SELECT * FROM gift_vouchers WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// DELETE /api/gift-vouchers/:id — admin-only
giftVouchersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM gift_vouchers WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Gift voucher not found");

    db.prepare(`DELETE FROM gift_vouchers WHERE id = ?`).run(req.params.id);

    logAudit(
      req.user!,
      "gift_voucher_delete",
      "gift_voucher",
      Number(req.params.id),
      `Deleted gift voucher ${existing.code} (Rs. ${existing.remaining_value.toLocaleString()} remaining)`
    );

    res.status(204).send();
  })
);
