import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { nextInvoiceCode } from "../lib/codes";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const salesRouter = Router();

// POS is used by both admin and staff — just needs login, no role restriction.
salesRouter.use(requireAuth);

// Loyalty points = 1% of the sale's total, rounded down to a whole point
// (e.g. Rs. 2500 spent -> 25 points). Matches the business's real,
// established rule.
const LOYALTY_RATE_PERCENT = 0.01;

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
  sale_type: z.enum(["in_store", "online"]).default("in_store"),
  // Delivery details — only meaningful for sale_type "online", ignored
  // otherwise. Weight and partner determine the delivery fee (Rs. 450
  // first kg + Rs. 100/extra kg), which is skipped entirely if
  // is_free_delivery is set — though the underlying order total still
  // needs settling either now or as COD.
  delivery_partner: z.enum(["CPAK", "D2D", "DEX"]).optional(),
  package_weight_kg: z.number().nonnegative().optional(),
  is_free_delivery: z.boolean().default(false),
  // When true, the product total is tracked as customer credit (balance
  // due) rather than collected at all today — only the delivery fee is
  // ever COD in this case, regardless of amount_paid.
  is_credit_order: z.boolean().default(false),
});

// Rs. 450 for the first kg, Rs. 100 for each additional kg (rounded up —
// couriers bill by whole kg increments). Kept server-side as the single
// source of truth so the fee actually charged can never drift from what
// the frontend displayed.
function calculateDeliveryFee(weightKg: number | undefined, isFree: boolean): number {
  if (isFree || !weightKg || weightKg <= 0) return 0;
  const extraKg = Math.max(0, Math.ceil(weightKg - 1));
  return 450 + extraKg * 100;
}

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
        `SELECT sales.*, customers.name as customer_name, customers.customer_code,
                customers.phone as customer_phone
         FROM sales
         LEFT JOIN customers ON customers.id = sales.customer_id
         WHERE sales.id = ?`
      )
      .get(req.params.id) as any;
    if (!sale) throw new ApiError(404, "Sale not found");

    const items = db
      .prepare(
        `SELECT sale_items.*, inventory.sku, inventory.size, inventory.color, inventory.barcode,
                inventory.selling_price AS original_selling_price,
                products.product_title, products.brand
         FROM sale_items
         JOIN inventory ON inventory.id = sale_items.inventory_id
         JOIN products ON products.id = inventory.product_id
         WHERE sale_items.sale_id = ?`
      )
      .all(req.params.id);

    // Online/COD orders ship somewhere — pull that delivery address in
    // too, so a receipt for one of these can show where it was sent.
    let delivery_address: { address_line1: string | null; address_line2: string | null; city: string | null } | null = null;
    if (sale.sale_type === "online") {
      delivery_address = db
        .prepare(
          `SELECT customer_addresses.address_line1, customer_addresses.address_line2, customer_addresses.city
           FROM deliveries
           LEFT JOIN customer_addresses ON customer_addresses.id = deliveries.address_id
           WHERE deliveries.sale_id = ?`
        )
        .get(req.params.id) as typeof delivery_address;
    }

    res.json({ ...sale, items, delivery_address });
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
    const loyalty_points_earned = Math.floor(total * LOYALTY_RATE_PERCENT);

    let payment_status: "paid" | "partial" | "unpaid" = "unpaid";
    if (data.amount_paid >= total && total > 0) payment_status = "paid";
    else if (data.amount_paid > 0) payment_status = "partial";

    const invoice = nextInvoiceCode();

    // better-sqlite3 transactions are synchronous, which fits perfectly
    // here — no partial writes possible if something throws mid-way.
    const runSaleTransaction = db.transaction(() => {
      const saleResult = db
        .prepare(
          `INSERT INTO sales (invoice, customer_id, salesperson, subtotal, discount, total, amount_paid, payment_status, payment_method, sale_type, loyalty_points_earned)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          data.sale_type,
          loyalty_points_earned
        );

      const saleId = saleResult.lastInsertRowid;

      // Record this as a real transaction, not just a number on the sale
      // — this is what lets a customer's loyalty history actually be
      // reviewed later (when points were earned, from which sale).
      if (data.customer_id && loyalty_points_earned > 0) {
        db.prepare(
          `INSERT INTO loyalty_transactions (customer_id, points, reason, reference_id, notes)
           VALUES (?, ?, 'sale', ?, ?)`
        ).run(data.customer_id, loyalty_points_earned, saleId, `Earned from invoice ${invoice}`);
      }

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

      // Online sales need to ship — auto-create a pending delivery using
      // the customer's default saved address, if they have one and a
      // customer was attached to the sale at all.
      if (data.sale_type === "online") {
        let defaultAddressId: number | null = null;
        if (data.customer_id) {
          const defaultAddress = db
            .prepare(
              `SELECT id FROM customer_addresses WHERE customer_id = ? AND is_default = 1 LIMIT 1`
            )
            .get(data.customer_id) as { id: number } | undefined;
          defaultAddressId = defaultAddress?.id ?? null;
        }

        const delivery_fee = calculateDeliveryFee(data.package_weight_kg, data.is_free_delivery);
        // COD to collect = whatever of the order wasn't already paid,
        // plus the delivery fee (0 if free) — a fixed figure computed
        // once at order time, not recalculated later against a sale
        // that may since have had a return or an added payment.
        // COD = (order total + delivery fee) minus whatever was already
        // paid, floored at 0 — UNLESS the product is on credit, in which
        // case COD is only ever the delivery fee, since the product
        // total is tracked as balance due instead of being collected now.
        const cod_amount = data.is_credit_order ? delivery_fee : Math.max(0, total + delivery_fee - data.amount_paid);

        db.prepare(
          `INSERT INTO deliveries
             (sale_id, address_id, delivery_status, delivery_partner, package_weight_kg,
              is_free_delivery, delivery_fee, cod_amount)
           VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`
        ).run(
          saleId,
          defaultAddressId,
          data.delivery_partner ?? null,
          data.package_weight_kg ?? null,
          data.is_free_delivery ? 1 : 0,
          delivery_fee,
          cod_amount
        );
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

// PUT /api/sales/:id/void — admin-only. Reverses a sale that was a
// billing mistake: every sold unit goes back to 'available', the income
// entry is reversed in the cash book, and any pending delivery is
// cancelled. The sale record itself is kept (is_voided = 1) rather than
// deleted, so it stays visible in Sale History for audit — including
// the original prices, which is what lets a receipt still show
// "was Rs. X, sold at Rs. Y" after the fact.
salesRouter.put(
  "/:id/void",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const reasonInput = z.object({ reason: z.string().optional() }).parse(req.body);

    const sale = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(req.params.id) as any;
    if (!sale) throw new ApiError(404, "Sale not found");
    if (sale.is_voided) throw new ApiError(409, "This sale has already been voided.");

    const items = db.prepare(`SELECT * FROM sale_items WHERE sale_id = ?`).all(req.params.id) as any[];

    const runVoidTransaction = db.transaction(() => {
      // Return each physical unit to sellable stock.
      for (const item of items) {
        db.prepare(`UPDATE inventory SET status = 'available' WHERE id = ?`).run(item.inventory_id);
      }

      // Reverse the income entry, so cash-on-hand and reports reflect
      // that this money was never actually kept.
      if (sale.amount_paid > 0) {
        db.prepare(
          `INSERT INTO cash_book (type, category, reference_id, amount, notes)
           VALUES ('expense', 'sale_void', ?, ?, ?)`
        ).run(sale.id, sale.amount_paid, `Reversal of voided invoice ${sale.invoice}`);
      }

      // Cancel any delivery tied to this sale rather than leaving it
      // stranded in the pipeline for an order that no longer exists.
      db.prepare(`UPDATE deliveries SET delivery_status = 'cancelled', notes = 'Sale voided' WHERE sale_id = ?`).run(sale.id);

      // Reverse any loyalty points this sale earned with an explicit
      // negative entry, so the ledger itself tells the full story rather
      // than relying only on customer queries filtering out voided sales.
      if (sale.customer_id && sale.loyalty_points_earned > 0) {
        db.prepare(
          `INSERT INTO loyalty_transactions (customer_id, points, reason, reference_id, notes)
           VALUES (?, ?, 'manual_adjustment', ?, ?)`
        ).run(sale.customer_id, -sale.loyalty_points_earned, sale.id, `Reversal — invoice ${sale.invoice} voided`);
      }

      db.prepare(
        `UPDATE sales SET is_voided = 1, voided_at = datetime('now'), void_reason = ? WHERE id = ?`
      ).run(reasonInput.reason ?? null, req.params.id);
    });

    runVoidTransaction();

    const updated = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);
