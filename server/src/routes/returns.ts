import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const returnsRouter = Router();

// Staff can submit requests and view history; only admins can approve/decline.
returnsRouter.use(requireAuth);

const requestInput = z.object({
  sale_item_id: z.number().int().positive(),
  condition: z.enum(["clean", "damaged"]),
  resolution: z.enum(["refund", "exchange"]),
  reason: z.string().min(1, "A reason is required to submit a return request"),
  exchange_inventory_id: z.number().int().positive().optional(),
});

const decisionInput = z.object({
  decision_reason: z.string().optional(),
});

const REQUEST_SELECT = `
  SELECT return_requests.*, sale_items.sale_id, sale_items.unit_price, sale_items.quantity as item_quantity,
         sales.invoice, sales.customer_id, customers.name as customer_name,
         inventory.sku, products.product_title, products.allow_returns,
         requester.name as requested_by_name, decider.name as decided_by_name
  FROM return_requests
  JOIN sale_items ON sale_items.id = return_requests.sale_item_id
  JOIN sales ON sales.id = sale_items.sale_id
  LEFT JOIN customers ON customers.id = sales.customer_id
  JOIN inventory ON inventory.id = sale_items.inventory_id
  JOIN products ON products.id = inventory.product_id
  LEFT JOIN users requester ON requester.id = return_requests.requested_by
  LEFT JOIN users decider ON decider.id = return_requests.decided_by
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

// POST /api/returns/requests — staff submits a return request. This
// NEVER touches stock, cash book, or loyalty points — it only exists as
// a pending record until an admin decides on it.
returnsRouter.post(
  "/requests",
  asyncHandler(async (req, res) => {
    const data = requestInput.parse(req.body);

    const saleItem = db
      .prepare(
        `SELECT sale_items.*, products.allow_returns, products.product_title
         FROM sale_items
         JOIN inventory ON inventory.id = sale_items.inventory_id
         JOIN products ON products.id = inventory.product_id
         WHERE sale_items.id = ?`
      )
      .get(data.sale_item_id) as any;

    if (!saleItem) throw new ApiError(404, "Sale item not found");

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

    const result = db
      .prepare(
        `INSERT INTO return_requests (sale_item_id, condition, resolution, exchange_inventory_id, reason, requested_by, is_admin_override)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.sale_item_id,
        data.condition,
        data.resolution,
        data.exchange_inventory_id ?? null,
        data.reason,
        req.user!.id,
        isFinalSale ? 1 : 0
      );

    const created = db.prepare(`${REQUEST_SELECT} WHERE return_requests.id = ?`).get(result.lastInsertRowid);
    res.status(201).json({ ...(created as object), is_final_sale: isFinalSale });
  })
);

// PUT /api/returns/requests/:id/approve — admin-only. This is where the
// original instant-return logic now lives: it only runs once a request
// is approved, not the moment staff submit one.
returnsRouter.put(
  "/requests/:id/approve",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const data = decisionInput.parse(req.body);

    const request = db.prepare(`SELECT * FROM return_requests WHERE id = ?`).get(req.params.id) as any;
    if (!request) throw new ApiError(404, "Return request not found");
    if (request.status !== "pending") throw new ApiError(409, `This request has already been ${request.status}.`);

    const saleItem = db
      .prepare(
        `SELECT sale_items.*, sales.invoice, sales.customer_id, sales.loyalty_points_earned, sales.total
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

    const refund_amount = request.resolution === "refund" ? saleItem.unit_price : 0;
    const pointsToReverse =
      request.resolution === "refund" && saleItem.total > 0
        ? Math.floor((saleItem.unit_price / saleItem.total) * saleItem.loyalty_points_earned)
        : 0;

    const runApproval = db.transaction(() => {
      const returnResult = db
        .prepare(
          `INSERT INTO returns (sale_item_id, condition, resolution, refund_amount, exchange_inventory_id, reason)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          request.sale_item_id,
          request.condition,
          request.resolution,
          refund_amount,
          request.exchange_inventory_id,
          request.reason
        );
      const returnId = returnResult.lastInsertRowid;

      const newStatus = request.condition === "clean" ? "available" : "damaged";
      db.prepare(`UPDATE inventory SET status = ? WHERE id = ?`).run(newStatus, saleItem.inventory_id);

      if (request.resolution === "refund") {
        db.prepare(
          `INSERT INTO cash_book (type, category, reference_id, amount, notes)
           VALUES ('expense', 'return_refund', ?, ?, ?)`
        ).run(returnId, refund_amount, `Refund for invoice ${saleItem.invoice}`);

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
      }

      if (request.resolution === "exchange") {
        db.prepare(`UPDATE inventory SET status = 'sold' WHERE id = ?`).run(request.exchange_inventory_id);
      }

      db.prepare(
        `UPDATE return_requests SET status = 'approved', decided_by = ?, decided_at = datetime('now'), decision_reason = ?, return_id = ?
         WHERE id = ?`
      ).run(req.user!.id, data.decision_reason ?? null, returnId, req.params.id);

      return returnId;
    });

    runApproval();
    const updated = db.prepare(`${REQUEST_SELECT} WHERE return_requests.id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// PUT /api/returns/requests/:id/decline — admin-only. Nothing about the
// sale, stock, or cash book changes — only the request's own status.
returnsRouter.put(
  "/requests/:id/decline",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const data = z.object({ decision_reason: z.string().min(1, "A reason is required to decline a request") }).parse(req.body);

    const request = db.prepare(`SELECT * FROM return_requests WHERE id = ?`).get(req.params.id) as any;
    if (!request) throw new ApiError(404, "Return request not found");
    if (request.status !== "pending") throw new ApiError(409, `This request has already been ${request.status}.`);

    db.prepare(
      `UPDATE return_requests SET status = 'declined', decided_by = ?, decided_at = datetime('now'), decision_reason = ? WHERE id = ?`
    ).run(req.user!.id, data.decision_reason, req.params.id);

    const updated = db.prepare(`${REQUEST_SELECT} WHERE return_requests.id = ?`).get(req.params.id);
    res.json(updated);
  })
);
