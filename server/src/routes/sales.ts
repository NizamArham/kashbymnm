import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { nextInvoiceCode, InvoiceCategory } from "../lib/codes";
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
  // Manual discount — staff-entered, either a percentage of the subtotal
  // or a flat amount. Kept separate from any coupon applied, per the
  // requirement that the two be tracked separately for audit even
  // though they combine into one line on the receipt.
  manual_discount_type: z.enum(["percent", "fixed"]).optional(),
  manual_discount_value: z.number().nonnegative().optional(),
  coupon_code: z.string().optional(),
  amount_paid: z.number().nonnegative().default(0),
  payment_method: z.string().optional(),
  // Store credit the customer has from a past overpayment, applied
  // against this sale's total. Validated server-side against their real
  // balance — never trusted as a client-supplied final amount.
  store_credit_applied: z.number().nonnegative().default(0),
  // Cash-specific: how much cash was actually handed over, so change due
  // can be computed and shown later in Sale History rather than just
  // the net amount_paid after change was given.
  amount_received: z.number().nonnegative().optional(),
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
                products.product_title, products.brand,
                (SELECT COUNT(*) FROM returns WHERE returns.sale_item_id = sale_items.id) as is_returned
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

    // Credit — in-store or online — is never extended to a walk-in.
    // Enforced here, not just in the UI, since a balance owed needs a
    // real customer record to actually be collectable later.
    const isCredit = data.payment_method === "credit" || data.is_credit_order;
    if (isCredit && !data.customer_id) {
      throw new ApiError(400, "Credit sales require a selected customer — it isn't offered to walk-ins.");
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

    // Manual discount: a flat amount, or a percentage of the subtotal.
    const manual_discount =
      data.manual_discount_type === "percent"
        ? Math.round((subtotal * (data.manual_discount_value ?? 0)) / 100)
        : data.manual_discount_value ?? 0;

    // Coupon discount: validated server-side against the real coupon
    // record — never trust a discount amount computed on the client,
    // since that would let a stale/invalid/expired code still apply.
    let coupon_discount = 0;
    let coupon_code: string | null = null;
    if (data.coupon_code) {
      const code = data.coupon_code.trim().toUpperCase();
      const coupon = db.prepare(`SELECT * FROM coupons WHERE code = ?`).get(code) as any;
      if (!coupon) throw new ApiError(400, `No coupon with code "${code}"`);
      if (!coupon.is_active) throw new ApiError(400, `Coupon "${code}" is no longer active`);
      if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
        throw new ApiError(400, `Coupon "${code}" has expired`);
      }
      coupon_discount =
        coupon.discount_type === "percent" ? Math.round((subtotal * coupon.discount_value) / 100) : coupon.discount_value;
      coupon_code = code;
    }

    const discount = manual_discount + coupon_discount;
    const total = Math.max(0, subtotal - discount);
    const loyalty_points_earned = Math.floor(total * LOYALTY_RATE_PERCENT);

    // Store credit applied — validated against the customer's REAL
    // balance (sum of their store_credit_transactions), never trusted as
    // a client-supplied number, and capped so it can never exceed either
    // what they actually have or what's owed on this sale.
    let storeCreditApplied = 0;
    if (data.store_credit_applied > 0) {
      if (!data.customer_id) {
        throw new ApiError(400, "Store credit can only be applied for a selected customer.");
      }
      const balanceRow = db
        .prepare(`SELECT COALESCE(SUM(amount), 0) as balance FROM store_credit_transactions WHERE customer_id = ?`)
        .get(data.customer_id) as { balance: number };
      storeCreditApplied = Math.min(data.store_credit_applied, balanceRow.balance, total);
    }

    // Effective amount paid now includes whatever store credit was
    // applied, on top of whatever was actually handed over/transferred.
    const effectiveAmountPaid = data.amount_paid + storeCreditApplied;

    let payment_status: "paid" | "partial" | "unpaid" = "unpaid";
    if (effectiveAmountPaid >= total && total > 0) payment_status = "paid";
    else if (effectiveAmountPaid > 0) payment_status = "partial";

    // Cash change due: only meaningful when cash was tendered above the
    // total. amount_received itself is stored as given, so Sale History
    // can show exactly what was handed over, not just the net kept.
    const change_due =
      data.payment_method === "cash" && data.amount_received != null && data.amount_received > total
        ? data.amount_received - total
        : 0;

    // Overpayment on a non-cash (e.g. online/bank transfer) payment —
    // tracked so it can be offered back as store credit, rather than
    // silently treated as extra income the customer never gets credit for.
    const overpaid_amount =
      data.payment_method !== "cash" && data.amount_paid > total ? data.amount_paid - total : 0;

    // Which of the 5 invoice categories this sale falls into, driving
    // both the invoice prefix and its own independent sequence:
    // STR (in-store paid), SCR (in-store credit), OCD (online COD),
    // OCR (online credit), OPS (online fully paid, nothing owed).
    // is_credit_order is the source of truth for "is this a credit sale"
    // — payment_method may legitimately be "cash"/"card"/"bank_transfer"
    // even on a credit sale, if a partial amount came in through one of
    // those channels, so it can't be used to infer credit status.
    let invoiceCategory: InvoiceCategory;
    if (data.sale_type === "in_store") {
      invoiceCategory = data.is_credit_order || data.payment_method === "credit" ? "SCR" : "STR";
    } else {
      if (data.is_credit_order) invoiceCategory = "OCR";
      else if (payment_status === "paid") invoiceCategory = "OPS";
      else invoiceCategory = "OCD";
    }

    const invoice = nextInvoiceCode(invoiceCategory);

    // better-sqlite3 transactions are synchronous, which fits perfectly
    // here — no partial writes possible if something throws mid-way.
    const runSaleTransaction = db.transaction(() => {
      const saleResult = db
        .prepare(
          `INSERT INTO sales
             (invoice, customer_id, salesperson, subtotal, discount, manual_discount, coupon_discount, coupon_code,
              total, amount_paid, payment_status, payment_method, sale_type, loyalty_points_earned,
              amount_received, change_due, overpaid_amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          invoice,
          data.customer_id ?? null,
          data.salesperson ?? null,
          subtotal,
          discount,
          manual_discount,
          coupon_discount,
          coupon_code,
          total,
          effectiveAmountPaid,
          payment_status,
          data.payment_method ?? null,
          data.sale_type,
          loyalty_points_earned,
          data.amount_received ?? null,
          change_due,
          overpaid_amount
        );

      const saleId = saleResult.lastInsertRowid;

      // Redeeming store credit spends it back down with a negative entry
      // — the ledger is what makes the running balance trustworthy.
      if (storeCreditApplied > 0 && data.customer_id) {
        db.prepare(
          `INSERT INTO store_credit_transactions (customer_id, amount, reason, reference_id, notes)
           VALUES (?, ?, 'redemption', ?, ?)`
        ).run(data.customer_id, -storeCreditApplied, saleId, `Applied to invoice ${invoice}`);
      }

      // An overpayment grants store credit for a future purchase, rather
      // than being silently kept as extra income with no record of whom
      // it's owed back to.
      if (overpaid_amount > 0 && data.customer_id) {
        db.prepare(
          `INSERT INTO store_credit_transactions (customer_id, amount, reason, reference_id, notes)
           VALUES (?, ?, 'overpayment', ?, ?)`
        ).run(data.customer_id, overpaid_amount, saleId, `Overpayment on invoice ${invoice}`);
      }

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
          `INSERT INTO cash_book (type, category, payment_method, reference_id, amount, notes)
           VALUES ('income', 'sale', ?, ?, ?, ?)`
        ).run(data.payment_method ?? null, saleId, data.amount_paid, `Payment for invoice ${invoice}`);
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
    const amountSchema = z.object({ amount: z.number().positive(), payment_method: z.string().optional() });
    const { amount, payment_method } = amountSchema.parse(req.body);

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
        `INSERT INTO cash_book (type, category, payment_method, reference_id, amount, notes)
         VALUES ('income', 'sale', ?, ?, ?, ?)`
      ).run(payment_method ?? null, req.params.id, amount, `Additional payment for invoice ${sale.invoice}`);
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
          `INSERT INTO cash_book (type, category, payment_method, reference_id, amount, notes)
           VALUES ('expense', 'sale_void', ?, ?, ?, ?)`
        ).run(sale.payment_method ?? null, sale.id, sale.amount_paid, `Reversal of voided invoice ${sale.invoice}`);
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

      // Reverse any store credit this sale granted (overpayment) or spent
      // (redemption) — a voided sale should leave the customer's credit
      // balance exactly as if the sale had never happened.
      const creditEntries = db
        .prepare(`SELECT * FROM store_credit_transactions WHERE reference_id = ?`)
        .all(sale.id) as { amount: number }[];
      for (const entry of creditEntries) {
        db.prepare(
          `INSERT INTO store_credit_transactions (customer_id, amount, reason, reference_id, notes)
           VALUES (?, ?, 'manual_adjustment', ?, ?)`
        ).run(sale.customer_id, -entry.amount, sale.id, `Reversal — invoice ${sale.invoice} voided`);
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
