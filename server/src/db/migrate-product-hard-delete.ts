/**
 * Additive migration for the product hard-delete feature — brings an
 * EXISTING, already-populated database up to date without deleting or
 * altering any current data. Safe to run multiple times.
 *
 * What this does, across 5 tables:
 * 1. sale_items: adds product_snapshot (plain ADD COLUMN — existing
 *    rows get NULL, which is exactly correct, since it's only ever
 *    populated at the moment a product is actually deleted), AND
 *    rebuilds the table so inventory_id becomes nullable with
 *    ON DELETE SET NULL instead of NOT NULL with a plain reference —
 *    SQLite can't alter a column's nullability or a foreign key's
 *    delete behavior directly, so this is done the standard safe way:
 *    create a new table with the right shape, copy every row across
 *    unchanged, drop the old table, rename the new one into place.
 * 2. purchase_items: same treatment — adds product_snapshot, and
 *    rebuilds so product_id becomes nullable with ON DELETE SET NULL.
 * 3. return_requests, returns, purchase_return_items: rebuilt so their
 *    exchange_inventory_id / inventory_id columns get ON DELETE SET
 *    NULL, so a product deletion never gets blocked by an old
 *    return/exchange record pointing at one of its units.
 *
 * All done inside one transaction, so either the whole thing succeeds
 * or the database is left exactly as it started.
 *
 * Run with: npx tsx src/db/migrate-product-hard-delete.ts
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
  // ---- 1. sale_items: product_snapshot + inventory_id FK rebuild ------
  if (!columnExists("sale_items", "product_snapshot")) {
    db.exec(`ALTER TABLE sale_items ADD COLUMN product_snapshot TEXT`);
    console.log("Added sale_items.product_snapshot.");
  } else {
    console.log("sale_items.product_snapshot already exists — skipped.");
  }

  const saleItemsSql = tableSql("sale_items");
  if (saleItemsSql && !saleItemsSql.includes("ON DELETE SET NULL")) {
    console.log("Rebuilding sale_items to make inventory_id nullable with ON DELETE SET NULL...");
    db.exec(`
      CREATE TABLE sale_items_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        inventory_id INTEGER REFERENCES inventory(id) ON DELETE SET NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        unit_price REAL NOT NULL,
        line_total REAL NOT NULL,
        product_snapshot TEXT
      );
      INSERT INTO sale_items_new (id, sale_id, inventory_id, quantity, unit_price, line_total, product_snapshot)
        SELECT id, sale_id, inventory_id, quantity, unit_price, line_total, product_snapshot FROM sale_items;
      DROP TABLE sale_items;
      ALTER TABLE sale_items_new RENAME TO sale_items;
      CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
      CREATE INDEX IF NOT EXISTS idx_sale_items_inventory ON sale_items(inventory_id);
    `);
    console.log("sale_items rebuilt — every existing row preserved exactly as it was.");
  } else {
    console.log("sale_items.inventory_id already has ON DELETE SET NULL — skipped.");
  }

  // ---- 2. purchase_items: product_snapshot + product_id FK rebuild ----
  if (!columnExists("purchase_items", "product_snapshot")) {
    db.exec(`ALTER TABLE purchase_items ADD COLUMN product_snapshot TEXT`);
    console.log("Added purchase_items.product_snapshot.");
  } else {
    console.log("purchase_items.product_snapshot already exists — skipped.");
  }

  const purchaseItemsSql = tableSql("purchase_items");
  if (purchaseItemsSql && !purchaseItemsSql.includes("ON DELETE SET NULL")) {
    console.log("Rebuilding purchase_items to make product_id nullable with ON DELETE SET NULL...");
    db.exec(`
      CREATE TABLE purchase_items_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        quantity INTEGER NOT NULL,
        unit_cost REAL NOT NULL,
        size TEXT,
        color TEXT,
        product_snapshot TEXT
      );
      INSERT INTO purchase_items_new (id, purchase_id, product_id, quantity, unit_cost, size, color, product_snapshot)
        SELECT id, purchase_id, product_id, quantity, unit_cost, size, color, product_snapshot FROM purchase_items;
      DROP TABLE purchase_items;
      ALTER TABLE purchase_items_new RENAME TO purchase_items;
    `);
    console.log("purchase_items rebuilt — every existing row preserved exactly as it was.");
  } else {
    console.log("purchase_items.product_id already has ON DELETE SET NULL — skipped.");
  }

  // ---- 3. return_requests: exchange_inventory_id FK rebuild -----------
  const returnRequestsSql = tableSql("return_requests");
  if (returnRequestsSql && !returnRequestsSql.includes("exchange_inventory_id INTEGER REFERENCES inventory(id) ON DELETE SET NULL")) {
    console.log("Rebuilding return_requests to add ON DELETE SET NULL to exchange_inventory_id...");
    const cols = db.prepare(`PRAGMA table_info(return_requests)`).all() as { name: string }[];
    const colNames = cols.map((c) => c.name).join(", ");
    db.exec(`
      CREATE TABLE return_requests_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
        quantity INTEGER NOT NULL DEFAULT 1,
        condition TEXT NOT NULL CHECK (condition IN ('clean','damaged')),
        resolution TEXT NOT NULL CHECK (resolution IN ('refund','exchange','store_credit_exchange')),
        exchange_inventory_id INTEGER REFERENCES inventory(id) ON DELETE SET NULL,
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
      INSERT INTO return_requests_new (${colNames}) SELECT ${colNames} FROM return_requests;
      DROP TABLE return_requests;
      ALTER TABLE return_requests_new RENAME TO return_requests;
      CREATE INDEX IF NOT EXISTS idx_return_requests_status ON return_requests(status);
      CREATE INDEX IF NOT EXISTS idx_return_requests_sale_item ON return_requests(sale_item_id);
    `);
    console.log("return_requests rebuilt — every existing row preserved exactly as it was.");
  } else {
    console.log("return_requests.exchange_inventory_id already has ON DELETE SET NULL — skipped.");
  }

  // ---- 4. returns: exchange_inventory_id FK rebuild -------------------
  const returnsSql = tableSql("returns");
  if (returnsSql && !returnsSql.includes("exchange_inventory_id INTEGER REFERENCES inventory(id) ON DELETE SET NULL")) {
    console.log("Rebuilding returns to add ON DELETE SET NULL to exchange_inventory_id...");
    db.exec(`
      CREATE TABLE returns_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
        condition TEXT NOT NULL CHECK (condition IN ('clean','damaged')),
        resolution TEXT NOT NULL CHECK (resolution IN ('refund','exchange','store_credit_exchange')),
        refund_amount REAL NOT NULL DEFAULT 0,
        exchange_inventory_id INTEGER REFERENCES inventory(id) ON DELETE SET NULL,
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
    console.log("returns.exchange_inventory_id already has ON DELETE SET NULL — skipped.");
  }

  // ---- 5. purchase_return_items: inventory_id FK rebuild --------------
  const purchaseReturnItemsSql = tableSql("purchase_return_items");
  if (purchaseReturnItemsSql && !purchaseReturnItemsSql.includes("inventory_id INTEGER REFERENCES inventory(id) ON DELETE SET NULL")) {
    console.log("Rebuilding purchase_return_items to add ON DELETE SET NULL to inventory_id...");
    db.exec(`
      CREATE TABLE purchase_return_items_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purchase_return_id INTEGER NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
        pending_line_id INTEGER REFERENCES pending_purchase_lines(id),
        inventory_id INTEGER REFERENCES inventory(id) ON DELETE SET NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        unit_cost REAL NOT NULL
      );
      INSERT INTO purchase_return_items_new (id, purchase_return_id, pending_line_id, inventory_id, quantity, unit_cost)
        SELECT id, purchase_return_id, pending_line_id, inventory_id, quantity, unit_cost FROM purchase_return_items;
      DROP TABLE purchase_return_items;
      ALTER TABLE purchase_return_items_new RENAME TO purchase_return_items;
    `);
    console.log("purchase_return_items rebuilt — every existing row preserved exactly as it was.");
  } else {
    console.log("purchase_return_items.inventory_id already has ON DELETE SET NULL — skipped.");
  }
});

run();

db.pragma("foreign_keys = ON");

const counts = ["sale_items", "purchase_items", "return_requests", "returns", "purchase_return_items"].map((t) => {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
  return `${t}: ${row.c} rows`;
});
console.log("\nRow counts after migration (should match what you had before):");
counts.forEach((c) => console.log(`  ${c}`));

console.log("\nMigration complete. Your existing data was not deleted or altered — only the table structure changed.");

db.close();
