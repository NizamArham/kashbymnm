import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { nextCustomerCode } from "../lib/codes";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

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
// store_credit_balance = every store credit entry EXCEPT expired
// return_exchange grants (expires_at in the past). A redemption
// (negative amount, spending down a balance) always counts regardless
// of its own expiry field, since money already spent isn't excluded by
// an expiry check — expiry only ever limits what's still USABLE.
const USABLE_CREDIT_SUBQUERY = `
  COALESCE(
    (SELECT SUM(amount) FROM store_credit_transactions
     WHERE customer_id = customers.id
       AND (expires_at IS NULL OR expires_at > datetime('now') OR amount < 0)),
    0
  )
`;

const CALC_SUBQUERY = `
  customers.bonus_points +
  COALESCE((SELECT SUM(points) FROM loyalty_transactions WHERE customer_id = customers.id), 0) AS loyalty_points,
  COALESCE((SELECT SUM(total - amount_paid) FROM sales WHERE customer_id = customers.id AND is_voided = 0), 0) AS balance_due,
  ${USABLE_CREDIT_SUBQUERY} AS store_credit_balance,
  (SELECT MAX(date) FROM sales WHERE customer_id = customers.id AND is_voided = 0) AS last_order_date
`;

// Individual usable credit grants for one customer, each with its TRUE
// remaining amount — a Rs. 2400 grant that's since been partly spent
// elsewhere shows as whatever's left, not its original size. Grants are
// consumed oldest-first as redemptions are applied (matching how the
// balance is actually spent down), and any grant past its own expiry is
// excluded entirely, same rule as the summary balance. Used for the
// detailed per-grant breakdown (e.g. "+1000 (overpayment, no expiry)",
// "+490 (expires in 12 days)"), not the flat total.
function computeCreditGrantBreakdown(customerId: number) {
  const rows = db
    .prepare(
      `SELECT id, amount, reason, expires_at, created_at FROM store_credit_transactions
       WHERE customer_id = ? ORDER BY created_at ASC, id ASC`
    )
    .all(customerId) as { id: number; amount: number; reason: string; expires_at: string | null; created_at: string }[];

  const grants = rows
    .filter((r) => r.amount > 0 && (r.expires_at === null || r.expires_at > new Date().toISOString()))
    .map((r) => ({ ...r, remaining: r.amount }));
  const totalRedeemed = rows.filter((r) => r.amount < 0).reduce((sum, r) => sum + Math.abs(r.amount), 0);

  let toConsume = totalRedeemed;
  for (const g of grants) {
    if (toConsume <= 0) break;
    const consumed = Math.min(g.remaining, toConsume);
    g.remaining -= consumed;
    toConsume -= consumed;
  }

  return grants
    .filter((g) => g.remaining > 0)
    .map((g) => ({
      amount: g.remaining,
      reason: g.reason,
      expires_at: g.expires_at,
    }));
}

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

// DELETE /api/customers/:id — admin-only. Two real outcomes:
// - No sales history at all: deletes outright, cascading their
//   loyalty/credit history along with them (nothing meaningful is lost,
//   since they never had a real transaction).
// - Has sales history: the FIRST call returns a warning (not an error)
//   rather than deleting anything, suggesting Edit or Suspend instead.
//   Only when the request explicitly confirms (?confirm=true) does the
//   delete actually happen — their sales survive with customer_id set
//   to NULL (see schema), displayed thereafter as "[Deleted Customer]"
//   rather than broken or misattributed to anyone else.
customersRouter.delete(
  "/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Customer not found");

    const hasSales = db.prepare(`SELECT COUNT(*) as cnt FROM sales WHERE customer_id = ?`).get(req.params.id) as {
      cnt: number;
    };

    if (hasSales.cnt > 0 && req.query.confirm !== "true") {
      return res.status(409).json({
        error: `This customer has ${hasSales.cnt} sale(s) on record. Deleting permanently will keep those sales but show them as belonging to a deleted customer. Consider editing their details or suspending them instead — or confirm to delete permanently anyway.`,
        requires_confirmation: true,
      });
    }

    if (hasSales.cnt > 0) {
      // Snapshot BEFORE the delete cascades customer_id to NULL — this
      // is what lets Sale History later show "[Deleted: John Silva]"
      // instead of being indistinguishable from a genuine walk-in sale.
      const snapshot = `${existing.name}${existing.customer_code ? ` (${existing.customer_code})` : ""}`;
      db.prepare(`UPDATE sales SET deleted_customer_snapshot = ? WHERE customer_id = ?`).run(snapshot, req.params.id);
    }

    db.prepare(`DELETE FROM customers WHERE id = ?`).run(req.params.id);
    res.status(204).send();
  })
);

const suspendInput = z.object({ reason: z.string().min(1, "A reason is required") });

// PUT /api/customers/:id/suspend — admin-only. The customer and every
// real record about them stays exactly as it is; they just can't be
// selected for a new sale (enforced wherever a customer is picked at
// checkout) until reactivated.
customersRouter.put(
  "/:id/suspend",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id);
    if (!existing) throw new ApiError(404, "Customer not found");

    const data = suspendInput.parse(req.body);
    db.prepare(
      `UPDATE customers SET is_suspended = 1, suspended_reason = ?, suspended_at = datetime('now') WHERE id = ?`
    ).run(data.reason, req.params.id);

    const updated = db.prepare(`SELECT customers.*, ${CALC_SUBQUERY} FROM customers WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// PUT /api/customers/:id/reactivate — admin-only, also requires a
// reason, so reactivating is just as deliberate and auditable as
// suspending was.
customersRouter.put(
  "/:id/reactivate",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Customer not found");
    if (!existing.is_suspended) throw new ApiError(409, "This customer is not currently suspended");

    const data = suspendInput.parse(req.body);
    db.prepare(
      `UPDATE customers SET is_suspended = 0, reactivated_reason = ?, reactivated_at = datetime('now') WHERE id = ?`
    ).run(data.reason, req.params.id);

    const updated = db.prepare(`SELECT customers.*, ${CALC_SUBQUERY} FROM customers WHERE id = ?`).get(req.params.id);
    res.json(updated);
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

// GET /api/customers/:id/credit-breakdown — the individual usable
// credit grants behind a customer's store_credit_balance, each with its
// TRUE remaining amount and its own expiry (or none, for permanent
// overpayment credit). Used for the detailed "+1000, +490 (expires in
// 12 days)" display rather than the flat total shown in the list.
customersRouter.get(
  "/:id/credit-breakdown",
  asyncHandler(async (req, res) => {
    const customer = db.prepare(`SELECT id FROM customers WHERE id = ?`).get(req.params.id);
    if (!customer) throw new ApiError(404, "Customer not found");

    res.json(computeCreditGrantBreakdown(Number(req.params.id)));
  })
);

// FIFO allocation — given an amount and a customer's outstanding sales
// (oldest first), returns how much goes to each sale and what its new
// status becomes. A sale only flips to 'paid' once FULLY covered; a
// sale that's only partially covered by what's left stays 'partial' (or
// 'unpaid' if it gets nothing), but the customer's overall balance_due
// still reflects the true remaining amount, since that's computed live
// from the sum across all their sales, not from this one action.
// Shared by both the preview (dry-run) and the real commit, so the two
// can never drift out of sync with each other.
function computeFifoAllocation(customerId: number, amount: number) {
  const outstandingSales = db
    .prepare(
      `SELECT id, invoice, date, total, amount_paid
       FROM sales
       WHERE customer_id = ? AND is_voided = 0 AND payment_status != 'paid'
       ORDER BY date ASC, id ASC`
    )
    .all(customerId) as { id: number; invoice: string; date: string; total: number; amount_paid: number }[];

  let remaining = amount;
  const allocations: {
    sale_id: number;
    invoice: string;
    date: string;
    owed_before: number;
    applied: number;
    new_amount_paid: number;
    new_status: "paid" | "partial" | "unpaid";
  }[] = [];

  for (const sale of outstandingSales) {
    if (remaining <= 0) break;
    const owed = sale.total - sale.amount_paid;
    if (owed <= 0) continue;

    const applied = Math.min(owed, remaining);
    const newAmountPaid = sale.amount_paid + applied;
    const newStatus: "paid" | "partial" | "unpaid" = newAmountPaid >= sale.total ? "paid" : newAmountPaid > 0 ? "partial" : "unpaid";

    allocations.push({
      sale_id: sale.id,
      invoice: sale.invoice,
      date: sale.date,
      owed_before: owed,
      applied,
      new_amount_paid: newAmountPaid,
      new_status: newStatus,
    });

    remaining -= applied;
  }

  return { allocations, unapplied: remaining };
}

const paymentPreviewInput = z.object({ amount: z.number().positive() });

// POST /api/customers/:id/payment-preview — dry run only, no writes. Lets
// the UI show exactly which sales a payment amount would cover before
// the person actually confirms it.
customersRouter.post(
  "/:id/payment-preview",
  asyncHandler(async (req, res) => {
    const customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id);
    if (!customer) throw new ApiError(404, "Customer not found");

    const { amount } = paymentPreviewInput.parse(req.body);
    const result = computeFifoAllocation(Number(req.params.id), amount);
    res.json(result);
  })
);

const recordPaymentInput = z.object({
  amount: z.number().positive(),
  method: z.enum(["cash", "bank_transfer", "cheque", "other"]),
  notes: z.string().optional(),
});

// POST /api/customers/:id/payment — record a real credit-customer
// payment, applied FIFO across their outstanding sales, oldest first.
// ONE cash book entry for the total amount received, linked to the
// customer rather than any single sale (since it may cover several).
customersRouter.post(
  "/:id/payment",
  asyncHandler(async (req, res) => {
    const customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id) as any;
    if (!customer) throw new ApiError(404, "Customer not found");

    const data = recordPaymentInput.parse(req.body);
    const { allocations, unapplied } = computeFifoAllocation(Number(req.params.id), data.amount);

    if (allocations.length === 0) {
      throw new ApiError(409, "This customer has no outstanding sales to apply a payment against");
    }

    const runPayment = db.transaction(() => {
      for (const a of allocations) {
        db.prepare(`UPDATE sales SET amount_paid = ?, payment_status = ? WHERE id = ?`).run(
          a.new_amount_paid,
          a.new_status,
          a.sale_id
        );
      }

      const invoiceList = allocations.map((a) => a.invoice).join(", ");
      db.prepare(
        `INSERT INTO cash_book (type, category, payment_method, reference_id, amount, notes)
         VALUES ('income', 'customer_payment', ?, ?, ?, ?)`
      ).run(
        data.method,
        req.params.id,
        data.amount,
        `Payment from ${customer.name} (${customer.customer_code}) — applied to ${invoiceList}${
          data.notes?.trim() ? ` — ${data.notes.trim()}` : ""
        }`
      );
    });

    runPayment();

    const updatedCustomer = db
      .prepare(`SELECT customers.*, ${CALC_SUBQUERY} FROM customers WHERE customers.id = ?`)
      .get(req.params.id);

    res.status(201).json({ customer: updatedCustomer, allocations, unapplied });
  })
);
