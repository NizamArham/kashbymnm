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

// Formula: first 3 consonants of the name (uppercased, skipping vowels)
// + the last 2 digits of the phone number. E.g. "Rushdi" + "773026781"
// -> "RSH" + "81" -> "RSH81". If the name has fewer than 3 consonants,
// pads with the name's remaining letters (including vowels) rather than
// leaving the code short. If no phone is given, pads with "00" instead
// of leaving those digits blank. Falls back to the old sequential S001
// style only if a collision can't be resolved by appending a number.
export function generateSupplierCode(name: string, phone: string | null | undefined): string {
  const letters = name.toUpperCase().replace(/[^A-Z]/g, "");
  const consonants = letters.split("").filter((c) => !"AEIOU".includes(c));
  let namePart = consonants.slice(0, 3).join("");
  if (namePart.length < 3) {
    // Not enough consonants (e.g. a short or vowel-heavy name) — fill out
    // with whatever letters are left so the code is still 3 characters.
    namePart = (namePart + letters).slice(0, 3);
  }
  namePart = namePart.padEnd(3, "X"); // final fallback if the name has no letters at all

  const digits = (phone ?? "").replace(/\D/g, "");
  const phonePart = digits.length >= 2 ? digits.slice(-2) : digits.padStart(2, "0") || "00";

  let code = `${namePart}${phonePart}`;
  // Codes must be unique — if this exact combination is already taken
  // (e.g. two suppliers with very similar names and phone endings),
  // append a running number rather than silently colliding.
  let suffix = 1;
  let candidate = code;
  while (db.prepare(`SELECT id FROM suppliers WHERE supplier_code = ?`).get(candidate)) {
    suffix += 1;
    candidate = `${code}${suffix}`;
  }
  return candidate;
}

export type InvoiceCategory = "STR" | "SCR" | "OCD" | "OCR" | "OPS";

// Format: {CATEGORY}{YY}{MM}{sequence} with no separators, e.g.
// STR26090047. Each category keeps its own independent sequence that
// never resets — STR and OCD invoices are numbered completely
// separately from each other, only ever counting up.
// STR = in-store, paid now (cash/card/bank)
// SCR = in-store, credit (balance due)
// OCD = online, cash on delivery
// OCR = online, credit (balance due, delivery fee still COD)
// OPS = online, fully paid upfront (nothing owed, no COD needed)
export function nextInvoiceCode(category: InvoiceCategory): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, "0")}`;

  const row = db
    .prepare(`SELECT invoice FROM sales WHERE invoice LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(`${category}%`) as { invoice: string } | undefined;

  let nextNum = 1;
  if (row?.invoice) {
    // Existing invoices in this category look like STR2609XXXX — the
    // sequence is everything after the category letters + YYMM digits.
    const digits = row.invoice.slice(category.length);
    const existingSeq = parseInt(digits.slice(4), 10);
    if (!isNaN(existingSeq)) nextNum = existingSeq + 1;
  }

  return `${category}${yymm}${String(nextNum).padStart(4, "0")}`;
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
