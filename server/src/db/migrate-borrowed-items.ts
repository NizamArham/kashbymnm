// One-off migration for "item not in stock" sales (borrowed pieces sold before they're entered).
//
// Adds two columns to `inventory` and widens the write-off reasons with "Returned to supplier".
// SQLite can't change a CHECK constraint in place, so the table is rebuilt: copy into a new table,
// drop the old one, rename, then recreate its indexes. Safe to run once; re-running is a no-op.
//
// Run with the server stopped:  npm run db:migrate-borrowed-items
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DB_PATH = path.join(DATA_DIR, "mm-clothing.db");
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

if (!fs.existsSync(DB_PATH)) {
  console.log(`No database at ${DB_PATH} — nothing to migrate. A fresh install gets this from schema.sql.`);
  process.exit(0);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const schemaSql = fs.readFileSync(SCHEMA_PATH, "utf-8");
const tableDef = schemaSql.match(/CREATE TABLE IF NOT EXISTS inventory \(([\s\S]*?)\n\);/);
if (!tableDef) throw new Error("Could not find the inventory table definition in schema.sql");
const indexSql = schemaSql.match(/^CREATE INDEX IF NOT EXISTS \w+ ON inventory\b[^;]*;/gm) ?? [];

const current = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inventory'`).get() as
  | { sql: string }
  | undefined;
if (!current) throw new Error("This database has no inventory table — run the base schema first");
if (current.sql.includes("manual_pending_line_id")) {
  console.log("Already migrated — nothing to do.");
  db.close();
  process.exit(0);
}

// A consistent copy of the whole database, taken before any change. (A plain file copy is unsafe
// while WAL is in use, because recent writes can still sit in the -wal file.)
const backup = `${DB_PATH}.before-borrowed-items-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`Backed up database to ${backup}`);

const oldCols = (db.prepare(`PRAGMA table_info(inventory)`).all() as { name: string }[]).map((c) => c.name);
const cols = oldCols.join(", ");

db.pragma("foreign_keys = OFF");
try {
  db.transaction(() => {
    db.exec(`CREATE TABLE inventory_new (${tableDef[1]}\n);`);
    db.exec(`INSERT INTO inventory_new (${cols}) SELECT ${cols} FROM inventory`);
    db.exec(`DROP TABLE inventory`);
    db.exec(`ALTER TABLE inventory_new RENAME TO inventory`);
    for (const stmt of indexSql) db.exec(stmt);
    const problems = db.pragma("foreign_key_check") as unknown[];
    if (problems.length > 0) throw new Error(`Foreign key problems after rebuild: ${JSON.stringify(problems)}`);
  })();
  console.log(`Rebuilt inventory with ${oldCols.length} existing columns preserved, and the new borrowed-item columns added.`);
} finally {
  db.pragma("foreign_keys = ON");
  db.close();
}
