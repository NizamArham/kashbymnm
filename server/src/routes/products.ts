import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";
import { logAudit } from "../lib/auditLog";

export const productsRouter = Router();

// Everyone using this API must be logged in; role checks happen per-route below.
productsRouter.use(requireAuth);

// Staff can view products (needed for POS) but never see cost_price or which supplier
// it came from — that's the owner's business, reserved for admin.
function stripCostPriceIfStaff(req: any, row: any) {
  if (!row) return row;
  if (req.user?.role === "staff") {
    const { cost_price, supplier_id, supplier_name, supplier_code, ...rest } = row;
    return rest;
  }
  return row;
}

const productInput = z.object({
  product_title: z.string().min(1),
  brand: z.string().optional(),
  category: z.string().optional(),
  cost_price: z.number().nonnegative(),
  selling_price: z.number().nonnegative(),
  supplier_id: z.number().int().positive().optional(),
  image_path: z.string().optional(),
  is_public: z.boolean().optional(),
  allow_returns: z.boolean().optional(),
  product_type: z.enum(["FO", "OG", "OR", "OP", "IM"]).default("OG"),
});

// qty = live count of this product's available inventory rows
const QTY_SUBQUERY = `
  (SELECT COUNT(*) FROM inventory WHERE inventory.product_id = products.id AND inventory.status = 'available')
  AS qty
`;

// Below this many available units, a product (or category) is flagged
// low-stock in the UI. Kept as one shared constant so the threshold is
// consistent everywhere it's checked.
const LOW_STOCK_THRESHOLD = 5;

// GET /api/products — list all with live qty and supplier name.
// Staff see everything except cost_price.
productsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = db
      .prepare(
        `SELECT products.*, ${QTY_SUBQUERY}, suppliers.name as supplier_name, suppliers.supplier_code
         FROM products
         LEFT JOIN suppliers ON suppliers.id = products.supplier_id
         ORDER BY products.id DESC`
      )
      .all();
    res.json(rows.map((row) => stripCostPriceIfStaff(req, row)));
  })
);

// GET /api/products/low-stock-by-category — total available units summed
// per category (the part before " / " in the stored category string),
// so a category can be flagged low even when no single product in it is
// critically low on its own.
productsRouter.get(
  "/low-stock-by-category",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT products.category as raw_category, ${QTY_SUBQUERY}
         FROM products`
      )
      .all() as { raw_category: string | null; qty: number }[];

    const totals = new Map<string, number>();
    for (const row of rows) {
      if (!row.raw_category) continue;
      const category = row.raw_category.split(" / ")[0].trim();
      totals.set(category, (totals.get(category) ?? 0) + row.qty);
    }

    const result = Array.from(totals.entries())
      .map(([category, total_available]) => ({
        category,
        total_available,
        low_stock: total_available < LOW_STOCK_THRESHOLD,
      }))
      .sort((a, b) => a.category.localeCompare(b.category));

    res.json(result);
  })
);

// GET /api/products/check-title?title=... — used by Add Product to warn
// if a product with this exact title already exists, so the person can
// use "add to existing product" (restock) instead of creating a duplicate.
productsRouter.get(
  "/check-title",
  asyncHandler(async (req, res) => {
    const title = String(req.query.title ?? "").trim();
    if (!title) return res.json({ exists: false });

    const existing = db
      .prepare(`SELECT id, product_title FROM products WHERE LOWER(product_title) = LOWER(?)`)
      .get(title);

    res.json({ exists: !!existing, product: existing ?? null });
  })
);

// GET /api/products/:id/sales — admin-only. Every piece of this product that
// has been sold, newest first: the invoice and date it went out on, which
// size/colour, who bought it and what that piece sold for. A voided sale or a
// returned piece stays in the list (flagged) so the history is complete, but
// only live ones are counted in the totals.
productsRouter.get(
  "/:id/sales",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const product = db.prepare(`SELECT id, product_title FROM products WHERE id = ?`).get(req.params.id) as
      | { id: number; product_title: string }
      | undefined;
    if (!product) throw new ApiError(404, "Product not found");

    const rows = db
      .prepare(
        `SELECT sale_items.id AS sale_item_id, sales.id AS sale_id, sales.invoice, sales.date, sales.sale_type,
                sales.is_voided, inventory.sku, inventory.size, inventory.color,
                sale_items.quantity, sale_items.unit_price, sale_items.line_total,
                customers.name AS customer_name,
                (SELECT COUNT(*) FROM returns WHERE returns.sale_item_id = sale_items.id) AS is_returned
         FROM sale_items
         JOIN inventory ON inventory.id = sale_items.inventory_id
         JOIN sales ON sales.id = sale_items.sale_id
         LEFT JOIN customers ON customers.id = sales.customer_id
         WHERE inventory.product_id = ? AND sales.status <> 'quotation'
         ORDER BY sales.date DESC, sale_items.id DESC`
      )
      .all(product.id) as { quantity: number; line_total: number; is_voided: number; is_returned: number }[];

    const live = rows.filter((r) => !r.is_voided && !r.is_returned);
    res.json({
      product,
      rows,
      pieces: live.reduce((sum, r) => sum + r.quantity, 0),
      amount: live.reduce((sum, r) => sum + r.line_total, 0),
    });
  })
);

// GET /api/products/:id/analytics — admin-only. The money story of one product:
// what was put in (every piece ever bought, grouped by what it cost), what has
// been sold (live invoices only, grouped by the price it went at, with what
// those same pieces cost), and where the rest is (on the shelf, written off,
// taken out for another reason, sent back to the supplier). Every piece lands in exactly one of those
// buckets, so the parts always add up to "invested".
productsRouter.get(
  "/:id/analytics",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const product = db
      .prepare(`SELECT id, product_title, selling_price FROM products WHERE id = ?`)
      .get(req.params.id) as { id: number; product_title: string; selling_price: number } | undefined;
    if (!product) throw new ApiError(404, "Product not found");

    // A borrowed piece that was never ours (set aside, not paid for) isn't an
    // investment, so it stays out of every count below.
    const units = db
      .prepare(
        `SELECT id, status, removal_reason, cost_price, selling_price
         FROM inventory
         WHERE product_id = ? AND NOT (manual_pending_line_id IS NOT NULL AND status = 'removed')`
      )
      .all(product.id) as {
      id: number;
      status: string;
      removal_reason: string | null;
      cost_price: number | null;
      selling_price: number | null;
    }[];

    // Pieces that went out on a live (not voided, not quotation) invoice and
    // were not returned. A returned piece is back on the shelf (or written off),
    // so it is counted there instead.
    const soldRows = db
      .prepare(
        `SELECT sale_items.inventory_id, sale_items.quantity, sale_items.unit_price, sale_items.line_total
         FROM sale_items
         JOIN inventory ON inventory.id = sale_items.inventory_id
         JOIN sales ON sales.id = sale_items.sale_id
         WHERE inventory.product_id = ? AND sales.status <> 'quotation' AND sales.is_voided = 0
           AND NOT EXISTS (SELECT 1 FROM returns WHERE returns.sale_item_id = sale_items.id)`
      )
      .all(product.id) as { inventory_id: number; quantity: number; unit_price: number; line_total: number }[];

    const costOf = new Map(units.map((u) => [u.id, u.cost_price ?? 0]));
    const soldUnitIds = new Set(soldRows.map((r) => r.inventory_id));

    // One unit is one physical piece. If invoices sold more pieces against a
    // unit than that, the stock list is short by the difference: those pieces
    // were bought too, so they count as bought, at the cost of that unit.
    const soldQtyByUnit = new Map<number, number>();
    for (const r of soldRows) soldQtyByUnit.set(r.inventory_id, (soldQtyByUnit.get(r.inventory_id) ?? 0) + r.quantity);
    const missing: { cost: number }[] = [];
    for (const [unitId, qty] of soldQtyByUnit) {
      for (let n = 1; n < qty; n++) missing.push({ cost: costOf.get(unitId) ?? 0 });
    }

    const group = <T extends { cost: number }>(map: Map<number, T>, key: number, make: () => T) => {
      let g = map.get(key);
      if (!g) map.set(key, (g = make()));
      return g;
    };

    // What was put in: one line per cost price.
    const boughtMap = new Map<number, { unit_cost: number; pieces: number; cost: number }>();
    let costUnknown = 0;
    const addBought = (cost: number | null) => {
      if (cost == null) costUnknown += 1;
      const g = group(boughtMap, cost ?? 0, () => ({ unit_cost: cost ?? 0, pieces: 0, cost: 0 }));
      g.pieces += 1;
      g.cost += cost ?? 0;
    };
    for (const u of units) addBought(u.cost_price);
    for (const m of missing) addBought(m.cost);

    // What was sold: one line per selling price.
    const soldMap = new Map<number, { unit_price: number; pieces: number; revenue: number; cost: number }>();
    for (const r of soldRows) {
      const g = group(soldMap, r.unit_price, () => ({ unit_price: r.unit_price, pieces: 0, revenue: 0, cost: 0 }));
      g.pieces += r.quantity;
      g.revenue += r.line_total;
      g.cost += (costOf.get(r.inventory_id) ?? 0) * r.quantity;
    }

    // Where the rest is. A unit marked sold with no live invoice behind it
    // (opening stock sold before invoices were kept, say) gets its own line so
    // the buckets still add up.
    const onShelf = units.filter((u) => u.status === "available");
    const soldNoInvoice = units.filter((u) => u.status === "sold" && !soldUnitIds.has(u.id));
    const sentBack = units.filter((u) => u.status === "removed" && u.removal_reason === "Returned to supplier");
    // A real loss: damaged, gifted, used by staff, lost or stolen.
    const LOSS_REASONS = ["Damaged", "Gifted", "Staff Use", "Stolen", "Lost"];
    const writtenOff = units.filter(
      (u) => ["damaged", "gifted", "stolen", "lost"].includes(u.status) || (u.status === "removed" && LOSS_REASONS.includes(u.removal_reason ?? ""))
    );
    // Taken out of stock for another reason ("Other", e.g. old stock swapped for a new lot):
    // shown as taken out, never counted as a loss.
    const takenOut = units.filter((u) => u.status === "removed" && !sentBack.includes(u) && !writtenOff.includes(u));
    const takenOutNotes = db
      .prepare(
        `SELECT DISTINCT removal_note FROM inventory
         WHERE product_id = ? AND status = 'removed' AND manual_pending_line_id IS NULL
           AND COALESCE(removal_reason, 'Other') NOT IN ('Returned to supplier', 'Damaged', 'Gifted', 'Staff Use', 'Stolen', 'Lost')
           AND removal_note IS NOT NULL AND removal_note <> ''`
      )
      .all(product.id) as { removal_note: string }[];
    const sum = (list: typeof units) => list.reduce((s, u) => s + (u.cost_price ?? 0), 0);

    const bought = [...boughtMap.values()].sort((a, b) => a.unit_cost - b.unit_cost);
    const sold = [...soldMap.values()].sort((a, b) => a.unit_price - b.unit_price);

    res.json({
      product,
      bought,
      invested: bought.reduce((s, g) => s + g.cost, 0),
      pieces_bought: units.length + missing.length,
      cost_unknown: costUnknown,
      sold,
      pieces_sold: sold.reduce((s, g) => s + g.pieces, 0),
      revenue: sold.reduce((s, g) => s + g.revenue, 0),
      cost_of_sold: sold.reduce((s, g) => s + g.cost, 0),
      on_shelf: {
        pieces: onShelf.length,
        cost: sum(onShelf),
        // What the shelf would bring at the price each piece is marked at now.
        worth: onShelf.reduce((s, u) => s + (u.selling_price ?? product.selling_price ?? 0), 0),
        // The distinct prices those pieces are marked at (usually one) — the target to cover is worked out from these.
        prices: [...new Set(onShelf.map((u) => u.selling_price ?? product.selling_price ?? 0))].sort((a, b) => a - b),
      },
      written_off: { pieces: writtenOff.length, cost: sum(writtenOff) },
      sent_back: { pieces: sentBack.length, cost: sum(sentBack) },
      taken_out: { pieces: takenOut.length, cost: sum(takenOut), note: takenOutNotes.length === 1 ? takenOutNotes[0].removal_note : null },
      sold_no_invoice: { pieces: soldNoInvoice.length, cost: sum(soldNoInvoice) },
      // Pieces sold on invoices beyond what the stock list held (counted as bought above).
      not_in_stock_list: { pieces: missing.length, cost: missing.reduce((t, m) => t + m.cost, 0) },
    });
  })
);

// GET /api/products/:id
productsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = db
      .prepare(
        `SELECT products.*, ${QTY_SUBQUERY}, suppliers.name as supplier_name, suppliers.supplier_code
         FROM products
         LEFT JOIN suppliers ON suppliers.id = products.supplier_id
         WHERE products.id = ?`
      )
      .get(req.params.id);
    if (!row) throw new ApiError(404, "Product not found");
    res.json(stripCostPriceIfStaff(req, row));
  })
);

// Everything below (create/update/delete) is admin-only.
productsRouter.use(requireRole("admin"));

// POST /api/products — create a new product style
productsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = productInput.parse(req.body);

    const result = db
      .prepare(
        `INSERT INTO products (product_title, brand, category, cost_price, selling_price, supplier_id, image_path, is_public, allow_returns, product_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.product_title,
        data.brand ?? null,
        data.category ?? null,
        data.cost_price,
        data.selling_price,
        data.supplier_id ?? null,
        data.image_path ?? null,
        data.is_public === false ? 0 : 1,
        data.allow_returns === false ? 0 : 1,
        data.product_type
      );

    const created = db.prepare(`SELECT * FROM products WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(created);
  })
);

// PUT /api/products/:id — update
productsRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const data = productInput.partial().parse(req.body);
    // Every piece of stock remembers the price IT was stocked at (two batches
    // can differ), so changing the product's price alone leaves units already
    // in stock untouched. apply_to_stock also sets the new price on the units
    // still available — never on ones already sold.
    const { apply_to_stock } = z.object({ apply_to_stock: z.boolean().optional() }).parse(req.body);
    const existing = db.prepare(`SELECT * FROM products WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Product not found");

    const merged = { ...existing, ...data };
    let unitsUpdated = 0;
    db.transaction(() => {
      db.prepare(
        `UPDATE products SET product_title = ?, brand = ?, category = ?, cost_price = ?,
         selling_price = ?, supplier_id = ?, image_path = ?, is_public = ?, allow_returns = ? WHERE id = ?`
      ).run(
        merged.product_title,
        merged.brand,
        merged.category,
        merged.cost_price,
        merged.selling_price,
        merged.supplier_id,
        merged.image_path,
        merged.is_public === false || merged.is_public === 0 ? 0 : 1,
        merged.allow_returns === false || merged.allow_returns === 0 ? 0 : 1,
        req.params.id
      );
      if (apply_to_stock && data.selling_price !== undefined) {
        unitsUpdated = db
          .prepare(`UPDATE inventory SET selling_price = ? WHERE product_id = ? AND status = 'available' AND COALESCE(selling_price, -1) <> ?`)
          .run(data.selling_price, req.params.id, data.selling_price).changes;
      }
    })();

    if (data.selling_price !== undefined && (data.selling_price !== existing.selling_price || unitsUpdated > 0)) {
      logAudit(
        req.user!,
        "product_price_change",
        "product",
        existing.id,
        `${merged.product_title}: selling price Rs. ${existing.selling_price.toLocaleString()} → Rs. ${data.selling_price.toLocaleString()}${
          apply_to_stock ? `, also set on ${unitsUpdated} unit${unitsUpdated === 1 ? "" : "s"} in stock` : " (units in stock keep their own prices)"
        }`
      );
    }

    const updated = db.prepare(`SELECT * FROM products WHERE id = ?`).get(req.params.id) as any;
    res.json({ ...updated, units_updated: unitsUpdated });
  })
);

// DELETE /api/products/:id — blocked if inventory units exist for it
productsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(req.params.id) as any;
    if (!product) throw new ApiError(404, "Product not found");

    // A confirmed, deliberate hard delete — the owner's own explicit
    // instruction: inventory and sales history no longer block this.
    // Purchase history is kept (never deleted), but detached via a
    // snapshot so it survives the product itself being gone. This is
    // NOT the same as the customer-deletion "warn then confirm" flow —
    // here the caller has already made the call, so this goes straight
    // through in one transaction.
    const runDelete = db.transaction(() => {
      // Snapshot this product's info onto every purchase_items row that
      // references it — real purchase/spend history, explicitly kept
      // per the owner's instruction, just no longer linked to a live
      // product row once this is done.
      const snapshot = `${product.product_title}${product.brand ? ` (${product.brand})` : ""}`;
      db.prepare(`UPDATE purchase_items SET product_snapshot = ? WHERE product_id = ?`).run(snapshot, req.params.id);
      db.prepare(`UPDATE purchase_items SET product_id = NULL WHERE product_id = ?`).run(req.params.id);

      // Every inventory unit under this product — for any that were
      // ever sold, snapshot enough onto the sale_item first (with its
      // actual size/color, since a sale can span several variants of
      // the same product) so the original receipt still reads
      // correctly once the unit itself is gone.
      const units = db.prepare(`SELECT * FROM inventory WHERE product_id = ?`).all(req.params.id) as any[];
      for (const unit of units) {
        const variantSnapshot = `${product.product_title}${unit.color || unit.size ? ` — ${[unit.color, unit.size].filter(Boolean).join(" / ")}` : ""}`;
        db.prepare(`UPDATE sale_items SET product_snapshot = ? WHERE inventory_id = ?`).run(variantSnapshot, unit.id);
      }

      // Now safe to delete every unit — sale_items.inventory_id cascades
      // to NULL automatically (ON DELETE SET NULL), same for any
      // return/exchange records still pointing at these units.
      db.prepare(`DELETE FROM inventory WHERE product_id = ?`).run(req.params.id);

      db.prepare(`DELETE FROM products WHERE id = ?`).run(req.params.id);
    });

    runDelete();

    logAudit(req.user!, "product_delete", "product", Number(req.params.id), `Deleted product ${product.product_title}`);

    res.status(204).send();
  })
);
