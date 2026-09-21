/**
 * One-time backfill: assigns a real barcode to every inventory unit that
 * doesn't have one yet. Existing units without a barcode (pre-dating the
 * barcode feature, or imported without one) are otherwise unscannable at
 * POS/lookup, even though every NEW unit created via Purchases already
 * gets one automatically.
 *
 * Uses the exact same format and continuation logic as
 * server/src/routes/purchases.ts's nextBarcodeBatch — "890" prefix + a
 * 10-digit zero-padded sequential number, continuing from the highest
 * barcode already in the system, so backfilled units slot into the same
 * numbering sequence as everything else rather than starting a separate
 * range.
 *
 * Idempotent: only touches rows where barcode IS NULL, ordered by id so
 * the assignment is deterministic and reproducible. Safe to re-run —
 * already-backfilled rows are simply skipped on a second pass.
 *
 * Run with: npx tsx src/db/migrate-backfill-barcodes.ts
 */
import path from "path";
import Database from "better-sqlite3";

const DB_PATH = path.join(__dirname, "..", "..", "data", "mm-clothing.db");
const db = new Database(DB_PATH);

const BARCODE_PREFIX = "890";

function nextBarcodeBatch(count: number): string[] {
  const row = db
    .prepare(`SELECT barcode FROM inventory WHERE barcode LIKE ? ORDER BY barcode DESC LIMIT 1`)
    .get(`${BARCODE_PREFIX}%`) as { barcode: string } | undefined;

  let nextNum = 100_000_000;
  if (row?.barcode) {
    const numericPart = row.barcode.slice(BARCODE_PREFIX.length);
    const parsed = parseInt(numericPart, 10);
    if (!isNaN(parsed)) nextNum = parsed + 1;
  }

  return Array.from({ length: count }, (_, i) => `${BARCODE_PREFIX}${String(nextNum + i).padStart(10, "0")}`);
}

console.log(`Migrating ${DB_PATH} ...`);

const missing = db.prepare(`SELECT id FROM inventory WHERE barcode IS NULL ORDER BY id ASC`).all() as { id: number }[];

if (missing.length === 0) {
  console.log("Every inventory unit already has a barcode — nothing to do.");
} else {
  const barcodes = nextBarcodeBatch(missing.length);
  const update = db.prepare(`UPDATE inventory SET barcode = ? WHERE id = ?`);

  const run = db.transaction(() => {
    missing.forEach((row, i) => update.run(barcodes[i], row.id));
  });
  run();

  console.log(`Backfilled ${missing.length} unit(s) — barcodes ${barcodes[0]} through ${barcodes[barcodes.length - 1]}.`);
}

const remaining = db.prepare(`SELECT COUNT(*) as c FROM inventory WHERE barcode IS NULL`).get() as { c: number };
console.log(`\nInventory units still without a barcode: ${remaining.c} (should be 0).`);

db.close();
