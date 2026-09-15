/**
 * Additive migration for customer/supplier bank accounts — brings an
 * EXISTING, already-populated database up to date without deleting or
 * altering any current data. Safe to run multiple times.
 *
 * Both tables are brand new, so a plain CREATE TABLE IF NOT EXISTS is
 * all that's needed — no ALTER, no rebuild, since nothing existing is
 * being changed structurally.
 *
 * Run with: npx tsx src/db/migrate-bank-accounts.ts
 */
import path from "path";
import Database from "better-sqlite3";

const DB_PATH = path.join(__dirname, "..", "..", "data", "mm-clothing.db");
const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

console.log(`Migrating ${DB_PATH} ...`);

db.exec(`
  CREATE TABLE IF NOT EXISTS customer_bank_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    bank_name TEXT NOT NULL,
    account_name TEXT NOT NULL,
    account_number TEXT NOT NULL,
    branch TEXT,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1))
  );

  CREATE INDEX IF NOT EXISTS idx_customer_bank_accounts_customer
    ON customer_bank_accounts(customer_id);

  CREATE TABLE IF NOT EXISTS supplier_bank_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    bank_name TEXT NOT NULL,
    account_name TEXT NOT NULL,
    account_number TEXT NOT NULL,
    branch TEXT,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1))
  );

  CREATE INDEX IF NOT EXISTS idx_supplier_bank_accounts_supplier
    ON supplier_bank_accounts(supplier_id);
`);

console.log("customer_bank_accounts and supplier_bank_accounts are ready (created if they didn't already exist).");

const counts = ["customer_bank_accounts", "supplier_bank_accounts"].map((t) => {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
  return `${t}: ${row.c} rows`;
});
console.log("\nRow counts:");
counts.forEach((c) => console.log(`  ${c}`));

console.log("\nMigration complete. No existing data was touched — these are new tables only.");

db.close();
