import { db } from "../db/connection";
import { ApiError } from "./errors";
import { nextTransactionCode } from "./codes";

// Store credit a customer can still spend: every entry except grants past their
// expiry (money already spent always counts) — the same rule as their balance.
export function usableStoreCredit(customerId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM store_credit_transactions
       WHERE customer_id = ? AND (expires_at IS NULL OR expires_at > datetime('now', '+330 minutes') OR amount < 0)`
    )
    .get(customerId) as { total: number };
  return row.total;
}

// Pays store credit back out as money — cash from the till or a bank transfer —
// instead of leaving it to be spent. The credit comes off the customer's balance
// and the payout goes in the cash book as an expense, in one step. Used when an
// exchange leaves a difference the customer would rather have back, and from the
// customer's profile for any credit they want paid out.
export function refundStoreCredit(opts: {
  customerId: number;
  amount: number;
  method: "cash" | "bank_transfer";
  note: string;
}): { transaction_code: string } {
  const amount = Math.round(opts.amount * 100) / 100;
  if (!(amount > 0)) throw new ApiError(400, "Enter an amount to refund.");
  const available = usableStoreCredit(opts.customerId);
  if (amount > available + 0.009) {
    throw new ApiError(409, `This customer only has Rs. ${Math.max(0, available).toLocaleString()} of store credit to refund.`);
  }
  const transaction_code = nextTransactionCode();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO store_credit_transactions (customer_id, amount, reason, notes) VALUES (?, ?, 'manual_adjustment', ?)`
    ).run(opts.customerId, -amount, `Refunded to the customer (${opts.method.replace("_", " ")}) — ${opts.note}`);
    db.prepare(
      `INSERT INTO cash_book (transaction_code, type, category, payment_method, reference_id, amount, notes)
       VALUES (?, 'expense', 'store_credit_refund', ?, ?, ?, ?)`
    ).run(transaction_code, opts.method, opts.customerId, amount, `Store credit refunded — ${opts.note}`);
  })();
  return { transaction_code };
}
