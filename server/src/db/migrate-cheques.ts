/**
 * Additive migration for the cheque tracking feature — brings an
 * EXISTING, already-populated database up to date without deleting or
 * altering any current data. Safe to run multiple times.
 *
 * This one is simpler than the earlier migrations: cheque_receipts and
 * cheque_transfers are both brand-new tables, so a plain CREATE TABLE
 * IF NOT EXISTS is all that's needed — no ALTER, no rebuild, since
 * nothing existing is being changed structurally.
 *
 * Run with: npx tsx src/db/migrate-cheques.ts
 */
import path from "path";
import Database from "better-sqlite3";

const DB_PATH = path.join(__dirname, "..", "..", "data", "mm-clothing.db");
const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

console.log(`Migrating ${DB_PATH} ...`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cheque_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cheque_number TEXT NOT NULL,
    bank_name TEXT NOT NULL,
    amount REAL NOT NULL,
    cheque_date TEXT NOT NULL,
    date_received TEXT NOT NULL DEFAULT (datetime('now')),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    sale_allocations TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_hand' CHECK (status IN ('in_hand','given_to_supplier','deposited','cleared','bounced')),
    cleared_at TEXT,
    bounced_at TEXT,
    bounced_reason TEXT,
    notes TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_cheque_receipts_customer ON cheque_receipts(customer_id);
  CREATE INDEX IF NOT EXISTS idx_cheque_receipts_status ON cheque_receipts(status);
  CREATE INDEX IF NOT EXISTS idx_cheque_receipts_number ON cheque_receipts(cheque_number);

  CREATE TABLE IF NOT EXISTS cheque_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cheque_receipt_id INTEGER NOT NULL REFERENCES cheque_receipts(id),
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    supplier_payment_id INTEGER REFERENCES supplier_payments(id),
    date_given TEXT NOT NULL DEFAULT (datetime('now')),
    notes TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_cheque_transfers_receipt ON cheque_transfers(cheque_receipt_id);
  CREATE INDEX IF NOT EXISTS idx_cheque_transfers_supplier ON cheque_transfers(supplier_id);

  CREATE TABLE IF NOT EXISTS cheques_issued (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cheque_number TEXT NOT NULL,
    bank_name TEXT NOT NULL,
    amount REAL NOT NULL,
    cheque_date TEXT NOT NULL,
    date_issued TEXT NOT NULL DEFAULT (datetime('now')),
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    supplier_payment_id INTEGER REFERENCES supplier_payments(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cleared','bounced')),
    cleared_at TEXT,
    bounced_at TEXT,
    bounced_reason TEXT,
    notes TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_cheques_issued_supplier ON cheques_issued(supplier_id);
  CREATE INDEX IF NOT EXISTS idx_cheques_issued_status ON cheques_issued(status);
`);

console.log("cheque_receipts, cheque_transfers, and cheques_issued are ready (created if they didn't already exist).");

const counts = ["cheque_receipts", "cheque_transfers", "cheques_issued"].map((t) => {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
  return `${t}: ${row.c} rows`;
});
console.log("\nRow counts:");
counts.forEach((c) => console.log(`  ${c}`));

console.log("\nMigration complete. No existing data was touched — these are new tables only.");

db.close();
