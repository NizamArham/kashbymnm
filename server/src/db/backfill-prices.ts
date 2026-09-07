/**
 * Backfills cost_price/selling_price on inventory units that don't have
 * them yet — e.g. units imported before per-unit pricing was added to the
 * schema. Each unit gets its PRODUCT's current cost_price/selling_price
 * as a reasonable starting value (this is an approximation for historical
 * data; going forward every new unit gets its own real batch price).
 *
 * Run with: npm run db:backfill-prices
 *
 * Safe to run multiple times — only touches units where both price
 * columns are still NULL.
 */
import { db } from "./connection";

function run() {
  const rows = db
    .prepare(
      `SELECT inventory.id, products.cost_price, products.selling_price
       FROM inventory
       JOIN products ON products.id = inventory.product_id
       WHERE inventory.cost_price IS NULL OR inventory.selling_price IS NULL`
    )
    .all() as { id: number; cost_price: number; selling_price: number }[];

  if (rows.length === 0) {
    console.log("No inventory units are missing a cost/selling price. Nothing to do.");
    return;
  }

  console.log(`Found ${rows.length} inventory unit(s) missing a price. Backfilling from their product's current price...`);

  const update = db.prepare(`UPDATE inventory SET cost_price = ?, selling_price = ? WHERE id = ?`);
  const runAll = db.transaction(() => {
    for (const row of rows) {
      update.run(row.cost_price, row.selling_price, row.id);
    }
  });
  runAll();

  console.log(`Done. Backfilled ${rows.length} unit(s).`);
}

run();
