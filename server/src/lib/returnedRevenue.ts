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
//
// The one exception is an exchange by delivery. The customer is charged the
// difference the day the order is made — the old items' value is already off
// what they pay — so its old items come off that day, while they are still on
// their way back, as if they were back in good condition. If they come back
// damaged the cost stays after all; if they never come back the credit is never
// given (what the customer still owes stays on their account) and nothing comes
// off. That is why returns tied to an exchange order are left out of the plain
// list below and counted with the exchange instead.
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
         AND r.id NOT IN (SELECT return_id FROM online_exchange_items WHERE return_id IS NOT NULL)
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
  const plain = rows.map((r) => ({
    day: r.return_date.slice(0, 10),
    amount: r.resolution === "refund" ? r.refund_amount : r.unit_price,
    cost: r.condition === "clean" ? r.unit_cost : 0,
    product_id: r.product_id,
    product_title: r.product_title,
    brand: r.brand,
    category: r.category,
  }));

  // Exchange by delivery: each old item is counted on the day its replacement order was made — still on its way back, or already
  // back — and not at all once it is marked as never returned.
  const exchangeItems = db
    .prepare(
      `SELECT ox.created_at, oei.status, oei.item_condition, oei.credit_amount,
              COALESCE(i.cost_price, 0) AS unit_cost, i.product_id, p.product_title, p.brand, p.category
       FROM online_exchange_items oei
       JOIN online_exchanges ox ON ox.id = oei.exchange_id
       JOIN sales ns ON ns.id = ox.new_sale_id
       JOIN sale_items si ON si.id = oei.old_sale_item_id
       JOIN sales os ON os.id = si.sale_id
       LEFT JOIN inventory i ON i.id = si.inventory_id
       LEFT JOIN products p ON p.id = i.product_id
       WHERE ns.is_voided = 0 AND ns.status = 'completed'
         AND os.is_voided = 0 AND os.status = 'completed'
         AND oei.status IN ('awaiting', 'received')
         AND date(ox.created_at) BETWEEN date(?) AND date(?)`
    )
    .all(start, end) as {
    created_at: string;
    status: string;
    item_condition: string | null;
    credit_amount: number;
    unit_cost: number;
    product_id: number | null;
    product_title: string | null;
    brand: string | null;
    category: string | null;
  }[];
  const exchanged = exchangeItems.map((x) => ({
    day: x.created_at.slice(0, 10),
    amount: x.credit_amount,
    cost: x.status === "received" && x.item_condition === "damaged" ? 0 : x.unit_cost,
    product_id: x.product_id,
    product_title: x.product_title,
    brand: x.brand,
    category: x.category,
  }));

  return [...plain, ...exchanged];
}
