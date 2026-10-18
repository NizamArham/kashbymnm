import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { nextTransactionCode } from "../lib/codes";
import { requireAuth, requireRole, AuthUser } from "../lib/auth";
import { requireAdminOrApproval, recordedByAdmin, actorOf } from "../lib/approval";
import { logAudit } from "../lib/auditLog";
import { LOYALTY_RATE_PERCENT } from "./sales";
import { returnsInRange } from "../lib/returnedRevenue";
import { exchangeQuoteSummary, itemInActiveExchange } from "../lib/exchanges";
import { itemInActivePickup, listPickups } from "../lib/onlineReturns";
import { holdEndOf } from "../lib/stockHolds";
import { refundEventByKey } from "../lib/refunds";

export const returnsRouter = Router();

// A request an admin recorded themselves is approved on the spot — flagged so the history can say "Auto-approved (recorded by admin)"
// instead of looking like someone else approved it. Rows from before this existed were all decided by hand.
if (!(db.prepare(`PRAGMA table_info(return_requests)`).all() as { name: string }[]).some((c) => c.name === "auto_approved")) {
  db.exec(`ALTER TABLE return_requests ADD COLUMN auto_approved INTEGER NOT NULL DEFAULT 0`);
}

// Staff can submit requests and view history; only admins can approve/decline.
returnsRouter.use(requireAuth);

// The loyalty points the customer earned on ONE item of a sale — its
// share of the points the sale earned (1% of what they actually paid
// after discounts), taken from the sale's original subtotal/discount so
// it stays accurate however many other items on the same sale have
// already been returned. Points on goods that came back are taken back
// again, whether the money goes back as a refund or as store credit —
// otherwise a customer keeps the points on something they returned, and
// then earns them a second time on the replacement they buy.
function pointsEarnedOnItem(item: { unit_price: number; subtotal: number; discount: number; loyalty_points_earned: number }): number {
  if (item.subtotal <= 0) return 0;
  const paidShare = (item.subtotal - item.discount) / item.subtotal;
  return Math.min(item.loyalty_points_earned, Math.max(0, Math.floor(item.unit_price * paidShare * LOYALTY_RATE_PERCENT)));
}

const requestInput = z.object({
  sale_item_id: z.number().int().positive(),
  condition: z.enum(["clean", "damaged"]),
  resolution: z.enum(["refund", "exchange", "store_credit_exchange"]),
  reason: z.string().min(1, "A reason is required to submit a return request"),
  exchange_inventory_id: z.number().int().positive().optional(),
  // Only meaningful for store_credit_exchange. 45 is the real default —
  // anything else is a deliberate exception, chosen at request time, not
  // an equally-weighted option.
  credit_expiry_days: z.number().int().positive().default(45),
  // Only used when an admin records the return themselves (it is approved straight away, so how a refund is paid is decided now).
  payment_method: z.enum(["cash", "bank_transfer"]).optional(),
  bank_account_id: z.number().int().positive().optional(),
});

const decisionInput = z.object({
  decision_reason: z.string().optional(),
  // Only meaningful when approving a 'refund' — how the money actually
  // goes back. 'bank_transfer' requires an account already on file for
  // this customer (see the lookup below); there's no fallback to "just
  // trust an address" the way cash needs nothing at all.
  payment_method: z.enum(["cash", "bank_transfer"]).optional(),
  bank_account_id: z.number().int().positive().optional(),
});

const REQUEST_SELECT = `
  SELECT return_requests.*, sale_items.sale_id, sale_items.unit_price, sale_items.quantity as item_quantity,
         sales.invoice, sales.customer_id, sales.deleted_customer_snapshot, customers.name as customer_name,
         inventory.sku, inventory.color, inventory.size,
         COALESCE(products.product_title, sale_items.product_snapshot) as product_title,
         products.id as product_id,
         COALESCE(products.allow_returns, 0) as allow_returns,
         requester.name as requested_by_name, decider.name as decided_by_name,
         returns.refund_amount,
         EXISTS (SELECT 1 FROM cash_book cb WHERE cb.category = 'return_refund' AND cb.reference_id = return_requests.return_id) AS refund_paid
  FROM return_requests
  JOIN sale_items ON sale_items.id = return_requests.sale_item_id
  JOIN sales ON sales.id = sale_items.sale_id
  LEFT JOIN customers ON customers.id = sales.customer_id
  LEFT JOIN inventory ON inventory.id = sale_items.inventory_id
  LEFT JOIN products ON products.id = inventory.product_id
  LEFT JOIN users requester ON requester.id = return_requests.requested_by
  LEFT JOIN users decider ON decider.id = return_requests.decided_by
  LEFT JOIN returns ON returns.id = return_requests.return_id
`;

// GET /api/returns/requests — full history, most recent first. Frontend
// applies its own date-range/quick-filter on top of this.
returnsRouter.get(
  "/requests",
  asyncHandler(async (_req, res) => {
    const rows = db.prepare(`${REQUEST_SELECT} ORDER BY return_requests.id DESC`).all();
    res.json(rows);
  })
);

// GET /api/returns/requests/pending — just the pending queue, for the
// admin's approval screen.
returnsRouter.get(
  "/requests/pending",
  asyncHandler(async (_req, res) => {
    const rows = db.prepare(`${REQUEST_SELECT} WHERE return_requests.status = 'pending' ORDER BY return_requests.id ASC`).all();
    res.json(rows);
  })
);

// GET /api/returns/approvals — everything waiting for an admin's yes, whichever way it came: a return at the shop (in_store), a courier
// return request (courier), the inspection report of a courier return that has arrived (courier_reports) and a delivery exchange
// (exchanges). One list to decide from; the Returns page's "To approve" tab.
returnsRouter.get(
  "/approvals",
  asyncHandler(async (_req, res) => {
    const inStore = db.prepare(`${REQUEST_SELECT} WHERE return_requests.status = 'pending' ORDER BY return_requests.id ASC`).all();
    const courier = listPickups("pending").reverse();
    const courierReports = listPickups("report").reverse();
    const exchangeRows = db
      .prepare(
        `SELECT sales.*, customers.name AS customer_name, customers.phone AS customer_phone
         FROM sales LEFT JOIN customers ON customers.id = sales.customer_id
         WHERE sales.status = 'quotation' AND sales.exchange_draft IS NOT NULL AND sales.approval_status = 'pending'
         ORDER BY sales.id ASC`
      )
      .all() as any[];
    const exchanges = exchangeRows.map((r) => ({
      ...r,
      hold_until: holdEndOf(r.id),
      exchange_quote: exchangeQuoteSummary(r),
      new_items: db
        .prepare(
          `SELECT si.unit_price, COALESCE(p.product_title, si.product_snapshot) AS title, i.size, i.color
           FROM sale_items si LEFT JOIN inventory i ON i.id = si.inventory_id LEFT JOIN products p ON p.id = i.product_id
           WHERE si.sale_id = ? ORDER BY si.id`
        )
        .all(r.id),
    }));
    res.json({ in_store: inStore, courier, courier_reports: courierReports, exchanges });
  })
);

// GET /api/returns/approvals/count — just how many are waiting, for the badge on the Returns menu item.
returnsRouter.get(
  "/approvals/count",
  asyncHandler(async (_req, res) => {
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    res.json({
      count:
        n(`SELECT COUNT(*) AS n FROM return_requests WHERE status = 'pending'`) +
        n(`SELECT COUNT(*) AS n FROM online_returns WHERE stage IN ('requested', 'report_pending')`) +
        n(`SELECT COUNT(*) AS n FROM sales WHERE status = 'quotation' AND exchange_draft IS NOT NULL AND approval_status = 'pending'`),
    });
  })
);

// GET /api/returns/refund-slips/:key — everything the "Refund payment done" slip needs: who was paid, how (and to which bank account), for
// which invoice and items, what was held back, the cash-book transaction IDs and who paid. key is "pickup-<id>" (a courier return) or
// "return-<id>" (a refund at the shop).
returnsRouter.get(
  "/refund-slips/:key",
  asyncHandler(async (req, res) => {
    const event = refundEventByKey(req.params.key);
    if (!event) throw new ApiError(404, "No refund payment found for that");
    res.json(event);
  })
);

// GET /api/returns/revenue-impact?start=YYYY-MM-DD&end=YYYY-MM-DD — what was
// handed back (store credit for returned items, cash/bank refunds) on each day
// in the range, so a revenue figure can be shown net of returns. Same rule as
// the Analytics page — see lib/returnedRevenue.ts.
returnsRouter.get(
  "/revenue-impact",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const start = String(req.query.start ?? "");
    const end = String(req.query.end ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      throw new ApiError(400, "start and end must be YYYY-MM-DD");
    }
    const byDay = new Map<string, { amount: number; count: number }>();
    for (const r of returnsInRange(start, end)) {
      const day = byDay.get(r.day) ?? { amount: 0, count: 0 };
      day.amount += r.amount;
      day.count += 1;
      byDay.set(r.day, day);
    }
    res.json({ days: Array.from(byDay, ([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)) });
  })
);

// POST /api/returns/requests — staff submits a return request. This
// NEVER touches stock, cash book, or loyalty points — it only exists as
// a pending record until an admin decides on it.
returnsRouter.post(
  "/requests",
  asyncHandler(async (req, res) => {
    const data = requestInput.parse(req.body);

    const saleItem = db
      .prepare(
        `SELECT sale_items.*, products.allow_returns, products.product_title, sales.customer_id
         FROM sale_items
         JOIN inventory ON inventory.id = sale_items.inventory_id
         JOIN products ON products.id = inventory.product_id
         JOIN sales ON sales.id = sale_items.sale_id
         WHERE sale_items.id = ?`
      )
      .get(data.sale_item_id) as any;

    // A deliberately unmodified inner join: if the product behind this
    // sale item has since been deleted, there's no live product to
    // return the unit to and no allow_returns to check — this correctly
    // falls through to "Sale item not found" below rather than letting
    // a new return request get submitted against something that no
    // longer exists. Existing/historical return records are unaffected
    // (see REQUEST_SELECT above, which uses LEFT JOIN for display).
    if (!saleItem) throw new ApiError(404, "Sale item not found");

    // An item that's part of an online exchange is dealt with there — returning it
    // here too would credit it twice.
    if (itemInActiveExchange(data.sale_item_id)) {
      throw new ApiError(409, "This item is part of an online exchange — it's received from that replacement order, not returned separately.");
    }

    // …and one waiting for a courier to collect it is dealt with there, when it arrives.
    if (itemInActivePickup(data.sale_item_id)) {
      throw new ApiError(409, "This item is on its way back by delivery — it's received (and the customer paid back) from that return, not returned separately.");
    }

    const alreadyHandled = db
      .prepare(`SELECT id FROM return_requests WHERE sale_item_id = ? AND status IN ('pending','approved')`)
      .get(data.sale_item_id);
    if (alreadyHandled) {
      throw new ApiError(409, "This item already has a pending or approved return request.");
    }

    // A Final Sale product can still have a request submitted (an admin
    // may want to override it), but the frontend should make clear this
    // will need an explicit override — flagged here so the record itself
    // shows whether the product normally disallows returns.
    const isFinalSale = saleItem.allow_returns === 0;

    if (data.resolution === "exchange" && !data.exchange_inventory_id) {
      throw new ApiError(400, "exchange_inventory_id is required when resolution is 'exchange'");
    }

    if (data.resolution === "store_credit_exchange" && !saleItem.customer_id) {
      throw new ApiError(
        400,
        "This sale has no customer attached — store credit needs a real customer account to be granted to. A walk-in sale can only use refund or a direct 1:1 exchange."
      );
    }

    // An admin's own request needs no one else's yes: it is approved in the same step (and rolled back with it if that fails — a refund
    // by bank transfer with no account chosen, say), flagged as auto-approved. A cashier's waits in the approval list.
    const approver = recordedByAdmin(req, res, "Recording a return");
    const requestId = db.transaction(() => {
      const result = db
        .prepare(
          `INSERT INTO return_requests (sale_item_id, condition, resolution, exchange_inventory_id, credit_expiry_days, reason, requested_by, is_admin_override, auto_approved)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          data.sale_item_id,
          data.condition,
          data.resolution,
          data.exchange_inventory_id ?? null,
          data.resolution === "store_credit_exchange" ? data.credit_expiry_days : null,
          data.reason,
          req.user!.id,
          isFinalSale ? 1 : 0,
          approver ? 1 : 0
        );
      if (approver) {
        approveReturnRequest(result.lastInsertRowid as number, approver, {
          // For a no-returns product the reason given is also the override reason.
          decision_reason: isFinalSale ? data.reason : undefined,
          payment_method: data.payment_method,
          bank_account_id: data.bank_account_id,
        }, { auto: true });
      }
      return result.lastInsertRowid;
    })();

    const created = db.prepare(`${REQUEST_SELECT} WHERE return_requests.id = ?`).get(requestId);
    res.status(201).json({ ...(created as object), is_final_sale: isFinalSale });
  })
);

// PUT /api/returns/requests/:id/approve — admin-only. This is where the
// original instant-return logic now lives: it only runs once a request
// is approved, not the moment staff submit one.
export type ReturnDecision = z.infer<typeof decisionInput>;

// Approves a pending return request: the unit goes back on the shelf (or to
// damaged), the money or store credit goes back, loyalty points are reversed.
// The approve route and an online exchange being received both come through here,
// so a return means exactly the same thing whichever way it was started.
// `deduct` is for a return that came back by delivery: that much of the refund (or store credit) is held back as the customer's share
// of the delivery charge. It never takes more than the item was going to give back.
// `deferPayout` is for a refund that is paid later (a courier return waiting for the customer's bank details): the return and its
// refund amount are recorded now, but the cash book entry is made when the refund is actually paid.
export function approveReturnRequest(requestId: number | string, user: AuthUser, data: ReturnDecision, opts?: { deduct?: number; deferPayout?: boolean; auto?: boolean }) {
  const request = db.prepare(`SELECT * FROM return_requests WHERE id = ?`).get(requestId) as any;
  if (!request) throw new ApiError(404, "Return request not found");
  if (request.status !== "pending") throw new ApiError(409, `This request has already been ${request.status}.`);

  const saleItem = db
    .prepare(
      `SELECT sale_items.*, sales.invoice, sales.customer_id, sales.loyalty_points_earned, sales.total, sales.amount_paid,
              sales.subtotal, sales.discount, sales.sale_type, sales.payment_method
       FROM sale_items JOIN sales ON sales.id = sale_items.sale_id
       WHERE sale_items.id = ?`
    )
    .get(request.sale_item_id) as any;
  if (!saleItem) throw new ApiError(404, "Sale item not found");

  let exchangeUnit: any = null;
  if (request.resolution === "exchange") {
    exchangeUnit = db.prepare(`SELECT * FROM inventory WHERE id = ?`).get(request.exchange_inventory_id);
    if (!exchangeUnit) throw new ApiError(400, "Exchange inventory unit no longer exists");
    if (exchangeUnit.status !== "available") {
      throw new ApiError(409, "Exchange inventory unit is no longer available for sale");
    }
  }

  const refundMethod = data.payment_method ?? "cash";
  if (request.resolution === "refund" && refundMethod === "bank_transfer") {
    if (!saleItem.customer_id) {
      throw new ApiError(400, "This is a walk-in sale with no customer attached — a bank transfer refund needs a real customer account. Use cash instead.");
    }
    if (!data.bank_account_id) {
      throw new ApiError(400, "Select which of the customer's bank accounts to refund into");
    }
    const account = db
      .prepare(`SELECT * FROM customer_bank_accounts WHERE id = ? AND customer_id = ?`)
      .get(data.bank_account_id, saleItem.customer_id);
    if (!account) throw new ApiError(400, "That bank account isn't on file for this customer");
  }

  // A "refund" only ever gives back money that was actually collected —
  // sales.amount_paid also counts store credit redeemed toward the sale,
  // which was never real cash either (same distinction as the void
  // handler), so that's excluded here too. Whatever fraction of the
  // sale was never actually paid for is written off the customer's
  // balance instead (see the sales.total adjustment below) rather than
  // manufacturing a cash_book expense for money that was never received
  // — this is exactly what a credit (unpaid) sale needs: the return
  // reduces what they owe, it doesn't touch cash on hand at all.
  const creditRedeemedRow = db
    .prepare(
      `SELECT COALESCE(SUM(-amount), 0) as total FROM store_credit_transactions
       WHERE reference_id = ? AND reason = 'redemption'`
    )
    .get(saleItem.sale_id) as { total: number };
  const realCashPaid = Math.max(0, saleItem.amount_paid - creditRedeemedRow.total);
  const paidFraction = saleItem.total > 0 ? Math.min(1, realCashPaid / saleItem.total) : 0;

  // An online COD order whose parcel never got delivered (packed and called back, refused
  // at the door) collected nothing: there's no money to hand back as credit. Turning it
  // into store credit would give the customer value for goods that were never paid for, so
  // it's treated as a refund of nothing — the item's price just comes off the order.
  const parcel = db.prepare(`SELECT delivery_status FROM deliveries WHERE sale_id = ?`).get(saleItem.sale_id) as
    | { delivery_status: string }
    | undefined;
  const parcelNeverCollected =
    request.resolution === "store_credit_exchange" &&
    saleItem.sale_type === "online" &&
    saleItem.payment_method !== "credit" &&
    !!parcel &&
    parcel.delivery_status !== "delivered" &&
    realCashPaid <= 0.009;
  const resolution: string = parcelNeverCollected ? "refund" : request.resolution;

  const refundBeforeShare = resolution === "refund" ? Math.round(saleItem.unit_price * paidFraction) : 0;
  const pickupDeduction = Math.max(0, Math.min(opts?.deduct ?? 0, resolution === "refund" ? refundBeforeShare : saleItem.unit_price));
  const refund_amount = refundBeforeShare - pickupDeduction;
  const ledgerWriteOff = resolution === "refund" ? saleItem.unit_price - refundBeforeShare : 0;
  // An immediate exchange creates no new sale for the replacement to
  // earn its own points on, so those stay; a refund or a store-credit
  // return doesn't (the replacement is a separate, new sale).
  const pointsToReverse =
    resolution === "refund" || resolution === "store_credit_exchange" ? pointsEarnedOnItem(saleItem) : 0;

  const runApproval = db.transaction(() => {
    const returnResult = db
      .prepare(
        `INSERT INTO returns (sale_item_id, condition, resolution, refund_amount, exchange_inventory_id, reason, pickup_deduction, refund_method, refund_account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        request.sale_item_id,
        request.condition,
        resolution,
        refund_amount,
        request.exchange_inventory_id,
        request.reason,
        pickupDeduction,
        // A refund paid now says how; one paid later (a courier return) is filled in when it is paid.
        resolution === "refund" && refund_amount > 0 && !opts?.deferPayout ? refundMethod : null,
        resolution === "refund" && refund_amount > 0 && !opts?.deferPayout && refundMethod === "bank_transfer" ? data.bank_account_id ?? null : null
      );
    const returnId = returnResult.lastInsertRowid;

    const newStatus = request.condition === "clean" ? "available" : "damaged";
    db.prepare(`UPDATE inventory SET status = ? WHERE id = ?`).run(newStatus, saleItem.inventory_id);

    if (resolution === "refund") {
      if (refund_amount > 0 && !opts?.deferPayout) {
        db.prepare(
          `INSERT INTO cash_book (transaction_code, type, category, payment_method, reference_id, amount, notes)
           VALUES (?, 'expense', 'return_refund', ?, ?, ?, ?)`
        ).run(nextTransactionCode(), refundMethod, returnId, refund_amount, `Refund for invoice ${saleItem.invoice}`);
      }

      // The part of this item that was never actually paid for comes
      // off the sale's total instead — the customer no longer owes for
      // an item they no longer have, without inventing a cash outflow
      // that never happened. Recompute payment_status too, since
      // shrinking total can turn an unpaid/partial sale fully paid.
      if (ledgerWriteOff > 0) {
        const newTotal = saleItem.total - ledgerWriteOff;
        const newPaymentStatus =
          newTotal <= 0 || saleItem.amount_paid >= newTotal ? "paid" : saleItem.amount_paid > 0 ? "partial" : "unpaid";
        db.prepare(`UPDATE sales SET total = ?, payment_status = ? WHERE id = ?`).run(
          newTotal,
          newPaymentStatus,
          saleItem.sale_id
        );
      }
    }

    if (pointsToReverse > 0) {
      db.prepare(`UPDATE sales SET loyalty_points_earned = MAX(0, loyalty_points_earned - ?) WHERE id = ?`).run(
        pointsToReverse,
        saleItem.sale_id
      );
      if (saleItem.customer_id) {
        db.prepare(
          `INSERT INTO loyalty_transactions (customer_id, points, reason, reference_id, notes)
           VALUES (?, ?, 'manual_adjustment', ?, ?)`
        ).run(saleItem.customer_id, -pointsToReverse, saleItem.sale_id, `Reversed on return — invoice ${saleItem.invoice}`);
      }
    }

    if (request.resolution === "exchange") {
      db.prepare(`UPDATE inventory SET status = 'sold' WHERE id = ?`).run(request.exchange_inventory_id);
    }

    if (resolution === "store_credit_exchange") {
      // The returned item's value becomes real, expiring store
      // credit — the customer picks their actual replacement later,
      // as a genuinely new sale, applying this credit as a payment
      // source there (see customers.ts / the sale checkout flow).
      const expiryDays = request.credit_expiry_days ?? 45;
      const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString();
      const creditAmount = saleItem.unit_price - pickupDeduction;
      if (creditAmount > 0) {
        db.prepare(
          `INSERT INTO store_credit_transactions (customer_id, amount, reason, reference_id, notes, expires_at)
           VALUES (?, ?, 'return_exchange', ?, ?, ?)`
        ).run(
          saleItem.customer_id,
          creditAmount,
          returnId,
          `Credit from return on invoice ${saleItem.invoice}${pickupDeduction > 0 ? ` (less Rs. ${pickupDeduction.toLocaleString()} delivery charge share)` : ""} — expires in ${expiryDays} days`,
          expiresAt
        );
      }
    }

    db.prepare(
      `UPDATE return_requests SET status = 'approved', decided_by = ?, decided_at = datetime('now', '+330 minutes'), decision_reason = ?, return_id = ?
       WHERE id = ?`
    ).run(user.id, data.decision_reason ?? null, returnId, requestId);

    return returnId;
  });

  const returnId = runApproval();

  logAudit(
    user,
    "return_approve",
    "return_request",
    Number(requestId),
    `${opts?.auto ? "Auto-approved (recorded by admin)" : "Approved"} return on invoice ${saleItem.invoice} — ${
      parcelNeverCollected ? "parcel never collected, nothing paid: written off, no store credit" : request.resolution.replace(/_/g, " ")
    }${refund_amount > 0 ? ` (Rs. ${refund_amount.toLocaleString()} ${opts?.deferPayout ? "refund due" : "refunded"})` : ""}${
      pickupDeduction > 0 ? ` — Rs. ${pickupDeduction.toLocaleString()} held back for the delivery charge` : ""
    }`
  );

  return db.prepare(`${REQUEST_SELECT} WHERE return_requests.id = ?`).get(requestId);
}

returnsRouter.put(
  "/requests/:id/approve",
  requireAdminOrApproval("Approving a return"),
  asyncHandler(async (req, res) => {
    const decision = decisionInput.parse(req.body);
    // A no-returns product is taken back only on purpose: the reason for overriding it has to be written down.
    const asked = db.prepare(`SELECT is_admin_override FROM return_requests WHERE id = ?`).get(req.params.id) as { is_admin_override: number } | undefined;
    if (asked?.is_admin_override === 1 && !decision.decision_reason?.trim()) {
      throw new ApiError(400, "An override reason is required for a Final Sale item.");
    }
    res.json(approveReturnRequest(req.params.id, actorOf(req), decision));
  })
);

// PUT /api/returns/requests/:id/decline — admin-only. Nothing about the
// sale, stock, or cash book changes — only the request's own status.
returnsRouter.put(
  "/requests/:id/decline",
  requireAdminOrApproval("Declining a return"),
  asyncHandler(async (req, res) => {
    const data = z.object({ decision_reason: z.string().min(1, "A reason is required to decline a request") }).parse(req.body);

    const request = db.prepare(`SELECT * FROM return_requests WHERE id = ?`).get(req.params.id) as any;
    if (!request) throw new ApiError(404, "Return request not found");
    if (request.status !== "pending") throw new ApiError(409, `This request has already been ${request.status}.`);

    db.prepare(
      `UPDATE return_requests SET status = 'declined', decided_by = ?, decided_at = datetime('now', '+330 minutes'), decision_reason = ? WHERE id = ?`
    ).run(actorOf(req).id, data.decision_reason, req.params.id);

    logAudit(
      actorOf(req),
      "return_decline",
      "return_request",
      Number(req.params.id),
      `Declined return request #${req.params.id} — ${data.decision_reason}`
    );

    const updated = db.prepare(`${REQUEST_SELECT} WHERE return_requests.id = ?`).get(req.params.id);
    res.json(updated);
  })
);
