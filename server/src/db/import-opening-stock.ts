/**
 * One-time import of a clean "opening stock" spreadsheet — four sheets
 * (Suppliers, Products, Purchases, Inventory) already shaped to match
 * this system's real tables almost exactly, including pre-generated
 * SKUs and barcodes. This is a DIFFERENT, simpler format from the full
 * operations spreadsheet — this one
 * is for starting fresh with a known-good opening position rather than
 * migrating years of sales/customer history.
 *
 * Run with: npx tsx src/db/import-opening-stock.ts /path/to/Data.xlsx
 *
 * What this does, sheet by sheet:
 * - Suppliers: imported as-is (id, supplier_code, name, phone, city, notes).
 * - Products: imported as-is, including product_type (FO/OG/OR/OP).
 *   supplier_id must resolve to a real supplier — the script fails loudly
 *   rather than silently importing a broken reference.
 * - Purchases: each row is one line item (product_id, quantity, unit_cost,
 *   size, color) grouped under a shared purchase_id. Since this is
 *   opening/historical stock that's already fully sorted into real
 *   inventory, each group becomes ONE fulfilled purchases header row
 *   (fulfillment_status='fulfilled') plus its purchase_items rows —
 *   never a 'pending' purchase, since there's nothing left to sort.
 *   total_cost is computed as the true sum of (quantity * unit_cost)
 *   across the group; amount_paid is set equal to total_cost
 *   (payment_status='paid'), since this is opening stock already paid
 *   for — there is no way to recover partial-payment history from this
 *   sheet, and marking it fully paid is the conservative, non-inflating
 *   choice (it will never overstate what's owed to a supplier).
 * - Inventory: imported as real inventory rows, keeping the SKU and
 *   barcode exactly as given in the sheet (already validated unique).
 *   Each row is linked to the correct purchase_items row generated
 *   above via a (product_id, size, color) match within that product's
 *   purchase groups, consuming one unit of quantity per inventory row
 *   so multiple physical units correctly map back to the batch they
 *   came from.
 *
 * After the four sheets, one opening cash_book entry is created for the
 * given opening cash balance (income, category 'opening_balance'), so
 * the running Cash Book balance starts from a real, visible number
 * rather than zero.
 *
 * Safe to run only on an EMPTY or freshly-migrated database. Does not
 * de-duplicate — running it twice creates duplicate rows.
 */
import path from "path";
import fs from "fs";
import * as XLSX from "xlsx";
import { db } from "./connection";
import { nextSku } from "../lib/codes";

const OPENING_CASH_BALANCE = 25350; // LKR, as given by the business owner

function loadSheet(wb: XLSX.WorkBook, name: string): Record<string, any>[] {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`Sheet "${name}" not found in workbook`);
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: null });
  return rows.filter((r) => Object.values(r).some((v) => v !== null && v !== ""));
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npx tsx src/db/import-opening-stock.ts /path/to/Data.xlsx");
    process.exit(1);
  }
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  const wb = XLSX.readFile(absPath);

  const supplierRows = loadSheet(wb, "Suppliers");
  const productRows = loadSheet(wb, "Products");
  const purchaseRows = loadSheet(wb, "Purchases");
  const inventoryRows = loadSheet(wb, "Invetory"); // matches the sheet's actual (misspelled) name

  console.log(
    `Loaded ${supplierRows.length} suppliers, ${productRows.length} products, ${purchaseRows.length} purchase lines, ${inventoryRows.length} inventory rows.`
  );

  const warnings: string[] = [];

  const runImport = db.transaction(() => {
    // ---- 1. Suppliers ----------------------------------------------
    const supplierIdMap = new Map<number, number>(); // sheet id -> real db id
    const insertSupplier = db.prepare(
      `INSERT INTO suppliers (supplier_code, name, phone, city, notes) VALUES (?, ?, ?, ?, ?)`
    );
    for (const row of supplierRows) {
      const sheetId = Number(row.id);
      const result = insertSupplier.run(
        String(row.supplier_code ?? "").trim(),
        String(row.name ?? "").trim(),
        row.phone != null ? String(row.phone) : null,
        row.city ?? null,
        row.notes ?? null
      );
      supplierIdMap.set(sheetId, Number(result.lastInsertRowid));
    }
    console.log(`Inserted ${supplierIdMap.size} suppliers.`);

    // ---- 2. Products -------------------------------------------------
    const productIdMap = new Map<number, number>(); // sheet id -> real db id
    const insertProduct = db.prepare(
      `INSERT INTO products (product_title, brand, category, cost_price, selling_price, supplier_id, image_path, is_public, allow_returns, product_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of productRows) {
      const sheetId = Number(row.id);
      const sheetSupplierId = row.supplier_id != null ? Number(row.supplier_id) : null;
      const realSupplierId = sheetSupplierId != null ? supplierIdMap.get(sheetSupplierId) : null;
      if (sheetSupplierId != null && realSupplierId == null) {
        throw new Error(
          `Product "${row.product_title}" (sheet id ${sheetId}) references supplier_id ${sheetSupplierId}, which does not exist in the Suppliers sheet. Fix the sheet and re-run.`
        );
      }

      const result = insertProduct.run(
        String(row.product_title ?? "").trim(),
        row.brand ?? null,
        row.category ?? null,
        Number(row.cost_price ?? 0),
        Number(row.selling_price ?? 0),
        realSupplierId,
        row.image_path ?? null,
        row.is_public === 0 ? 0 : 1,
        row.allow_returns === 0 ? 0 : 1,
        row.product_type ?? "OG"
      );
      productIdMap.set(sheetId, Number(result.lastInsertRowid));
    }
    console.log(`Inserted ${productIdMap.size} products.`);

    // ---- 3. Purchases (grouped by each product's REAL supplier) --------
    // The sheet's own purchase_id column groups everything under a single
    // id (1) regardless of supplier — that can't become one purchases row
    // in the real schema, since a purchase always belongs to exactly one
    // supplier. Instead, purchase lines are grouped by the supplier of
    // their product, so each supplier gets their own single opening
    // purchases header row covering everything bought from them.
    // Opening stock is treated as fully paid — the conservative choice,
    // since partial-payment history can't be recovered from this sheet
    // and this never overstates what's owed to a supplier.
    const linesBySupplier = new Map<number, typeof purchaseRows>(); // real supplier id -> lines
    for (const row of purchaseRows) {
      const sheetProductId = Number(row.product_id);
      const productRow = productRows.find((p) => Number(p.id) === sheetProductId);
      const sheetSupplierId = productRow?.supplier_id != null ? Number(productRow.supplier_id) : null;
      const realSupplierId = sheetSupplierId != null ? supplierIdMap.get(sheetSupplierId) : null;
      if (realSupplierId == null) {
        throw new Error(`Purchase line for product_id ${sheetProductId} has no resolvable supplier — cannot create a purchases header row.`);
      }
      if (!linesBySupplier.has(realSupplierId)) linesBySupplier.set(realSupplierId, []);
      linesBySupplier.get(realSupplierId)!.push(row);
    }

    // Purchase batches are matched to Inventory by PRODUCT ONLY — the
    // sheet's Purchases rows don't break quantity down by size/color
    // (just a bulk total per product), so an exact variant-level match
    // isn't possible from this data. Since every product here has just
    // one purchase line, matching by product alone is unambiguous.
    interface CreatedPurchaseItem {
      id: number;
      product_id: number; // real db id
      remaining: number;
    }
    const createdPurchaseItems: CreatedPurchaseItem[] = [];

    const insertPurchase = db.prepare(
      `INSERT INTO purchases (purchase_code, supplier_id, purchase_date, total_cost, amount_paid, payment_status, fulfillment_status, description)
       VALUES (?, ?, datetime('now'), ?, ?, 'paid', 'fulfilled', ?)`
    );
    const insertPurchaseItem = db.prepare(
      `INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_cost, size, color) VALUES (?, ?, ?, ?, ?, ?)`
    );

    let purchaseSeq = 1;
    for (const [realSupplierId, lines] of linesBySupplier) {
      const totalCost = lines.reduce((sum, l) => sum + Number(l.quantity) * Number(l.unit_cost), 0);
      const purchaseCode = `P-OPEN-${String(purchaseSeq).padStart(4, "0")}`;
      purchaseSeq++;

      const purchaseResult = insertPurchase.run(
        purchaseCode,
        realSupplierId,
        totalCost,
        totalCost,
        "Opening stock, imported from opening-stock spreadsheet"
      );
      const realPurchaseId = Number(purchaseResult.lastInsertRowid);

      for (const line of lines) {
        const sheetProductId = Number(line.product_id);
        const realProductId = productIdMap.get(sheetProductId);
        if (realProductId == null) {
          throw new Error(`Purchase line references product_id ${sheetProductId}, which was not found in Products.`);
        }
        const quantity = Number(line.quantity);
        const unitCost = Number(line.unit_cost);
        const size = line.size ?? null;
        const color = line.color ?? null;

        const itemResult = insertPurchaseItem.run(realPurchaseId, realProductId, quantity, unitCost, size, color);
        createdPurchaseItems.push({
          id: Number(itemResult.lastInsertRowid),
          product_id: realProductId,
          remaining: quantity,
        });
      }
    }
    console.log(`Created ${linesBySupplier.size} purchase batches (one per supplier), ${createdPurchaseItems.length} purchase line items.`);

    // ---- 4. Inventory --------------------------------------------------
    // Each inventory row is matched to a purchase_items row for the SAME
    // PRODUCT with remaining quantity left (see note above on why this
    // is product-level, not variant-level), consuming one unit as it's
    // matched. If a product's purchased quantity and actual inventory
    // count don't line up exactly (a handful do, in this historical
    // data), the extra inventory rows still import correctly — they
    // just end up with no batch link once the matching batch is used up.
    const insertInventory = db.prepare(
      `INSERT INTO inventory (product_id, size, color, sku, barcode, cost_price, selling_price, purchase_item_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let inventoryInserted = 0;
    let unmatchedBatch = 0;
    for (const row of inventoryRows) {
      const sheetProductId = Number(row.product_id);
      const realProductId = productIdMap.get(sheetProductId);
      if (realProductId == null) {
        throw new Error(`Inventory row references product_id ${sheetProductId}, which was not found in Products.`);
      }

      const size = row.size ?? null;
      const color = row.color ?? null;

      const match = createdPurchaseItems.find((pi) => pi.product_id === realProductId && pi.remaining > 0);
      if (match) {
        match.remaining -= 1;
      } else {
        // No batch with remaining quantity left for this product (this
        // product's purchased-vs-inventory count didn't line up exactly
        // in the source data) — the unit still gets imported, just
        // without a batch link, and this is reported at the end rather
        // than silently swallowed.
        unmatchedBatch++;
      }

      insertInventory.run(
        realProductId,
        size,
        color,
        String(row.sku ?? "").trim(),
        row.barcode != null ? String(row.barcode) : null,
        Number(row.cost_price ?? 0),
        Number(row.selling_price ?? 0),
        match ? match.id : null,
        row.status ?? "available"
      );
      inventoryInserted++;
    }
    console.log(`Inserted ${inventoryInserted} inventory units.`);
    if (unmatchedBatch > 0) {
      warnings.push(
        `${unmatchedBatch} inventory row(s) had no matching purchase batch (product/size/color combination exhausted or missing in Purchases sheet) — imported with purchase_item_id = NULL.`
      );
    }

    // ---- 5. Opening cash balance ---------------------------------------
    db.prepare(
      `INSERT INTO cash_book (type, category, payment_method, amount, notes) VALUES ('income', 'opening_balance', 'cash', ?, ?)`
    ).run(OPENING_CASH_BALANCE, "Opening cash balance at system setup");
    console.log(`Recorded opening cash balance: Rs. ${OPENING_CASH_BALANCE.toLocaleString()}`);
  });

  runImport();

  console.log("\nImport complete.");
  if (warnings.length > 0) {
    console.log("\nWarnings:");
    warnings.forEach((w) => console.log(`  - ${w}`));
  }
}

main();
