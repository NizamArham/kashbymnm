import { db } from "../db/connection";

// What a returned item's price is made of, so a return on an order that is still owed (a credit order, or one only part paid) never hands
// money or store credit back for something that was never paid for.
//
//   owedCleared    the part that only cancels what the customer still owes on this sale — no money ever changed hands for it, so
//                  there is nothing to pay back: it simply comes off the invoice
//   paidPart       the rest of the price, which was actually paid for
//   cashRefundable of that, the part that was collected as cash/bank (the part paid with store credit can't go back as cash)
//
// What they owe is cleared FIRST. A sale of 10,000 with 4,000 paid, returning a 5,000 item: all 5,000 comes off what they owe (they now owe
// 1,000), and nothing is refunded. A sale of 10,000 with 8,000 paid: 2,000 comes off what they owe, and only the other 3,000 is paid back.
export interface ReturnSplit {
  owedCleared: number;
  paidPart: number;
  cashRefundable: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function returnSplit(unitPrice: number, sale: { total: number; amount_paid: number }, creditRedeemed: number): ReturnSplit {
  const owed = Math.max(0, sale.total - sale.amount_paid);
  const owedCleared = round2(Math.min(unitPrice, owed));
  const paidPart = round2(unitPrice - owedCleared);
  const cashPaid = Math.max(0, sale.amount_paid - creditRedeemed);
  return { owedCleared, paidPart, cashRefundable: round2(Math.min(paidPart, cashPaid)) };
}

// Store credit the customer spent paying for this sale — never real cash (the same distinction the void handler makes).
export function creditRedeemedOn(saleId: number): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(-amount), 0) AS total FROM store_credit_transactions WHERE reference_id = ? AND reason = 'redemption'`)
    .get(saleId) as { total: number };
  return row.total;
}

// The split for several items of one sale taken back one after another, as approving them does: each one that clears what is owed leaves the
// sale owing less for the next. (A preview — the real figures are worked out when each is approved.)
export function returnSplitsInOrder(saleId: number, unitPrices: number[]): ReturnSplit[] {
  const sale = db.prepare(`SELECT total, amount_paid FROM sales WHERE id = ?`).get(saleId) as { total: number; amount_paid: number } | undefined;
  if (!sale) return unitPrices.map(() => ({ owedCleared: 0, paidPart: 0, cashRefundable: 0 }));
  const credit = creditRedeemedOn(saleId);
  let total = sale.total;
  return unitPrices.map((price) => {
    const split = returnSplit(price, { total, amount_paid: sale.amount_paid }, credit);
    total -= split.owedCleared;
    return split;
  });
}
