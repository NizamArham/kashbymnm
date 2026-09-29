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

export type CustomerGender = "male" | "female" | "unspecified";

const GENDER_LETTER: Record<CustomerGender, string> = { male: "M", female: "F", unspecified: "U" };

// M&M Clothing opened in 2024 — "Year 1" for the customer-code shop-year
// digit below. A single digit only covers years 1-9 (2024-2032); if the
// shop's still running in 2033, that digit needs to become 2 digits (or
// switch to a letter) — a one-time format bump, same kind of change as
// this feature itself.
const SHOP_EPOCH_YEAR = 2024;

// Format: C{shopYear}{MM}{sequence}{GenderLetter}, e.g. C3090001M — the
// single leading digit is the shop's OWN age (2024 = year 1, 2025 = year
// 2, ...) rather than the calendar year, then MM is the join month, so
// the code shows how long someone's been a customer at a glance without
// revealing the actual calendar year. The 4-digit sequence is a lifetime
// running number shared across every gender — same "never resets" design
// as invoice/purchase codes, see nextInvoiceCode — and the trailing
// letter (M/F/U) makes gender visible in the code for quick campaign
// segmentation.
//
// Older customers (before this format) look like C-0001 — the regex
// below requires a fixed run of digits right after "C" with no dash, so
// those are safely skipped rather than mismatched.
export function nextCustomerCode(gender: CustomerGender, joinedAt: Date = new Date()): string {
  const shopYear = joinedAt.getFullYear() - SHOP_EPOCH_YEAR + 1;
  const mm = String(joinedAt.getMonth() + 1).padStart(2, "0");

  const rows = db.prepare(`SELECT customer_code FROM customers WHERE customer_code LIKE 'C%'`).all() as {
    customer_code: string;
  }[];
  let nextNum = 1;
  for (const { customer_code } of rows) {
    const match = customer_code.match(/^C\d{3}(\d{4})[MFU]$/);
    if (!match) continue;
    const n = parseInt(match[1], 10);
    if (!isNaN(n) && n + 1 > nextNum) nextNum = n + 1;
  }

  return `C${shopYear}${mm}${String(nextNum).padStart(4, "0")}${GENDER_LETTER[gender]}`;
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

// Format: {CATEGORY}{day-of-360}X{sequence}, e.g. SCR263X0240 — a real
// date is still in there (month/day on a 360-day-year basis: (month-1)
// * 30 + day), but not in the obvious YYMMDD shape anyone can decode
// in two seconds. "X" is just a fixed separator letter, same for every
// category. The sequence is a lifetime running number shared across
// every category, never resetting, starting at 0240 rather than 1 —
// so the very first invoice under this format doesn't read as
// "customer number one."
// STR = in-store, paid now (cash/card/bank)
// SCR = in-store, credit (balance due)
// OCD = online, cash on delivery
// OCR = online, credit (balance due, delivery fee still COD)
// OPS = online, fully paid upfront (nothing owed, no COD needed)
//
// Older invoices (before this format) look like STR26090047 or
// STR26092301 or STR-8 — none of them contain an "X", so filtering on
// that safely excludes all of them; nothing here parses those, they
// stay as historical records.
export function nextInvoiceCode(category: InvoiceCategory): string {
  const { day360 } = db
    .prepare(
      `SELECT (CAST(strftime('%m', 'now', '+330 minutes') AS INTEGER) - 1) * 30
              + CAST(strftime('%d', 'now', '+330 minutes') AS INTEGER) AS day360`
    )
    .get() as { day360: number };
  const dayPart = String(day360).padStart(3, "0");

  const rows = db.prepare(`SELECT invoice FROM sales WHERE invoice LIKE '%X%'`).all() as { invoice: string }[];
  let nextNum = 240;
  for (const { invoice } of rows) {
    const match = invoice.match(/^[A-Z]+\d{3}X(\d{4})$/);
    if (!match) continue;
    const n = parseInt(match[1], 10);
    if (!isNaN(n) && n + 1 > nextNum) nextNum = n + 1;
  }

  return `${category}${dayPart}X${String(nextNum).padStart(4, "0")}`;
}

// Format: P{YY}{MM}{sequence}, e.g. P26090001 — same style as invoice
// codes (STR26090001 etc.), just with the "P" prefix for Purchases and
// its own independent sequence. No separators, matching the established
// pattern rather than the old "PO-0001" format.
export function nextPurchaseCode(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, "0")}`;

  const row = db
    .prepare(`SELECT purchase_code FROM purchases WHERE purchase_code LIKE 'P%' ORDER BY id DESC LIMIT 1`)
    .get() as { purchase_code: string } | undefined;

  let nextNum = 1;
  if (row?.purchase_code) {
    const digits = row.purchase_code.slice(1); // drop the "P"
    const existingSeq = parseInt(digits.slice(4), 10); // drop YYMM
    if (!isNaN(existingSeq)) nextNum = existingSeq + 1;
  }

  return `P${yymm}${String(nextNum).padStart(4, "0")}`;
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
