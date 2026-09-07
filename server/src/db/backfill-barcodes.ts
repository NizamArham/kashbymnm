/**
 * Backfills barcodes for existing inventory units that don't have one —
 * e.g. units brought in via the spreadsheet import, whose source data
 * never had a barcode column.
 *
 * Run with: npm run db:backfill-barcodes
 *
 * Safe to run multiple times — it only touches rows where barcode IS NULL,
 * so units that already have a barcode (from the app's own "Add Product"
 * flow) are never touched or regenerated.
 */
import { db } from "./connection";

function makeBarcodeBatch(count: number, startFrom: number): string[] {
  const prefix = "890";
  return Array.from({ length: count }, (_, i) => `${prefix}${String(startFrom + i).padStart(10, "0")}`);
}

function randomBatchStart(): number {
  return Math.floor(Math.random() * 9_000_000_000) + 100_000_000;
}

function run() {
  const rows = db
    .prepare(`SELECT id FROM inventory WHERE barcode IS NULL ORDER BY id ASC`)
    .all() as { id: number }[];

  if (rows.length === 0) {
    console.log("No inventory units are missing a barcode. Nothing to do.");
    return;
  }

  console.log(`Found ${rows.length} inventory unit(s) without a barcode. Generating...`);

  const barcodes = makeBarcodeBatch(rows.length, randomBatchStart());
  const update = db.prepare(`UPDATE inventory SET barcode = ? WHERE id = ?`);

  const runAll = db.transaction(() => {
    rows.forEach((row, i) => {
      update.run(barcodes[i], row.id);
    });
  });

  runAll();

  console.log(`Done. Assigned barcodes ${barcodes[0]} through ${barcodes[barcodes.length - 1]}.`);
}

run();
