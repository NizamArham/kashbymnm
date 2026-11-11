import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { nextCustomerCode, nextTransactionCode } from "../lib/codes";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";
import { logAudit } from "../lib/auditLog";
import { storeCreditSources } from "../lib/storeCreditSources";
import { loyaltyBalance } from "../lib/loyalty";
import { normalizePhone } from "../lib/phones";
import { approveIfNeeded } from "../lib/approval";
import { exchangeOutcomeForSale } from "../lib/exchangeOutcome";
import { WITH_COURIER_SQL, ON_DELIVERY_SQL, REAL_OWED_SQL } from "../lib/owedSql";
import { maskAccount, refundEventsForCustomer, returnedEventsForCustomer } from "../lib/refunds";
import { returnedValueForCustomer } from "../lib/returnedRevenue";
import { refundStoreCredit, usableStoreCredit } from "../lib/storeCreditRefund";

export const customersRouter = Router();

// cheque_receipts.sale_scope (the bills a cheque was aimed at) and .account_holder_name (whose account it is drawn on) — see
// schema.sql; added to databases created before they existed.
{
  const cols = db.prepare(`PRAGMA table_info(cheque_receipts)`).all() as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === "sale_scope")) db.exec(`ALTER TABLE cheque_receipts ADD COLUMN sale_scope TEXT`);
  if (cols.length > 0 && !cols.some((c) => c.name === "account_holder_name")) db.exec(`ALTER TABLE cheque_receipts ADD COLUMN account_holder_name TEXT`);
}

// Both admin and staff can view/create/manage customers — no role
// restriction needed here beyond being logged in at all.
customersRouter.use(requireAuth);

const customerInput = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  phone2: z.string().optional(),
  bonus_points: z.number().int().nonnegative().optional(),
  gender: z.enum(["male", "female", "unspecified"]).default("unspecified"),
});

const addressInput = z.object({
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  city: z.string().optional(),
  is_default: z.boolean().optional(),
});

const bankAccountInput = z.object({
  bank_name: z.string().min(1, "Bank name is required"),
  account_name: z.string().min(1, "Account holder name is required"),
  account_number: z.string().min(1, "Account number is required"),
  branch: z.string().optional(),
  is_default: z.boolean().optional(),
});

// A customer needs to have reached this balance at least once before
// any redemption is allowed — a one-time unlock, not a permanent
// floor they can never dip below. 1 point redeems for exactly Rs. 1
// of store credit, matching the 1%-of-sale earn rate (see
// LOYALTY_RATE_PERCENT in sales.ts) so there's no separate conversion
// scale to explain on top of the earn rate.
const LOYALTY_REDEMPTION_MIN_BALANCE = 500;
const LOYALTY_POINT_VALUE = 1;

// loyalty_points = bonus_points (manually granted, kept for backward
// compatibility with the legacy-customer import) + sum of every real
// loyalty_transactions entry (earned, granted, redeemed, or reversed).
// balance_due = sum of (total - amount_paid) across their sales, EXCEPT COD
// orders: one still on its way is on_delivery (collected at the door), and one a
// courier has already delivered is with_courier (the customer paid the courier;
// it's shown separately until the courier settles)
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
       AND (expires_at IS NULL OR expires_at > datetime('now', '+330 minutes') OR amount < 0)),
    0
  )
`;

export const CALC_SUBQUERY = `
  customers.bonus_points +
  COALESCE((SELECT SUM(points) FROM loyalty_transactions WHERE customer_id = customers.id), 0) AS loyalty_points,
  COALESCE((SELECT SUM(${REAL_OWED_SQL}) FROM sales WHERE customer_id = customers.id AND is_voided = 0 AND status = 'completed'), 0) AS balance_due,
  COALESCE((SELECT SUM(${WITH_COURIER_SQL}) FROM sales WHERE customer_id = customers.id AND is_voided = 0 AND status = 'completed'), 0) AS with_courier,
  COALESCE((SELECT SUM(${ON_DELIVERY_SQL}) FROM sales WHERE customer_id = customers.id AND is_voided = 0 AND status = 'completed'), 0) AS on_delivery,
  ${USABLE_CREDIT_SUBQUERY} AS store_credit_balance,
  (SELECT MAX(date) FROM sales WHERE customer_id = customers.id AND is_voided = 0 AND status = 'completed') AS last_order_date
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

// A cashier finds a customer by typing part of their name or phone number (or a customer code in full) — but never by
// browsing: at least 3 characters, at most 5 people come back, and only the one whose full name / code /
// number was typed exactly shows a whole phone number (the rest show their last three digits, enough to tell
// two "Ali"s apart). No balances either; those come with the customer once opened (GET /api/customers/:id).
const CASHIER_MIN_CHARS = 3;
const CASHIER_MAX_MATCHES = 5;
const maskPhone = (p: string | null) => (p ? `••••••${p.replace(/\D/g, "").slice(-3)}` : null);
const escapeLike = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);

export function searchCustomersForCashier(text: string) {
  const q = text.trim();
  if (q.length < CASHIER_MIN_CHARS) return [];
  let phone: string | undefined;
  try {
    phone = normalizePhone(q); // "0771234567", "771234567" and "+94 77 123 4567" are all the same number
  } catch {
    phone = undefined; // not a full number — it can still be part of a name, a code, or the start of a number
  }
  const digits = q.replace(/\D/g, "").replace(/^0+/, "");
  const phoneLike = digits.length >= 5 ? `%${escapeLike(digits)}%` : null; // part of a number needs 5+ digits
  const like = `%${escapeLike(q)}%`;
  const rows = db
    .prepare(
      `SELECT customers.*, ${CALC_SUBQUERY},
              CASE WHEN LOWER(customers.name) = LOWER(?) OR LOWER(customers.customer_code) = LOWER(?)
                        OR customers.phone = ? OR customers.phone2 = ? THEN 1 ELSE 0 END AS exact_match
       FROM customers
       WHERE customers.name LIKE ? ESCAPE '\\' OR LOWER(customers.customer_code) = LOWER(?)
          OR customers.phone LIKE ? ESCAPE '\\' OR customers.phone2 LIKE ? ESCAPE '\\'
       ORDER BY exact_match DESC, customers.name
       LIMIT ?`
    )
    .all(q, q, phone ?? null, phone ?? null, like, q, phoneLike, phoneLike, CASHIER_MAX_MATCHES) as any[];
  return rows.map(({ balance_due, with_courier, on_delivery, store_credit_balance, ...r }) => ({
    ...r,
    exact_match: !!r.exact_match,
    phone: r.exact_match ? r.phone : maskPhone(r.phone),
    phone2: r.exact_match ? r.phone2 : maskPhone(r.phone2),
  }));
}

// GET /api/customers
//
// An admin gets the whole list. A cashier gets no list at all: only a search (?find=…, see above), or — with an
// admin's password typed at the till — the customers who owe money (?owing=1), which is management information
// and so needs that one-time OK each time.
customersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    if (req.user!.role !== "staff") {
      res.json(db.prepare(`SELECT customers.*, ${CALC_SUBQUERY} FROM customers ORDER BY id DESC`).all());
      return;
    }

    if (req.query.owing) {
      approveIfNeeded(req, res, ["the list of customers who owe money"], "This list");
      const owing = (db.prepare(`SELECT customers.*, ${CALC_SUBQUERY} FROM customers`).all() as any[])
        .filter((c) => c.balance_due > 0)
        .sort((a, b) => b.balance_due - a.balance_due);
      res.json(owing);
      return;
    }

    res.json(searchCustomersForCashier(String(req.query.find ?? "")));
  })
);

// GET /api/customers/check-phone?phone=... — used by Add Customer to warn
// if this phone number (checked against BOTH phone and phone2) already
// belongs to an existing customer, avoiding accidental duplicate entries.
// GET /api/customers/bought?q=legging — admin only. Who has bought something matching that text (a product's name, brand or
// category) in a sale that stood, so the customer list can be narrowed to the people most likely to want more of it.
customersRouter.get(
  "/bought",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? "").trim().toLowerCase();
    if (q.length < 2) throw new ApiError(400, "Type at least 2 letters of a product, brand or category");
    const like = `%${escapeLike(q)}%`;
    const match = `(LOWER(p.product_title) LIKE @like ESCAPE '\\' OR LOWER(COALESCE(p.brand, '')) LIKE @like ESCAPE '\\' OR LOWER(COALESCE(p.category, '')) LIKE @like ESCAPE '\\')`;
    const ids = db
      .prepare(
        `SELECT DISTINCT s.customer_id AS id
         FROM sales s
         JOIN sale_items si ON si.sale_id = s.id
         JOIN inventory i ON i.id = si.inventory_id
         JOIN products p ON p.id = i.product_id
         WHERE s.customer_id IS NOT NULL AND s.is_voided = 0 AND s.status = 'completed' AND ${match}`
      )
      .all({ like }) as { id: number }[];
    const products = db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE ${match}`).get({ like }) as { n: number };
    res.json({ customer_ids: ids.map((r) => r.id), matching_products: products.n });
  })
);

customersRouter.get(
  "/check-phone",
  asyncHandler(async (req, res) => {
    let phone: string | undefined;
    try {
      phone = normalizePhone(String(req.query.phone ?? ""));
    } catch {
      // Half-typed numbers are expected while someone is still typing — not an error here.
      return res.json({ exists: false });
    }
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

    const bankAccounts = db
      .prepare(`SELECT * FROM customer_bank_accounts WHERE customer_id = ? ORDER BY is_default DESC, id ASC`)
      .all(req.params.id);

    // What was handed back to them (refunds and store-credit exchanges), so the page can show their total after returns.
    res.json({ ...customer, addresses, bank_accounts: bankAccounts, returned_value: returnedValueForCustomer(customer.id) });
  })
);

// POST /api/customers — auto-generates customer_code
customersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = customerInput.parse(req.body);
    // Points are worth store credit, so giving a new customer a head start is an admin decision
    // (Loyalty adjust is admin-only for the same reason) — a cashier can't type them in.
    if (data.bonus_points && req.user!.role !== "admin") {
      throw new ApiError(403, "Only an admin can give a customer starting points");
    }
    const customer_code = nextCustomerCode(data.gender);

    const result = db
      .prepare(
        `INSERT INTO customers (customer_code, name, phone, phone2, bonus_points, gender) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(customer_code, data.name, normalizePhone(data.phone) ?? null, normalizePhone(data.phone2) ?? null, data.bonus_points ?? 0, data.gender);

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

    // A number is only checked when it's being changed — saving a name edit
    // never trips over an older record's number.
    const phones: { phone?: string | null; phone2?: string | null } = {};
    if (data.phone !== undefined && data.phone !== existing.phone) phones.phone = normalizePhone(data.phone) ?? null;
    if (data.phone2 !== undefined && data.phone2 !== existing.phone2) phones.phone2 = normalizePhone(data.phone2) ?? null;

    const merged = { ...existing, ...data, ...phones };
    // Correcting gender here only affects new filtering/segmentation —
    // it never regenerates customer_code, same as an invoice's category
    // is fixed forever once issued (see nextInvoiceCode).
    db.prepare(`UPDATE customers SET name = ?, phone = ?, phone2 = ?, gender = ? WHERE id = ?`).run(
      merged.name,
      merged.phone,
      merged.phone2,
      merged.gender,
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

    logAudit(
      req.user!,
      "customer_delete",
      "customer",
      Number(req.params.id),
      `Deleted customer ${existing.name}${existing.customer_code ? ` (${existing.customer_code})` : ""}`
    );

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
    const existing = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Customer not found");

    const data = suspendInput.parse(req.body);
    db.prepare(
      `UPDATE customers SET is_suspended = 1, suspended_reason = ?, suspended_at = datetime('now', '+330 minutes') WHERE id = ?`
    ).run(data.reason, req.params.id);

    logAudit(req.user!, "customer_suspend", "customer", Number(req.params.id), `Suspended customer ${existing.name} — ${data.reason}`);

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
      `UPDATE customers SET is_suspended = 0, reactivated_reason = ?, reactivated_at = datetime('now', '+330 minutes') WHERE id = ?`
    ).run(data.reason, req.params.id);

    logAudit(req.user!, "customer_reactivate", "customer", Number(req.params.id), `Reactivated customer ${existing.name} — ${data.reason}`);

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

// ---- Nested bank accounts ----

// POST /api/customers/:id/bank-accounts — add a new saved bank account
customersRouter.post(
  "/:id/bank-accounts",
  asyncHandler(async (req, res) => {
    const customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id);
    if (!customer) throw new ApiError(404, "Customer not found");

    const data = bankAccountInput.parse(req.body);
    const isDefault = data.is_default ? 1 : 0;

    if (isDefault) {
      db.prepare(`UPDATE customer_bank_accounts SET is_default = 0 WHERE customer_id = ?`).run(req.params.id);
    }

    const result = db
      .prepare(
        `INSERT INTO customer_bank_accounts (customer_id, bank_name, account_name, account_number, branch, is_default)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(req.params.id, data.bank_name, data.account_name, data.account_number, data.branch ?? null, isDefault);

    const created = db.prepare(`SELECT * FROM customer_bank_accounts WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(created);
  })
);

// PUT /api/customers/:id/bank-accounts/:accountId
customersRouter.put(
  "/:id/bank-accounts/:accountId",
  asyncHandler(async (req, res) => {
    const existing = db
      .prepare(`SELECT * FROM customer_bank_accounts WHERE id = ? AND customer_id = ?`)
      .get(req.params.accountId, req.params.id) as any;
    if (!existing) throw new ApiError(404, "Bank account not found for this customer");

    const data = bankAccountInput.partial().parse(req.body);
    const merged = { ...existing, ...data };
    const isDefault = merged.is_default ? 1 : 0;

    if (isDefault) {
      db.prepare(`UPDATE customer_bank_accounts SET is_default = 0 WHERE customer_id = ? AND id != ?`).run(
        req.params.id,
        req.params.accountId
      );
    }

    db.prepare(
      `UPDATE customer_bank_accounts SET bank_name = ?, account_name = ?, account_number = ?, branch = ?, is_default = ? WHERE id = ?`
    ).run(merged.bank_name, merged.account_name, merged.account_number, merged.branch, isDefault, req.params.accountId);

    const updated = db.prepare(`SELECT * FROM customer_bank_accounts WHERE id = ?`).get(req.params.accountId);
    res.json(updated);
  })
);

// DELETE /api/customers/:id/bank-accounts/:accountId
customersRouter.delete(
  "/:id/bank-accounts/:accountId",
  asyncHandler(async (req, res) => {
    const existing = db
      .prepare(`SELECT * FROM customer_bank_accounts WHERE id = ? AND customer_id = ?`)
      .get(req.params.accountId, req.params.id);
    if (!existing) throw new ApiError(404, "Bank account not found for this customer");

    db.prepare(`DELETE FROM customer_bank_accounts WHERE id = ?`).run(req.params.accountId);
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

// GET /api/customers/:id/payment-history — a single customer's full
// running ledger: every sale (increases what they owe), every payment
// received (cash/bank/other via cash_book, or a cheque via
// cheque_receipts — never both for the same event, since a cheque never
// creates a cash_book entry until it clears), and every store credit
// grant/spend — merged into one chronological timeline with a running
// balance, mirroring the supplier ledger's design exactly.
//
// IMPORTANT: a sale's own line always shows its FULL total as new debt,
// never netted against its current amount_paid — amount_paid is a live,
// mutable field that later payments update directly (see
// computeFifoAllocation), so netting it into the sale's own line would
// double-count every payment that ever reduced it: once folded into the
// sale, and again as that payment's own separate line below. This is
// the exact bug the supplier ledger had — fixed there by never treating
// a mutable running total as if it were a fixed value at creation time.
customersRouter.get(
  "/:id/payment-history",
  asyncHandler(async (req, res) => {
    // balance_due / store_credit_balance come along so the page can show
    // what's owed on invoices and what credit is held as two figures —
    // the running balance below nets them, so spending credit on an
    // invoice (which moves value between the two) leaves it unchanged.
    const customer = db
      .prepare(`SELECT customers.*, ${CALC_SUBQUERY} FROM customers WHERE customers.id = ?`)
      .get(req.params.id) as any;
    if (!customer) throw new ApiError(404, "Customer not found");

    const sales = db
      .prepare(`SELECT id, invoice, date, total, amount_paid FROM sales WHERE customer_id = ? AND is_voided = 0 AND status = 'completed' ORDER BY date`)
      .all(req.params.id) as any[];
    const payments = db
      .prepare(
        `SELECT id, entry_date, amount, payment_method, notes, transaction_code FROM cash_book
         WHERE category = 'customer_payment' AND reference_id = ? ORDER BY entry_date`
      )
      .all(req.params.id) as any[];
    // Money collected at checkout, or added to an existing sale later via
    // PUT /sales/:id/payment, both land in cash_book under category
    // 'sale' (reference_id = the sale's own id) — NOT 'customer_payment'
    // (reference_id = the customer's id), which is only used by the
    // dedicated "record a payment" / FIFO-allocation flow above. Without
    // this, every sale paid at checkout would show as a phantom unpaid
    // debt here, even though it's already settled everywhere else.
    const salePayments = db
      .prepare(
        `SELECT id, entry_date, amount, payment_method, notes, reference_id, transaction_code FROM cash_book
         WHERE category = 'sale' AND type = 'income'
           AND reference_id IN (SELECT id FROM sales WHERE customer_id = ? AND is_voided = 0 AND status = 'completed')
         ORDER BY entry_date`
      )
      .all(req.params.id) as any[];
    const cheques = db
      .prepare(
        `SELECT id, date_received, amount, cheque_number, bank_name, status FROM cheque_receipts
         WHERE customer_id = ? ORDER BY date_received`
      )
      .all(req.params.id) as any[];
    const credits = db
      .prepare(
        `SELECT id, created_at, amount, reason, reference_id, notes, expires_at FROM store_credit_transactions WHERE customer_id = ? ORDER BY created_at`
      )
      .all(req.params.id) as any[];
    // A prepaid online order's payment also covered its delivery fee,
    // which was never part of the sale's own total — so that slice of
    // the payment isn't settling any debt shown here.
    // The same goes for the customer's share of an exchange's return pickup charge, when it was paid up front with the order.
    const feePaidRows = db
      .prepare(`SELECT sale_id, SUM(fee_paid) as fee, SUM(pickup_prepaid) as pickup FROM deliveries WHERE fee_paid > 0 OR pickup_prepaid > 0 GROUP BY sale_id`)
      .all() as { sale_id: number; fee: number; pickup: number }[];
    const feeLeft = new Map(feePaidRows.map((r) => [r.sale_id, r.fee]));
    const pickupLeft = new Map(feePaidRows.map((r) => [r.sale_id, r.pickup]));
    const ledgerSaleIds = new Set(sales.map((s) => s.id));
    // How much of each sale's amount_paid the lines below actually
    // account for (cash taken at/after checkout, store credit spent on
    // it) — used at the end to spot payments that were applied to a sale
    // without leaving a line of their own.
    const explainedBySale = new Map<number, number>();
    const explain = (saleId: number, amount: number) => explainedBySale.set(saleId, (explainedBySale.get(saleId) ?? 0) + amount);

    // Store credit entries tied to a sale (spent on it, kept from an
    // overpayment on it, or a void/correction reversing either) only MOVE
    // value between "credit they hold" and "what they owe on that sale" —
    // the sale's own line and its payment lines already carry the real
    // money, so counting these again would overstate the balance by
    // every rupee of credit ever spent. Only credit with no such
    // counterpart (a grant from a return, redeemed loyalty points) moves
    // the balance on its own. A return's reference_id is the return, not
    // a sale, so which kind it is comes from the reason.
    const isSaleLinkedCredit = (c: { reason: string; reference_id: number | null }) =>
      c.reference_id != null && ["redemption", "overpayment", "manual_adjustment"].includes(c.reason);

    type LedgerEntry = {
      date: string;
      type: "sale" | "payment" | "cheque" | "credit" | "refund" | "returned" | "deduction" | "charge";
      label: string;
      amount: number;
      effect: number;
      // Credit rows only: how much this changes the store credit held
      // (signed — a grant is +, spending it is −). The running balance
      // below nets owed against credit, so this is what lets it also be
      // shown split into the two parts.
      credit_delta?: number;
      credit_reason?: string;
      // Short main text for the row (the label says it in a full sentence).
      title?: string;
      // Cash-book transaction ID of a payment (e.g. TXN-0056).
      transaction_code?: string | null;
      // Extra lines shown under a sale: how store credit paid for it.
      details?: string[];
      sale_id?: number;
      sale_invoice?: string;
      // A COD order the courier has delivered and collected — see WITH_COURIER_SQL.
      courier_held?: boolean;
      // A COD order not delivered yet — to be paid at the door.
      on_delivery?: boolean;
      // Exchange credit waiting for the old item to be collected.
      exchange_pending?: boolean;
      // A refund paid back to the customer: the key its "Refund payment done" slip is fetched by.
      refund_key?: string;
      // When a row's amount isn't a change to the balance (goods returned, money paid out) the word that goes under it instead of a + or −.
      amount_label?: string;
    };
    const methodLabel = (m: string | null) => {
      const t = (m ?? "").replace(/_/g, " ").trim();
      return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
    };
    // What a return's store credit was for: the item, its invoice, why.
    const returnInfo = db.prepare(
      `SELECT s.invoice, r.reason, p.product_title, i.size, i.color
       FROM returns r
       JOIN sale_items si ON si.id = r.sale_item_id
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN inventory i ON i.id = si.inventory_id
       LEFT JOIN products p ON p.id = i.product_id
       WHERE r.id = ?`
    );
    const shortDate = (iso: string) => {
      const d = new Date(iso.replace(" ", "T"));
      return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString("en-GB", d.getFullYear() === new Date().getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
    };
    const returnCredit = (c: { amount: number; reason: string; reference_id: number | null; expires_at: string | null }) => {
      if (c.amount <= 0 || c.reason !== "return_exchange" || c.reference_id == null) return null;
      const r = returnInfo.get(c.reference_id) as { invoice: string; reason: string | null; product_title: string | null; size: string | null; color: string | null } | undefined;
      if (!r) return null;
      const variant = [r.size, r.color].filter(Boolean).join(", ");
      const item = `${r.product_title ?? "Returned item"}${variant ? ` (${variant})` : ""}`;
      return {
        label: `Return — ${item} from invoice ${r.invoice}`,
        title: item,
        details: [
          `Returned from invoice ${r.invoice}${r.reason ? ` · ${r.reason}` : ""}`,
          ...(c.expires_at ? [`Store credit valid until ${shortDate(c.expires_at)}`] : []),
        ],
      };
    };

    // Returns that only cancelled what was owed (nothing paid for the item, so nothing was paid back) and the customer's share of a courier
    // return's delivery charge that was added to what they owe both change sales.total. The statement shows the sale as it was billed and each of
    // these as its own row, so a return never just makes an invoice quietly smaller. (Returns from before written_off was recorded: a refund
    // that gave back less than the item's price had the difference taken off the invoice, which is worked out the same way.)
    type DebtReturn = { return_id: number; sale_id: number; invoice: string; date: string; title: string; written_off: number; reason: string | null; by_courier: boolean };
    const debtReturns: DebtReturn[] = [];
    const chargedBySale = new Map<number, { amount: number; date: string; invoice: string }>();
    if (sales.length > 0) {
      const ids = sales.map((x) => x.id);
      const marks = ids.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT r.id AS return_id, r.resolution, r.return_date, r.refund_amount, r.pickup_deduction, r.inspection_deduction, r.written_off,
                  si.sale_id, si.unit_price, sl.invoice, COALESCE(p.product_title, si.product_snapshot, 'item') AS title, rq.reason,
                  EXISTS (SELECT 1 FROM online_return_items oi WHERE oi.return_id = r.id) AS by_courier
           FROM returns r
           JOIN sale_items si ON si.id = r.sale_item_id
           JOIN sales sl ON sl.id = si.sale_id
           LEFT JOIN inventory i ON i.id = si.inventory_id
           LEFT JOIN products p ON p.id = i.product_id
           LEFT JOIN return_requests rq ON rq.return_id = r.id
           WHERE si.sale_id IN (${marks}) ORDER BY r.id`
        )
        .all(...ids) as any[];
      for (const r of rows) {
        const derived = r.resolution === "refund" ? Math.max(0, r.unit_price - r.refund_amount - r.pickup_deduction - r.inspection_deduction) : 0;
        const writtenOff = Math.round((r.written_off > 0 ? r.written_off : derived) * 100) / 100;
        if (writtenOff <= 0.009) continue;
        debtReturns.push({ return_id: r.return_id, sale_id: r.sale_id, invoice: r.invoice, date: r.return_date, title: r.title, written_off: writtenOff, reason: r.reason ?? null, by_courier: !!r.by_courier });
      }
      for (const o of db
        .prepare(
          `SELECT o.sale_id, o.charged_to_customer, COALESCE(o.report_decided_at, o.closed_at, o.report_at) AS at, sl.invoice
           FROM online_returns o JOIN sales sl ON sl.id = o.sale_id WHERE o.charged_to_customer > 0 AND o.sale_id IN (${marks}) ORDER BY o.id`
        )
        .all(...ids) as { sale_id: number; charged_to_customer: number; at: string | null; invoice: string }[]) {
        const prev = chargedBySale.get(o.sale_id);
        chargedBySale.set(o.sale_id, { amount: (prev?.amount ?? 0) + o.charged_to_customer, date: o.at ?? prev?.date ?? "", invoice: o.invoice });
      }
    }
    const writtenOffBySale = new Map<number, number>();
    for (const d of debtReturns) writtenOffBySale.set(d.sale_id, (writtenOffBySale.get(d.sale_id) ?? 0) + d.written_off);
    // The sale as it was billed: today's total with the returned part put back and the added delivery share taken out.
    const billedTotal = (sl: { id: number; total: number }) => Math.round((sl.total + (writtenOffBySale.get(sl.id) ?? 0) - (chargedBySale.get(sl.id)?.amount ?? 0)) * 100) / 100;

    // A payment made through the shop can include the delivery fee and the customer's share of an exchange's return pickup charge. Neither is part of
    // the invoice, so each is its own charge row on the statement (dated with its order) and the payment shows in full — the three always net to what
    // came off the invoice. How much of a payment went to each comes from the delivery record, never more than the payment itself.
    const saleById = new Map<number, { invoice: string; date: string }>(sales.map((x) => [x.id, { invoice: x.invoice, date: x.date }]));
    const chargeRows: LedgerEntry[] = [];
    const salePaymentRows: LedgerEntry[] = salePayments.map((p) => {
      const deliveryPart = Math.min(feeLeft.get(p.reference_id) ?? 0, p.amount);
      if (deliveryPart > 0) feeLeft.set(p.reference_id, (feeLeft.get(p.reference_id) ?? 0) - deliveryPart);
      const pickupPart = Math.min(pickupLeft.get(p.reference_id) ?? 0, p.amount - deliveryPart);
      if (pickupPart > 0) pickupLeft.set(p.reference_id, (pickupLeft.get(p.reference_id) ?? 0) - pickupPart);
      explain(p.reference_id, p.amount - deliveryPart - pickupPart);
      const sale = saleById.get(p.reference_id);
      const addCharge = (kind: string, amount: number) =>
        chargeRows.push({
          date: sale?.date ?? p.entry_date,
          type: "charge" as const,
          label: `${kind} (${sale?.invoice ?? "order"})`,
          title: `${kind} — ${sale?.invoice ?? "order"}`,
          amount,
          effect: amount,
          sale_id: p.reference_id,
          sale_invoice: sale?.invoice,
        });
      if (deliveryPart > 0) addCharge("Delivery charge", deliveryPart);
      if (pickupPart > 0) addCharge("Return pickup charge", pickupPart);
      return {
        date: p.entry_date,
        type: "payment" as const,
        label: p.notes || `Payment${p.payment_method ? ` (${methodLabel(p.payment_method)})` : ""}`,
        amount: p.amount,
        effect: -p.amount,
        transaction_code: p.transaction_code,
        sale_id: p.reference_id,
      };
    });

    const entries: LedgerEntry[] = [
      ...sales.map((s) => ({
        date: s.date,
        type: "sale" as const,
        label: `Sale ${s.invoice}`,
        amount: billedTotal(s),
        effect: billedTotal(s),
        sale_id: s.id,
        sale_invoice: s.invoice,
      })),
      ...chargeRows,
      // A return that only cancelled what was owed: no money moved, so it is a row that takes that much off — not a refund or a credit.
      ...debtReturns.map((d) => ({
        date: d.date,
        type: "returned" as const,
        label: `Returned ${d.invoice} — ${d.title}`,
        title: `Returned ${d.invoice} — ${d.title}`,
        details: [
          `${d.by_courier ? "Sent back by courier" : "Taken back"} from ${d.invoice}${d.reason ? ` · ${d.reason.replace(/^Courier return — /, "")}` : ""}`,
          `Rs. ${d.written_off.toLocaleString()} came off what they owed — it hadn't been paid for, so nothing is paid back`,
        ],
        amount: d.written_off,
        effect: -d.written_off,
        sale_id: d.sale_id,
        sale_invoice: d.invoice,
      })),
      // The customer's share of a courier return's delivery charge, added because a refund couldn't carry it.
      ...Array.from(chargedBySale, ([saleId, c]) => ({
        date: c.date,
        type: "deduction" as const,
        label: `Paid for courier — delivery charge added to what they owe (${c.invoice})`,
        title: `Paid for courier — delivery charge (${c.invoice})`,
        details: [`The customer's share of what it cost to send items back, added because there was no refund to take it from`],
        amount: c.amount,
        effect: c.amount,
        sale_id: saleId,
        sale_invoice: c.invoice,
      })),
      ...payments.map((p) => ({
        date: p.entry_date,
        type: "payment" as const,
        label: `Payment${p.payment_method ? ` (${methodLabel(p.payment_method)})` : ""}`,
        amount: p.amount,
        effect: -p.amount,
        transaction_code: p.transaction_code,
      })),
      ...salePaymentRows,
      // A cheque still in_hand or otherwise not yet cleared/bounced is
      // shown as settling the balance right away — matching the app's
      // own design (a received cheque marks the sale paid immediately,
      // real cash_book impact happens later when it clears). A bounced
      // cheque already reversed its own sale allocations elsewhere, so
      // showing it here too would double-reverse — excluded entirely.
      ...cheques
        .filter((c) => c.status !== "bounced")
        .map((c) => ({
          date: c.date_received,
          type: "cheque" as const,
          label: `Cheque #${c.cheque_number} (${c.bank_name})`,
          amount: c.amount,
          effect: -c.amount,
        })),
      ...credits
        // A sale-linked credit row for a sale that isn't in this ledger
        // (voided) would just be an unexplained line — its sale and
        // payments are hidden, and its credit movements cancel out.
        .filter((c) => !isSaleLinkedCredit(c) || ledgerSaleIds.has(c.reference_id))
        .map((c) => {
          const ret = returnCredit(c);
          return {
          date: c.created_at,
          type: "credit" as const,
          label: ret?.label ?? (c.amount > 0 ? c.notes || "Store credit granted" : `Store credit removed${c.notes ? ` — ${c.notes}` : ""}`),
          ...(ret ? { title: ret.title, details: ret.details } : {}),
          amount: Math.abs(c.amount),
          effect: isSaleLinkedCredit(c) ? 0 : -c.amount,
          credit_delta: c.amount,
          credit_reason: c.reason,
          ...(isSaleLinkedCredit(c) ? { sale_id: c.reference_id } : {}),
          };
        }),
    ];

    // A return whose money goes back as a refund reads like this, each its own line with the balance after it:
    //   Returned        what the goods came to — the shop now owes the customer that (a credit)
    //   Paid for courier / held back   the customer's share of the delivery charge, and anything an inspection held back, come off it
    //   Paid out        the rest, paid back (with its slip) — and the balance is settled
    // They always net to nothing: the goods came back, the money went back. Until the payout, what is owed shows as a credit — that is the
    // refund still to be paid, not store credit (refund_owed says how much).
    const itemWhat = (items: { title: string | null; size: string | null; color: string | null }[]) =>
      items.length === 1
        ? `${items[0].title ?? "item"}${[items[0].size, items[0].color].filter(Boolean).length ? ` (${[items[0].size, items[0].color].filter(Boolean).join(", ")})` : ""}`
        : `${items.length} items`;
    let refundOwed = 0;
    for (const r of returnedEventsForCustomer(Number(req.params.id))) {
      if (!r.paid) refundOwed += r.refund_total;
      const inv = r.invoices.join(", ");
      entries.push({
        date: r.date,
        type: "returned" as const,
        label: `Returned ${inv} — ${itemWhat(r.items)}`,
        title: `Returned ${inv} — ${itemWhat(r.items)}`,
        details: [`Taken back from ${inv}${r.reason ? ` · ${r.reason}` : ""}`, ...(r.paid ? [] : [`Refund of Rs. ${r.refund_total.toLocaleString()} approved — waiting to be paid out`])],
        amount: r.returned_value,
        effect: -r.returned_value,
        sale_id: r.sale_id,
        sale_invoice: r.invoices[0],
      });
      if (r.delivery_share > 0) {
        entries.push({
          date: r.date,
          type: "deduction" as const,
          label: `Paid for courier — delivery charge taken off the refund (${inv})`,
          title: `Paid for courier — delivery charge (${inv})`,
          details: [`The customer's share of what it cost to send ${itemWhat(r.items)} back, held back from the refund`],
          amount: r.delivery_share,
          effect: r.delivery_share,
          sale_id: r.sale_id,
          sale_invoice: r.invoices[0],
        });
      }
      if (r.inspection_hold > 0) {
        entries.push({
          date: r.date,
          type: "deduction" as const,
          label: `Held back after inspection (${inv})`,
          title: `Held back after inspection (${inv})`,
          details: [`Taken off the refund for ${itemWhat(r.items)} when the parcel was inspected`],
          amount: r.inspection_hold,
          effect: r.inspection_hold,
          sale_id: r.sale_id,
          sale_invoice: r.invoices[0],
        });
      }
    }
    for (const r of refundEventsForCustomer(Number(req.params.id))) {
      const how = r.method === "bank_transfer" ? `bank transfer${r.bank ? ` to ${r.bank.bank_name} ${maskAccount(r.bank.account_number)}` : ""}` : methodLabel(r.method).toLowerCase();
      entries.push({
        date: r.paid_at,
        type: "refund" as const,
        label: `Paid out — refund for ${r.invoices.join(", ")} (${how})`,
        title: `Paid out — refund for ${r.invoices.join(", ")}`,
        details: [
          `${itemWhat(r.items)} · paid back by ${how}${r.paid_by ? ` · ${r.paid_by}` : ""}`,
          ...(r.transaction_codes.length > 1 ? [`Transaction IDs ${r.transaction_codes.join(", ")}`] : []),
        ],
        amount: r.total,
        effect: r.total,
        transaction_code: r.transaction_codes[0] ?? null,
        refund_key: r.key,
        sale_id: r.sale_id,
        sale_invoice: r.invoices[0],
      });
    }

    // Payments that were applied straight onto a sale's amount_paid with
    // no line of their own — the main case is a courier settling COD for
    // delivered orders, which marks each one paid from a single lump
    // remittance. Without these the statement keeps listing those orders
    // as unpaid and drifts away from what the invoices themselves say.
    for (const c of credits) {
      if (c.reason === "redemption" && c.amount < 0 && ledgerSaleIds.has(c.reference_id)) explain(c.reference_id, -c.amount);
    }
    const actualPaid = sales.reduce((sum, s) => sum + s.amount_paid, 0);
    const explainedPaid =
      Array.from(explainedBySale.values()).reduce((sum, v) => sum + v, 0) +
      payments.reduce((sum, p) => sum + p.amount, 0) +
      cheques.filter((c) => c.status !== "bounced").reduce((sum, c) => sum + c.amount, 0);
    let residual = Math.round((actualPaid - explainedPaid) * 100) / 100;

    if (residual > 0) {
      const settled = db
        .prepare(
          `SELECT s.id, s.invoice, s.date, s.amount_paid, d.delivery_date, dp.name AS partner_name
           FROM sales s
           JOIN deliveries d ON d.sale_id = s.id
           LEFT JOIN delivery_partners dp ON dp.code = d.delivery_partner
           WHERE s.customer_id = ? AND s.is_voided = 0 AND s.status = 'completed'
             AND d.delivery_status = 'delivered' AND s.amount_paid > 0
           ORDER BY s.date, s.id`
        )
        .all(req.params.id) as any[];
      for (const sale of settled) {
        if (residual <= 0) break;
        const give = Math.min(residual, Math.max(0, sale.amount_paid - (explainedBySale.get(sale.id) ?? 0)));
        if (give <= 0) continue;
        // On the day it was delivered (never before the sale itself).
        let when = sale.delivery_date
          ? sale.delivery_date.length >= 19
            ? sale.delivery_date.replace("T", " ")
            : `${sale.delivery_date.slice(0, 10)} 23:59:59`
          : sale.date;
        if (when < sale.date) when = sale.date;
        entries.push({
          date: when,
          type: "payment" as const,
          label: `Paid on delivery — settled by ${sale.partner_name ?? "the courier"} (${sale.invoice})`,
          amount: give,
          effect: -give,
          sale_id: sale.id,
        });
        residual = Math.round((residual - give) * 100) / 100;
      }
    }
    // Anything still unexplained (in either direction) is shown as one
    // plain line rather than left to quietly skew the balance.
    if (Math.abs(residual) >= 0.01 && sales.length > 0) {
      entries.push({
        date: sales[sales.length - 1].date,
        type: "payment" as const,
        label: residual > 0 ? "Other payments applied to invoices" : "Payments reversed or corrected",
        amount: Math.abs(residual),
        effect: -residual,
      });
    }

    // COD orders a courier has delivered but not yet paid out. The customer
    // paid (to the courier, at the door), so they aren't owing anything for
    // these — each gets its own row taking it off what's owed, dated on the
    // delivery, so the balance doesn't ask the customer for money that's
    // simply still on its way to us from the courier.
    const heldSales = db
      .prepare(
        `SELECT sales.id, sales.invoice, sales.date, ROUND(${WITH_COURIER_SQL}, 2) AS amount,
                dl.delivery_date, COALESCE(dpt.name, dl.delivery_partner) AS partner_name
         FROM sales
         JOIN deliveries dl ON dl.sale_id = sales.id
         LEFT JOIN delivery_partners dpt ON dpt.code = dl.delivery_partner
         WHERE sales.customer_id = ? AND sales.is_voided = 0 AND sales.status = 'completed' AND ${WITH_COURIER_SQL} > 0.009
         ORDER BY sales.date, sales.id`
      )
      .all(req.params.id) as { id: number; invoice: string; date: string; amount: number; delivery_date: string | null; partner_name: string }[];
    for (const h of heldSales) {
      let when = h.delivery_date ? (h.delivery_date.length >= 19 ? h.delivery_date.replace("T", " ") : `${h.delivery_date.slice(0, 10)} 23:59:59`) : h.date;
      if (when < h.date) when = h.date;
      entries.push({
        date: when,
        type: "payment" as const,
        label: `Paid to ${h.partner_name} on delivery — awaiting courier payout (${h.invoice})`,
        title: `Paid to ${h.partner_name} on delivery`,
        details: [`${h.invoice} is paid — ${h.partner_name} collected it and will pay it over to us`],
        amount: h.amount,
        effect: -h.amount,
        sale_id: h.id,
        sale_invoice: h.invoice,
        courier_held: true,
      });
    }

    // COD orders not delivered yet: the customer pays at the door, so nothing is
    // owed on account — each gets a row (right after its sale) taking it off,
    // which disappears into a "paid to the courier" row once it's delivered.
    const onWay = db
      .prepare(
        `SELECT sales.id, sales.invoice, sales.date, ROUND(${ON_DELIVERY_SQL}, 2) AS amount,
                COALESCE(dpt.name, dl.delivery_partner, 'the courier') AS partner_name
         FROM sales
         JOIN deliveries dl ON dl.sale_id = sales.id
         LEFT JOIN delivery_partners dpt ON dpt.code = dl.delivery_partner
         WHERE sales.customer_id = ? AND sales.is_voided = 0 AND sales.status = 'completed' AND ${ON_DELIVERY_SQL} > 0.009
         ORDER BY sales.date, sales.id`
      )
      .all(req.params.id) as { id: number; invoice: string; date: string; amount: number; partner_name: string }[];
    for (const o of onWay) {
      entries.push({
        date: o.date,
        type: "payment" as const,
        label: `To pay on delivery — ${o.partner_name} (${o.invoice})`,
        title: `To pay on delivery (${o.partner_name})`,
        details: [`${o.invoice} is cash on delivery — the customer pays when it arrives`],
        amount: o.amount,
        effect: -o.amount,
        sale_id: o.id,
        sale_invoice: o.invoice,
        on_delivery: true,
      });
    }

    // An exchange whose old items haven't come back: the replacement order stays owed in full, and one short line at the end of the statement
    // names the items and says what happens when they arrive (see exchangeOutcomeForSale) — all worked out from the records, never typed in.
    const pendingExchanges = (
      db
        .prepare(
          `SELECT sales.id FROM sales
           WHERE sales.customer_id = ? AND sales.is_voided = 0 AND sales.status = 'completed'
             AND EXISTS (SELECT 1 FROM online_exchanges px WHERE px.new_sale_id = sales.id AND px.status = 'awaiting_pickup')
           ORDER BY sales.date, sales.id`
        )
        .all(req.params.id) as { id: number }[]
    ).flatMap((x) => {
      const outcome = exchangeOutcomeForSale(x.id);
      return outcome ? [{ id: x.id, outcome }] : [];
    });
    const lastDate = entries.reduce((latest, e) => (e.date > latest ? e.date : latest), "");
    for (const { id, outcome } of pendingExchanges) {
      const plural = outcome.waiting_items.length !== 1;
      entries.push({
        date: lastDate,
        type: "payment" as const,
        label: `Exchange — ${plural ? "old items" : "old item"} on the way back (${outcome.invoice})`,
        title: `Exchange — ${plural ? "old items" : "old item"} on the way back`,
        details: [outcome.waiting_items.map((i) => `${i.name} ${i.worth.toLocaleString()}`).join("  ·  "), outcome.text].filter(Boolean),
        amount: outcome.waiting_value,
        amount_label: "pending",
        effect: 0,
        sale_id: id,
        sale_invoice: outcome.invoice,
        exchange_pending: true,
      });
    }

    entries.sort((a, b) => a.date.localeCompare(b.date));

    // balance = owed on invoices − store credit held. A row's effect on
    // the net is owedChange − creditChange, so owedChange = effect +
    // creditChange: spending credit on an invoice lowers BOTH by the same
    // amount (net unchanged), a return's credit grant raises only credit.
    let runningBalance = 0;
    let owedBalance = 0;
    let creditBalance = 0;
    const withBalance = entries.map((entry) => {
      const creditChange = entry.credit_delta ?? 0;
      runningBalance += entry.effect;
      creditBalance += creditChange;
      owedBalance += entry.effect + creditChange;
      return { ...entry, running_balance: runningBalance, owed_balance: owedBalance, credit_balance: creditBalance };
    });

    // Store credit spent on (or kept from) an invoice never changes the
    // balance, so it isn't a row of its own — it becomes a line under that
    // invoice saying how it was paid, and which return the credit came from.
    const detailsBySale = new Map<number, string[]>();
    const addDetail = (saleId: number, text: string) => detailsBySale.set(saleId, [...(detailsBySale.get(saleId) ?? []), text]);
    const money = (n: number) => `Rs. ${n.toLocaleString()}`;
    const spentSales = new Set<number>();
    // An overpayment kept as credit and a later correction of it are one
    // story: only what's left after netting them is worth a line.
    const keptBySale = new Map<number, number>();
    for (const e of withBalance) {
      if (e.type !== "credit" || e.effect !== 0 || e.sale_id == null) continue;
      const delta = e.credit_delta ?? 0;
      if (e.credit_reason === "redemption" && delta < 0) {
        if (spentSales.has(e.sale_id)) continue;
        spentSales.add(e.sale_id);
        const sources = storeCreditSources(e.sale_id, Number(req.params.id));
        if (sources.length > 0) for (const src of sources) addDetail(e.sale_id, `${money(src.amount)} paid from store credit — ${src.label}`);
        else addDetail(e.sale_id, `${money(-delta)} paid from store credit`);
      } else {
        keptBySale.set(e.sale_id, Math.round(((keptBySale.get(e.sale_id) ?? 0) + delta) * 100) / 100);
      }
    }
    for (const [saleId, kept] of keptBySale) {
      if (kept > 0) addDetail(saleId, `${money(kept)} overpayment kept as store credit`);
      else if (kept < 0) addDetail(saleId, `${money(-kept)} store credit taken back`);
    }
    // kind is what the page shows in its Type column; title is the row's
    // short main text (the sale's invoice, the payment method, the item).
    const visible = withBalance
      .filter((e) => !(e.type === "credit" && e.effect === 0 && e.sale_id != null))
      .map((e) => {
        const kind = e.courier_held ? "courier" : e.on_delivery ? "on_delivery" : e.exchange_pending ? "exchange" : e.type === "refund" ? "refund" : e.type === "returned" ? "return" : e.type === "deduction" ? "deduction" : e.type === "credit" ? (e.credit_reason === "return_exchange" ? "return" : "credit") : e.type;
        const title = e.title ?? (e.type === "sale" ? e.sale_invoice : e.label.replace(/^Payment \((.+)\)$/, "$1"));
        const details = e.type === "sale" && e.sale_id != null && detailsBySale.has(e.sale_id) ? detailsBySale.get(e.sale_id) : e.details;
        return { ...e, kind, title, ...(details ? { details } : {}) };
      });

    res.json({
      customer,
      entries: visible,
      final_balance: runningBalance,
      // Refunds approved for returns but not yet paid out: they show in the balance as a credit, which is money to hand back, not store credit.
      refund_owed: Math.round(refundOwed * 100) / 100,
      // Exchanges whose old items haven't come back: the figures behind the "on the way back" line, for the statement's closing summary.
      exchange_outcomes: pendingExchanges.map((p) => p.outcome),
      // COD still to be collected at the door (orders not yet delivered).
      on_delivery: onWay.map((o) => ({ sale_id: o.id, invoice: o.invoice, partner: o.partner_name, amount: o.amount })),
      // Paid to the courier at delivery, not yet paid over to the shop.
      with_courier: heldSales.map((h) => ({ sale_id: h.id, invoice: h.invoice, partner: h.partner_name, amount: h.amount })),
    });
  })
);

// POST /api/customers/:id/store-credit-refund — admin only. Pays some of the
// customer's store credit back out as money (cash from the till, or a bank
// transfer) instead of leaving it to be spent: it comes off their credit and goes
// in the cash book as an expense.
customersRouter.post(
  "/:id/store-credit-refund",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const data = z
      .object({ amount: z.number().positive(), method: z.enum(["cash", "bank_transfer"]), note: z.string().optional() })
      .parse(req.body);
    const customer = db.prepare(`SELECT id, name FROM customers WHERE id = ?`).get(req.params.id) as { id: number; name: string } | undefined;
    if (!customer) throw new ApiError(404, "Customer not found");

    const { transaction_code } = refundStoreCredit({
      customerId: customer.id,
      amount: data.amount,
      method: data.method,
      note: data.note?.trim() || "refund requested by the customer",
    });
    logAudit(
      req.user!,
      "store_credit_refund",
      "customer",
      customer.id,
      `Refunded Rs. ${data.amount.toLocaleString()} of ${customer.name}'s store credit (${data.method.replace("_", " ")}) — ${transaction_code}`
    );
    res.json({ transaction_code, store_credit: usableStoreCredit(customer.id) });
  })
);

// POST /api/customers/:id/store-credit-grant — admin only. Gives a customer store
// credit by hand, with a reason — for money that came in with no invoice to attach it
// to, such as a courier collecting Rs. 50 more than the order at the door. It isn't
// tied to any sale, so it shows on their ledger as credit granted; no cash book entry
// is made, because whatever money arrived is already recorded wherever it came in
// (e.g. the courier's settlement).
customersRouter.post(
  "/:id/store-credit-grant",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        amount: z.number().positive().max(1_000_000),
        reason: z.string().trim().min(3, "A reason is required — a few words is fine").max(200),
        // Leave out for credit that never expires.
        expiry_days: z.number().int().positive().max(3650).optional(),
      })
      .parse(req.body);
    const customer = db.prepare(`SELECT id, name FROM customers WHERE id = ?`).get(req.params.id) as { id: number; name: string } | undefined;
    if (!customer) throw new ApiError(404, "Customer not found");

    const expiresAt = data.expiry_days ? new Date(Date.now() + data.expiry_days * 24 * 60 * 60 * 1000).toISOString() : null;
    db.prepare(
      `INSERT INTO store_credit_transactions (customer_id, amount, reason, reference_id, notes, expires_at)
       VALUES (?, ?, 'manual_adjustment', NULL, ?, ?)`
    ).run(customer.id, data.amount, data.reason, expiresAt);

    logAudit(
      req.user!,
      "store_credit_grant",
      "customer",
      customer.id,
      `Gave ${customer.name} Rs. ${data.amount.toLocaleString()} of store credit — ${data.reason}${data.expiry_days ? ` (valid ${data.expiry_days} days)` : ""}`
    );
    res.status(201).json({ store_credit: usableStoreCredit(customer.id) });
  })
);

// GET /api/customers/:id/amount-due — what a customer needs to pay right
// now: every invoice still owing money, the store credit they can use
// against it, and the net amount to pay. Same sources as the customer's
// own balance_due / store_credit_balance, so a payment request can never
// disagree with the ledger's Balance.
customersRouter.get(
  "/:id/amount-due",
  asyncHandler(async (req, res) => {
    const customer = db
      .prepare(`SELECT customers.id, customers.name, customers.customer_code, customers.phone, ${CALC_SUBQUERY} FROM customers WHERE customers.id = ?`)
      .get(req.params.id) as any;
    if (!customer) throw new ApiError(404, "Customer not found");

    const invoices = db
      .prepare(
        `SELECT id, invoice, date, total, amount_paid, ROUND(${REAL_OWED_SQL}, 2) AS balance
         FROM sales
         WHERE customer_id = ? AND is_voided = 0 AND status = 'completed' AND ${REAL_OWED_SQL} > 0.009
         ORDER BY date, id`
      )
      .all(req.params.id);

    const owed = customer.balance_due as number;
    const credit = customer.store_credit_balance as number;
    res.json({
      customer: { id: customer.id, name: customer.name, customer_code: customer.customer_code, phone: customer.phone },
      invoices,
      owed,
      store_credit: credit,
      amount_to_pay: Math.max(0, Math.round((owed - credit) * 100) / 100),
      // Exchanges whose old items are still on their way back, so the slip can say the balance is covered by them once they arrive.
      exchange_outcomes: (db.prepare(`SELECT id FROM sales WHERE customer_id = ? AND is_voided = 0 AND status = 'completed' AND EXISTS (SELECT 1 FROM online_exchanges px WHERE px.new_sale_id = sales.id AND px.status = 'awaiting_pickup') ORDER BY date, id`).all(req.params.id) as { id: number }[]).flatMap((x) => {
        const outcome = exchangeOutcomeForSale(x.id);
        return outcome ? [outcome] : [];
      }),
    });
  })
);

customersRouter.get(
  "/:id/credit-breakdown",
  asyncHandler(async (req, res) => {
    const customer = db.prepare(`SELECT id FROM customers WHERE id = ?`).get(req.params.id);
    if (!customer) throw new ApiError(404, "Customer not found");

    res.json(computeCreditGrantBreakdown(Number(req.params.id)));
  })
);

// GET /api/customers/:id/loyalty-ledger — the raw earned/redeemed
// history behind the single loyalty_points number, newest first. No
// FIFO/remaining-balance logic needed here (unlike store credit) since
// points don't expire or get consumed against specific grants — it's
// just a running total, so the plain transaction list is the whole
// story.
customersRouter.get(
  "/:id/loyalty-ledger",
  asyncHandler(async (req, res) => {
    const customer = db.prepare(`SELECT id FROM customers WHERE id = ?`).get(req.params.id);
    if (!customer) throw new ApiError(404, "Customer not found");

    // The sale link comes from a real join, not by parsing the invoice
    // number out of the notes sentence — reference_id already points
    // at the sale for 'sale' and reversal entries, so sale_id/invoice
    // are exact whenever there's a real sale behind this row.
    const entries = db
      .prepare(
        `SELECT lt.points, lt.reason, lt.notes, lt.created_at,
                sales.id AS sale_id, sales.invoice AS sale_invoice
         FROM loyalty_transactions lt
         LEFT JOIN sales ON sales.id = lt.reference_id AND lt.reason IN ('sale', 'manual_adjustment')
         WHERE lt.customer_id = ? ORDER BY lt.created_at DESC, lt.id DESC`
      )
      .all(req.params.id);

    res.json(entries);
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
//
// `onlySaleIds` limits it to the bills the customer chose to pay ("settle the third bill, leave the second part-paid"): still oldest
// first among those, and nothing else is touched.
export function computeFifoAllocation(customerId: number, amount: number, onlySaleIds?: number[]) {
  const scoped = onlySaleIds && onlySaleIds.length > 0;
  const outstandingSales = db
    .prepare(
      `SELECT id, invoice, date, total, amount_paid, ${REAL_OWED_SQL} AS real_owed
       FROM sales
       WHERE customer_id = ? AND is_voided = 0 AND status = 'completed' AND payment_status != 'paid'
       ${scoped ? `AND id IN (${onlySaleIds!.map(() => "?").join(",")})` : ""}
       ORDER BY date ASC, id ASC`
    )
    .all(customerId, ...(scoped ? onlySaleIds! : [])) as { id: number; invoice: string; date: string; total: number; amount_paid: number; real_owed: number }[];

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
    // What's really owed on this sale — not the part a COD is collecting.
    const owed = sale.real_owed;
    if (owed <= 0.009) continue;

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

const paymentPreviewInput = z.object({ amount: z.number().positive(), sale_ids: z.array(z.number().int().positive()).max(200).optional() });

// GET /api/customers/:id/open-bills — the bills this customer still owes on, oldest first, with what is really owed on each. The
// record-payment dialog lists them so a payment can be aimed at particular bills instead of always going to the oldest.
customersRouter.get(
  "/:id/open-bills",
  asyncHandler(async (req, res) => {
    const customer = db.prepare(`SELECT id FROM customers WHERE id = ?`).get(req.params.id);
    if (!customer) throw new ApiError(404, "Customer not found");
    const rows = db
      .prepare(
        `SELECT id AS sale_id, invoice, date, total, amount_paid, ${REAL_OWED_SQL} AS owed
         FROM sales
         WHERE customer_id = ? AND is_voided = 0 AND status = 'completed' AND payment_status != 'paid'
         ORDER BY date ASC, id ASC`
      )
      .all(req.params.id) as { sale_id: number; invoice: string; date: string; total: number; amount_paid: number; owed: number }[];
    res.json(rows.filter((r) => r.owed > 0.009));
  })
);

// POST /api/customers/:id/payment-preview — dry run only, no writes. Lets
// the UI show exactly which sales a payment amount would cover before
// the person actually confirms it.
customersRouter.post(
  "/:id/payment-preview",
  asyncHandler(async (req, res) => {
    const customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id);
    if (!customer) throw new ApiError(404, "Customer not found");

    const { amount, sale_ids } = paymentPreviewInput.parse(req.body);
    const result = computeFifoAllocation(Number(req.params.id), amount, sale_ids);
    res.json(result);
  })
);

const chequeItemInput = z.object({
  cheque_number: z.string().min(1, "Cheque number is required"),
  bank_name: z.string().min(1, "Bank name is required"),
  amount: z.number().positive(),
  cheque_date: z.string(),
  branch: z.string().optional(),
  // Whether the physical cheque is crossed — a fact about the paper
  // itself, read off it when recording the payment, not a choice made
  // here. Defaults to true (crossed) to match the column's own default.
  is_crossed: z.boolean().optional(),
  // Exactly who the cheque was made out to. Left unset/blank means it
  // was made out to "Cash".
  payee_name: z.string().optional(),
  // Whose bank account the cheque is drawn on, as printed on it. Left blank means the customer's own name.
  account_holder_name: z.string().trim().max(120).optional(),
});

const recordPaymentInput = z.object({
  amount: z.number().positive().optional(),
  method: z.enum(["cash", "bank_transfer", "cheque", "other"]),
  notes: z.string().optional(),
  // Only used when method is 'cheque' — one or more cheques handed over
  // together. Each becomes its own trackable cheque_receipts row (so it
  // can individually clear or bounce later), but all of their amounts
  // are summed into ONE combined FIFO allocation across the customer's
  // outstanding sales, applied as a single action — not one allocation
  // per cheque. `amount` above is ignored when this is set; the real
  // total is the sum of these.
  cheques: z.array(chequeItemInput).optional(),
  // Only valid with method 'other': settle the invoices out of the
  // customer's own store credit instead of taking money — no cash book
  // entry, since no money changed hands; the credit is spent down the
  // same way checkout does it.
  deduct_from_store_credit: z.boolean().optional(),
  // Pay these bills only (oldest first among them), leaving the customer's other bills as they are. Left out, the payment goes to
  // the oldest unpaid bills first. A payment aimed at particular bills can't be more than they owe.
  sale_ids: z.array(z.number().int().positive()).max(200).optional(),
});

// POST /api/customers/:id/payment — record a real credit-customer
// payment, applied FIFO across their outstanding sales, oldest first.
// For cash/bank_transfer/other: ONE cash book entry immediately, exactly
// as before. For cheque (one or several handed over together): the
// sales still flip to paid right away (the business's own choice — see
// the cheque design notes), but NO cash book entry is created yet,
// since the money isn't real until each cheque clears. Each cheque gets
// its own cheque_receipts row, individually trackable/clearable, but
// they all share ONE combined FIFO allocation (see computeFifoAllocation
// call below) rather than each doing its own separate allocation.
customersRouter.post(
  "/:id/payment",
  asyncHandler(async (req, res) => {
    const customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id) as any;
    if (!customer) throw new ApiError(404, "Customer not found");

    const data = recordPaymentInput.parse(req.body);

    const deductFromCredit = !!data.deduct_from_store_credit;
    if (deductFromCredit && data.method !== "other") {
      throw new ApiError(400, "Deducting from store credit is only available under 'Other'.");
    }

    const cheques = data.method === "cheque" ? data.cheques ?? [] : [];
    if (data.method === "cheque" && cheques.length === 0) {
      throw new ApiError(400, "Add at least one cheque");
    }
    const totalAmount = data.method === "cheque" ? cheques.reduce((sum, c) => sum + c.amount, 0) : data.amount;
    if (!totalAmount || totalAmount <= 0) {
      throw new ApiError(400, "Enter a valid amount");
    }

    // Same usable-credit rule as the customer's balance and checkout:
    // expired grants don't count, money already spent always does.
    if (deductFromCredit) {
      const { balance } = db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) as balance FROM store_credit_transactions
           WHERE customer_id = ? AND (expires_at IS NULL OR expires_at > datetime('now', '+330 minutes') OR amount < 0)`
        )
        .get(req.params.id) as { balance: number };
      if (totalAmount > balance) {
        throw new ApiError(409, `${customer.name} only has Rs. ${Math.max(0, balance).toLocaleString()} of store credit available.`);
      }
    }

    const chosenBills = [...new Set(data.sale_ids ?? [])];
    const { allocations, unapplied } = computeFifoAllocation(Number(req.params.id), totalAmount, chosenBills);

    if (chosenBills.length > 0) {
      // Every bill picked must still be one of this customer's open ones, and the payment must fit inside what they owe.
      const stillOpen = new Set(computeFifoAllocation(Number(req.params.id), Number.MAX_SAFE_INTEGER, chosenBills).allocations.map((a) => a.sale_id));
      if (chosenBills.some((id) => !stillOpen.has(id))) {
        throw new ApiError(409, "One of the bills you picked isn't open any more — close this and choose again.");
      }
      if (unapplied > 0.009) {
        const owed = Math.round((totalAmount - unapplied) * 100) / 100;
        throw new ApiError(409, `That's Rs. ${Math.round(unapplied).toLocaleString()} more than the Rs. ${owed.toLocaleString()} owed on the bills you picked.`);
      }
    }

    if (allocations.length === 0) {
      throw new ApiError(409, "This customer has no outstanding sales to apply a payment against");
    }

    const chequeReceiptIds: number[] = [];

    const runPayment = db.transaction(() => {
      for (const a of allocations) {
        db.prepare(`UPDATE sales SET amount_paid = ?, payment_status = ? WHERE id = ?`).run(
          a.new_amount_paid,
          a.new_status,
          a.sale_id
        );
      }

      const invoiceList = allocations.map((a) => a.invoice).join(", ");

      if (data.method === "cheque") {
        // Every cheque in this batch stores the SAME combined
        // allocation — a bounce on any one of them walks that shared
        // list backward (most-recently-settled sale first) up to that
        // specific cheque's own amount, leaving the other cheques and
        // sales beyond that point untouched.
        const sharedAllocationJson = JSON.stringify(allocations);
        for (const c of cheques) {
          const receiptResult = db
            .prepare(
              `INSERT INTO cheque_receipts (cheque_number, bank_name, amount, cheque_date, customer_id, sale_allocations, notes, branch, is_crossed, payee_name, sale_scope, account_holder_name)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              c.cheque_number.trim(),
              c.bank_name.trim(),
              c.amount,
              c.cheque_date,
              req.params.id,
              sharedAllocationJson,
              `From ${customer.name} (${customer.customer_code}) — part of a combined payment applied to ${invoiceList}${
                data.notes?.trim() ? ` — ${data.notes.trim()}` : ""
              }`,
              c.branch?.trim() || null,
              c.is_crossed === false ? 0 : 1,
              c.payee_name?.trim() || null,
              chosenBills.length > 0 ? JSON.stringify(chosenBills) : null,
              c.account_holder_name?.trim() || null
            );
          chequeReceiptIds.push(Number(receiptResult.lastInsertRowid));
        }
      } else if (deductFromCredit) {
        // One redemption row per invoice it settled, each pointing at
        // that sale — exactly how checkout records credit being spent —
        // so voiding a sale later can give its credit back. Only what was
        // actually applied is spent; any unapplied excess is never taken.
        for (const a of allocations) {
          db.prepare(
            `INSERT INTO store_credit_transactions (customer_id, amount, reason, reference_id, notes)
             VALUES (?, ?, 'redemption', ?, ?)`
          ).run(
            req.params.id,
            -a.applied,
            a.sale_id,
            `Applied to invoice ${a.invoice} (deducted from store credit)${data.notes?.trim() ? ` — ${data.notes.trim()}` : ""}`
          );
        }
      } else {
        // Only what was applied to invoices is the payment; anything beyond what they owed
        // is kept as store credit, as the preview says ("Left as credit") — its own cash
        // book line and credit entry, so nothing received is left unaccounted for.
        const excess = Math.round(unapplied * 100) / 100;
        const appliedTotal = Math.round((totalAmount - excess) * 100) / 100;
        db.prepare(
          `INSERT INTO cash_book (transaction_code, type, category, payment_method, reference_id, amount, notes)
           VALUES (?, 'income', 'customer_payment', ?, ?, ?, ?)`
        ).run(
          nextTransactionCode(),
          data.method,
          req.params.id,
          appliedTotal,
          `Payment from ${customer.name} (${customer.customer_code}) — applied to ${invoiceList}${
            data.notes?.trim() ? ` — ${data.notes.trim()}` : ""
          }`
        );
        if (excess > 0.009) {
          db.prepare(
            `INSERT INTO cash_book (transaction_code, type, category, payment_method, reference_id, amount, notes)
             VALUES (?, 'income', 'customer_credit', ?, ?, ?, ?)`
          ).run(
            nextTransactionCode(),
            data.method,
            req.params.id,
            excess,
            `Rs. ${excess.toLocaleString()} paid over what ${customer.name} (${customer.customer_code}) owed — kept as store credit`
          );
          db.prepare(
            `INSERT INTO store_credit_transactions (customer_id, amount, reason, reference_id, notes, expires_at)
             VALUES (?, ?, 'overpayment', NULL, ?, NULL)`
          ).run(req.params.id, excess, `Paid over what was owed (${invoiceList})`);
        }
      }
    });

    runPayment();

    const updatedCustomer = db
      .prepare(`SELECT customers.*, ${CALC_SUBQUERY} FROM customers WHERE customers.id = ?`)
      .get(req.params.id);

    res.status(201).json({ customer: updatedCustomer, allocations, unapplied, cheque_receipt_ids: chequeReceiptIds });
  })
);

const redeemLoyaltyInput = z.object({
  points: z.number().int().positive(),
});

const loyaltyAdjustInput = z.object({
  // negative takes points away, positive gives some back
  points: z.number().int().refine((n) => n !== 0, "Enter how many points"),
  reason: z.string().trim().min(3, "A reason is required"),
});

// POST /api/customers/:id/loyalty-adjust — admin-only. Takes points away
// (e.g. they were earned on wholesale buying) or gives some back (to undo a
// mistake), always with a reason. It's one more entry in the loyalty
// ledger, so the history shows exactly what changed, when and why — nothing
// earlier is edited or deleted.
customersRouter.post(
  "/:id/loyalty-adjust",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT id, name FROM customers WHERE id = ?`).get(req.params.id) as { id: number; name: string } | undefined;
    if (!existing) throw new ApiError(404, "Customer not found");
    const data = loyaltyAdjustInput.parse(req.body);

    const balance = loyaltyBalance(existing.id);
    if (data.points < 0 && -data.points > balance) {
      throw new ApiError(400, `${existing.name} only has ${balance} points — you can remove at most that many.`);
    }

    db.prepare(`INSERT INTO loyalty_transactions (customer_id, points, reason, notes) VALUES (?, ?, 'manual_adjustment', ?)`).run(
      existing.id,
      data.points,
      `${data.points < 0 ? "Removed" : "Added"} by staff — ${data.reason}`
    );
    logAudit(
      req.user!,
      "loyalty_adjust",
      "customer",
      existing.id,
      `${data.points < 0 ? "Removed" : "Added"} ${Math.abs(data.points)} loyalty points ${data.points < 0 ? "from" : "to"} ${existing.name} — ${data.reason}`
    );

    res.json(db.prepare(`SELECT customers.*, ${CALC_SUBQUERY} FROM customers WHERE customers.id = ?`).get(existing.id));
  })
);

const loyaltyBlockInput = z.object({
  blocked: z.boolean(),
  reason: z.string().trim().optional(),
});

// PUT /api/customers/:id/loyalty-block — admin-only. A blocked customer
// never earns loyalty points on new sales (a wholesale buyer, say); POS
// shows it and records the sale without points. Points they already have
// are untouched — take those away separately with loyalty-adjust.
customersRouter.put(
  "/:id/loyalty-block",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT id, name FROM customers WHERE id = ?`).get(req.params.id) as { id: number; name: string } | undefined;
    if (!existing) throw new ApiError(404, "Customer not found");
    const data = loyaltyBlockInput.parse(req.body);

    if (data.blocked) {
      if (!data.reason || data.reason.length < 3) throw new ApiError(400, "A reason is required to block loyalty points.");
      db.prepare(
        `UPDATE customers SET loyalty_blocked = 1, loyalty_block_reason = ?, loyalty_blocked_at = datetime('now', '+330 minutes') WHERE id = ?`
      ).run(data.reason, existing.id);
      logAudit(req.user!, "loyalty_block", "customer", existing.id, `Blocked loyalty points for ${existing.name} — ${data.reason}`);
    } else {
      db.prepare(`UPDATE customers SET loyalty_blocked = 0, loyalty_block_reason = NULL, loyalty_blocked_at = NULL WHERE id = ?`).run(existing.id);
      logAudit(req.user!, "loyalty_block", "customer", existing.id, `Allowed loyalty points again for ${existing.name}`);
    }

    res.json(db.prepare(`SELECT customers.*, ${CALC_SUBQUERY} FROM customers WHERE customers.id = ?`).get(existing.id));
  })
);

// POST /api/customers/:id/redeem-loyalty-points — trade loyalty
// points in for store credit, reusing the existing store-credit
// ledger (and its checkout redemption, already wired in) rather than
// building a separate discount mechanism. Requires the customer's
// balance to have reached LOYALTY_REDEMPTION_MIN_BALANCE — once past
// that, any amount up to their full balance can be redeemed, not just
// the amount above the minimum.
customersRouter.post(
  "/:id/redeem-loyalty-points",
  asyncHandler(async (req, res) => {
    const customer = db
      .prepare(`SELECT customers.*, ${CALC_SUBQUERY} FROM customers WHERE customers.id = ?`)
      .get(req.params.id) as any;
    if (!customer) throw new ApiError(404, "Customer not found");

    const { points } = redeemLoyaltyInput.parse(req.body);

    if (customer.loyalty_points < LOYALTY_REDEMPTION_MIN_BALANCE) {
      throw new ApiError(
        409,
        `${customer.name} needs at least ${LOYALTY_REDEMPTION_MIN_BALANCE} points before any redemption (currently ${customer.loyalty_points})`
      );
    }
    if (points > customer.loyalty_points) {
      throw new ApiError(400, `Only ${customer.loyalty_points} points are available to redeem`);
    }

    const creditAmount = points * LOYALTY_POINT_VALUE;

    const runRedemption = db.transaction(() => {
      db.prepare(`INSERT INTO loyalty_transactions (customer_id, points, reason, notes) VALUES (?, ?, 'redemption', ?)`).run(
        req.params.id,
        -points,
        `Redeemed ${points} points for Rs. ${creditAmount} store credit`
      );

      db.prepare(`INSERT INTO store_credit_transactions (customer_id, amount, reason, notes) VALUES (?, ?, 'redemption', ?)`).run(
        req.params.id,
        creditAmount,
        `From ${points} redeemed loyalty points`
      );
    });

    runRedemption();

    const updatedCustomer = db
      .prepare(`SELECT customers.*, ${CALC_SUBQUERY} FROM customers WHERE customers.id = ?`)
      .get(req.params.id);

    res.status(201).json({ customer: updatedCustomer, credit_granted: creditAmount });
  })
);
