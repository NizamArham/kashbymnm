import { db } from "../db/connection";

/**
 * Generates the next sequential code for a given prefix by looking at the
 * highest existing number for that prefix and adding 1. Works entirely off
 * existing data, so there's no separate "counter" table to get out of sync.
 *
 * Example: for prefix "P" it looks at existing codes like "P-0006" and
 * returns "P-0007".
 */
function nextSequentialCode(
  table: string,
  codeColumn: string,
  prefix: string,
  padLength = 4
): string {
  const row = db
    .prepare(
      `SELECT ${codeColumn} as code FROM ${table}
       WHERE ${codeColumn} LIKE ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(`${prefix}-%`) as { code: string } | undefined;

  let nextNum = 1;
  if (row?.code) {
    const parts = row.code.split("-");
    const num = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(num)) nextNum = num + 1;
  }

  return `${prefix}-${String(nextNum).padStart(padLength, "0")}`;
}

export function nextProductCode(): string {
  // products table doesn't store a product_code column per the finalized
  // schema (it's identified by numeric id) — kept here in case you want
  // a human-readable code later. Not used by default.
  return nextSequentialCode("products", "id", "P");
}

export function nextCustomerCode(): string {
  return nextSequentialCode("customers", "customer_code", "C");
}

export function nextSupplierCode(): string {
  return nextSequentialCode("suppliers", "supplier_code", "S");
}

export function nextInvoiceCode(): string {
  // Format: INV-YYMM followed by an ever-increasing sequence number that
  // never resets (e.g. INV-26090047 in September 2026). The YYMM prefix
  // makes the invoice's rough date obvious at a glance; the sequence
  // keeps counting across months so two invoices are never mixed up.
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, "0")}`;

  const row = db
    .prepare(`SELECT invoice FROM sales WHERE invoice LIKE 'INV-%' ORDER BY id DESC LIMIT 1`)
    .get() as { invoice: string } | undefined;

  let nextNum = 1;
  if (row?.invoice) {
    // Existing invoices look like INV-2609XXXX — the sequence is
    // everything after the YYMM digits that follow "INV-".
    const digits = row.invoice.replace("INV-", "");
    const existingSeq = parseInt(digits.slice(4), 10);
    if (!isNaN(existingSeq)) nextNum = existingSeq + 1;
  }

  return `INV-${yymm}${String(nextNum).padStart(4, "0")}`;
}

export function nextPurchaseCode(): string {
  return nextSequentialCode("purchases", "purchase_code", "PO");
}

export function nextSku(productId: number): string {
  // SKU derived from product id + a running count of its inventory rows,
  // e.g. product 12's 3rd unit -> SKU-0012-003
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM inventory WHERE product_id = ?`)
    .get(productId) as { cnt: number };
  const nextCount = row.cnt + 1;
  return `SKU-${String(productId).padStart(4, "0")}-${String(nextCount).padStart(3, "0")}`;
}
