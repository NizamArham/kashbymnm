import { db } from "../db/connection";

export interface ReturnRow {
  day: string;
  amount: number; // revenue handed back
  cost: number; // cost of the unit that went back into stock (0 if it was damaged)
  product_id: number | null;
  product_title: string | null;
  brand: string | null;
  category: string | null;
}

// Returns processed in a range, counted on the day they are processed — so an
// item sold last week and exchanged today shows up against today, not against
// the day it was first sold. A store-credit exchange hands back the item's
// price as credit; a refund hands back the cash that was actually refunded (any
// part that was never paid for already came off the sale's own total). A direct
// 1:1 swap doesn't change what the shop has earned, so it isn't counted. The
// cost of the unit comes back off only when it went back on the shelf ("clean");
// a damaged one stays as cost. Returns on voided sales are skipped — voiding
// already took the whole sale out.
export function returnsInRange(start: string, end: string): ReturnRow[] {
  const rows = db
    .prepare(
      `SELECT r.return_date, r.resolution, r.condition, r.refund_amount, si.unit_price,
              COALESCE(i.cost_price, 0) AS unit_cost, i.product_id, p.product_title, p.brand, p.category
       FROM returns r
       JOIN sale_items si ON si.id = r.sale_item_id
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN inventory i ON i.id = si.inventory_id
       LEFT JOIN products p ON p.id = i.product_id
       WHERE s.is_voided = 0 AND s.status = 'completed'
         AND r.resolution IN ('refund', 'store_credit_exchange')
         AND date(r.return_date) BETWEEN date(?) AND date(?)`
    )
    .all(start, end) as {
    return_date: string;
    resolution: string;
    condition: string;
    refund_amount: number;
    unit_price: number;
    unit_cost: number;
    product_id: number | null;
    product_title: string | null;
    brand: string | null;
    category: string | null;
  }[];
  return rows.map((r) => ({
    day: r.return_date.slice(0, 10),
    amount: r.resolution === "refund" ? r.refund_amount : r.unit_price,
    cost: r.condition === "clean" ? r.unit_cost : 0,
    product_id: r.product_id,
    product_title: r.product_title,
    brand: r.brand,
    category: r.category,
  }));
}
