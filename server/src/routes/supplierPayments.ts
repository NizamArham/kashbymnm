import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const supplierPaymentsRouter = Router();

// Financial data — admin only.
supplierPaymentsRouter.use(requireAuth, requireRole("admin"));

const paymentInput = z.object({
  supplier_id: z.number().int().positive(),
  purchase_id: z.number().int().positive().optional(),
  amount: z.number().positive(),
  method: z.string().optional(),
  // Only meaningful when method is 'bank_transfer' — which of the
  // supplier's on-file accounts the money is actually going to.
  bank_account_id: z.number().int().positive().optional(),
  is_partial: z.boolean().optional(),
  notes: z.string().optional(),
});

// GET /api/supplier-payments — optionally filter by ?supplier_id=,
// ?start=, ?end= (date range), paginated via ?page= and ?pageSize=.
// Default page size is small (5) for the everyday "just the recent
// ones" view; a date range typically comes with a larger page size
// (e.g. 50) from the frontend, since picking a range is already a
// deliberate, bounded query rather than "show me everything ever."
supplierPaymentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const conditions: string[] = [];
    const params: any[] = [];

    if (req.query.supplier_id) {
      conditions.push("supplier_payments.supplier_id = ?");
      params.push(req.query.supplier_id);
    }
    if (req.query.start) {
      conditions.push("supplier_payments.payment_date >= ?");
      params.push(req.query.start);
    }
    if (req.query.end) {
      conditions.push("supplier_payments.payment_date <= ?");
      params.push(`${req.query.end} 23:59:59`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.pageSize ?? "5"), 10) || 5));
    const offset = (page - 1) * pageSize;

    const totalRow = db
      .prepare(`SELECT COUNT(*) as count FROM supplier_payments ${where}`)
      .get(...params) as { count: number };

    const rows = db
      .prepare(
        `SELECT supplier_payments.*, suppliers.name as supplier_name
         FROM supplier_payments
         JOIN suppliers ON suppliers.id = supplier_payments.supplier_id
         ${where}
         ORDER BY supplier_payments.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);

    res.json({ rows, total: totalRow.count, page, pageSize });
  })
);

// POST /api/supplier-payments — record a standalone payment
supplierPaymentsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = paymentInput.parse(req.body);

    const supplier = db.prepare(`SELECT id FROM suppliers WHERE id = ?`).get(data.supplier_id);
    if (!supplier) throw new ApiError(400, "Referenced supplier does not exist");

    let accountNote = "";
    if (data.method === "bank_transfer") {
      if (!data.bank_account_id) {
        throw new ApiError(400, "Select which of the supplier's bank accounts to pay into");
      }
      const account = db
        .prepare(`SELECT * FROM supplier_bank_accounts WHERE id = ? AND supplier_id = ?`)
        .get(data.bank_account_id, data.supplier_id) as any;
      if (!account) throw new ApiError(400, "That bank account isn't on file for this supplier");
      accountNote = ` — ${account.bank_name} ${account.account_number}`;
    }

    const runTransaction = db.transaction(() => {
      const result = db
        .prepare(
          `INSERT INTO supplier_payments (supplier_id, purchase_id, amount, method, is_partial, notes)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          data.supplier_id,
          data.purchase_id ?? null,
          data.amount,
          data.method ?? null,
          data.is_partial ? 1 : 0,
          `${data.notes ?? ""}${accountNote}`.trim() || null
        );

      db.prepare(
        `INSERT INTO cash_book (type, category, payment_method, reference_id, amount, notes)
         VALUES ('expense', 'supplier_payment', ?, ?, ?, ?)`
      ).run(data.method ?? null, result.lastInsertRowid, data.amount, `${data.notes ?? "Supplier payment"}${accountNote}`);

      // If tied to a specific purchase, keep that purchase's payment_status current.
      if (data.purchase_id) {
        const purchase = db
          .prepare(`SELECT * FROM purchases WHERE id = ?`)
          .get(data.purchase_id) as any;
        if (purchase) {
          const totalPaid = db
            .prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM supplier_payments WHERE purchase_id = ?`)
            .get(data.purchase_id) as { total: number };

          let status: "paid" | "partial" | "unpaid" = "unpaid";
          if (totalPaid.total >= purchase.total_cost && purchase.total_cost > 0) status = "paid";
          else if (totalPaid.total > 0) status = "partial";

          db.prepare(`UPDATE purchases SET amount_paid = ?, payment_status = ? WHERE id = ?`).run(
            totalPaid.total,
            status,
            data.purchase_id
          );
        }
      }

      return result.lastInsertRowid;
    });

    const id = runTransaction();
    const created = db.prepare(`SELECT * FROM supplier_payments WHERE id = ?`).get(id);
    res.status(201).json(created);
  })
);

// GET /api/supplier-payments/summary — the "Supplier Summary" report,
// computed live rather than stored (purchases total vs payments total
// vs available credit per supplier). Credit comes from damaged-goods
// returns the supplier agreed to cover as a future discount rather than
// an immediate cash refund — it reduces what's actually still owed, the
// same as a payment would.
supplierPaymentsRouter.get(
  "/summary",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT
           suppliers.id, suppliers.supplier_code, suppliers.name,
           COALESCE((SELECT SUM(total_cost) FROM purchases WHERE supplier_id = suppliers.id), 0) as total_purchased,
           COALESCE((SELECT SUM(amount_paid) FROM purchases WHERE supplier_id = suppliers.id), 0) as total_paid,
           COALESCE((SELECT SUM(amount) FROM supplier_credit_transactions WHERE supplier_id = suppliers.id), 0) as credit_balance,
           COALESCE((SELECT SUM(total_cost) FROM purchases WHERE supplier_id = suppliers.id), 0) -
           COALESCE((SELECT SUM(amount_paid) FROM purchases WHERE supplier_id = suppliers.id), 0) -
           COALESCE((SELECT SUM(amount) FROM supplier_credit_transactions WHERE supplier_id = suppliers.id), 0) as balance_owed
         FROM suppliers
         ORDER BY suppliers.name ASC`
      )
      .all();
    res.json(rows);
  })
);

// GET /api/supplier-payments/ledger/:supplierId — a single supplier's
// full running ledger: every purchase (increases what's owed), every
// payment (reduces it), and every credit from a return (also reduces
// it) — merged into one chronological timeline with a running balance
// computed as we go, so it reads like a real statement: "owed 8750, paid
// 5000 -> 3750 owed, credited 3000 -> 750 owed."
supplierPaymentsRouter.get(
  "/ledger/:supplierId",
  asyncHandler(async (req, res) => {
    const supplier = db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.supplierId);
    if (!supplier) throw new ApiError(404, "Supplier not found");

    const purchases = db
      .prepare(`SELECT id, purchase_code, purchase_date, total_cost, amount_paid FROM purchases WHERE supplier_id = ? ORDER BY purchase_date`)
      .all(req.params.supplierId) as any[];
    // For each purchase, how much of its amount_paid is ALREADY
    // reflected in a separate supplier_payments row tied to it — since
    // amount_paid is kept as a running SUM of exactly those rows
    // whenever a payment is linked to a purchase (see the payment
    // recording endpoint above). Only the REMAINDER — money that was
    // set directly on the purchase with no linked payment row at all,
    // e.g. opening stock's amount_paid = total_cost at import — should
    // be netted into the purchase's own ledger entry. Otherwise a
    // linked payment would be counted twice: once folded into the
    // purchase, and again as its own line further down.
    const linkedPaymentTotals = db
      .prepare(
        `SELECT purchase_id, COALESCE(SUM(amount), 0) as total FROM supplier_payments
         WHERE purchase_id IN (SELECT id FROM purchases WHERE supplier_id = ?)
         GROUP BY purchase_id`
      )
      .all(req.params.supplierId) as { purchase_id: number; total: number }[];
    const linkedPaymentByPurchase = new Map(linkedPaymentTotals.map((row) => [row.purchase_id, row.total]));
    const payments = db
      .prepare(`SELECT id, payment_date, amount, method, purchase_id FROM supplier_payments WHERE supplier_id = ? ORDER BY payment_date`)
      .all(req.params.supplierId) as any[];
    const credits = db
      .prepare(
        `SELECT id, created_at, amount, reason, notes FROM supplier_credit_transactions WHERE supplier_id = ? ORDER BY created_at`
      )
      .all(req.params.supplierId) as any[];
    // Shown purely as a record of what happened — never double-counted
    // toward the balance, since a cash_refund never touches what's
    // owed (it's a straight cash-in-hand transaction, recorded only in
    // the cash book) and a supplier_credit resolution is already
    // reflected above via its own supplier_credit_transactions row.
    const returns = db
      .prepare(
        `SELECT id, created_at, total_amount, resolution, reason FROM purchase_returns WHERE supplier_id = ? ORDER BY created_at`
      )
      .all(req.params.supplierId) as any[];

    // Merge all three into one timeline, each entry tagged with its type
    // and the amount's effect on balance (+owed for a purchase, -owed
    // for a payment; a credit's effect is its own signed amount, since
    // a grant reduces what's owed and a spend-down against a purchase
    // increases it back — mirroring the exact real balance formula used
    // everywhere else (purchases - payments - credit_transactions), so
    // this ledger's running balance always reconciles with it.
    type LedgerEntry = { date: string; type: "purchase" | "payment" | "credit" | "return"; label: string; amount: number; effect: number };
    const entries: LedgerEntry[] = [
      ...purchases.map((p) => {
        // Only the portion of amount_paid NOT already covered by a
        // linked supplier_payments row belongs on the purchase's own
        // line — that linked portion gets its own entry further down
        // (in the payments list) and must not be counted here too.
        const linkedAlready = linkedPaymentByPurchase.get(p.id) ?? 0;
        const unlinkedPaid = Math.max(0, (p.amount_paid || 0) - linkedAlready);
        const netOwed = p.total_cost - unlinkedPaid;
        const wasPrepaid = unlinkedPaid > 0;
        return {
          date: p.purchase_date,
          type: "purchase" as const,
          label: `Purchase ${p.purchase_code}${
            wasPrepaid ? (netOwed <= 0 ? " (paid in full at purchase)" : ` (Rs. ${unlinkedPaid.toLocaleString()} paid at purchase)`) : ""
          }`,
          amount: Math.abs(netOwed),
          effect: netOwed,
        };
      }),
      ...payments.map((p) => ({
        date: p.payment_date,
        type: "payment" as const,
        label: `Payment${p.method ? ` (${p.method})` : ""}`,
        amount: p.amount,
        effect: -p.amount,
      })),
      ...credits.map((c) => ({
        date: c.created_at,
        type: "credit" as const,
        label:
          c.amount > 0
            ? c.notes || "Credit from return"
            : `Credit applied${c.notes ? ` — ${c.notes}` : ""}`,
        amount: Math.abs(c.amount),
        effect: -c.amount,
      })),
      ...returns.map((r) => ({
        date: r.created_at,
        type: "return" as const,
        label: `Return (${r.resolution === "cash_refund" ? "cash refund" : "credited"})${r.reason ? ` — ${r.reason}` : ""}`,
        amount: r.total_amount,
        // Zero effect — never double-counted. A cash_refund is settled
        // straight to the cash book, outside the supplier balance
        // entirely; a supplier_credit resolution already appears as
        // its own "credit" entry above.
        effect: 0,
      })),
    ].sort((a, b) => a.date.localeCompare(b.date));

    let runningBalance = 0;
    const withBalance = entries.map((entry) => {
      runningBalance += entry.effect;
      return { ...entry, running_balance: runningBalance };
    });

    res.json({ supplier, entries: withBalance, final_balance: runningBalance });
  })
);
