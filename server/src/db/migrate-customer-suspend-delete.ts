/**
 * Additive migration for the customer suspend/delete feature — brings an
 * EXISTING, already-populated database up to date without deleting or
 * altering any current data. Safe to run multiple times (checks before
 * doing anything).
 *
 * What this does:
 * 1. customers: adds 5 new columns (is_suspended, suspended_reason,
 *    suspended_at, reactivated_reason, reactivated_at) via plain
 *    ALTER TABLE ADD COLUMN — SQLite handles this natively, existing
 *    rows just get the column's default (0 for is_suspended, NULL for
 *    the rest), which is exactly correct: every existing customer is
 *    simply "not suspended."
 * 2. sales: adds deleted_customer_snapshot (same ADD COLUMN approach),
 *    AND rebuilds the table so customer_id's foreign key becomes
 *    ON DELETE SET NULL instead of a plain reference — SQLite has no
 *    direct way to alter a foreign key's delete behavior, so this is
 *    done the standard safe way: create a new table with the right
 *    constraint, copy every existing row across unchanged, drop the
 *    old table, rename the new one into place.
 * 3. loyalty_transactions and store_credit_transactions: same rebuild
 *    approach, changing customer_id's foreign key to ON DELETE CASCADE.
 *
 * All done inside one transaction, so either the whole thing succeeds
 * or the database is left exactly as it started.
 *
 * Run with: npx tsx src/db/migrate-customer-suspend-delete.ts
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

function tableSql(table: string): string | undefined {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as
    | { sql: string }
    | undefined;
  return row?.sql;
}

console.log(`Migrating ${DB_PATH} ...`);

const run = db.transaction(() => {
  // ---- 1. customers: 5 new columns -------------------------------------
  const newCustomerColumns: [string, string][] = [
    ["is_suspended", "INTEGER NOT NULL DEFAULT 0"],
    ["suspended_reason", "TEXT"],
    ["suspended_at", "TEXT"],
    ["reactivated_reason", "TEXT"],
    ["reactivated_at", "TEXT"],
  ];
  for (const [col, def] of newCustomerColumns) {
    if (!columnExists("customers", col)) {
      db.exec(`ALTER TABLE customers ADD COLUMN ${col} ${def}`);
      console.log(`Added customers.${col}.`);
    } else {
      console.log(`customers.${col} already exists — skipped.`);
    }
  }

  // ---- 2. sales: deleted_customer_snapshot + customer_id FK rebuild ----
  if (!columnExists("sales", "deleted_customer_snapshot")) {
    db.exec(`ALTER TABLE sales ADD COLUMN deleted_customer_snapshot TEXT`);
    console.log("Added sales.deleted_customer_snapshot.");
  } else {
    console.log("sales.deleted_customer_snapshot already exists — skipped.");
  }

  const salesSql = tableSql("sales");
  if (salesSql && !salesSql.includes("ON DELETE SET NULL")) {
    console.log("Rebuilding sales to change customer_id's foreign key to ON DELETE SET NULL...");
    const cols = db.prepare(`PRAGMA table_info(sales)`).all() as { name: string }[];
    const colNames = cols.map((c) => c.name).join(", ");
    db.exec(`
      CREATE TABLE sales_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice TEXT UNIQUE NOT NULL,
        customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        deleted_customer_snapshot TEXT,
        salesperson TEXT,
        date TEXT NOT NULL DEFAULT (datetime('now')),
        subtotal REAL NOT NULL,
        discount REAL NOT NULL DEFAULT 0,
        manual_discount REAL NOT NULL DEFAULT 0,
        coupon_discount REAL NOT NULL DEFAULT 0,
        coupon_code TEXT,
        total REAL NOT NULL,
        amount_paid REAL NOT NULL DEFAULT 0,
        payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('paid','partial','unpaid')),
        payment_method TEXT,
        sale_type TEXT NOT NULL DEFAULT 'in_store' CHECK (sale_type IN ('in_store','online')),
        loyalty_points_earned INTEGER NOT NULL DEFAULT 0,
        amount_received REAL,
        change_due REAL NOT NULL DEFAULT 0,
        overpaid_amount REAL NOT NULL DEFAULT 0,
        is_voided INTEGER NOT NULL DEFAULT 0 CHECK (is_voided IN (0,1)),
        voided_at TEXT,
        void_reason TEXT
      );
      INSERT INTO sales_new (${colNames})
        SELECT ${colNames} FROM sales;
      DROP TABLE sales;
      ALTER TABLE sales_new RENAME TO sales;
    `);
    console.log("sales rebuilt — every existing row preserved exactly as it was.");
  } else {
    console.log("sales.customer_id already has ON DELETE SET NULL — skipped.");
  }

  // ---- 3. loyalty_transactions: customer_id FK rebuild to CASCADE ------
  const loyaltySql = tableSql("loyalty_transactions");
  if (loyaltySql && !loyaltySql.includes("ON DELETE CASCADE")) {
    console.log("Rebuilding loyalty_transactions to change customer_id's foreign key to ON DELETE CASCADE...");
    db.exec(`
      CREATE TABLE loyalty_transactions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        points INTEGER NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('sale','bonus_grant','manual_adjustment','redemption')),
        reference_id INTEGER,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO loyalty_transactions_new (id, customer_id, points, reason, reference_id, notes, created_at)
        SELECT id, customer_id, points, reason, reference_id, notes, created_at FROM loyalty_transactions;
      DROP TABLE loyalty_transactions;
      ALTER TABLE loyalty_transactions_new RENAME TO loyalty_transactions;
      CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_customer ON loyalty_transactions(customer_id);
    `);
    console.log("loyalty_transactions rebuilt — every existing row preserved exactly as it was.");
  } else {
    console.log("loyalty_transactions.customer_id already has ON DELETE CASCADE — skipped.");
  }

  // ---- 4. store_credit_transactions: customer_id FK rebuild to CASCADE -
  const creditSql = tableSql("store_credit_transactions");
  if (creditSql && !creditSql.includes("ON DELETE CASCADE")) {
    console.log("Rebuilding store_credit_transactions to change customer_id's foreign key to ON DELETE CASCADE...");
    db.exec(`
      CREATE TABLE store_credit_transactions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
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
    console.log("store_credit_transactions.customer_id already has ON DELETE CASCADE — skipped.");
  }
});

run();

db.pragma("foreign_keys = ON");

const counts = ["customers", "sales", "loyalty_transactions", "store_credit_transactions"].map((t) => {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
  return `${t}: ${row.c} rows`;
});
console.log("\nRow counts after migration (should match what you had before):");
counts.forEach((c) => console.log(`  ${c}`));

console.log("\nMigration complete. Your existing data was not deleted or altered — only the table structure changed.");

db.close();
