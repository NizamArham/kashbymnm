import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";

export const deliveriesRouter = Router();

const deliveryInput = z.object({
  sale_id: z.number().int().positive(),
  address_id: z.number().int().positive().optional(),
  courier_name: z.string().optional(),
  tracking_number: z.string().optional(),
  delivery_fee: z.number().nonnegative().default(0),
  notes: z.string().optional(),
});

const statusInput = z.object({
  delivery_status: z.enum(["pending", "shipped", "delivered", "returned"]),
  delivery_date: z.string().optional(),
});

// GET /api/deliveries — optionally filter by ?status=
deliveriesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const where = req.query.status ? "WHERE deliveries.delivery_status = ?" : "";
    const params = req.query.status ? [req.query.status] : [];

    const rows = db
      .prepare(
        `SELECT deliveries.*, sales.invoice, customer_addresses.address_line1, customer_addresses.city
         FROM deliveries
         JOIN sales ON sales.id = deliveries.sale_id
         LEFT JOIN customer_addresses ON customer_addresses.id = deliveries.address_id
         ${where}
         ORDER BY deliveries.id DESC`
      )
      .all(...params);
    res.json(rows);
  })
);

// GET /api/deliveries/:id
deliveriesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = db
      .prepare(
        `SELECT deliveries.*, sales.invoice, customer_addresses.address_line1,
                customer_addresses.address_line2, customer_addresses.city
         FROM deliveries
         JOIN sales ON sales.id = deliveries.sale_id
         LEFT JOIN customer_addresses ON customer_addresses.id = deliveries.address_id
         WHERE deliveries.id = ?`
      )
      .get(req.params.id);
    if (!row) throw new ApiError(404, "Delivery not found");
    res.json(row);
  })
);

// POST /api/deliveries — create a delivery record for a sale
deliveriesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = deliveryInput.parse(req.body);

    const sale = db.prepare(`SELECT id FROM sales WHERE id = ?`).get(data.sale_id);
    if (!sale) throw new ApiError(400, "Referenced sale does not exist");

    if (data.address_id) {
      const address = db
        .prepare(`SELECT id FROM customer_addresses WHERE id = ?`)
        .get(data.address_id);
      if (!address) throw new ApiError(400, "Referenced address does not exist");
    }

    const result = db
      .prepare(
        `INSERT INTO deliveries (sale_id, address_id, courier_name, tracking_number, delivery_fee, notes)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.sale_id,
        data.address_id ?? null,
        data.courier_name ?? null,
        data.tracking_number ?? null,
        data.delivery_fee,
        data.notes ?? null
      );

    const created = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(created);
  })
);

// PUT /api/deliveries/:id/status — update delivery status (pending -> shipped -> delivered/returned)
deliveriesRouter.put(
  "/:id/status",
  asyncHandler(async (req, res) => {
    const data = statusInput.parse(req.body);
    const existing = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id);
    if (!existing) throw new ApiError(404, "Delivery not found");

    db.prepare(`UPDATE deliveries SET delivery_status = ?, delivery_date = ? WHERE id = ?`).run(
      data.delivery_status,
      data.delivery_date ?? (data.delivery_status === "delivered" ? new Date().toISOString() : null),
      req.params.id
    );

    const updated = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);
