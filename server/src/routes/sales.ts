import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { nextInvoiceCode } from "../lib/codes";
import { ApiError, asyncHandler } from "../lib/errors";

export const salesRouter = Router();

// 1 loyalty point per Rs. 1000 spent (based on total, floored to whole points)
const LOYALTY_RATE = 1000;

const saleItemInput = z.object({
  inventory_id: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
});

const saleInput = z.object({
  customer_id: z.number().int().positive().optional(),
  salesperson: z.string().optional(),
  items: z.array(saleItemInput).min(1),
  discount: z.number().nonnegative().default(0),
  amount_paid: z.number().nonnegative().default(0),
  payment_method: z.string().optional(),
});

// GET /api/sales — list all, with customer name
salesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT sales.*, customers.name as customer_name, customers.customer_code
         FROM sales
         LEFT JOIN customers ON customers.id = sales.customer_id
         ORDER BY sales.id DESC`
      )
      .all();
    res.json(rows);
  })
);

// GET /api/sales/:id — includes line items
salesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const sale = db
      .prepare(
        `SELECT sales.*, customers.name as customer_name, customers.customer_code
         FROM sales
         LEFT JOIN customers ON customers.id = sales.customer_id
         WHERE sales.id = ?`
      )
      .get(req.params.id);
    if (!sale) throw new ApiError(404, "Sale not found");

    const items = db
      .prepare(
        `SELECT sale_items.*, inventory.sku, inventory.size, inventory.color, inventory.barcode,
                products.product_title, products.brand
         FROM sale_items
         JOIN inventory ON inventory.id = sale_items.inventory_id
         JOIN products ON products.id = inventory.product_id
         WHERE sale_items.sale_id = ?`
      )
      .all(req.params.id);

    res.json({ ...sale, items });
  })
);

// POST /api/sales — create a sale (POS checkout).
// This is the one operation that touches three tables together, so it
// runs as a single SQLite transaction: either everything succeeds
// (sale + items + inventory flips to 'sold') or nothing is saved at all.
salesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = saleInput.parse(req.body);

    if (data.customer_id) {
      const customer = db.prepare(`SELECT id FROM customers WHERE id = ?`).get(data.customer_id);
      if (!customer) throw new ApiError(400, "Referenced customer does not exist");
    }

    // Validate every inventory item up front: must exist and be available.
    const inventoryRows = data.items.map((item) => {
      const row = db
        .prepare(`SELECT * FROM inventory WHERE id = ?`)
        .get(item.inventory_id) as any;
      if (!row) {
        throw new ApiError(400, `Inventory unit ${item.inventory_id} does not exist`);
      }
      if (row.status !== "available") {
        throw new ApiError(
          409,
          `Inventory unit ${item.inventory_id} (SKU ${row.sku}) is already sold and cannot be sold again`
        );
      }
      return row;
    });

    const subtotal = data.items.reduce((sum, item) => sum + item.unit_price, 0);
    const total = Math.max(0, subtotal - data.discount);
    const loyalty_points_earned = Math.floor(total / LOYALTY_RATE);

    let payment_status: "paid" | "partial" | "unpaid" = "unpaid";
    if (data.amount_paid >= total && total > 0) payment_status = "paid";
    else if (data.amount_paid > 0) payment_status = "partial";

    const invoice = nextInvoiceCode();

    // better-sqlite3 transactions are synchronous, which fits perfectly
    // here — no partial writes possible if something throws mid-way.
    const runSaleTransaction = db.transaction(() => {
      const saleResult = db
        .prepare(
          `INSERT INTO sales (invoice, customer_id, salesperson, subtotal, discount, total, amount_paid, payment_status, payment_method, loyalty_points_earned)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          invoice,
          data.customer_id ?? null,
          data.salesperson ?? null,
          subtotal,
          data.discount,
          total,
          data.amount_paid,
          payment_status,
          data.payment_method ?? null,
          loyalty_points_earned
        );

      const saleId = saleResult.lastInsertRowid;

      for (const item of data.items) {
        db.prepare(
          `INSERT INTO sale_items (sale_id, inventory_id, quantity, unit_price, line_total)
           VALUES (?, ?, 1, ?, ?)`
        ).run(saleId, item.inventory_id, item.unit_price, item.unit_price);

        // Flip the specific physical unit to 'sold' — auto, per your instruction.
        db.prepare(`UPDATE inventory SET status = 'sold' WHERE id = ?`).run(item.inventory_id);
      }

      // Mirror the sale into the cash book as an income entry.
      if (data.amount_paid > 0) {
        db.prepare(
          `INSERT INTO cash_book (type, category, reference_id, amount, notes)
           VALUES ('income', 'sale', ?, ?, ?)`
        ).run(saleId, data.amount_paid, `Payment for invoice ${invoice}`);
      }

      return saleId;
    });

    const saleId = runSaleTransaction();

    const created = db
      .prepare(
        `SELECT sales.*, customers.name as customer_name
         FROM sales LEFT JOIN customers ON customers.id = sales.customer_id
         WHERE sales.id = ?`
      )
      .get(saleId);

    res.status(201).json(created);
  })
);

// PUT /api/sales/:id/payment — record an additional payment against an existing sale
// (handles the "partial payment paid off later" case)
salesRouter.put(
  "/:id/payment",
  asyncHandler(async (req, res) => {
    const amountSchema = z.object({ amount: z.number().positive() });
    const { amount } = amountSchema.parse(req.body);

    const sale = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(req.params.id) as any;
    if (!sale) throw new ApiError(404, "Sale not found");

    const newAmountPaid = sale.amount_paid + amount;
    let payment_status: "paid" | "partial" | "unpaid" = "unpaid";
    if (newAmountPaid >= sale.total) payment_status = "paid";
    else if (newAmountPaid > 0) payment_status = "partial";

    const runPaymentTransaction = db.transaction(() => {
      db.prepare(`UPDATE sales SET amount_paid = ?, payment_status = ? WHERE id = ?`).run(
        newAmountPaid,
        payment_status,
        req.params.id
      );

      db.prepare(
        `INSERT INTO cash_book (type, category, reference_id, amount, notes)
         VALUES ('income', 'sale', ?, ?, ?)`
      ).run(req.params.id, amount, `Additional payment for invoice ${sale.invoice}`);
    });

    runPaymentTransaction();

    const updated = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);
