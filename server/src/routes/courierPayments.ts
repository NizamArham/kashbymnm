import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";

export const courierPaymentsRouter = Router();

const paymentInput = z.object({
  courier_name: z.string().optional(),
  delivery_id: z.number().int().positive().optional(),
  amount: z.number().positive(),
  notes: z.string().optional(),
});

// GET /api/courier-payments
courierPaymentsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT courier_payments.*, deliveries.tracking_number, sales.invoice
         FROM courier_payments
         LEFT JOIN deliveries ON deliveries.id = courier_payments.delivery_id
         LEFT JOIN sales ON sales.id = deliveries.sale_id
         ORDER BY courier_payments.id DESC`
      )
      .all();
    res.json(rows);
  })
);

// POST /api/courier-payments — record a payment to a courier
courierPaymentsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = paymentInput.parse(req.body);

    if (data.delivery_id) {
      const delivery = db
        .prepare(`SELECT id FROM deliveries WHERE id = ?`)
        .get(data.delivery_id);
      if (!delivery) throw new ApiError(400, "Referenced delivery does not exist");
    }

    const runTransaction = db.transaction(() => {
      const result = db
        .prepare(
          `INSERT INTO courier_payments (courier_name, delivery_id, amount, notes)
           VALUES (?, ?, ?, ?)`
        )
        .run(data.courier_name ?? null, data.delivery_id ?? null, data.amount, data.notes ?? null);

      db.prepare(
        `INSERT INTO cash_book (type, category, reference_id, amount, notes)
         VALUES ('expense', 'courier_payment', ?, ?, ?)`
      ).run(result.lastInsertRowid, data.amount, data.notes ?? "Courier payment");

      return result.lastInsertRowid;
    });

    const id = runTransaction();
    const created = db.prepare(`SELECT * FROM courier_payments WHERE id = ?`).get(id);
    res.status(201).json(created);
  })
);
