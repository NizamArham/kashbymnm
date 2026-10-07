import { Router } from "express";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";
import { SALE_EXCHANGE_FLAGS_SQL } from "../lib/exchanges";

export const findRouter = Router();

// Universal code lookup — admin only. Scan or type any barcode, SKU,
// invoice number, customer/supplier/purchase code, cash book transaction
// code, or coupon/gift voucher code from anywhere in the system and get
// back whatever record it actually belongs to.
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
                sales.sale_type, sales.is_voided, customers.name as customer_name, sales.deleted_customer_snapshot,
                ${SALE_EXCHANGE_FLAGS_SQL}
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

    const coupon = db.prepare(`SELECT * FROM coupons WHERE LOWER(code) = LOWER(?)`).get(code);
    if (coupon) return res.json({ type: "coupon", data: coupon });

    const voucher = db.prepare(`SELECT * FROM gift_vouchers WHERE LOWER(code) = LOWER(?)`).get(code);
    if (voucher) return res.json({ type: "gift_voucher", data: voucher });

    throw new ApiError(404, `No record found for "${code}"`);
  })
);

// GET /api/find/search?q=... — the fuzzy complement to the exact lookup
// above. Codes are exact by nature (a barcode either matches or it
// doesn't), but a name is something people misremember or half-type —
// "levis" should surface Levi's products, "kiyaso" should surface that
// customer, without needing the exact code. Plain SQL LIKE across each
// table's name-ish columns, a handful of rows per type, ranked with an
// exact-prefix match first since that's almost always what's meant.
findRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return res.json([]);
    const like = `%${q}%`;
    const startsWith = `${q}%`;
    const rank = (col: string) => `CASE WHEN ${col} LIKE ? THEN 0 ELSE 1 END`;

    const products = db
      .prepare(
        `SELECT id, product_title as title, COALESCE(brand, category, '') as subtitle,
                ${rank("product_title")} as rnk
         FROM products
         WHERE product_title LIKE ? OR brand LIKE ?
         ORDER BY rnk, product_title LIMIT 6`
      )
      .all(startsWith, like, like)
      .map((r: any) => ({ type: "product", id: r.id, title: r.title, subtitle: r.subtitle, route: `/products/${r.id}` }));

    const customers = db
      .prepare(
        `SELECT id, name as title, customer_code as subtitle, ${rank("name")} as rnk
         FROM customers
         WHERE name LIKE ? OR phone LIKE ? OR customer_code LIKE ?
         ORDER BY rnk, name LIMIT 6`
      )
      .all(startsWith, like, like, like)
      .map((r: any) => ({ type: "customer", id: r.id, title: r.title, subtitle: r.subtitle, route: `/customers/${r.id}/orders` }));

    const suppliers = db
      .prepare(
        `SELECT id, name as title, supplier_code as subtitle, ${rank("name")} as rnk
         FROM suppliers
         WHERE name LIKE ? OR supplier_code LIKE ?
         ORDER BY rnk, name LIMIT 6`
      )
      .all(startsWith, like, like)
      .map((r: any) => ({ type: "supplier", id: r.id, title: r.title, subtitle: r.subtitle, route: `/suppliers/${r.id}/payment-history` }));

    const sales = db
      .prepare(
        `SELECT sales.id, sales.invoice as title, COALESCE(customers.name, 'Walk-in') as subtitle,
                ${SALE_EXCHANGE_FLAGS_SQL},
                ${rank("sales.invoice")} as rnk
         FROM sales LEFT JOIN customers ON customers.id = sales.customer_id
         WHERE sales.invoice LIKE ? OR customers.name LIKE ?
         ORDER BY rnk, sales.id DESC LIMIT 6`
      )
      .all(startsWith, like, like)
      .map((r: any) => {
        // An invoice caught up in an exchange says so right in the suggestion.
        const tag =
          r.exchange_out_status === "awaiting"
            ? " · exchange pending"
            : r.exchange_out_status === "received"
            ? " · exchanged"
            : r.exchange_out_status === "not_returned"
            ? " · exchange: item not returned"
            : r.exchange_in_status
            ? " · exchange order"
            : "";
        return { type: "sale", id: r.id, title: r.title, subtitle: `${r.subtitle}${tag}`, route: `/sales/${r.id}` };
      });

    const staff = db
      .prepare(
        `SELECT id, COALESCE(name, username) as title, username as subtitle, ${rank("name")} as rnk
         FROM users
         WHERE name LIKE ? OR username LIKE ?
         ORDER BY rnk, title LIMIT 6`
      )
      .all(startsWith, like, like)
      .map((r: any) => ({ type: "staff", id: r.id, title: r.title, subtitle: r.subtitle, route: `/staff` }));

    // Typing the category word itself ("gift", "voucher", "coupon")
    // browses everything of that kind, on top of the normal by-code
    // match — useful right after issuing one, when you don't remember
    // the exact code you just typed in.
    const isGiftQuery = /\b(gift|vouchers?)\b/i.test(q);
    const isCouponQuery = /\b(coupons?)\b/i.test(q);

    const couponRows = isCouponQuery
      ? db.prepare(`SELECT id, code, discount_type, discount_value FROM coupons ORDER BY id DESC LIMIT 6`).all()
      : db
          .prepare(
            `SELECT id, code, discount_type, discount_value, ${rank("code")} as rnk
             FROM coupons WHERE code LIKE ? ORDER BY rnk, code LIMIT 6`
          )
          .all(startsWith, like);
    const coupons = (couponRows as any[]).map((r) => ({
      type: "coupon",
      id: r.id,
      title: r.code,
      subtitle: r.discount_type === "percent" ? `${r.discount_value}% off` : `Rs. ${r.discount_value.toLocaleString()} off`,
      route: "/promotions",
    }));

    const voucherRows = isGiftQuery
      ? db.prepare(`SELECT id, code, remaining_value, activated_at FROM gift_vouchers ORDER BY id DESC LIMIT 6`).all()
      : db
          .prepare(
            `SELECT id, code, remaining_value, activated_at, ${rank("code")} as rnk
             FROM gift_vouchers WHERE code LIKE ? OR notes LIKE ? ORDER BY rnk, code LIMIT 6`
          )
          .all(startsWith, like, like);
    const vouchers = (voucherRows as any[]).map((r) => ({
      type: "gift_voucher",
      id: r.id,
      title: r.code,
      subtitle: r.activated_at ? `Rs. ${r.remaining_value.toLocaleString()} left` : "Not yet sold",
      route: "/promotions",
    }));

    res.json([...products, ...customers, ...suppliers, ...sales, ...staff, ...coupons, ...vouchers]);
  })
);
