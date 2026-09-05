import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { nextCustomerCode } from "../lib/codes";
import { ApiError, asyncHandler } from "../lib/errors";

export const customersRouter = Router();

const customerInput = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
});

const addressInput = z.object({
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  city: z.string().optional(),
  is_default: z.boolean().optional(),
});

// loyalty_points = sum of loyalty_points_earned across their sales
// balance_due = sum of (total - amount_paid) across their sales
const CALC_SUBQUERY = `
  COALESCE((SELECT SUM(loyalty_points_earned) FROM sales WHERE customer_id = customers.id), 0) AS loyalty_points,
  COALESCE((SELECT SUM(total - amount_paid) FROM sales WHERE customer_id = customers.id), 0) AS balance_due
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
      .prepare(`INSERT INTO customers (customer_code, name, phone) VALUES (?, ?, ?)`)
      .run(customer_code, data.name, data.phone ?? null);

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
    db.prepare(`UPDATE customers SET name = ?, phone = ? WHERE id = ?`).run(
      merged.name,
      merged.phone,
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
