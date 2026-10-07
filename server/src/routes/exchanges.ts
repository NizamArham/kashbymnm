import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";
import { logAudit } from "../lib/auditLog";
import { eligibleExchangeItems, exchangeById, exchangeItems } from "../lib/exchanges";
import { refundStoreCredit } from "../lib/storeCreditRefund";
import { approveReturnRequest } from "./returns";
import { addPickupCharge } from "./courierReconciliation";

export const exchangesRouter = Router();

exchangesRouter.use(requireAuth);

// GET /api/exchanges/eligible?customer_id= — the delivered items of that
// customer's online orders that an exchange can start from.
exchangesRouter.get(
  "/eligible",
  asyncHandler(async (req, res) => {
    const customerId = Number(req.query.customer_id);
    if (!Number.isInteger(customerId) || customerId <= 0) throw new ApiError(400, "customer_id is required");
    res.json(eligibleExchangeItems(customerId));
  })
);

const receiveInput = z.object({
  // What happened to each old item still waiting: it came back clean, it came back
  // damaged, or it wasn't handed back. Items not listed stay waiting.
  items: z
    .array(z.object({ sale_item_id: z.number().int().positive(), outcome: z.enum(["clean", "damaged", "not_returned"]) }))
    .min(1),
  // When the replacement costs less than the old items that came back, what to do
  // with the difference: leave it as store credit (the default) or pay it out.
  leftover: z.object({ mode: z.enum(["credit", "refund"]), method: z.enum(["cash", "bank_transfer"]).optional() }).optional(),
  note: z.string().optional(),
});

// PUT /api/exchanges/:id/receive — the courier brought old items back with the
// replacement delivery and they've been checked (or some weren't handed back). Each
// item that came back is a normal return of it (store-credit exchange: back on the
// shelf or to damaged, loyalty points reversed, its value granted as credit); that
// credit is put straight onto the replacement order. Whatever is left over after the
// replacement is covered stays as store credit, or is refunded if asked. An item not
// handed back leaves its part owed on the replacement. Once every old item has been
// dealt with, the courier's pickup charge is booked against them.
exchangesRouter.put(
  "/:id/receive",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const data = receiveInput.parse(req.body);
    const exchange = exchangeById(req.params.id) as any;
    if (!exchange) throw new ApiError(404, "Exchange not found");
    if (exchange.status !== "awaiting_pickup") throw new ApiError(409, `This exchange is already ${exchange.status.replace(/_/g, " ")}.`);

    const sale = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(exchange.new_sale_id) as any;
    if (!sale || sale.is_voided) throw new ApiError(409, "The replacement invoice was voided — there's nothing to apply the items' value to.");
    const delivery = db.prepare(`SELECT * FROM deliveries WHERE sale_id = ?`).get(sale.id) as any;
    if (!delivery || delivery.delivery_status !== "delivered") {
      throw new ApiError(409, "The replacement hasn't been delivered yet — the old items are collected when it is.");
    }

    // Every listed item must be one of this exchange's, still waiting, once.
    const waiting = new Map<number, any>(exchange.items.filter((i: any) => i.status === "awaiting").map((i: any) => [i.old_sale_item_id, i]));
    const seen = new Set<number>();
    for (const o of data.items) {
      if (!waiting.has(o.sale_item_id) || seen.has(o.sale_item_id)) {
        throw new ApiError(409, "One of those items isn't waiting on this exchange.");
      }
      seen.add(o.sale_item_id);
    }
    if (data.leftover?.mode === "refund" && !data.leftover.method) throw new ApiError(400, "Choose cash or bank transfer for the refund.");

    let leftoverCredit = 0;
    const run = db.transaction(() => {
      for (const o of data.items) {
        const item = waiting.get(o.sale_item_id);
        if (o.outcome === "not_returned") {
          db.prepare(`UPDATE online_exchange_items SET status = 'not_returned' WHERE id = ?`).run(item.id);
          continue;
        }
        const request = db
          .prepare(
            `INSERT INTO return_requests (sale_item_id, quantity, condition, resolution, credit_expiry_days, reason, requested_by, is_admin_override)
             VALUES (?, 1, ?, 'store_credit_exchange', 45, ?, ?, 0)`
          )
          .run(item.old_sale_item_id, o.outcome, `Online exchange — replacement invoice ${sale.invoice}`, req.user!.id);
        const approved = approveReturnRequest(request.lastInsertRowid as number, req.user!, {
          decision_reason: "Collected by the courier with the replacement delivery",
        }) as any;

        // This item's value is now store credit — its part goes onto the replacement.
        const current = db.prepare(`SELECT amount_paid, total FROM sales WHERE id = ?`).get(sale.id) as { amount_paid: number; total: number };
        const applied = Math.min(item.applied_share, Math.max(0, current.total - current.amount_paid));
        if (applied > 0) {
          db.prepare(
            `INSERT INTO store_credit_transactions (customer_id, amount, reason, reference_id, notes)
             VALUES (?, ?, 'redemption', ?, ?)`
          ).run(sale.customer_id, -applied, sale.id, `Applied to invoice ${sale.invoice} — exchange for ${item.old_invoice}`);
          const newPaid = current.amount_paid + applied;
          const status = newPaid >= current.total ? "paid" : newPaid > 0 ? "partial" : "unpaid";
          db.prepare(`UPDATE sales SET amount_paid = ?, payment_status = ? WHERE id = ?`).run(newPaid, status, sale.id);
        }
        leftoverCredit += item.credit_amount - applied;
        db.prepare(`UPDATE online_exchange_items SET status = 'received', item_condition = ?, return_id = ? WHERE id = ?`).run(
          o.outcome,
          approved.return_id ?? null,
          item.id
        );
      }

      // The difference, if the replacement cost less: paid out when asked, else it
      // simply stays as the customer's store credit.
      if (data.leftover?.mode === "refund" && leftoverCredit > 0.009) {
        refundStoreCredit({
          customerId: sale.customer_id,
          amount: leftoverCredit,
          method: data.leftover.method!,
          note: `exchange for ${sale.invoice} — replacement cost less than the old item${exchange.items.length > 1 ? "s" : ""}`,
        });
      }

      // Everything dealt with? Close the exchange and book the courier's charge once.
      const items = exchangeItems(exchange.id);
      if (!items.some((i) => i.status === "awaiting")) {
        const anyReceived = items.some((i) => i.status === "received");
        const first = items.find((i) => i.status === "received");
        db.prepare(
          `UPDATE online_exchanges
           SET status = ?, item_condition = ?, return_id = ?, note = COALESCE(?, note), closed_at = datetime('now', '+330 minutes')
           WHERE id = ?`
        ).run(anyReceived ? "received" : "not_returned", first?.item_condition ?? null, first?.return_id ?? null, data.note ?? null, exchange.id);
        if (!exchange.pickup_booked) {
          addPickupCharge(delivery, exchange.pickup_charge);
          db.prepare(`UPDATE online_exchanges SET pickup_booked = 1 WHERE id = ?`).run(exchange.id);
        }
      }
    });
    run();

    const came = data.items.filter((o) => o.outcome !== "not_returned").length;
    const missing = data.items.length - came;
    logAudit(
      req.user!,
      missing === data.items.length ? "exchange_not_returned" : "exchange_received",
      "sale",
      sale.id,
      `${sale.invoice}: ${came} old item${came === 1 ? "" : "s"} collected${missing ? `, ${missing} not handed back` : ""}${
        leftoverCredit > 0.009 ? `; Rs. ${Math.round(leftoverCredit).toLocaleString()} left over ${data.leftover?.mode === "refund" ? "refunded" : "kept as store credit"}` : ""
      }`
    );
    res.json(exchangeById(exchange.id));
  })
);
