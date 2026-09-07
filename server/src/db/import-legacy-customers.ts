/**
 * Imports the cleaned legacy customer list (see legacy-customers-data.json)
 * — 116 unique customers manually deduplicated from two messy pasted
 * lists (a name+phone list and a name+address+phone list), with known
 * duplicate spellings merged by matching phone numbers.
 *
 * Every imported customer gets bonus_points = 200 as a one-time reward
 * for being an existing customer prior to this system's launch. This is
 * stored in the new customers.bonus_points column, kept separate from
 * points earned through actual sales, so it never distorts real sales
 * history (no fake sale record is created to "explain" the points).
 *
 * Run with: npm run db:import-legacy-customers
 *
 * Skips any customer whose exact name already exists in the database
 * (case-insensitive), so it's safe to run more than once without
 * creating duplicates.
 */
import fs from "fs";
import path from "path";
import { db } from "./connection";

const LEGACY_BONUS_POINTS = 200;

interface LegacyCustomer {
  name: string;
  phone: string | null;
  phone2: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
}

function nextCustomerCode(): string {
  const row = db
    .prepare(`SELECT customer_code as code FROM customers WHERE customer_code LIKE 'C-%' ORDER BY id DESC LIMIT 1`)
    .get() as { code: string } | undefined;

  let nextNum = 1;
  if (row?.code) {
    const num = parseInt(row.code.split("-")[1], 10);
    if (!isNaN(num)) nextNum = num + 1;
  }
  return `C-${String(nextNum).padStart(4, "0")}`;
}

function run() {
  const dataPath = path.join(__dirname, "legacy-customers-data.json");
  const customers: LegacyCustomer[] = JSON.parse(fs.readFileSync(dataPath, "utf-8"));

  const checkExisting = db.prepare(`SELECT id FROM customers WHERE LOWER(name) = LOWER(?)`);
  const insertCustomer = db.prepare(
    `INSERT INTO customers (customer_code, name, phone, phone2, bonus_points) VALUES (?, ?, ?, ?, ?)`
  );
  const insertAddress = db.prepare(
    `INSERT INTO customer_addresses (customer_id, address_line1, address_line2, city, is_default)
     VALUES (?, ?, ?, ?, 1)`
  );

  let imported = 0;
  let skipped = 0;

  const runAll = db.transaction(() => {
    for (const c of customers) {
      const existing = checkExisting.get(c.name);
      if (existing) {
        skipped++;
        continue;
      }

      const customer_code = nextCustomerCode();
      const result = insertCustomer.run(customer_code, c.name, c.phone, c.phone2, LEGACY_BONUS_POINTS);
      const customerId = result.lastInsertRowid;

      if (c.address_line1 || c.city) {
        insertAddress.run(customerId, c.address_line1, c.address_line2, c.city);
      }

      imported++;
    }
  });

  runAll();

  console.log(`Imported ${imported} legacy customer(s), each with ${LEGACY_BONUS_POINTS} bonus loyalty points.`);
  if (skipped > 0) {
    console.log(`Skipped ${skipped} customer(s) whose name already existed in the database.`);
  }
}

run();
