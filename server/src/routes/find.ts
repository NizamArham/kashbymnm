import { Router } from "express";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const findRouter = Router();

// Universal code lookup — admin only. Scan or type any barcode, SKU,
// invoice number, customer/supplier/purchase code, or cash book
// transaction code from anywhere in the system and get back whatever
// record it actually belongs to.
// Checked in a fixed order (a barcode is almost always what's scanned,
// so inventory goes first) and stops at the first match — code formats
// don't collide across these tables in practice, but if one ever did,
// this order decides which record wins.
findRouter.use(requireAuth, requireRole("admin"));

findRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const code = String(req.query.code ?? "").trim();
    if (!code) throw new ApiError(400, "A code is required");

    const unit = db
      .prepare(
        `SELECT inventory.id, inventory.product_id, inventory.sku, inventory.barcode, inventory.size, inventory.color, inventory.status,
                products.product_title, products.brand, products.category
         FROM inventory
         JOIN products ON products.id = inventory.product_id
         WHERE LOWER(inventory.barcode) = LOWER(?) OR LOWER(inventory.sku) = LOWER(?)`
      )
      .get(code, code);
    if (unit) return res.json({ type: "inventory", data: unit });

    const sale = db
      .prepare(
        `SELECT sales.id, sales.invoice, sales.date, sales.total, sales.amount_paid, sales.payment_status,
                sales.sale_type, sales.is_voided, customers.name as customer_name, sales.deleted_customer_snapshot
         FROM sales
         LEFT JOIN customers ON customers.id = sales.customer_id
         WHERE LOWER(sales.invoice) = LOWER(?)`
      )
      .get(code);
    if (sale) return res.json({ type: "sale", data: sale });

    const customer = db
      .prepare(
        `SELECT id, customer_code, name, phone, phone2, gender, is_suspended FROM customers WHERE LOWER(customer_code) = LOWER(?)`
      )
      .get(code);
    if (customer) return res.json({ type: "customer", data: customer });

    const supplier = db
      .prepare(`SELECT id, supplier_code, name, phone, city FROM suppliers WHERE LOWER(supplier_code) = LOWER(?)`)
      .get(code);
    if (supplier) return res.json({ type: "supplier", data: supplier });

    const purchase = db
      .prepare(
        `SELECT purchases.id, purchases.purchase_code, purchases.purchase_date, purchases.total_cost, purchases.amount_paid,
                purchases.payment_status, purchases.fulfillment_status, suppliers.name as supplier_name
         FROM purchases
         JOIN suppliers ON suppliers.id = purchases.supplier_id
         WHERE LOWER(purchases.purchase_code) = LOWER(?)`
      )
      .get(code);
    if (purchase) return res.json({ type: "purchase", data: purchase });

    const transaction = db
      .prepare(
        `SELECT id, transaction_code, entry_date, type, category, payment_method, amount, notes
         FROM cash_book WHERE LOWER(transaction_code) = LOWER(?)`
      )
      .get(code);
    if (transaction) return res.json({ type: "transaction", data: transaction });

    const staff = db
      .prepare(`SELECT id, username, name, role, job_title, phone FROM users WHERE LOWER(username) = LOWER(?)`)
      .get(code);
    if (staff) return res.json({ type: "staff", data: staff });

    throw new ApiError(404, `No record found for "${code}"`);
  })
);
