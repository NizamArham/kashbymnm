/**
 * One-time import from the "M&M Clothing — Operations Template" workbook
 * — the fuller, human-maintained spreadsheet, a different shape from
 * import-opening-stock.ts's simpler 4-sheet format (that script expects
 * numeric ids and a "Products"/"Invetory" sheet naming; this template
 * uses human Product Code/Supplier Code strings and different headers
 * entirely, so it needed its own importer).
 *
 * Only three sheets in this template are actually filled in as of this
 * writing: Suppliers, Product Details, and Inventory. Everything else
 * (Purchases, Sales Register, Customers, Cash Book, Supplier Payments,
 * Courier Payments) is still the blank template — intentionally left out
 * of this import; that history goes in through the app itself instead.
 *
 * Run with: npx tsx src/db/import-operations-template.ts /path/to/Workbook.xlsx
 *
 * Suppliers -> imported as-is (Supplier Code, Supplier Name -> name,
 * Contact Number -> phone, Location -> city).
 *
 * Product Details -> one row per product. This sheet has no explicit
 * selling-price column (its own Instructions sheet confirms Total Cost
 * and Profit are the only formula cells — Revenue is a manually-entered
 * planning figure, not a formula), so selling_price is derived as
 * Revenue / Qty (rounded) — the only per-unit price signal available.
 * cost_price comes straight from Cost/pp. product_type (FO/OG/OR/OP/IM)
 * is read from a clean "-XX" suffix at the very end of the title where
 * one exists (e.g. "GP-Linen Slim Pant-FO" -> FO); most titles have no
 * such suffix and default to OG. A row with no Product Title is skipped
 * and reported.
 *
 * Inventory -> one row per physical unit, linked to its product by
 * Product Code. Status blank -> 'available', 'Sold' -> 'sold'. There's
 * no per-unit price in this sheet, so cost_price/selling_price are
 * inherited from the parent product.
 *
 * Purchases -> the sheet's own Purchases tab is empty (no real purchase
 * or payment history to import faithfully), so one synthetic "Opening
 * stock" purchases header is created per supplier — covering everything
 * bought from them, using each product's real Qty * Cost/pp — marked
 * fully paid. This means every supplier starts owed Rs. 0 (the
 * conservative, non-inflating choice) while Purchases still shows real
 * cost history instead of starting completely blank. Codes are compact,
 * no separators (OPN0001, OPN0002, ...), matching the style asked for.
 *
 * Safe to run only on an EMPTY or freshly-migrated database. Does not
 * de-duplicate — running it twice creates duplicate rows.
 */
import path from "path";
import fs from "fs";
import * as XLSX from "xlsx";
import { db } from "./connection";

const PRODUCT_TYPES = new Set(["FO", "OG", "OR", "OP", "IM"]);

function loadSheet(wb: XLSX.WorkBook, name: string): Record<string, any>[] {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`Sheet "${name}" not found in workbook`);
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: null });
  return rows.filter((r) => Object.values(r).some((v) => v !== null && v !== ""));
}

function deriveProductType(title: string): string {
  const m = title.match(/-([A-Z]{2})$/);
  if (m && PRODUCT_TYPES.has(m[1])) return m[1];
  return "OG";
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npx tsx src/db/import-operations-template.ts /path/to/Workbook.xlsx");
    process.exit(1);
  }
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  const wb = XLSX.readFile(absPath);

  const supplierRows = loadSheet(wb, "Suppliers");
  const productRows = loadSheet(wb, "Product Details");
  const inventoryRows = loadSheet(wb, "Inventory");

  console.log(`Loaded ${supplierRows.length} suppliers, ${productRows.length} products, ${inventoryRows.length} inventory rows.`);

  const warnings: string[] = [];

  const runImport = db.transaction(() => {
    // ---- 1. Suppliers ----------------------------------------------
    const supplierIdMap = new Map<string, number>(); // Supplier Code -> real db id
    const insertSupplier = db.prepare(`INSERT INTO suppliers (supplier_code, name, phone, city, notes) VALUES (?, ?, ?, ?, ?)`);
    for (const row of supplierRows) {
      const code = String(row["Supplier Code"] ?? "").trim();
      if (!code) continue;
      const result = insertSupplier.run(
        code,
        String(row["Supplier Name"] ?? "").trim(),
        row["Contact Number"] != null ? String(row["Contact Number"]) : null,
        row["Location"] ?? null,
        null
      );
      supplierIdMap.set(code, Number(result.lastInsertRowid));
    }
    console.log(`Inserted ${supplierIdMap.size} suppliers.`);

    // ---- 2. Products -------------------------------------------------
    const productIdMap = new Map<string, number>(); // Product Code (sheet ID) -> real db id
    // Also remember each product's sheet-side Qty/Cost/pp/Supplier Code
    // for the synthetic opening-stock purchase batches built below.
    const productMeta = new Map<
      string,
      { realId: number; qty: number; costPerPiece: number; supplierCode: string | null }
    >();
    const insertProduct = db.prepare(
      `INSERT INTO products (product_title, brand, category, cost_price, selling_price, supplier_id, is_public, allow_returns, product_type)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`
    );
    let skippedNoTitle = 0;
    let unresolvedSupplier = 0;
    for (const row of productRows) {
      const sheetId = String(row["ID"] ?? "").trim();
      const title = row["Product Title"] != null ? String(row["Product Title"]).trim() : "";
      if (!sheetId || !title) {
        skippedNoTitle++;
        continue;
      }

      const supplierCode = row["Supplier Code"] != null ? String(row["Supplier Code"]).trim() : null;
      const realSupplierId = supplierCode ? supplierIdMap.get(supplierCode) ?? null : null;
      if (supplierCode && realSupplierId == null) {
        // supplier_id is nullable — a real, common gap in this sheet
        // ("??" placeholders for products whose supplier was never
        // pinned down) shouldn't block importing the other 80+ products
        // that ARE clean. Reported once at the end instead.
        unresolvedSupplier++;
      }

      const qty = Number(row["Qty"] ?? 0);
      const costPerPiece = Number(row["Cost/pp"] ?? 0);
      const revenue = Number(row["Revenue"] ?? 0);
      const sellingPrice = qty > 0 ? Math.round(revenue / qty) : 0;

      const result = insertProduct.run(
        title,
        row["Brand"] ?? null,
        row["Category"] ?? null,
        costPerPiece,
        sellingPrice,
        realSupplierId,
        deriveProductType(title)
      );
      const realId = Number(result.lastInsertRowid);
      productIdMap.set(sheetId, realId);
      productMeta.set(sheetId, { realId, qty, costPerPiece, supplierCode: realSupplierId != null ? supplierCode : null });
    }
    console.log(`Inserted ${productIdMap.size} products.${skippedNoTitle > 0 ? ` Skipped ${skippedNoTitle} row(s) with no ID/title.` : ""}`);
    if (skippedNoTitle > 0) warnings.push(`${skippedNoTitle} product row(s) had no ID or Product Title and were skipped.`);
    if (unresolvedSupplier > 0) {
      warnings.push(
        `${unresolvedSupplier} product(s) had a Supplier Code that doesn't match any real supplier (e.g. "??" placeholders) — imported with no supplier linked, and left out of the opening-stock purchase batches below.`
      );
    }

    // ---- 3. Opening-stock purchases (one per supplier) ------------------
    // Grouped by supplier, using each product's real Qty * Cost/pp —
    // the only cost data this template actually has, since its own
    // Purchases sheet was never filled in.
    interface CreatedPurchaseItem {
      id: number;
      productSheetId: string;
      remaining: number;
    }
    const createdPurchaseItems: CreatedPurchaseItem[] = [];
    const linesBySupplier = new Map<string, string[]>(); // supplierCode -> product sheet ids
    for (const [sheetId, meta] of productMeta) {
      if (!meta.supplierCode) continue;
      if (!linesBySupplier.has(meta.supplierCode)) linesBySupplier.set(meta.supplierCode, []);
      linesBySupplier.get(meta.supplierCode)!.push(sheetId);
    }

    const insertPurchase = db.prepare(
      `INSERT INTO purchases (purchase_code, supplier_id, purchase_date, total_cost, amount_paid, payment_status, fulfillment_status, description)
       VALUES (?, ?, datetime('now', '+330 minutes'), ?, ?, 'paid', 'fulfilled', ?)`
    );
    const insertPurchaseItem = db.prepare(
      `INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_cost) VALUES (?, ?, ?, ?)`
    );

    let purchaseSeq = 1;
    for (const [supplierCode, sheetIds] of linesBySupplier) {
      const realSupplierId = supplierIdMap.get(supplierCode);
      if (realSupplierId == null) continue;

      const totalCost = sheetIds.reduce((sum, id) => {
        const meta = productMeta.get(id)!;
        return sum + meta.qty * meta.costPerPiece;
      }, 0);
      const purchaseCode = `OPN${String(purchaseSeq).padStart(4, "0")}`;
      purchaseSeq++;

      const purchaseResult = insertPurchase.run(purchaseCode, realSupplierId, totalCost, totalCost, "Opening stock");
      const realPurchaseId = Number(purchaseResult.lastInsertRowid);

      for (const sheetId of sheetIds) {
        const meta = productMeta.get(sheetId)!;
        if (meta.qty <= 0) continue;
        const itemResult = insertPurchaseItem.run(realPurchaseId, meta.realId, meta.qty, meta.costPerPiece);
        createdPurchaseItems.push({ id: Number(itemResult.lastInsertRowid), productSheetId: sheetId, remaining: meta.qty });
      }
    }
    console.log(`Created ${linesBySupplier.size} opening-stock purchase batches (one per supplier), ${createdPurchaseItems.length} purchase line items.`);

    // ---- 4. Inventory --------------------------------------------------
    const insertInventory = db.prepare(
      `INSERT INTO inventory (product_id, size, color, sku, barcode, cost_price, selling_price, purchase_item_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let inventoryInserted = 0;
    let skippedNoProduct = 0;
    let unmatchedBatch = 0;
    for (const row of inventoryRows) {
      const sheetProductId = row["Product Code"] != null ? String(row["Product Code"]).trim() : "";
      const meta = productMeta.get(sheetProductId);
      if (!meta) {
        skippedNoProduct++;
        continue;
      }

      const size = row["Size"] ?? null;
      const color = row["Color"] ?? null;
      const sku = row["SKU"] != null ? String(row["SKU"]).trim() : null;
      const statusRaw = row["Status"] != null ? String(row["Status"]).trim().toLowerCase() : "";
      const status = statusRaw === "sold" ? "sold" : "available";

      const match = createdPurchaseItems.find((pi) => pi.productSheetId === sheetProductId && pi.remaining > 0);
      if (match) {
        match.remaining -= 1;
      } else {
        unmatchedBatch++;
      }

      insertInventory.run(meta.realId, size, color, sku, null, meta.costPerPiece, null, match ? match.id : null, status);
      inventoryInserted++;
    }
    // Fill inventory.selling_price from the parent product's derived
    // selling price, now that every product row exists — simpler than
    // threading the value through the insert loop above.
    db.exec(`
      UPDATE inventory
      SET selling_price = (SELECT selling_price FROM products WHERE products.id = inventory.product_id)
      WHERE selling_price IS NULL
    `);

    console.log(`Inserted ${inventoryInserted} inventory units.${skippedNoProduct > 0 ? ` Skipped ${skippedNoProduct} row(s) with an unresolvable Product Code.` : ""}`);
    if (skippedNoProduct > 0) warnings.push(`${skippedNoProduct} inventory row(s) referenced a Product Code not found in Product Details and were skipped.`);
    if (unmatchedBatch > 0) {
      warnings.push(
        `${unmatchedBatch} inventory row(s) had no matching purchase batch left (that product's sheet Qty and actual unit count didn't line up exactly) — imported with purchase_item_id = NULL.`
      );
    }
  });

  runImport();

  console.log("\nImport complete. No opening cash balance was recorded — enter that yourself via Cash Book.");
  if (warnings.length > 0) {
    console.log("\nWarnings:");
    warnings.forEach((w) => console.log(`  - ${w}`));
  }
}

main();
