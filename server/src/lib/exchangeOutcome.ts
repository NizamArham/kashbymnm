import { db } from "../db/connection";
import { exchangeForSale } from "./exchanges";
import { REAL_OWED_SQL } from "./owedSql";

// An exchange whose old items haven't come back yet, in numbers and in words: what they are worth, how much of it comes off what the customer
// still owes on the replacement order once the items are received and checked, and how much becomes store credit. Everything is worked out from the
// exchange and the order as they stand now — the customer statement, the balance slip and the printed bill all say it from this one place.
export interface ExchangeOutcome {
  invoice: string;
  waiting_items: { name: string; worth: number }[];
  waiting_value: number;
  // What is still owed on the replacement order right now.
  owed_now: number;
  // Of the old items' value: the part that clears that, and the part that becomes store credit (some of which may already have been given in advance).
  clears: number;
  to_credit: number;
  advance_given: number;
  // "Old items still on their way back (Rs. 9,700)" and "Once received and checked: Rs. 3,700 comes off the balance and Rs. 6,000 becomes store credit".
  lead: string;
  text: string;
}

const rupees = (n: number) => `Rs. ${n.toLocaleString()}`;

export function exchangeOutcomeForSale(saleId: number): ExchangeOutcome | null {
  const exchange = exchangeForSale(saleId) as { status: string; advance_credit?: number | null; items: { status: string; title: string | null; size: string | null; applied_share: number }[] } | null;
  if (!exchange || exchange.status !== "awaiting_pickup") return null;
  const waiting = exchange.items.filter((i) => i.status === "awaiting");
  if (waiting.length === 0) return null;
  const sale = db.prepare(`SELECT sales.invoice, MAX(0, ROUND(${REAL_OWED_SQL}, 2)) AS owed FROM sales WHERE sales.id = ?`).get(saleId) as { invoice: string; owed: number } | undefined;
  if (!sale) return null;

  const waiting_items = waiting.map((i) => ({ name: `${i.title ?? "Item"}${i.size ? ` (${i.size})` : ""}`, worth: i.applied_share }));
  const waiting_value = Math.round(waiting_items.reduce((sum, i) => sum + i.worth, 0) * 100) / 100;
  const clears = Math.round(Math.min(sale.owed, waiting_value) * 100) / 100;
  const to_credit = Math.round(Math.max(0, waiting_value - clears) * 100) / 100;
  const advance_given = exchange.advance_credit ?? 0;
  const outcome = [
    ...(clears > 0.5 ? [`${rupees(clears)} comes off the balance`] : []),
    ...(to_credit > 0.5 ? [`${rupees(to_credit)} becomes store credit${advance_given > 0.5 ? ` (${rupees(Math.min(advance_given, to_credit))} already given)` : ""}`] : []),
  ];
  return {
    invoice: sale.invoice,
    waiting_items,
    waiting_value,
    owed_now: sale.owed,
    clears,
    to_credit,
    advance_given,
    lead: `Old ${waiting.length === 1 ? "item" : "items"} still on the way back (${rupees(waiting_value)})`,
    text: outcome.length > 0 ? `Once received and checked: ${outcome.join(" and ")}` : "",
  };
}
