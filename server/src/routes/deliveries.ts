import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const deliveriesRouter = Router();

// Admin only, per the access model (staff don't handle courier/delivery logistics).
deliveriesRouter.use(requireAuth, requireRole("admin"));

const deliveryInput = z.object({
  sale_id: z.number().int().positive(),
  address_id: z.number().int().positive().optional(),
  courier_name: z.string().optional(),
  tracking_number: z.string().optional(),
  delivery_fee: z.number().nonnegative().default(0),
  notes: z.string().optional(),
});

function nextWaybillNumber(): string {
  const row = db
    .prepare(`SELECT waybill_number FROM deliveries WHERE waybill_number LIKE 'WB-%' ORDER BY id DESC LIMIT 1`)
    .get() as { waybill_number: string } | undefined;
  let nextNum = 1;
  if (row?.waybill_number) {
    const num = parseInt(row.waybill_number.split("-")[1], 10);
    if (!isNaN(num)) nextNum = num + 1;
  }
  return `WB-${String(nextNum).padStart(5, "0")}`;
}

// GET /api/deliveries — optionally filter by ?status=
deliveriesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const where = req.query.status ? "WHERE deliveries.delivery_status = ?" : "";
    const params = req.query.status ? [req.query.status] : [];

    const rows = db
      .prepare(
        `SELECT deliveries.*, sales.invoice, sales.date as sale_date, sales.total as sale_total,
                customers.name as customer_name, customers.phone as customer_phone,
                customer_addresses.address_line1, customer_addresses.address_line2, customer_addresses.city
         FROM deliveries
         JOIN sales ON sales.id = deliveries.sale_id
         LEFT JOIN customers ON customers.id = sales.customer_id
         LEFT JOIN customer_addresses ON customer_addresses.id = deliveries.address_id
         ${where}
         ORDER BY deliveries.id DESC`
      )
      .all(...params);
    res.json(rows);
  })
);

// GET /api/deliveries/:id — includes sale items, needed for the waybill
deliveriesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = db
      .prepare(
        `SELECT deliveries.*, sales.invoice, sales.date as sale_date, sales.total as sale_total,
                customers.name as customer_name, customers.phone as customer_phone,
                customer_addresses.address_line1, customer_addresses.address_line2, customer_addresses.city
         FROM deliveries
         JOIN sales ON sales.id = deliveries.sale_id
         LEFT JOIN customers ON customers.id = sales.customer_id
         LEFT JOIN customer_addresses ON customer_addresses.id = deliveries.address_id
         WHERE deliveries.id = ?`
      )
      .get(req.params.id) as any;
    if (!row) throw new ApiError(404, "Delivery not found");

    const items = db
      .prepare(
        `SELECT sale_items.*, products.product_title, products.brand, inventory.sku, inventory.size, inventory.color
         FROM sale_items
         JOIN inventory ON inventory.id = sale_items.inventory_id
         JOIN products ON products.id = inventory.product_id
         WHERE sale_items.sale_id = ?`
      )
      .all(row.sale_id);

    res.json({ ...row, items });
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

// PUT /api/deliveries/:id/confirm-address — marks the delivery address as
// verified (typically after calling/messaging the customer). Required
// before packing, so a bad address is caught as a phone call rather than
// an expensive return after shipping.
deliveriesRouter.put(
  "/:id/confirm-address",
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Delivery not found");
    if (existing.delivery_status !== "pending") {
      throw new ApiError(409, "Only pending orders need address confirmation.");
    }

    db.prepare(`UPDATE deliveries SET address_confirmed = 1, address_confirmed_at = datetime('now') WHERE id = ?`).run(req.params.id);
    const updated = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// PUT /api/deliveries/:id/pack — Pending -> Packed, generates the waybill
// number. This is the "Generate Waybill" action from the Pending tab.
// Hard-gated on address_confirmed — no waybill without a verified address.
deliveriesRouter.put(
  "/:id/pack",
  asyncHandler(async (req, res) => {
    const data = z.object({ courier_name: z.string().optional(), tracking_number: z.string().optional() }).parse(req.body);
    const existing = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Delivery not found");
    if (existing.delivery_status !== "pending") {
      throw new ApiError(409, `This order is already ${existing.delivery_status} — only pending orders can be packed.`);
    }
    if (!existing.address_confirmed) {
      throw new ApiError(409, "Confirm the delivery address with the customer before packing this order.");
    }

    const waybill_number = nextWaybillNumber();
    db.prepare(
      `UPDATE deliveries
       SET delivery_status = 'packed', waybill_number = ?, packed_at = datetime('now'),
           courier_name = COALESCE(?, courier_name), tracking_number = COALESCE(?, tracking_number)
       WHERE id = ?`
    ).run(waybill_number, data.courier_name ?? null, data.tracking_number ?? null, req.params.id);

    const updated = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// PUT /api/deliveries/:id/dispatch — Packed -> Dispatched
deliveriesRouter.put(
  "/:id/dispatch",
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Delivery not found");
    if (existing.delivery_status !== "packed") {
      throw new ApiError(409, "Only packed orders (with a waybill) can be dispatched.");
    }

    db.prepare(`UPDATE deliveries SET delivery_status = 'dispatched', dispatched_at = datetime('now') WHERE id = ?`).run(req.params.id);
    const updated = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// PUT /api/deliveries/:id/deliver — Dispatched -> Delivered
deliveriesRouter.put(
  "/:id/deliver",
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Delivery not found");
    if (existing.delivery_status !== "dispatched") {
      throw new ApiError(409, "Only dispatched orders can be marked delivered.");
    }

    db.prepare(`UPDATE deliveries SET delivery_status = 'delivered', delivery_date = datetime('now') WHERE id = ?`).run(req.params.id);
    const updated = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// PUT /api/deliveries/:id/return — reachable from packed or dispatched;
// a separate terminal state rather than a step in the forward pipeline.
deliveriesRouter.put(
  "/:id/return",
  asyncHandler(async (req, res) => {
    const data = z.object({ notes: z.string().optional() }).parse(req.body);
    const existing = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Delivery not found");
    if (!["packed", "dispatched"].includes(existing.delivery_status)) {
      throw new ApiError(409, "Only packed or dispatched orders can be marked returned.");
    }

    db.prepare(`UPDATE deliveries SET delivery_status = 'returned', notes = COALESCE(?, notes) WHERE id = ?`).run(
      data.notes ?? null,
      req.params.id
    );
    const updated = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

