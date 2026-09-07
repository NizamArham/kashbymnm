import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { requireAuth, requireRole } from "../lib/auth";

export const businessInfoRouter = Router();

// Business settings — admin only.
businessInfoRouter.use(requireAuth, requireRole("admin"));

const infoInput = z.object({
  business_name: z.string().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  city: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  bank_name: z.string().optional(),
  bank_account_no: z.string().optional(),
  bank_account_name: z.string().optional(),
  notes: z.string().optional(),
});

// GET /api/business-info — there's only ever one row (id=1)
businessInfoRouter.get("/", (_req, res) => {
  const row = db.prepare(`SELECT * FROM business_info WHERE id = 1`).get();
  res.json(row ?? null);
});

// PUT /api/business-info — creates the single row if missing, otherwise updates it
businessInfoRouter.put("/", (req, res) => {
  const data = infoInput.parse(req.body);
  const existing = db.prepare(`SELECT * FROM business_info WHERE id = 1`).get() as any;

  if (!existing) {
    db.prepare(
      `INSERT INTO business_info (id, business_name, address_line1, address_line2, city, phone, email, bank_name, bank_account_no, bank_account_name, notes)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      data.business_name ?? null,
      data.address_line1 ?? null,
      data.address_line2 ?? null,
      data.city ?? null,
      data.phone ?? null,
      data.email ?? null,
      data.bank_name ?? null,
      data.bank_account_no ?? null,
      data.bank_account_name ?? null,
      data.notes ?? null
    );
  } else {
    const merged = { ...existing, ...data };
    db.prepare(
      `UPDATE business_info SET business_name = ?, address_line1 = ?, address_line2 = ?, city = ?,
       phone = ?, email = ?, bank_name = ?, bank_account_no = ?, bank_account_name = ?, notes = ?
       WHERE id = 1`
    ).run(
      merged.business_name,
      merged.address_line1,
      merged.address_line2,
      merged.city,
      merged.phone,
      merged.email,
      merged.bank_name,
      merged.bank_account_no,
      merged.bank_account_name,
      merged.notes
    );
  }

  const updated = db.prepare(`SELECT * FROM business_info WHERE id = 1`).get();
  res.json(updated);
});
