import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";
import { logAudit } from "../lib/auditLog";
import { getPartner } from "../lib/deliveryPartners";

export const deliveryPartnersRouter = Router();

// Anyone logged in can READ the list — POS (staff included) needs it to
// offer a delivery partner on an online order. Only admins change it.
deliveryPartnersRouter.use(requireAuth);

const partnerFields = {
  name: z.string().trim().min(1, "Enter a name"),
  kind: z.enum(["courier", "on_demand"]),
  waybill_code: z.string().trim().optional(),
  tracking_url_template: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || v.includes("{tracking}"), "The tracking link must contain {tracking} where the number goes"),
  base_fee: z.number().nonnegative().default(450),
  extra_kg_fee: z.number().nonnegative().default(100),
  is_active: z.boolean().default(true),
};

const createInput = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,8}$/, "Code must be 2–8 letters or numbers, e.g. FDR"),
  ...partnerFields,
});
const updateInput = z.object(partnerFields);

// GET /api/delivery-partners — every partner (active or not), in the
// order the admin arranged them. Callers that offer a choice (POS)
// filter to is_active themselves; history pages need the inactive ones
// too, so an old delivery still shows its partner's real name.
deliveryPartnersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(db.prepare(`SELECT * FROM delivery_partners ORDER BY sort_order, name`).all());
  })
);

deliveryPartnersRouter.post(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const data = createInput.parse(req.body);
    if (getPartner(data.code)) throw new ApiError(409, `A delivery partner with code ${data.code} already exists`);

    const { next } = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM delivery_partners`).get() as { next: number };
    db.prepare(
      `INSERT INTO delivery_partners (code, name, kind, waybill_code, tracking_url_template, base_fee, extra_kg_fee, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      data.code,
      data.name,
      data.kind,
      data.waybill_code || `MNM X ${data.code}`,
      data.tracking_url_template || null,
      data.base_fee,
      data.extra_kg_fee,
      data.is_active ? 1 : 0,
      next
    );

    logAudit(req.user!, "delivery_partner_create", "delivery_partner", null, `Added delivery partner ${data.name} [${data.code}]`);
    res.status(201).json(getPartner(data.code));
  })
);

// The code is permanent — past deliveries and courier settlements refer
// to it — so only everything else is editable. Partners are never
// deleted either; switching one off just hides it from new orders.
deliveryPartnersRouter.put(
  "/:code",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const existing = getPartner(req.params.code);
    if (!existing) throw new ApiError(404, "Delivery partner not found");
    const data = updateInput.parse(req.body);

    db.prepare(
      `UPDATE delivery_partners
       SET name = ?, kind = ?, waybill_code = ?, tracking_url_template = ?, base_fee = ?, extra_kg_fee = ?, is_active = ?
       WHERE code = ?`
    ).run(
      data.name,
      data.kind,
      data.waybill_code || `MNM X ${existing.code}`,
      data.tracking_url_template || null,
      data.base_fee,
      data.extra_kg_fee,
      data.is_active ? 1 : 0,
      existing.code
    );

    logAudit(
      req.user!,
      "delivery_partner_edit",
      "delivery_partner",
      null,
      `Edited delivery partner ${data.name} [${existing.code}]${existing.is_active && !data.is_active ? " — deactivated" : ""}${
        !existing.is_active && data.is_active ? " — reactivated" : ""
      }`
    );
    res.json(getPartner(existing.code));
  })
);
