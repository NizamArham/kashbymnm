/**
 * Additive migration for the store-credit-exchange feature — brings an
 * EXISTING, already-populated database up to date without touching any
 * current data. Safe to run multiple times (checks before doing
 * anything). Unlike migrate.ts (which only handles brand-new tables via
 * CREATE TABLE IF NOT EXISTS), this handles the two real changes needed
 * on tables that already exist with real rows in them:
 *
 * 1. New columns — plain ALTER TABLE ADD COLUMN, which SQLite supports
 *    directly and which never touches existing rows (they just get NULL
 *    in the new column, which is exactly correct here: existing store
 *    credit stays permanent with no expiry, existing return_requests
 *    have no credit_expiry_days since they were never a
 *    store_credit_exchange to begin with).
 *
 * 2. Widening a CHECK constraint (resolution now also allows
 *    'store_credit_exchange') — SQLite has no direct "ALTER CHECK"
 *    command, so this rebuilds the table the standard safe way: create
 *    a new table with the correct constraint, copy every existing row
 *    across unchanged, drop the old table, rename the new one into its
 *    place. All done inside one transaction, so either the whole thing
 *    succeeds or the database is left exactly as it was.
 *
 * Run with: npx tsx src/db/migrate-store-credit-exchange.ts
 */
import path from "path";
import Database from "better-sqlite3";

const DB_PATH = path.join(__dirname, "..", "..", "data", "mm-clothing.db");
const db = new Database(DB_PATH);
db.pragma("foreign_keys = OFF"); // temporarily, only for the table-rebuild steps below

function columnExists(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

console.log(`Migrating ${DB_PATH} ...`);

const run = db.transaction(() => {
  // ---- 1. store_credit_transactions.expires_at ------------------------
  if (!columnExists("store_credit_transactions", "expires_at")) {
    db.exec(`ALTER TABLE store_credit_transactions ADD COLUMN expires_at TEXT`);
    console.log("Added store_credit_transactions.expires_at (existing rows: NULL = never expires, unchanged).");
  } else {
    console.log("store_credit_transactions.expires_at already exists — skipped.");
  }

  // ---- 2. return_requests.credit_expiry_days ---------------------------
  if (!columnExists("return_requests", "credit_expiry_days")) {
    db.exec(`ALTER TABLE return_requests ADD COLUMN credit_expiry_days INTEGER`);
    console.log("Added return_requests.credit_expiry_days (existing rows: NULL, since none were store_credit_exchange).");
  } else {
    console.log("return_requests.credit_expiry_days already exists — skipped.");
  }

  // ---- 3. store_credit_transactions.reason CHECK widening --------------
  const scCheck = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'store_credit_transactions'`)
    .get() as { sql: string } | undefined;
  if (scCheck && !scCheck.sql.includes("return_exchange")) {
    console.log("Rebuilding store_credit_transactions to widen its reason CHECK constraint...");
    db.exec(`
      CREATE TABLE store_credit_transactions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        amount REAL NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('overpayment','redemption','manual_adjustment','return_exchange')),
        reference_id INTEGER,
        notes TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO store_credit_transactions_new (id, customer_id, amount, reason, reference_id, notes, expires_at, created_at)
        SELECT id, customer_id, amount, reason, reference_id, notes, expires_at, created_at FROM store_credit_transactions;
      DROP TABLE store_credit_transactions;
      ALTER TABLE store_credit_transactions_new RENAME TO store_credit_transactions;
      CREATE INDEX IF NOT EXISTS idx_store_credit_transactions_customer ON store_credit_transactions(customer_id);
    `);
    console.log("store_credit_transactions rebuilt — every existing row preserved exactly as it was.");
  } else {
    console.log("store_credit_transactions.reason CHECK already allows return_exchange — skipped.");
  }

  // ---- 4. return_requests.resolution CHECK widening --------------------
  const rrCheck = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'return_requests'`)
    .get() as { sql: string } | undefined;
  if (rrCheck && !rrCheck.sql.includes("store_credit_exchange")) {
    console.log("Rebuilding return_requests to widen its resolution CHECK constraint...");
    db.exec(`
      CREATE TABLE return_requests_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
        quantity INTEGER NOT NULL DEFAULT 1,
        condition TEXT NOT NULL CHECK (condition IN ('clean','damaged')),
        resolution TEXT NOT NULL CHECK (resolution IN ('refund','exchange','store_credit_exchange')),
        exchange_inventory_id INTEGER REFERENCES inventory(id),
        credit_expiry_days INTEGER,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
        requested_by INTEGER REFERENCES users(id),
        requested_at TEXT NOT NULL DEFAULT (datetime('now')),
        decided_by INTEGER REFERENCES users(id),
        decided_at TEXT,
        decision_reason TEXT,
        is_admin_override INTEGER NOT NULL DEFAULT 0 CHECK (is_admin_override IN (0,1)),
        return_id INTEGER REFERENCES returns(id)
      );
      INSERT INTO return_requests_new
        (id, sale_item_id, quantity, condition, resolution, exchange_inventory_id, credit_expiry_days, reason, status,
         requested_by, requested_at, decided_by, decided_at, decision_reason, is_admin_override, return_id)
        SELECT id, sale_item_id, quantity, condition, resolution, exchange_inventory_id, credit_expiry_days, reason, status,
               requested_by, requested_at, decided_by, decided_at, decision_reason, is_admin_override, return_id
        FROM return_requests;
      DROP TABLE return_requests;
      ALTER TABLE return_requests_new RENAME TO return_requests;
      CREATE INDEX IF NOT EXISTS idx_return_requests_status ON return_requests(status);
      CREATE INDEX IF NOT EXISTS idx_return_requests_sale_item ON return_requests(sale_item_id);
    `);
    console.log("return_requests rebuilt — every existing row preserved exactly as it was.");
  } else {
    console.log("return_requests.resolution CHECK already allows store_credit_exchange — skipped.");
  }

  // ---- 5. returns.resolution CHECK widening -----------------------------
  const rCheck = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'returns'`).get() as
    | { sql: string }
    | undefined;
  if (rCheck && !rCheck.sql.includes("store_credit_exchange")) {
    console.log("Rebuilding returns to widen its resolution CHECK constraint...");
    db.exec(`
      CREATE TABLE returns_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
        condition TEXT NOT NULL CHECK (condition IN ('clean','damaged')),
        resolution TEXT NOT NULL CHECK (resolution IN ('refund','exchange','store_credit_exchange')),
        refund_amount REAL NOT NULL DEFAULT 0,
        exchange_inventory_id INTEGER REFERENCES inventory(id),
        reason TEXT,
        return_date TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO returns_new (id, sale_item_id, condition, resolution, refund_amount, exchange_inventory_id, reason, return_date)
        SELECT id, sale_item_id, condition, resolution, refund_amount, exchange_inventory_id, reason, return_date FROM returns;
      DROP TABLE returns;
      ALTER TABLE returns_new RENAME TO returns;
    `);
    console.log("returns rebuilt — every existing row preserved exactly as it was.");
  } else {
    console.log("returns.resolution CHECK already allows store_credit_exchange — skipped.");
  }
});

run();

db.pragma("foreign_keys = ON");

// Sanity check — row counts on the touched tables should be unchanged
// by this migration, only their structure changed.
const counts = ["store_credit_transactions", "return_requests", "returns"].map((t) => {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
  return `${t}: ${row.c} rows`;
});
console.log("\nRow counts after migration (should match what you had before):");
counts.forEach((c) => console.log(`  ${c}`));

console.log("\nMigration complete. Your existing data was not deleted or altered — only the table structure changed.");

db.close();
