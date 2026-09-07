import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth } from "../lib/auth";

export const returnsRouter = Router();

// Same access as Sales/POS — both admin and staff process returns at the counter.
returnsRouter.use(requireAuth);

const returnInput = z.object({
  sale_item_id: z.number().int().positive(),
  condition: z.enum(["clean", "damaged"]),
  resolution: z.enum(["refund", "exchange"]),
  reason: z.string().optional(),
  // Required only when resolution = "exchange": the inventory unit going out instead.
  exchange_inventory_id: z.number().int().positive().optional(),
});

// GET /api/returns — list all
returnsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT returns.*, sale_items.sale_id, sale_items.unit_price, sales.invoice,
                inventory.sku, products.product_title
         FROM returns
         JOIN sale_items ON sale_items.id = returns.sale_item_id
         JOIN sales ON sales.id = sale_items.sale_id
         JOIN inventory ON inventory.id = sale_items.inventory_id
         JOIN products ON products.id = inventory.product_id
         ORDER BY returns.id DESC`
      )
      .all();
    res.json(rows);
  })
);

// POST /api/returns — process a return against a specific sale line item.
//
// Logic:
//  - condition "clean"   -> the returned inventory unit goes back to 'available'
//  - condition "damaged" -> the returned inventory unit goes to 'damaged' (write-off,
//                            never sellable again, but kept in records)
//  - resolution "refund"   -> refund_amount = the item's original unit_price,
//                              logged as a cash book EXPENSE (money going back out),
//                              and this item's share of loyalty points is reversed
//                              from the customer's running total
//  - resolution "exchange" -> the customer takes a different unit instead
//                              (exchange_inventory_id, which must be 'available' and
//                              flips to 'sold'); no cash refund entry, since nothing
//                              left the business — only a price difference (if any)
//                              is settled as a refund or additional charge
//
// Everything happens in one transaction: partial returns can never leave
// inventory status, the cash book, and loyalty points out of sync with
// each other.
returnsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = returnInput.parse(req.body);

    const saleItem = db
      .prepare(
        `SELECT sale_items.*, sales.invoice, sales.customer_id, sales.loyalty_points_earned, sales.total
         FROM sale_items JOIN sales ON sales.id = sale_items.sale_id
         WHERE sale_items.id = ?`
      )
      .get(data.sale_item_id) as any;

    if (!saleItem) throw new ApiError(404, "Sale item not found");

    const alreadyReturned = db
      .prepare(`SELECT id FROM returns WHERE sale_item_id = ?`)
      .get(data.sale_item_id);
    if (alreadyReturned) {
      throw new ApiError(409, "This item has already been returned once — cannot return it again.");
    }

    let exchangeUnit: any = null;
    if (data.resolution === "exchange") {
      if (!data.exchange_inventory_id) {
        throw new ApiError(400, "exchange_inventory_id is required when resolution is 'exchange'");
      }
      exchangeUnit = db
        .prepare(`SELECT * FROM inventory WHERE id = ?`)
        .get(data.exchange_inventory_id);
      if (!exchangeUnit) throw new ApiError(400, "Exchange inventory unit does not exist");
      if (exchangeUnit.status !== "available") {
        throw new ApiError(409, "Exchange inventory unit is not available for sale");
      }
    }

    // Refund amount is the original line's price — only meaningful for
    // "refund"; for "exchange" it stays 0 unless you later add a price-
    // difference field, which isn't in scope here.
    const refund_amount = data.resolution === "refund" ? saleItem.unit_price : 0;

    // This item's share of loyalty points, proportional to its price vs
    // the sale's total — reversed only on a cash refund.
    const pointsToReverse =
      data.resolution === "refund" && saleItem.total > 0
        ? Math.floor((saleItem.unit_price / saleItem.total) * saleItem.loyalty_points_earned)
        : 0;

    const runReturnTransaction = db.transaction(() => {
      const result = db
        .prepare(
          `INSERT INTO returns (sale_item_id, condition, resolution, refund_amount, exchange_inventory_id, reason)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          data.sale_item_id,
          data.condition,
          data.resolution,
          refund_amount,
          data.exchange_inventory_id ?? null,
          data.reason ?? null
        );

      // The returned unit's fate depends on its condition, regardless of resolution.
      const newStatus = data.condition === "clean" ? "available" : "damaged";
      db.prepare(`UPDATE inventory SET status = ? WHERE id = ?`).run(
        newStatus,
        saleItem.inventory_id
      );

      if (data.resolution === "refund") {
        db.prepare(
          `INSERT INTO cash_book (type, category, reference_id, amount, notes)
           VALUES ('expense', 'return_refund', ?, ?, ?)`
        ).run(result.lastInsertRowid, refund_amount, `Refund for invoice ${saleItem.invoice}`);

        if (pointsToReverse > 0) {
          db.prepare(
            `UPDATE sales SET loyalty_points_earned = MAX(0, loyalty_points_earned - ?) WHERE id = ?`
          ).run(pointsToReverse, saleItem.sale_id);
        }
      }

      if (data.resolution === "exchange" && data.exchange_inventory_id) {
        db.prepare(`UPDATE inventory SET status = 'sold' WHERE id = ?`).run(
          data.exchange_inventory_id
        );
      }

      return result.lastInsertRowid;
    });

    const returnId = runReturnTransaction();
    const created = db.prepare(`SELECT * FROM returns WHERE id = ?`).get(returnId);
    res.status(201).json(created);
  })
);
