import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { nextCustomerCode } from "../lib/codes";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth } from "../lib/auth";

export const customersRouter = Router();

// Both admin and staff can view/create/manage customers — no role
// restriction needed here beyond being logged in at all.
customersRouter.use(requireAuth);

const customerInput = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  phone2: z.string().optional(),
  bonus_points: z.number().int().nonnegative().optional(),
});

const addressInput = z.object({
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  city: z.string().optional(),
  is_default: z.boolean().optional(),
});

// loyalty_points = bonus_points (manually granted, kept for backward
// compatibility with the legacy-customer import) + sum of every real
// loyalty_transactions entry (earned, granted, redeemed, or reversed).
// balance_due = sum of (total - amount_paid) across their sales
// last_order_date = most recent sale date, so repeat customers are easy
// to spot at a glance without opening their full sale history
// A voided sale contributes to none of these — it's kept for audit but
// otherwise treated as if it never happened.
const CALC_SUBQUERY = `
  customers.bonus_points +
  COALESCE((SELECT SUM(points) FROM loyalty_transactions WHERE customer_id = customers.id), 0) AS loyalty_points,
  COALESCE((SELECT SUM(total - amount_paid) FROM sales WHERE customer_id = customers.id AND is_voided = 0), 0) AS balance_due,
  (SELECT MAX(date) FROM sales WHERE customer_id = customers.id AND is_voided = 0) AS last_order_date
`;

// GET /api/customers
customersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(`SELECT customers.*, ${CALC_SUBQUERY} FROM customers ORDER BY id DESC`)
      .all();
    res.json(rows);
  })
);

// GET /api/customers/check-phone?phone=... — used by Add Customer to warn
// if this phone number (checked against BOTH phone and phone2) already
// belongs to an existing customer, avoiding accidental duplicate entries.
customersRouter.get(
  "/check-phone",
  asyncHandler(async (req, res) => {
    const phone = String(req.query.phone ?? "").trim();
    if (!phone) return res.json({ exists: false });

    const existing = db
      .prepare(`SELECT id, name, customer_code FROM customers WHERE phone = ? OR phone2 = ?`)
      .get(phone, phone);

    res.json({ exists: !!existing, customer: existing ?? null });
  })
);

// GET /api/customers/:id — includes their saved addresses
customersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const customer = db
      .prepare(`SELECT customers.*, ${CALC_SUBQUERY} FROM customers WHERE id = ?`)
      .get(req.params.id) as any;
    if (!customer) throw new ApiError(404, "Customer not found");

    const addresses = db
      .prepare(`SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, id ASC`)
      .all(req.params.id);

    res.json({ ...customer, addresses });
  })
);

// POST /api/customers — auto-generates customer_code
customersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = customerInput.parse(req.body);
    const customer_code = nextCustomerCode();

    const result = db
      .prepare(`INSERT INTO customers (customer_code, name, phone, phone2, bonus_points) VALUES (?, ?, ?, ?, ?)`)
      .run(customer_code, data.name, data.phone ?? null, data.phone2 ?? null, data.bonus_points ?? 0);

    const created = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(created);
  })
);

// PUT /api/customers/:id
customersRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const data = customerInput.partial().parse(req.body);
    const existing = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Customer not found");

    const merged = { ...existing, ...data };
    db.prepare(`UPDATE customers SET name = ?, phone = ?, phone2 = ? WHERE id = ?`).run(
      merged.name,
      merged.phone,
      merged.phone2,
      req.params.id
    );

    const updated = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// DELETE /api/customers/:id — blocked if they have sales history
customersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id);
    if (!existing) throw new ApiError(404, "Customer not found");

    const hasSales = db
      .prepare(`SELECT COUNT(*) as cnt FROM sales WHERE customer_id = ?`)
      .get(req.params.id) as { cnt: number };

    if (hasSales.cnt > 0) {
      throw new ApiError(409, "Cannot delete a customer with sales history.");
    }

    db.prepare(`DELETE FROM customers WHERE id = ?`).run(req.params.id);
    res.status(204).send();
  })
);

// ---- Nested addresses ----

// POST /api/customers/:id/addresses — add a new saved address
customersRouter.post(
  "/:id/addresses",
  asyncHandler(async (req, res) => {
    const customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id);
    if (!customer) throw new ApiError(404, "Customer not found");

    const data = addressInput.parse(req.body);
    const isDefault = data.is_default ? 1 : 0;

    // If this one is marked default, clear default flag on any others first
    if (isDefault) {
      db.prepare(`UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?`).run(
        req.params.id
      );
    }

    const result = db
      .prepare(
        `INSERT INTO customer_addresses (customer_id, address_line1, address_line2, city, is_default)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(req.params.id, data.address_line1 ?? null, data.address_line2 ?? null, data.city ?? null, isDefault);

    const created = db
      .prepare(`SELECT * FROM customer_addresses WHERE id = ?`)
      .get(result.lastInsertRowid);
    res.status(201).json(created);
  })
);

// PUT /api/customers/:id/addresses/:addressId
customersRouter.put(
  "/:id/addresses/:addressId",
  asyncHandler(async (req, res) => {
    const existing = db
      .prepare(`SELECT * FROM customer_addresses WHERE id = ? AND customer_id = ?`)
      .get(req.params.addressId, req.params.id) as any;
    if (!existing) throw new ApiError(404, "Address not found for this customer");

    const data = addressInput.partial().parse(req.body);
    const merged = { ...existing, ...data };
    const isDefault = merged.is_default ? 1 : 0;

    if (isDefault) {
      db.prepare(
        `UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ? AND id != ?`
      ).run(req.params.id, req.params.addressId);
    }

    db.prepare(
      `UPDATE customer_addresses SET address_line1 = ?, address_line2 = ?, city = ?, is_default = ? WHERE id = ?`
    ).run(merged.address_line1, merged.address_line2, merged.city, isDefault, req.params.addressId);

    const updated = db
      .prepare(`SELECT * FROM customer_addresses WHERE id = ?`)
      .get(req.params.addressId);
    res.json(updated);
  })
);

// DELETE /api/customers/:id/addresses/:addressId
customersRouter.delete(
  "/:id/addresses/:addressId",
  asyncHandler(async (req, res) => {
    const existing = db
      .prepare(`SELECT * FROM customer_addresses WHERE id = ? AND customer_id = ?`)
      .get(req.params.addressId, req.params.id);
    if (!existing) throw new ApiError(404, "Address not found for this customer");

    const usedInDelivery = db
      .prepare(`SELECT COUNT(*) as cnt FROM deliveries WHERE address_id = ?`)
      .get(req.params.addressId) as { cnt: number };

    if (usedInDelivery.cnt > 0) {
      throw new ApiError(409, "Cannot delete an address that has been used in a delivery.");
    }

    db.prepare(`DELETE FROM customer_addresses WHERE id = ?`).run(req.params.addressId);
    res.status(204).send();
  })
);

// GET /api/customers/:id/loyalty-history — the real transaction ledger
// behind a customer's point balance: every sale that earned points,
// every manual grant, every reversal — not just the computed total.
customersRouter.get(
  "/:id/loyalty-history",
  asyncHandler(async (req, res) => {
    const customer = db.prepare(`SELECT id FROM customers WHERE id = ?`).get(req.params.id);
    if (!customer) throw new ApiError(404, "Customer not found");

    const rows = db
      .prepare(`SELECT * FROM loyalty_transactions WHERE customer_id = ? ORDER BY id DESC`)
      .all(req.params.id);

    res.json(rows);
  })
);
