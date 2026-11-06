// One-off migration for "item not in stock" sales (borrowed pieces sold before they're entered).
//
// Adds two columns to `inventory` and widens the write-off reasons with "Returned to supplier".
// SQLite can't change a CHECK constraint in place, so the table is rebuilt. The new table is built
// from the live database's OWN definition of `inventory`, so any columns it already has (including
// ones added by older migrations) are kept. Indexes and triggers on the table are recreated.
//
// Safe to run once; re-running is a no-op. Run with the server stopped:
//   npm run db:migrate-borrowed-items
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DB_PATH = path.join(DATA_DIR, "mm-clothing.db");

if (!fs.existsSync(DB_PATH)) {
  console.log(`No database at ${DB_PATH} — nothing to migrate. A fresh install gets this from schema.sql.`);
  process.exit(0);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const current = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inventory'`).get() as
  | { sql: string }
  | undefined;
if (!current) throw new Error("This database has no inventory table — run the base schema first");
if (current.sql.includes("manual_pending_line_id")) {
  console.log("Already migrated — nothing to do.");
  db.close();
  process.exit(0);
}

// Build the new table definition from the live one.
let newTableSql = current.sql.replace(/^CREATE TABLE\s+("?)inventory\1\s*\(/i, "CREATE TABLE inventory_new (");
if (!newTableSql.startsWith("CREATE TABLE inventory_new (")) {
  throw new Error("Unexpected inventory table definition — nothing was changed");
}

const reasonCheck = /(removal_reason\s+TEXT\s+CHECK\s*\(\s*removal_reason\s+IN\s*\()([^)]*)\)/i;
if (!reasonCheck.test(newTableSql)) {
  throw new Error("Could not find the removal_reason check on inventory — nothing was changed");
}
newTableSql = newTableSql.replace(reasonCheck, (_m, head: string, list: string) => `${head}${list}, 'Returned to supplier')`);

const closeAt = newTableSql.lastIndexOf(")");
newTableSql =
  newTableSql.slice(0, closeAt) +
  ",\n  manual_pending_line_id INTEGER REFERENCES pending_purchase_lines(id),\n" +
  "  manual_resolution TEXT CHECK (manual_resolution IN ('paid','returned'))\n" +
  newTableSql.slice(closeAt);

// Indexes and triggers on inventory are dropped with the old table, so save their definitions.
const extras = db
  .prepare(`SELECT sql FROM sqlite_master WHERE tbl_name = 'inventory' AND type IN ('index','trigger') AND sql IS NOT NULL`)
  .all() as { sql: string }[];

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
    db.exec(newTableSql + ";");
    db.exec(`INSERT INTO inventory_new (${cols}) SELECT ${cols} FROM inventory`);
    db.exec(`DROP TABLE inventory`);
    db.exec(`ALTER TABLE inventory_new RENAME TO inventory`);
    for (const row of extras) db.exec(row.sql + ";");
    const problems = db.pragma("foreign_key_check") as unknown[];
    if (problems.length > 0) throw new Error(`Foreign key problems after rebuild: ${JSON.stringify(problems)}`);
  })();
  console.log(`Rebuilt inventory: kept all ${oldCols.length} existing columns, added the borrowed-item columns.`);
} finally {
  db.pragma("foreign_keys = ON");
  db.close();
}
