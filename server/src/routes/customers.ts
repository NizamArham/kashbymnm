import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { nextCustomerCode, nextTransactionCode } from "../lib/codes";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";
import { logAudit } from "../lib/auditLog";
import { storeCreditSources } from "../lib/storeCreditSources";

export const customersRouter = Router();

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
       AND (expires_at IS NULL OR expires_at > datetime('now', '+330 minutes') OR amount < 0)),
    0
  )
`;

const CALC_SUBQUERY = `
  customers.bonus_points +
  COALESCE((SELECT SUM(points) FROM loyalty_transactions WHERE customer_id = customers.id), 0) AS loyalty_points,
  COALESCE((SELECT SUM(total - amount_paid) FROM sales WHERE customer_id = customers.id AND is_voided = 0 AND status = 'completed'), 0) AS balance_due,
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

    const bankAccounts = db
      .prepare(`SELECT * FROM customer_bank_accounts WHERE customer_id = ? ORDER BY is_default DESC, id ASC`)
      .all(req.params.id);

    res.json({ ...customer, addresses, bank_accounts: bankAccounts });
  })
);

// POST /api/customers — auto-generates customer_code
customersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = customerInput.parse(req.body);
    const customer_code = nextCustomerCode(data.gender);

    const result = db
      .prepare(
        `INSERT INTO customers (customer_code, name, phone, phone2, bonus_points, gender) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(customer_code, data.name, data.phone ?? null, data.phone2 ?? null, data.bonus_points ?? 0, data.gender);

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
    const feePaidRows = db
      .prepare(`SELECT sale_id, SUM(fee_paid) as fee FROM deliveries WHERE fee_paid > 0 GROUP BY sale_id`)
      .all() as { sale_id: number; fee: number }[];
    const feeLeft = new Map(feePaidRows.map((r) => [r.sale_id, r.fee]));
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
      type: "sale" | "payment" | "cheque" | "credit";
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
      return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
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

    const entries: LedgerEntry[] = [
      ...sales.map((s) => ({
        date: s.date,
        type: "sale" as const,
        label: `Sale ${s.invoice}`,
        amount: s.total,
        effect: s.total,
        sale_id: s.id,
        sale_invoice: s.invoice,
      })),
      ...payments.map((p) => ({
        date: p.entry_date,
        type: "payment" as const,
        label: `Payment${p.payment_method ? ` (${methodLabel(p.payment_method)})` : ""}`,
        amount: p.amount,
        effect: -p.amount,
        transaction_code: p.transaction_code,
      })),
      ...salePayments.map((p) => {
        const deliveryPart = Math.min(feeLeft.get(p.reference_id) ?? 0, p.amount);
        if (deliveryPart > 0) feeLeft.set(p.reference_id, (feeLeft.get(p.reference_id) ?? 0) - deliveryPart);
        const baseLabel = p.notes || `Payment${p.payment_method ? ` (${methodLabel(p.payment_method)})` : ""}`;
        explain(p.reference_id, p.amount - deliveryPart);
        return {
          date: p.entry_date,
          type: "payment" as const,
          label: deliveryPart > 0 ? `${baseLabel} (incl. Rs. ${deliveryPart.toLocaleString()} delivery fee)` : baseLabel,
          amount: p.amount,
          effect: -(p.amount - deliveryPart),
          transaction_code: p.transaction_code,
          sale_id: p.reference_id,
        };
      }),
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
        const kind = e.type === "credit" ? (e.credit_reason === "return_exchange" ? "return" : "credit") : e.type;
        const title = e.title ?? (e.type === "sale" ? e.sale_invoice : e.label.replace(/^Payment \((.+)\)$/, "$1"));
        const details = e.type === "sale" && e.sale_id != null && detailsBySale.has(e.sale_id) ? detailsBySale.get(e.sale_id) : e.details;
        return { ...e, kind, title, ...(details ? { details } : {}) };
      });

    res.json({ customer, entries: visible, final_balance: runningBalance });
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
        `SELECT id, invoice, date, total, amount_paid, ROUND(total - amount_paid, 2) AS balance
         FROM sales
         WHERE customer_id = ? AND is_voided = 0 AND status = 'completed' AND total - amount_paid > 0.009
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
export function computeFifoAllocation(customerId: number, amount: number) {
  const outstandingSales = db
    .prepare(
      `SELECT id, invoice, date, total, amount_paid
       FROM sales
       WHERE customer_id = ? AND is_voided = 0 AND status = 'completed' AND payment_status != 'paid'
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

    const { allocations, unapplied } = computeFifoAllocation(Number(req.params.id), totalAmount);

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
              `INSERT INTO cheque_receipts (cheque_number, bank_name, amount, cheque_date, customer_id, sale_allocations, notes, branch, is_crossed, payee_name)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
              c.payee_name?.trim() || null
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
        db.prepare(
          `INSERT INTO cash_book (transaction_code, type, category, payment_method, reference_id, amount, notes)
           VALUES (?, 'income', 'customer_payment', ?, ?, ?, ?)`
        ).run(
          nextTransactionCode(),
          data.method,
          req.params.id,
          totalAmount,
          `Payment from ${customer.name} (${customer.customer_code}) — applied to ${invoiceList}${
            data.notes?.trim() ? ` — ${data.notes.trim()}` : ""
          }`
        );
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
