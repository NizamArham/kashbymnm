/**
 * One-time import of real business data from the M&M Clothing operations
 * spreadsheet (Suppliers, Product Details, Inventory, Customers, Sales
 * Register) into the SQLite database.
 *
 * Run with: npx tsx src/db/import-spreadsheet.ts /path/to/file.xlsx
 *
 * Decisions this script follows (agreed with the business owner):
 * - Products with supplier code "??" import with supplier_id = NULL.
 * - Customer addresses / supplier locations are blank in the source data
 *   and are simply left blank — no fabricated values.
 * - Sales Register rows with delivery info (Delivery Option, Status="Sent")
 *   generate a delivery record; "Sent" maps to delivery_status "delivered".
 * - Loyalty points are NOT copied from the spreadsheet's own point column
 *   (which used the old formula) — they are recalculated on each imported
 *   sale using the CURRENT system rule (1% of total), so historical points
 *   stay consistent with points earned on any future sale.
 *
 * Safe to run only on an EMPTY or freshly-migrated database. It does not
 * de-duplicate against existing rows — running it twice will create
 * duplicate suppliers/products/etc.
 */
import path from "path";
import fs from "fs";
import * as XLSX from "xlsx";
import { db } from "./connection";

const LOYALTY_RATE_PERCENT = 0.01; // must match server/src/routes/sales.ts

interface ImportStats {
  suppliers: number;
  products: number;
  inventory: number;
  customers: number;
  sales: number;
  deliveries: number;
  warnings: string[];
}

function loadSheet(wb: XLSX.WorkBook, name: string): Record<string, any>[] {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: null });
  // Drop fully-empty rows (spreadsheet template padding beyond real data)
  return rows.filter((r) => Object.values(r).some((v) => v !== null && v !== ""));
}

// Reads a single sheet as an array-of-arrays (raw: false) purely to get
// each cell's FORMATTED text, used only for phone-like columns. A phone
// cell like "0771234567" gets silently turned into the number 771234567
// (leading zero dropped) under normal raw parsing, since XLSX has no way
// to know it's a phone number rather than a quantity — the formatted
// text preserves it as typed, as long as the source column is formatted
// as Text in Excel. This is intentionally scoped to phone columns only:
// applying raw:false sheet-wide risks corrupting genuinely numeric data
// (prices, quantities) if any cell's number format doesn't round-trip
// cleanly through Excel's text formatting.
function buildPhoneTextLookup(wb: XLSX.WorkBook, sheetName: string, phoneColumnHeader: string): Map<number, string> {
  const ws = wb.Sheets[sheetName];
  const lookup = new Map<number, string>();
  if (!ws) return lookup;

  const textRows = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: null, raw: false });
  textRows.forEach((row, i) => {
    const value = row[phoneColumnHeader];
    if (value != null && value !== "") lookup.set(i, String(value));
  });
  return lookup;
}

function excelDateToIso(value: any): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") {
    // Excel serial date
    const d = XLSX.SSF.parse_date_code(value);
    if (!d) return null;
    return new Date(Date.UTC(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, d.S || 0)).toISOString();
  }
  return null;
}

function run() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npx tsx src/db/import-spreadsheet.ts /path/to/file.xlsx");
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const wb = XLSX.readFile(filePath, { cellDates: true });
  const stats: ImportStats = {
    suppliers: 0,
    products: 0,
    inventory: 0,
    customers: 0,
    sales: 0,
    deliveries: 0,
    warnings: [],
  };

  const supplierRows = loadSheet(wb, "Suppliers");
  const productRows = loadSheet(wb, "Product Details");
  const inventoryRows = loadSheet(wb, "Inventory");
  const customerRows = loadSheet(wb, "Customers");
  const salesRows = loadSheet(wb, "Sales Register");

  // Phone-like columns read separately as formatted text, so a number
  // like 0771234567 keeps its leading zero instead of being silently
  // parsed as the JS number 771234567 by the normal raw row loading above.
  const supplierPhoneText = buildPhoneTextLookup(wb, "Suppliers", "Contact Number");
  const customerPhoneText = buildPhoneTextLookup(wb, "Customers", "Tel.");

  // Maps from spreadsheet code -> new database id, built as we insert so
  // later sheets (which reference earlier ones) can resolve foreign keys.
  const supplierCodeToId = new Map<string, number>();
  const productCodeToId = new Map<string, number>();
  const customerCodeToId = new Map<string, number>();
  // SKU -> inventory row id, so Sales Register lines can find their unit.
  const skuToInventoryId = new Map<string, number>();
  // product code -> list of available inventory ids for that product,
  // used when a sale references a product without a specific SKU.
  const productCodeToAvailableInventoryIds = new Map<string, number[]>();
  // product id -> its cost/selling price at import time, so every
  // imported inventory unit gets a real per-unit price instead of NULL.
  const productIdToPrices = new Map<number, { cost_price: number; selling_price: number }>();

  const importAll = db.transaction(() => {
    // ---------- Suppliers ----------
    const insertSupplier = db.prepare(
      `INSERT INTO suppliers (supplier_code, name, phone, city, notes) VALUES (?, ?, ?, ?, ?)`
    );
    supplierRows.forEach((row, i) => {
      const code = String(row["Supplier Code"] ?? "").trim();
      if (!code) return;
      const result = insertSupplier.run(
        code,
        String(row["Supplier Name"] ?? "").trim() || "Unnamed supplier",
        supplierPhoneText.get(i) ?? null,
        row["Location"] ? String(row["Location"]).trim() : null,
        null
      );
      supplierCodeToId.set(code, Number(result.lastInsertRowid));
      stats.suppliers++;
    });

    // ---------- Products ----------
    const insertProduct = db.prepare(
      `INSERT INTO products (product_title, brand, category, cost_price, selling_price, supplier_id, is_public)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    );
    for (const row of productRows) {
      const code = String(row["ID"] ?? "").trim();
      if (!code) continue;

      const supplierCode = row["Code"] ? String(row["Code"]).trim() : null;
      // "??" is the spreadsheet's placeholder for "supplier unknown" —
      // imports as NULL rather than a fabricated or guessed supplier.
      const supplierId =
        supplierCode && supplierCode !== "??" ? supplierCodeToId.get(supplierCode) ?? null : null;
      if (supplierCode === "??") {
        stats.warnings.push(`Product ${code} (${row["Product Title"]}) had supplier code "??" — imported with no supplier.`);
      } else if (supplierCode && supplierId == null) {
        stats.warnings.push(`Product ${code} referenced unknown supplier code "${supplierCode}" — imported with no supplier.`);
      }

      const costPrice = Number(row["Cost/pp"] ?? 0);
      // Selling price isn't a direct column — Product Details only has
      // Revenue (total across all units sold historically) and Qty.
      // We derive a per-unit selling price from Revenue / Qty when
      // possible, falling back to cost price (0% margin) if we can't.
      const qty = Number(row["Qty"] ?? 0);
      const revenue = Number(row["Revenue"] ?? 0);
      const sellingPrice = qty > 0 && revenue > 0 ? Math.round(revenue / qty) : costPrice;

      const result = insertProduct.run(
        String(row["Product Title"] ?? "").trim() || "Untitled product",
        String(row["Brand"] ?? "").trim() || null,
        String(row["Category"] ?? "").trim() || null,
        costPrice,
        sellingPrice,
        supplierId
      );
      const newProductId = Number(result.lastInsertRowid);
      productCodeToId.set(code, newProductId);
      productIdToPrices.set(newProductId, { cost_price: costPrice, selling_price: sellingPrice });
      stats.products++;
    }

    // ---------- Inventory ----------
    const insertInventory = db.prepare(
      `INSERT INTO inventory (product_id, size, color, sku, status, cost_price, selling_price) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of inventoryRows) {
      const productCode = String(row["Product Code"] ?? "").trim();
      const productId = productCodeToId.get(productCode);
      if (!productId) {
        stats.warnings.push(`Inventory row with SKU ${row["SKU"]} references unknown product code "${productCode}" — skipped.`);
        continue;
      }

      const sku = String(row["SKU"] ?? "").trim();
      const statusRaw = row["Status"] ? String(row["Status"]).trim().toLowerCase() : "available";
      const status = statusRaw === "sold" ? "sold" : "available";
      const prices = productIdToPrices.get(productId);

      const result = insertInventory.run(
        productId,
        row["Size"] ? String(row["Size"]).trim() : null,
        row["Color"] ? String(row["Color"]).trim() : null,
        sku || null,
        status,
        prices?.cost_price ?? null,
        prices?.selling_price ?? null
      );
      const invId = Number(result.lastInsertRowid);
      if (sku) skuToInventoryId.set(sku, invId);

      if (status === "available") {
        const list = productCodeToAvailableInventoryIds.get(productCode) ?? [];
        list.push(invId);
        productCodeToAvailableInventoryIds.set(productCode, list);
      }
      stats.inventory++;
    }

    // ---------- Customers ----------
    const insertCustomer = db.prepare(
      `INSERT INTO customers (customer_code, name, phone, created_at) VALUES (?, ?, ?, ?)`
    );
    customerRows.forEach((row, i) => {
      const code = String(row["Customer Code"] ?? "").trim();
      if (!code) return;

      const createdAt = excelDateToIso(row["Registration Date"]) ?? new Date().toISOString();
      const result = insertCustomer.run(
        code,
        String(row["Name"] ?? "").trim() || "Unnamed customer",
        customerPhoneText.get(i) ?? null,
        createdAt
      );
      customerCodeToId.set(code, Number(result.lastInsertRowid));
      stats.customers++;

      // Address fields exist in the source but are blank for every row in
      // this data set — nothing to insert into customer_addresses. If a
      // future import has real address data, add it here as a
      // customer_addresses insert keyed off Address 1 / Address 2 / City.
    });

    // ---------- Sales Register -> sales + sale_items (+ deliveries) ----------
    const insertSale = db.prepare(
      `INSERT INTO sales
         (invoice, customer_id, date, subtotal, discount, total, amount_paid, payment_status, payment_method, sale_type, loyalty_points_earned)
       VALUES
         (@invoice, @customer_id, @date, @subtotal, 0, @total, @amount_paid, 'paid', @payment_method, 'online', @loyalty_points)`
    );
    // Sales Register only recorded a Product Code, never a specific SKU —
    // so for imported historical sales we can't know exactly which unit
    // was sold. sale_items has no free-text notes field, so this caveat
    // is recorded on the SALE itself (payment_method column is already
    // used; we append a note via a dedicated update after insert) so
    // anyone looking at an imported sale can see it's an approximation,
    // never confusing it with a real, precisely-tracked POS sale.
    const flagApproximateUnit = db.prepare(
      `UPDATE sales SET salesperson = COALESCE(salesperson, '') || ? WHERE id = ?`
    );
    const insertSaleItem = db.prepare(
      `INSERT INTO sale_items (sale_id, inventory_id, quantity, unit_price, line_total) VALUES (?, ?, 1, ?, ?)`
    );
    const markSold = db.prepare(`UPDATE inventory SET status = 'sold' WHERE id = ?`);
    const insertCashBook = db.prepare(
      `INSERT INTO cash_book (type, category, reference_id, amount, notes, entry_date) VALUES ('income', 'sale', ?, ?, ?, ?)`
    );
    const insertDelivery = db.prepare(
      `INSERT INTO deliveries (sale_id, courier_name, delivery_status, delivery_date, notes) VALUES (?, ?, ?, ?, ?)`
    );

    for (const row of salesRows) {
      const invoice = String(row["Invoice"] ?? "").trim();
      if (!invoice) continue;

      const customerCode = String(row["Customer Code"] ?? "").trim();
      const customerId = customerCodeToId.get(customerCode) ?? null;
      if (customerCode && customerId == null) {
        stats.warnings.push(`Sale ${invoice} references unknown customer code "${customerCode}" — imported without a linked customer.`);
      }

      const productCode = String(row["Product Code"] ?? "").trim();
      const price = Number(row["Price"] ?? row["Total"] ?? 0);
      const total = Number(row["Total"] ?? price);
      const saleDate = excelDateToIso(row["Date"]) ?? new Date().toISOString();
      const loyaltyPoints = Math.floor(total * LOYALTY_RATE_PERCENT);

      const saleResult = insertSale.run({
        invoice,
        customer_id: customerId,
        date: saleDate,
        subtotal: total,
        total,
        amount_paid: total,
        payment_method: String(row["Payment"] ?? "").trim() || null,
        loyalty_points: loyaltyPoints,
      });
      const saleId = Number(saleResult.lastInsertRowid);
      stats.sales++;

      // Find a specific inventory unit for this line. The Sales Register
      // doesn't record which exact SKU was sold, only the product code —
      // so we pick one available unit of that product (or, failing that,
      // any unit of that product) to attach the sale to. This is an
      // approximation: the specific size/color actually sold isn't
      // recoverable from this sheet.
      let inventoryId: number | undefined;
      const availableForProduct = productCodeToAvailableInventoryIds.get(productCode);
      if (availableForProduct && availableForProduct.length > 0) {
        inventoryId = availableForProduct.pop();
      } else {
        const anyUnit = db
          .prepare(`SELECT id FROM inventory WHERE product_id = ? LIMIT 1`)
          .get(productCodeToId.get(productCode)) as { id: number } | undefined;
        inventoryId = anyUnit?.id;
      }

      if (inventoryId) {
        insertSaleItem.run(saleId, inventoryId, price, total);
        markSold.run(inventoryId);
        // Sales Register never recorded which specific SKU was sold, only
        // the product code — so this is always an approximate unit pick,
        // never an exact match. Flag it clearly on the sale record.
        flagApproximateUnit.run(
          "[imported: exact unit sold not recorded in source data]",
          saleId
        );
      } else {
        stats.warnings.push(`Sale ${invoice}: could not find any inventory unit for product code "${productCode}" to attach as a line item.`);
      }

      insertCashBook.run(saleId, total, `Imported sale ${invoice}`, saleDate);

      // Delivery: every Sales Register row in this data set carries a
      // Delivery Option (courier) and Status "Sent" -> mapped to
      // "delivered" per the agreed decision.
      const courier = row["Delivery Option"] ? String(row["Delivery Option"]).trim() : null;
      const rawStatus = row["Status"] ? String(row["Status"]).trim().toLowerCase() : null;
      if (courier || rawStatus) {
        const deliveryStatus = rawStatus === "sent" ? "delivered" : "pending";
        insertDelivery.run(saleId, courier, deliveryStatus, deliveryStatus === "delivered" ? saleDate : null, row["Remark"] ? String(row["Remark"]) : null);
        stats.deliveries++;
      }
    }
  });

  importAll();

  console.log("=== Import complete ===");
  console.log(`Suppliers:  ${stats.suppliers}`);
  console.log(`Products:   ${stats.products}`);
  console.log(`Inventory:  ${stats.inventory}`);
  console.log(`Customers:  ${stats.customers}`);
  console.log(`Sales:      ${stats.sales}`);
  console.log(`Deliveries: ${stats.deliveries}`);

  if (stats.warnings.length > 0) {
    console.log(`\n=== ${stats.warnings.length} warning(s) — review these ===`);
    stats.warnings.forEach((w) => console.log(`  - ${w}`));
  } else {
    console.log("\nNo warnings.");
  }
}

run();
