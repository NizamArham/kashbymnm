import { db } from "../db/connection";
import "./onlineReturns"; // makes sure the columns read below exist

// A REFUND PAYMENT — money paid back to a customer for a return — as one thing, for the customer's history and for the "Refund payment done"
// slip. It is read from what was recorded when the refund was paid (the return, the cash-book entries and, for a courier return, the
// refund details on it), so every refund ever paid shows up, old ones included, and nothing has to be kept in step by hand.
//
// Two kinds, each with a key the slip is fetched by:
//   pickup-<id>   a courier return — one payment for all of its items that were taken back (one cash-book entry per item)
//   return-<id>   a refund at the shop — one payment for one returned item

// A bank account number as it is printed or shown in a history: only the last four digits, the rest hidden, for the customer's privacy.
export function maskAccount(accountNumber: string | null | undefined): string {
  const digits = (accountNumber ?? "").replace(/\s+/g, "");
  return digits.length > 4 ? `****${digits.slice(-4)}` : "****";
}

export interface RefundSlipItem {
  title: string | null;
  size: string | null;
  color: string | null;
  invoice: string;
  // What the customer paid for it, what was held back (the delivery charge share; anything an inspection held back; the part that was
  // never actually paid for) and what they got back.
  price: number;
  delivery_share: number;
  inspection_hold: number;
  not_paid: number;
  refunded: number;
}

export interface RefundEvent {
  key: string;
  kind: "courier_return" | "in_store_return";
  paid_at: string;
  customer: { id: number; name: string; customer_code: string | null; phone: string | null } | null;
  invoices: string[];
  reason: string | null;
  method: string;
  // The bank account a transfer went to, when it was recorded.
  bank: { bank_name: string; account_name: string; account_number: string; branch: string | null } | null;
  items: RefundSlipItem[];
  total: number;
  transaction_codes: string[];
  paid_by: string | null;
  // Where it is on screen: the sale the (first) item came from.
  sale_id: number;
}

const ITEM_SQL = `
  SELECT r.id AS return_id, r.refund_amount, r.pickup_deduction, r.inspection_deduction, r.refund_method, r.refund_account_id,
         si.unit_price AS price, s.id AS sale_id, s.invoice, s.customer_id,
         COALESCE(p.product_title, si.product_snapshot) AS title, i.size, i.color
  FROM returns r
  JOIN sale_items si ON si.id = r.sale_item_id
  JOIN sales s ON s.id = si.sale_id
  LEFT JOIN inventory i ON i.id = si.inventory_id
  LEFT JOIN products p ON p.id = i.product_id
`;

interface ItemRow {
  return_id: number;
  refund_amount: number;
  pickup_deduction: number;
  inspection_deduction: number;
  refund_method: string | null;
  refund_account_id: number | null;
  price: number;
  sale_id: number;
  invoice: string;
  customer_id: number | null;
  title: string | null;
  size: string | null;
  color: string | null;
}

const toItem = (r: ItemRow): RefundSlipItem => {
  const refunded = r.refund_amount;
  const notPaid = Math.max(0, Math.round((r.price - r.pickup_deduction - r.inspection_deduction - refunded) * 100) / 100);
  return {
    title: r.title,
    size: r.size,
    color: r.color,
    invoice: r.invoice,
    price: r.price,
    delivery_share: r.pickup_deduction,
    inspection_hold: r.inspection_deduction,
    not_paid: notPaid,
    refunded,
  };
};

const customerOf = (id: number | null) =>
  id == null ? null : ((db.prepare(`SELECT id, name, customer_code, phone FROM customers WHERE id = ?`).get(id) as RefundEvent["customer"]) ?? null);

const bankOf = (id: number | null) =>
  id == null
    ? null
    : ((db.prepare(`SELECT bank_name, account_name, account_number, branch FROM customer_bank_accounts WHERE id = ?`).get(id) as RefundEvent["bank"]) ?? null);

const cashRows = (returnIds: number[]) =>
  returnIds.length === 0
    ? []
    : (db
        .prepare(
          `SELECT transaction_code, entry_date, payment_method FROM cash_book
           WHERE category = 'return_refund' AND type = 'expense' AND reference_id IN (${returnIds.map(() => "?").join(",")}) ORDER BY id`
        )
        .all(...returnIds) as { transaction_code: string | null; entry_date: string; payment_method: string | null }[]);

// A courier return's refund, once something has been paid out for it.
export function courierRefundEvent(pickupId: number): RefundEvent | null {
  const op = db
    .prepare(
      `SELECT op.*, rf.name AS refunded_by_name FROM online_returns op LEFT JOIN users rf ON rf.id = op.refunded_by WHERE op.id = ?`
    )
    .get(pickupId) as any;
  if (!op) return null;
  const rows = (
    db
      .prepare(`${ITEM_SQL} JOIN online_return_items oi ON oi.return_id = r.id WHERE oi.pickup_id = ? AND r.refund_amount > 0 ORDER BY oi.id`)
      .all(pickupId) as ItemRow[]
  );
  const cash = cashRows(rows.map((r) => r.return_id));
  if (rows.length === 0 || cash.length === 0) return null; // nothing has been paid out (yet)
  const method = op.refund_method ?? rows[0].refund_method ?? cash[0].payment_method ?? "cash";
  const accountId = op.refund_account_id ?? rows.find((r) => r.refund_account_id)?.refund_account_id ?? null;
  return {
    key: `pickup-${pickupId}`,
    kind: "courier_return",
    paid_at: op.refunded_at ?? cash[0].entry_date,
    customer: customerOf(op.customer_id ?? rows[0].customer_id),
    invoices: Array.from(new Set(rows.map((r) => r.invoice))),
    reason: op.reason ?? null,
    method,
    bank: method === "bank_transfer" ? bankOf(accountId) : null,
    items: rows.map(toItem),
    total: Math.round(rows.reduce((sum, r) => sum + r.refund_amount, 0) * 100) / 100,
    transaction_codes: cash.map((c) => c.transaction_code).filter((c): c is string => !!c),
    paid_by: op.refunded_by_name ?? null,
    sale_id: rows[0].sale_id,
  };
}

// A refund paid at the shop for one returned item (in-store return, approved by an admin — the cash-book entry is made then).
export function inStoreRefundEvent(returnId: number): RefundEvent | null {
  const row = db.prepare(`${ITEM_SQL} WHERE r.id = ? AND r.resolution = 'refund' AND r.refund_amount > 0`).get(returnId) as ItemRow | undefined;
  if (!row) return null;
  const cash = cashRows([returnId]);
  if (cash.length === 0) return null;
  const req = db
    .prepare(`SELECT rr.reason, rr.decided_at, u.name AS decided_by_name FROM return_requests rr LEFT JOIN users u ON u.id = rr.decided_by WHERE rr.return_id = ?`)
    .get(returnId) as { reason: string | null; decided_at: string | null; decided_by_name: string | null } | undefined;
  const method = row.refund_method ?? cash[0].payment_method ?? "cash";
  return {
    key: `return-${returnId}`,
    kind: "in_store_return",
    paid_at: cash[0].entry_date,
    customer: customerOf(row.customer_id),
    invoices: [row.invoice],
    reason: req?.reason ?? null,
    method,
    bank: method === "bank_transfer" ? bankOf(row.refund_account_id) : null,
    items: [toItem(row)],
    total: row.refund_amount,
    transaction_codes: cash.map((c) => c.transaction_code).filter((c): c is string => !!c),
    paid_by: req?.decided_by_name ?? null,
    sale_id: row.sale_id,
  };
}

export function refundEventByKey(key: string): RefundEvent | null {
  const m = /^(pickup|return)-(\d+)$/.exec(key);
  if (!m) return null;
  return m[1] === "pickup" ? courierRefundEvent(Number(m[2])) : inStoreRefundEvent(Number(m[2]));
}

// Every refund paid to one customer, oldest first — what their payment history lists.
export function refundEventsForCustomer(customerId: number): RefundEvent[] {
  const events: RefundEvent[] = [];
  const pickups = db.prepare(`SELECT id FROM online_returns WHERE customer_id = ? ORDER BY id`).all(customerId) as { id: number }[];
  for (const p of pickups) {
    const e = courierRefundEvent(p.id);
    if (e) events.push(e);
  }
  // A refund at the shop: a returned item (refund, not credit) of one of this customer's sales, not part of a courier return.
  const returns = db
    .prepare(
      `SELECT r.id FROM returns r
       JOIN sale_items si ON si.id = r.sale_item_id
       JOIN sales s ON s.id = si.sale_id
       WHERE s.customer_id = ? AND r.resolution = 'refund' AND r.refund_amount > 0
         AND NOT EXISTS (SELECT 1 FROM online_return_items oi WHERE oi.return_id = r.id)
       ORDER BY r.id`
    )
    .all(customerId) as { id: number }[];
  for (const r of returns) {
    const e = inStoreRefundEvent(r.id);
    if (e) events.push(e);
  }
  return events.sort((a, b) => a.paid_at.localeCompare(b.paid_at));
}

// A return whose money goes back as a REFUND (not store credit): the moment the goods were taken back — stock restored, the refund owed —
// which comes first, and is its own line on the customer's history; the payment itself ("paid out", above) comes later, or at the same time
// for a refund paid at the shop. One per courier return, one per item returned at the shop.
export interface ReturnedEvent {
  key: string;
  date: string;
  invoices: string[];
  reason: string | null;
  items: RefundSlipItem[];
  // What the goods were worth to the customer, and what is to be paid back after what was held back.
  goods_value: number;
  refund_total: number;
  // What the customer is credited when the goods come back — the refund plus what is then held back from it (so it is what they paid for the
  // goods, less any part that was never actually paid) — and the two kinds of hold-back.
  returned_value: number;
  delivery_share: number;
  inspection_hold: number;
  // The refund has been paid out (so its slip exists).
  paid: boolean;
  paid_key: string | null;
  sale_id: number;
}

const heldOf = (rows: ItemRow[]) => {
  const delivery_share = rows.reduce((sum, r) => sum + r.pickup_deduction, 0);
  const inspection_hold = rows.reduce((sum, r) => sum + r.inspection_deduction, 0);
  const refund = rows.reduce((sum, r) => sum + r.refund_amount, 0);
  return { returned_value: Math.round((refund + delivery_share + inspection_hold) * 100) / 100, delivery_share, inspection_hold };
};

export function returnedEventsForCustomer(customerId: number): ReturnedEvent[] {
  const events: ReturnedEvent[] = [];
  const stamp = (rows: { return_date: string }[]) => rows.map((r) => r.return_date).sort()[0];
  const withDate = (sql: string, ...args: unknown[]) => db.prepare(`${ITEM_SQL.replace("r.refund_amount,", "r.return_date, r.refund_amount,")} ${sql}`).all(...args) as (ItemRow & { return_date: string })[];

  const pickups = db.prepare(`SELECT id, reason FROM online_returns WHERE customer_id = ? ORDER BY id`).all(customerId) as { id: number; reason: string | null }[];
  for (const p of pickups) {
    const rows = withDate(`JOIN online_return_items oi ON oi.return_id = r.id WHERE oi.pickup_id = ? AND r.resolution = 'refund' AND r.refund_amount > 0 ORDER BY oi.id`, p.id);
    if (rows.length === 0) continue;
    const paid = courierRefundEvent(p.id);
    events.push({
      key: `pickup-${p.id}`,
      date: stamp(rows),
      invoices: Array.from(new Set(rows.map((r) => r.invoice))),
      reason: p.reason,
      items: rows.map(toItem),
      goods_value: rows.reduce((sum, r) => sum + r.price, 0),
      refund_total: Math.round(rows.reduce((sum, r) => sum + r.refund_amount, 0) * 100) / 100,
      ...heldOf(rows),
      paid: !!paid,
      paid_key: paid ? paid.key : null,
      sale_id: rows[0].sale_id,
    });
  }
  const shop = withDate(
    `WHERE s.customer_id = ? AND r.resolution = 'refund' AND r.refund_amount > 0
       AND NOT EXISTS (SELECT 1 FROM online_return_items oi WHERE oi.return_id = r.id)
     ORDER BY r.id`,
    customerId
  );
  for (const r of shop) {
    const paid = inStoreRefundEvent(r.return_id);
    const req = db.prepare(`SELECT reason FROM return_requests WHERE return_id = ?`).get(r.return_id) as { reason: string | null } | undefined;
    events.push({
      key: `return-${r.return_id}`,
      date: r.return_date,
      invoices: [r.invoice],
      reason: req?.reason ?? null,
      items: [toItem(r)],
      goods_value: r.price,
      refund_total: r.refund_amount,
      ...heldOf([r]),
      paid: !!paid,
      paid_key: paid ? paid.key : null,
      sale_id: r.sale_id,
    });
  }
  return events.sort((a, b) => a.date.localeCompare(b.date));
}
