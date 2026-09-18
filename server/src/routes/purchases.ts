import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { nextPurchaseCode, nextSku } from "../lib/codes";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const purchasesRouter = Router();

// Purchasing is financial/supplier data — admin only.
purchasesRouter.use(requireAuth, requireRole("admin"));

const purchaseItemInput = z.object({
  product_id: z.number().int().positive(),
  quantity: z.number().int().positive(),
  unit_cost: z.number().nonnegative(),
  // Per-unit selling price for THIS batch — lets the same product sell at
  // different prices across older/newer stock. Falls back to the
  // product's current selling_price if not given.
  unit_selling_price: z.number().nonnegative().optional(),
  size: z.string().optional(),
  color: z.string().optional(),
});

const purchaseInput = z.object({
  supplier_id: z.number().int().positive(),
  items: z.array(purchaseItemInput).min(1),
  amount_paid: z.number().nonnegative().default(0),
  payment_method: z.string().optional(),
  // When set, this restock/add-product action fulfills ONE specific line
  // of an existing pending purchase (goods that already arrived and were
  // paid for, now being sorted into real products/variants) — not the
  // whole pending purchase at once, since a single delivery can contain
  // several different items entered across separate actions over time.
  // amount_paid is ignored when this is set — the pending purchase's own
  // payment already covers the supplier side of this line.
  fulfills_line_id: z.number().int().positive().optional(),
});

// Barcodes are generated server-side, continuing from the highest
// existing barcode in the whole system (barcodes are globally unique, not
// per-product) — so a restock never restarts at a random, disconnected
// number, and there's never a race between client-generated codes and
// what the database actually has.
const BARCODE_PREFIX = "890";

function nextBarcodeBatch(count: number): string[] {
  const row = db
    .prepare(`SELECT barcode FROM inventory WHERE barcode LIKE ? ORDER BY barcode DESC LIMIT 1`)
    .get(`${BARCODE_PREFIX}%`) as { barcode: string } | undefined;

  let nextNum = 100_000_000; // same starting range as the previous client-side generator
  if (row?.barcode) {
    const numericPart = row.barcode.slice(BARCODE_PREFIX.length);
    const parsed = parseInt(numericPart, 10);
    if (!isNaN(parsed)) nextNum = parsed + 1;
  }

  return Array.from({ length: count }, (_, i) => `${BARCODE_PREFIX}${String(nextNum + i).padStart(10, "0")}`);
}

// Sizes are normalized to uppercase before storage so "m" and "M" are
// always treated as the exact same size — otherwise they'd silently
// split into two different inventory groups.
function normalizeSize(size: string | undefined): string | null {
  if (!size) return null;
  return size.trim().toUpperCase();
}

function normalizeColor(color: string | undefined): string | null {
  if (!color) return null;
  // Title-case the color for consistency (Black, not black/BLACK) without
  // being as strict as uppercasing, since color names read better this way.
  const trimmed = color.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}


// GET /api/purchases
purchasesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT purchases.*, suppliers.name as supplier_name, suppliers.supplier_code
         FROM purchases
         JOIN suppliers ON suppliers.id = purchases.supplier_id
         ORDER BY purchases.id DESC`
      )
      .all();
    res.json(rows);
  })
);

const pendingPurchaseLineInput = z.object({
  description: z.string().min(1),
  quantity: z.number().int().positive(),
  unit_cost: z.number().nonnegative(),
  product_type: z.enum(["FO", "OG", "OR", "OP", "IM"]).default("OG"),
});

const purchaseExpenseInput = z.object({
  label: z.string().min(1),
  amount: z.number().positive(),
});

const pendingPurchaseInput = z.object({
  supplier_id: z.number().int().positive(),
  lines: z.array(pendingPurchaseLineInput).min(1, "Add at least one line"),
  amount_paid: z.number().nonnegative().default(0),
  payment_method: z.string().optional(),
  description: z.string().optional(),
  // Only meaningful when payment_method is 'cheque'. 'in_hand' pays
  // using a cheque already received from a customer (found by number);
  // 'own' writes a brand new cheque from the business's own account.
  // Either way, amount_paid does NOT become an immediate cash_book
  // entry — a cheque isn't real cash until it clears, same rule as
  // everywhere else cheques are handled.
  cheque_kind: z.enum(["in_hand", "own"]).optional(),
  cheque_receipt_id: z.number().int().positive().optional(), // for in_hand
  cheque_number: z.string().optional(), // for own
  bank_name: z.string().optional(), // for own
  cheque_date: z.string().optional(), // for own
  // Transport, commission, loading, or any other cost that ISN'T owed to
  // the supplier — each its own named line, all recorded straight to the
  // cash book as separate expenses, never added to the supplier's
  // balance or this purchase's total_cost.
  expenses: z.array(purchaseExpenseInput).default([]),
});

// POST /api/purchases/pending — record that goods arrived and were paid
// for (fully or partially), before they've been sorted into specific
// products/variants. Each line is a rough description + quantity + per-
// piece cost — the real product/variant assignment happens later,
// possibly across several separate Add Product / restock actions.
// total_cost (what's owed to the SUPPLIER) is the sum of lines' qty *
// unit_cost — transport/commission/other costs are entirely separate and
// go to the cash book as their own expense, never inflating what the
// supplier is owed.
// NOTE: this and the GET /pending route below MUST be registered before
// GET /:id — otherwise Express matches the literal path "pending"
// against :id first, and this route becomes unreachable.
purchasesRouter.post(
  "/pending",
  asyncHandler(async (req, res) => {
    const data = pendingPurchaseInput.parse(req.body);

    const supplier = db.prepare(`SELECT id FROM suppliers WHERE id = ?`).get(data.supplier_id);
    if (!supplier) throw new ApiError(400, "Referenced supplier does not exist");

    const total_cost = data.lines.reduce((sum, line) => sum + line.quantity * line.unit_cost, 0);

    // Automatically apply any available credit (from a past damaged-
    // goods return the supplier agreed to cover as a future discount)
    // against this purchase — reducing what's actually still owed after
    // whatever cash was paid, up to the credit available.
    const creditRow = db
      .prepare(`SELECT COALESCE(SUM(amount), 0) as balance FROM supplier_credit_transactions WHERE supplier_id = ?`)
      .get(data.supplier_id) as { balance: number };
    const availableCredit = Math.max(0, creditRow.balance);
    const remainingAfterPayment = Math.max(0, total_cost - data.amount_paid);
    const creditApplied = Math.min(availableCredit, remainingAfterPayment);

    let payment_status: "paid" | "partial" | "unpaid" = "unpaid";
    if (data.amount_paid + creditApplied >= total_cost && total_cost > 0) payment_status = "paid";
    else if (data.amount_paid > 0 || creditApplied > 0) payment_status = "partial";

    const purchase_code = nextPurchaseCode();

    const runTransaction = db.transaction(() => {
      const result = db
        .prepare(
          `INSERT INTO purchases (purchase_code, supplier_id, total_cost, amount_paid, payment_status, fulfillment_status, description)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`
        )
        .run(purchase_code, data.supplier_id, total_cost, data.amount_paid + creditApplied, payment_status, data.description ?? null);

      const purchaseId = result.lastInsertRowid;

      for (const line of data.lines) {
        db.prepare(
          `INSERT INTO pending_purchase_lines (purchase_id, description, quantity, unit_cost, product_type)
           VALUES (?, ?, ?, ?, ?)`
        ).run(purchaseId, line.description, line.quantity, line.unit_cost, line.product_type);
      }

      // Spend down the credit that was just applied, so the running
      // balance reflects reality going forward.
      if (creditApplied > 0) {
        db.prepare(
          `INSERT INTO supplier_credit_transactions (supplier_id, amount, reason, reference_id, notes)
           VALUES (?, ?, 'applied_to_purchase', ?, ?)`
        ).run(data.supplier_id, -creditApplied, purchaseId, `Applied to pending purchase ${purchase_code}`);
      }

      // The supplier payment — goods only, never inflated by
      // transport/commission, since that money isn't owed to them.
      if (data.amount_paid > 0) {
        if (data.payment_method === "cheque") {
          if (data.cheque_kind === "in_hand") {
            if (!data.cheque_receipt_id) {
              throw new ApiError(400, "Select which in-hand cheque is being used");
            }
            const receipt = db.prepare(`SELECT * FROM cheque_receipts WHERE id = ?`).get(data.cheque_receipt_id) as any;
            if (!receipt) throw new ApiError(404, "Cheque not found");
            if (receipt.status !== "in_hand") {
              throw new ApiError(409, `This cheque is ${receipt.status.replace("_", " ")} and can't be used for a new payment.`);
            }

            const paymentResult = db
              .prepare(
                `INSERT INTO supplier_payments (supplier_id, purchase_id, amount, method, is_partial, notes)
                 VALUES (?, ?, ?, 'cheque', ?, ?)`
              )
              .run(
                data.supplier_id,
                purchaseId,
                data.amount_paid,
                payment_status === "partial" ? 1 : 0,
                `Cheque #${receipt.cheque_number} (${receipt.bank_name}) — pending purchase ${purchase_code}`
              );
            db.prepare(
              `INSERT INTO cheque_transfers (cheque_receipt_id, supplier_id, supplier_payment_id)
               VALUES (?, ?, ?)`
            ).run(data.cheque_receipt_id, data.supplier_id, paymentResult.lastInsertRowid);
            db.prepare(`UPDATE cheque_receipts SET status = 'given_to_supplier' WHERE id = ?`).run(data.cheque_receipt_id);
          } else {
            if (!data.cheque_number?.trim() || !data.bank_name?.trim() || !data.cheque_date) {
              throw new ApiError(400, "Cheque number, bank name, and date are required for your own cheque");
            }
            const paymentResult = db
              .prepare(
                `INSERT INTO supplier_payments (supplier_id, purchase_id, amount, method, is_partial, notes)
                 VALUES (?, ?, ?, 'cheque', ?, ?)`
              )
              .run(
                data.supplier_id,
                purchaseId,
                data.amount_paid,
                payment_status === "partial" ? 1 : 0,
                `Cheque #${data.cheque_number} (${data.bank_name}) — pending purchase ${purchase_code}`
              );
            db.prepare(
              `INSERT INTO cheques_issued (cheque_number, bank_name, amount, cheque_date, supplier_id, supplier_payment_id, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).run(
              data.cheque_number.trim(),
              data.bank_name.trim(),
              data.amount_paid,
              data.cheque_date,
              data.supplier_id,
              paymentResult.lastInsertRowid,
              `For pending purchase ${purchase_code}`
            );
          }
          // No cash_book entry here — a cheque isn't real cash yet,
          // regardless of which kind. That only happens once it clears.
        } else {
          db.prepare(
            `INSERT INTO cash_book (type, category, payment_method, reference_id, amount, notes)
             VALUES ('expense', 'purchase', ?, ?, ?, ?)`
          ).run(data.payment_method ?? null, purchaseId, data.amount_paid, `Payment for pending purchase ${purchase_code}`);

          db.prepare(
            `INSERT INTO supplier_payments (supplier_id, purchase_id, amount, is_partial, notes)
             VALUES (?, ?, ?, ?, ?)`
          ).run(
            data.supplier_id,
            purchaseId,
            data.amount_paid,
            payment_status === "partial" ? 1 : 0,
            `Payment recorded at time of pending purchase ${purchase_code}`
          );
        }
      }

      // Transport/commission/other costs — each its own named line, a
      // real cost of getting this stock but not owed to the supplier, so
      // every one becomes its own separate cash book expense with no
      // link to the supplier's balance at all.
      for (const expense of data.expenses) {
        db.prepare(
          `INSERT INTO purchase_expenses (purchase_id, label, amount) VALUES (?, ?, ?)`
        ).run(purchaseId, expense.label.trim(), expense.amount);

        db.prepare(
          `INSERT INTO cash_book (type, category, payment_method, reference_id, amount, notes)
           VALUES ('expense', 'purchase_other_costs', ?, ?, ?, ?)`
        ).run(data.payment_method ?? null, purchaseId, expense.amount, `${expense.label.trim()} for purchase ${purchase_code}`);
      }

      return purchaseId;
    });

    const purchaseId = runTransaction();
    const created = db
      .prepare(
        `SELECT purchases.*, suppliers.name as supplier_name
         FROM purchases JOIN suppliers ON suppliers.id = purchases.supplier_id
         WHERE purchases.id = ?`
      )
      .get(purchaseId);
    const lines = db.prepare(`SELECT * FROM pending_purchase_lines WHERE purchase_id = ?`).all(purchaseId);
    const expenses = db.prepare(`SELECT * FROM purchase_expenses WHERE purchase_id = ?`).all(purchaseId);

    res.status(201).json({ ...(created as object), lines, expenses, credit_applied: creditApplied });
  })
);

// GET /api/purchases/pending — list purchases still awaiting product
// assignment, each with its lines, for the "fulfill this line" picker in
// Add Product / Manage Products and the Purchases page itself.
purchasesRouter.get(
  "/pending",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT purchases.*, suppliers.name as supplier_name
         FROM purchases
         JOIN suppliers ON suppliers.id = purchases.supplier_id
         WHERE purchases.fulfillment_status = 'pending'
         ORDER BY purchases.purchase_date DESC`
      )
      .all() as any[];

    const lineStmt = db.prepare(`SELECT * FROM pending_purchase_lines WHERE purchase_id = ? ORDER BY id ASC`);
    const expenseStmt = db.prepare(`SELECT * FROM purchase_expenses WHERE purchase_id = ? ORDER BY id ASC`);
    const withLines = rows.map((p) => ({ ...p, lines: lineStmt.all(p.id), expenses: expenseStmt.all(p.id) }));

    res.json(withLines);
  })
);

// PUT /api/purchases/:id/mark-sorted — a deliberate human decision that
// everything from this pending purchase has been entered, regardless of
// whether every line was individually linked to a restock. Never
// inferred automatically from totals, since only a person reviewing the
// actual physical goods can really know it's done.
purchasesRouter.put(
  "/:id/mark-sorted",
  asyncHandler(async (req, res) => {
    const purchase = db.prepare(`SELECT * FROM purchases WHERE id = ?`).get(req.params.id) as any;
    if (!purchase) throw new ApiError(404, "Purchase not found");
    if (purchase.fulfillment_status !== "pending") {
      throw new ApiError(409, "This purchase is already marked as sorted");
    }

    db.prepare(`UPDATE purchases SET fulfillment_status = 'fulfilled' WHERE id = ?`).run(req.params.id);
    const updated = db.prepare(`SELECT * FROM purchases WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

const editPurchaseLineInput = z.object({
  id: z.number().int().positive(),
  description: z.string().min(1).optional(),
  quantity: z.number().int().positive().optional(),
  unit_cost: z.number().nonnegative().optional(),
});

const editPurchaseInput = z.object({
  supplier_id: z.number().int().positive().optional(),
  description: z.string().optional(),
  notes: z.string().optional(),
  // Only honored while the purchase is still 'pending' — once fulfilled,
  // the real inventory units created from these lines already carry
  // their own frozen cost_price, so editing the line afterward would
  // silently create a mismatch between the purchase record and what's
  // actually in stock. Metadata (supplier/description/notes) stays
  // editable regardless of status, since nothing downstream depends on
  // those being frozen.
  lines: z.array(editPurchaseLineInput).optional(),
});

// PUT /api/purchases/:id — fix a mistake within 24 hours of the purchase
// being created. Admin-only (enforced at the route group level below).
purchasesRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const purchase = db.prepare(`SELECT * FROM purchases WHERE id = ?`).get(req.params.id) as any;
    if (!purchase) throw new ApiError(404, "Purchase not found");

    const hoursSince = (Date.now() - new Date(purchase.purchase_date).getTime()) / (1000 * 60 * 60);
    if (hoursSince > 24) {
      throw new ApiError(409, "This purchase is more than 24 hours old and can no longer be edited.");
    }

    const data = editPurchaseInput.parse(req.body);

    if (data.supplier_id != null) {
      const supplier = db.prepare(`SELECT id FROM suppliers WHERE id = ?`).get(data.supplier_id);
      if (!supplier) throw new ApiError(400, "Referenced supplier does not exist");
    }

    if (data.lines && data.lines.length > 0 && purchase.fulfillment_status !== "pending") {
      throw new ApiError(
        409,
        "This purchase has already been fulfilled — its lines are frozen since real inventory units were created from them. Only supplier, description, and notes can still be changed."
      );
    }

    const runEdit = db.transaction(() => {
      db.prepare(`UPDATE purchases SET supplier_id = ?, description = ? WHERE id = ?`).run(
        data.supplier_id ?? purchase.supplier_id,
        data.description !== undefined ? data.description : purchase.description,
        req.params.id
      );

      if (data.lines) {
        for (const line of data.lines) {
          const existing = db.prepare(`SELECT * FROM pending_purchase_lines WHERE id = ? AND purchase_id = ?`).get(line.id, req.params.id) as any;
          if (!existing) throw new ApiError(404, `Line ${line.id} not found on this purchase`);
          db.prepare(
            `UPDATE pending_purchase_lines SET description = ?, quantity = ?, unit_cost = ? WHERE id = ?`
          ).run(
            line.description ?? existing.description,
            line.quantity ?? existing.quantity,
            line.unit_cost ?? existing.unit_cost,
            line.id
          );
        }

        // Recompute total_cost from the (possibly just-edited) lines —
        // this is the purchase's own goods total, always derived fresh
        // rather than trusted as a separately-editable number, so it can
        // never drift out of sync with what the lines actually say.
        const newTotal = db
          .prepare(`SELECT COALESCE(SUM(quantity * unit_cost), 0) as total FROM pending_purchase_lines WHERE purchase_id = ?`)
          .get(req.params.id) as { total: number };
        db.prepare(`UPDATE purchases SET total_cost = ? WHERE id = ?`).run(newTotal.total, req.params.id);
      }
    });

    runEdit();

    const updated = db
      .prepare(
        `SELECT purchases.*, suppliers.name as supplier_name
         FROM purchases JOIN suppliers ON suppliers.id = purchases.supplier_id
         WHERE purchases.id = ?`
      )
      .get(req.params.id);
    const lines = db.prepare(`SELECT * FROM pending_purchase_lines WHERE purchase_id = ?`).all(req.params.id);
    res.json({ ...(updated as object), lines });
  })
);

const returnItemInput = z.object({
  // Exactly one of these two must be set per item — which scenario this
  // particular thing being returned falls under.
  pending_line_id: z.number().int().positive().optional(),
  inventory_id: z.number().int().positive().optional(),
  // Only meaningful (and required) for pending_line_id — how much of
  // that line is actually being returned, which may be less than the
  // line's full remaining quantity. Ignored for inventory_id, since each
  // inventory item is always exactly one specific physical unit.
  quantity: z.number().int().positive().optional(),
});

const recordReturnInput = z.object({
  purchase_id: z.number().int().positive(),
  items: z.array(returnItemInput).min(1, "Select at least one item to return"),
  reason: z.string().min(1, "A reason is required"),
  resolution: z.enum(["cash_refund", "supplier_credit"]),
  // Only meaningful when resolution is cash_refund — how the money
  // actually came back (cash in hand, bank transfer, etc.). Ignored for
  // supplier_credit, since no cash moves in that case.
  payment_method: z.string().optional(),
  notes: z.string().optional(),
});

// POST /api/purchases/returns — "Record Returns". Covers both real
// scenarios in one action:
// - goods still on a pending purchase line (never entered as inventory):
//   pass pending_line_id, quantity comes from how much of the line is
//   being returned — reduces that line's remaining expected amount.
// - goods already in inventory: pass inventory_id for one or more
//   SPECIFIC available units (never sold ones — checked here, not just
//   assumed) — each unit is individually pulled from stock. Multiple
//   units across different variants of the same product can be included
//   in one call, since the person picks them by checking off real rows,
//   not typing a number that could exceed what's on the shelf.
// The resolution (cash refund now, or supplier credit for a future
// purchase) is always the person's own explicit choice.
purchasesRouter.post(
  "/returns",
  asyncHandler(async (req, res) => {
    const data = recordReturnInput.parse(req.body);

    const purchase = db
      .prepare(`SELECT * FROM purchases WHERE id = ?`)
      .get(data.purchase_id) as any;
    if (!purchase) throw new ApiError(404, "Purchase not found");

    // Resolve and validate every item up front, before writing anything.
    const resolvedItems: {
      pending_line_id: number | null;
      inventory_id: number | null;
      quantity: number;
      unit_cost: number;
    }[] = [];

    for (const item of data.items) {
      if (item.pending_line_id && item.inventory_id) {
        throw new ApiError(400, "Each item must be either a pending line or an inventory unit, not both");
      }
      if (item.pending_line_id) {
        const line = db.prepare(`SELECT * FROM pending_purchase_lines WHERE id = ?`).get(item.pending_line_id) as any;
        if (!line) throw new ApiError(404, "Referenced pending purchase line not found");
        if (line.purchase_id !== data.purchase_id) throw new ApiError(400, "That line does not belong to the selected purchase");
        if (!item.quantity || item.quantity <= 0) {
          throw new ApiError(400, "A quantity is required when returning part of a pending purchase line");
        }
        if (item.quantity > line.quantity) {
          throw new ApiError(
            400,
            `Cannot return ${item.quantity} — only ${line.quantity} remaining on this line`
          );
        }
        resolvedItems.push({ pending_line_id: line.id, inventory_id: null, quantity: item.quantity, unit_cost: line.unit_cost });
      } else if (item.inventory_id) {
        const unit = db
          .prepare(
            `SELECT inventory.*, purchase_items.purchase_id
             FROM inventory
             LEFT JOIN purchase_items ON purchase_items.id = inventory.purchase_item_id
             WHERE inventory.id = ?`
          )
          .get(item.inventory_id) as any;
        if (!unit) throw new ApiError(404, "Referenced inventory unit not found");
        // Hard rule: a damaged-goods return can only ever touch stock
        // still sitting unsold — never something already with a
        // customer, which is a completely different situation (a
        // customer return, handled elsewhere).
        if (unit.status !== "available") {
          throw new ApiError(409, "Only available (unsold) units can be returned this way — this unit is not available.");
        }
        resolvedItems.push({
          pending_line_id: null,
          inventory_id: unit.id,
          quantity: 1,
          unit_cost: unit.cost_price ?? 0,
        });
      } else {
        throw new ApiError(400, "Each item needs either a pending_line_id or an inventory_id");
      }
    }

    const total_amount = resolvedItems.reduce((sum, item) => sum + item.quantity * item.unit_cost, 0);

    const runTransaction = db.transaction(() => {
      const returnResult = db
        .prepare(
          `INSERT INTO purchase_returns (purchase_id, supplier_id, total_amount, reason, resolution, notes)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(data.purchase_id, purchase.supplier_id, total_amount, data.reason.trim(), data.resolution, data.notes?.trim() || null);

      const returnId = returnResult.lastInsertRowid;

      for (const item of resolvedItems) {
        db.prepare(
          `INSERT INTO purchase_return_items (purchase_return_id, pending_line_id, inventory_id, quantity, unit_cost)
           VALUES (?, ?, ?, ?, ?)`
        ).run(returnId, item.pending_line_id, item.inventory_id, item.quantity, item.unit_cost);

        if (item.pending_line_id) {
          // Reduce what's still expected on this line — a returned
          // quantity was never going to be sorted into real stock, so it
          // comes straight off the remaining amount rather than being
          // tracked as "fulfilled."
          db.prepare(`UPDATE pending_purchase_lines SET quantity = MAX(0, quantity - ?) WHERE id = ?`).run(
            item.quantity,
            item.pending_line_id
          );
        } else if (item.inventory_id) {
          // Pull the specific physical unit from stock — it's leaving
          // the building, not becoming sellable inventory.
          db.prepare(`UPDATE inventory SET status = 'removed', removal_reason = 'Damaged', removal_note = ? WHERE id = ?`).run(
            data.reason.trim(),
            item.inventory_id
          );
        }
      }

      if (data.resolution === "cash_refund") {
        // Cash changes hands right away — recorded as income (money
        // coming back to the business), nothing carried forward.
        db.prepare(
          `INSERT INTO cash_book (type, category, payment_method, reference_id, amount, notes)
           VALUES ('income', 'return_refund', ?, ?, ?, ?)`
        ).run(data.payment_method ?? null, returnId, total_amount, `Cash refund for return — purchase ${purchase.purchase_code}`);
      } else {
        // Supplier credit: a running balance that automatically reduces
        // what's owed on a future purchase from this same supplier.
        db.prepare(
          `INSERT INTO supplier_credit_transactions (supplier_id, amount, reason, reference_id, notes)
           VALUES (?, ?, 'damaged_goods_credit', ?, ?)`
        ).run(
          purchase.supplier_id,
          total_amount,
          returnId,
          `Credit for return — purchase ${purchase.purchase_code}, applied to a future purchase`
        );
      }

      return returnId;
    });

    const returnId = runTransaction();
    const created = db
      .prepare(
        `SELECT purchase_returns.*, suppliers.name as supplier_name, purchases.purchase_code
         FROM purchase_returns
         JOIN suppliers ON suppliers.id = purchase_returns.supplier_id
         JOIN purchases ON purchases.id = purchase_returns.purchase_id
         WHERE purchase_returns.id = ?`
      )
      .get(returnId);
    const items = db.prepare(`SELECT * FROM purchase_return_items WHERE purchase_return_id = ?`).all(returnId);

    res.status(201).json({ ...(created as object), items });
  })
);

// GET /api/purchases/returns — full history, most recent first.
purchasesRouter.get(
  "/returns",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT purchase_returns.*, suppliers.name as supplier_name, purchases.purchase_code
         FROM purchase_returns
         JOIN suppliers ON suppliers.id = purchase_returns.supplier_id
         JOIN purchases ON purchases.id = purchase_returns.purchase_id
         ORDER BY purchase_returns.id DESC`
      )
      .all() as any[];

    const itemStmt = db.prepare(`SELECT * FROM purchase_return_items WHERE purchase_return_id = ?`);
    const withItems = rows.map((r) => ({ ...r, items: itemStmt.all(r.id) }));

    res.json(withItems);
  })
);

// GET /api/purchases/:id/available-units — every AVAILABLE inventory
// unit tied to a specific purchase (across all its fulfilled lines),
// grouped implicitly by variant via the returned size/color fields — the
// data behind the Scenario A multi-select picker. Never includes sold,
// damaged, or otherwise unavailable units, since those can never be
// picked for a return here.
purchasesRouter.get(
  "/:purchaseId/available-units",
  asyncHandler(async (req, res) => {
    const rows = db
      .prepare(
        `SELECT inventory.id, inventory.sku, inventory.barcode, inventory.size, inventory.color,
                inventory.cost_price, products.id as product_id, products.product_title
         FROM inventory
         JOIN purchase_items ON purchase_items.id = inventory.purchase_item_id
         JOIN products ON products.id = inventory.product_id
         WHERE purchase_items.purchase_id = ? AND inventory.status = 'available'
         ORDER BY products.product_title, inventory.color, inventory.size`
      )
      .all(req.params.purchaseId);
    res.json(rows);
  })
);

// GET /api/purchases/:id — includes line items
purchasesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const purchase = db
      .prepare(
        `SELECT purchases.*, suppliers.name as supplier_name
         FROM purchases JOIN suppliers ON suppliers.id = purchases.supplier_id
         WHERE purchases.id = ?`
      )
      .get(req.params.id);
    if (!purchase) throw new ApiError(404, "Purchase not found");

    const items = db
      .prepare(
        `SELECT purchase_items.*, COALESCE(products.product_title, purchase_items.product_snapshot) as product_title
         FROM purchase_items LEFT JOIN products ON products.id = purchase_items.product_id
         WHERE purchase_items.purchase_id = ?`
      )
      .all(req.params.id);

    const lines = db.prepare(`SELECT * FROM pending_purchase_lines WHERE purchase_id = ?`).all(req.params.id);

    res.json({ ...purchase, items, lines });
  })
);

// POST /api/purchases — record stock received. This is a transaction:
// it creates the purchase, its line items, AND one new inventory row per
// unit received (quantity=3 -> 3 new inventory rows, ready for you to
// assign size/color/barcode afterward via PUT /api/inventory/:id).
purchasesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = purchaseInput.parse(req.body);

    const supplier = db.prepare(`SELECT id FROM suppliers WHERE id = ?`).get(data.supplier_id);
    if (!supplier) throw new ApiError(400, "Referenced supplier does not exist");

    for (const item of data.items) {
      const product = db.prepare(`SELECT id FROM products WHERE id = ?`).get(item.product_id);
      if (!product) throw new ApiError(400, `Product ${item.product_id} does not exist`);
    }

    const total_cost = data.items.reduce((sum, item) => sum + item.unit_cost * item.quantity, 0);
    const quantityBeingAdded = data.items.reduce((sum, item) => sum + item.quantity, 0);

    let purchaseId: number | bigint;
    let purchase_code: string;
    let fulfilledLine: any = null;
    // A soft warning only — never blocks the request. Populated when
    // fulfilling a line takes the running total above what was expected,
    // e.g. "70 expected, this takes it to 75" — an honest miscount or a
    // supplier bonus shouldn't be prevented, just flagged.
    let quantityWarning: string | null = null;

    if (data.fulfills_line_id) {
      // Fulfilling (part of) a line of a pending purchase: the supplier,
      // cost, and payment for the OVERALL purchase were already recorded
      // when the goods arrived — this step only adds the actual product/
      // variant line items and inventory for this rough line. A line can
      // be fulfilled across several separate actions, so already being
      // marked fulfilled once doesn't block adding more against it.
      fulfilledLine = db.prepare(`SELECT * FROM pending_purchase_lines WHERE id = ?`).get(data.fulfills_line_id) as any;
      if (!fulfilledLine) throw new ApiError(404, "Referenced pending purchase line not found");

      const pending = db.prepare(`SELECT * FROM purchases WHERE id = ?`).get(fulfilledLine.purchase_id) as any;
      if (!pending) throw new ApiError(404, "Referenced pending purchase not found");
      if (pending.supplier_id !== data.supplier_id) {
        throw new ApiError(400, "Supplier must match the pending purchase this line belongs to");
      }
      purchaseId = pending.id;
      purchase_code = pending.purchase_code;

      const newFulfilledTotal = fulfilledLine.fulfilled_quantity + quantityBeingAdded;
      if (newFulfilledTotal > fulfilledLine.quantity) {
        quantityWarning = `This line expected ${fulfilledLine.quantity} pcs — entering this brings the total fulfilled to ${newFulfilledTotal}.`;
      }
    } else {
      purchase_code = nextPurchaseCode();
    }

    let payment_status: "paid" | "partial" | "unpaid" = "unpaid";
    if (data.amount_paid >= total_cost && total_cost > 0) payment_status = "paid";
    else if (data.amount_paid > 0) payment_status = "partial";

    const createdInventoryIds: number[] = [];

    const runPurchaseTransaction = db.transaction(() => {
      if (!data.fulfills_line_id) {
        const purchaseResult = db
          .prepare(
            `INSERT INTO purchases (purchase_code, supplier_id, total_cost, amount_paid, payment_status)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(purchase_code, data.supplier_id, total_cost, data.amount_paid, payment_status);
        purchaseId = purchaseResult.lastInsertRowid;
      }

      let firstPurchaseItemId: number | bigint | null = null;

      for (const item of data.items) {
        const size = normalizeSize(item.size);
        const color = normalizeColor(item.color);

        const purchaseItemResult = db
          .prepare(
            `INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_cost, size, color)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(purchaseId, item.product_id, item.quantity, item.unit_cost, size, color);
        const purchaseItemId = purchaseItemResult.lastInsertRowid;
        if (firstPurchaseItemId === null) firstPurchaseItemId = purchaseItemId;

        // Look up the product's current selling_price as the fallback for
        // this batch's unit_selling_price, and continue barcodes from
        // wherever the whole system last left off.
        const product = db
          .prepare(`SELECT selling_price FROM products WHERE id = ?`)
          .get(item.product_id) as { selling_price: number };
        const unitSellingPrice = item.unit_selling_price ?? product.selling_price;
        const barcodes = nextBarcodeBatch(item.quantity);

        // Generate one inventory row per physical unit received, each
        // carrying its OWN cost and selling price for this batch — so an
        // older-cost batch and a newer-cost batch of the same product can
        // sit in stock and sell at their own real prices simultaneously.
        // Each unit also links back to purchase_items, so it can always
        // be traced to the exact batch (and therefore supplier) it came
        // from — not just its cost.
        for (let i = 0; i < item.quantity; i++) {
          const sku = nextSku(item.product_id);
          const invResult = db
            .prepare(
              `INSERT INTO inventory (product_id, size, color, sku, barcode, cost_price, selling_price, purchase_item_id, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available')`
            )
            .run(item.product_id, size, color, sku, barcodes[i], item.unit_cost, unitSellingPrice, purchaseItemId);
          createdInventoryIds.push(Number(invResult.lastInsertRowid));
        }

        // The product's own cost_price/selling_price become "current" —
        // i.e. what shows as the default for the NEXT restock and in
        // product listings — reflecting this latest batch. Historical
        // units keep their own real cost/price regardless of this update.
        db.prepare(`UPDATE products SET cost_price = ?, selling_price = ? WHERE id = ?`).run(
          item.unit_cost,
          unitSellingPrice,
          item.product_id
        );
      }

      // Add to this line's running fulfilled quantity — a line can be
      // completed across several separate actions, so this accumulates
      // rather than overwrites. is_fulfilled is set once the running
      // total reaches (or, per the soft-warning rule, exceeds) what was
      // expected — it's informational, never a hard gate on further use.
      if (data.fulfills_line_id && fulfilledLine) {
        const newTotal = fulfilledLine.fulfilled_quantity + quantityBeingAdded;
        db.prepare(
          `UPDATE pending_purchase_lines
           SET fulfilled_quantity = ?, is_fulfilled = ?, fulfilled_purchase_item_id = ?
           WHERE id = ?`
        ).run(newTotal, newTotal >= fulfilledLine.quantity ? 1 : 0, firstPurchaseItemId, data.fulfills_line_id);
      }

      // A fulfillment's payment was already recorded when the purchase
      // was created as pending — recording it again here would double
      // count it in the cash book and supplier balance.
      if (data.amount_paid > 0 && !data.fulfills_line_id) {
        db.prepare(
          `INSERT INTO cash_book (type, category, payment_method, reference_id, amount, notes)
           VALUES ('expense', 'purchase', ?, ?, ?, ?)`
        ).run(data.payment_method ?? null, purchaseId, data.amount_paid, `Payment for purchase ${purchase_code}`);

        db.prepare(
          `INSERT INTO supplier_payments (supplier_id, purchase_id, amount, is_partial, notes)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          data.supplier_id,
          purchaseId,
          data.amount_paid,
          payment_status === "partial" ? 1 : 0,
          `Payment recorded at time of purchase ${purchase_code}`
        );
      }

      return purchaseId;
    });

    runPurchaseTransaction();

    const created = db
      .prepare(
        `SELECT purchases.*, suppliers.name as supplier_name
         FROM purchases JOIN suppliers ON suppliers.id = purchases.supplier_id
         WHERE purchases.id = ?`
      )
      .get(purchaseId);

    res.status(201).json({
      ...(created as object),
      new_inventory_ids: createdInventoryIds,
      note: "New inventory units created as 'available' with server-generated sequential barcodes and this batch's cost/selling price.",
      quantity_warning: quantityWarning,
    });
  })
);


// DELETE /api/purchases/:id — undo a purchase entirely, within 24 hours
// of creation, so a genuinely bad entry (wrong cost typed, wrong
// supplier picked) can be scrapped and re-entered correctly rather than
// trying to patch a fulfilled purchase's numbers out of sync with the
// real inventory units it already created. Blocked if ANY unit from
// this purchase has already been sold — at that point the sale is real
// and this purchase is load-bearing history, not a mistake to erase.
purchasesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const purchase = db.prepare(`SELECT * FROM purchases WHERE id = ?`).get(req.params.id) as any;
    if (!purchase) throw new ApiError(404, "Purchase not found");

    const hoursSince = (Date.now() - new Date(purchase.purchase_date).getTime()) / (1000 * 60 * 60);
    if (hoursSince > 24) {
      throw new ApiError(409, "This purchase is more than 24 hours old and can no longer be deleted.");
    }

    // Find every inventory unit that traces back to this purchase, via
    // its purchase_items rows.
    const units = db
      .prepare(
        `SELECT inventory.id, inventory.status
         FROM inventory
         JOIN purchase_items ON purchase_items.id = inventory.purchase_item_id
         WHERE purchase_items.purchase_id = ?`
      )
      .all(req.params.id) as { id: number; status: string }[];

    const soldCount = units.filter((u) => u.status === "sold").length;
    if (soldCount > 0) {
      throw new ApiError(
        409,
        `Cannot delete — ${soldCount} unit(s) from this purchase have already been sold. Once a sale is real, this purchase is part of that history.`
      );
    }

    const runDelete = db.transaction(() => {
      // Delete the inventory units explicitly first, since
      // inventory.purchase_item_id has no ON DELETE CASCADE — the
      // purchase_items rows below would otherwise leave them dangling.
      if (units.length > 0) {
        const ids = units.map((u) => u.id);
        db.prepare(`DELETE FROM inventory WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
      }

      // Clean up the loosely-referenced (non-foreign-key) side effects
      // this purchase may have caused — cash book entries, supplier
      // payments, and any credit transaction tied to it.
      db.prepare(`DELETE FROM cash_book WHERE category IN ('purchase', 'purchase_other_costs') AND reference_id = ?`).run(req.params.id);
      db.prepare(`DELETE FROM supplier_payments WHERE purchase_id = ?`).run(req.params.id);
      db.prepare(`DELETE FROM supplier_credit_transactions WHERE reference_id = ? AND reason = 'applied_to_purchase'`).run(req.params.id);

      // purchase_items, pending_purchase_lines, and purchase_returns all
      // cascade automatically via their ON DELETE CASCADE foreign keys.
      db.prepare(`DELETE FROM purchases WHERE id = ?`).run(req.params.id);
    });

    runDelete();
    res.status(204).send();
  })
);
