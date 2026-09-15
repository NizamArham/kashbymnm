import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const cashBookRouter = Router();

// The master financial ledger — admin only.
cashBookRouter.use(requireAuth, requireRole("admin"));

const entryInput = z.object({
  type: z.enum(["income", "expense"]),
  category: z.string().min(1),
  payment_method: z.string().optional(),
  reference_id: z.number().int().optional(),
  amount: z.number().positive(),
  notes: z.string().optional(),
  entry_date: z.string().optional(),
});

// GET /api/cash-book — full ledger with running_balance computed on the fly,
// ordered oldest -> newest so the running total accumulates correctly.
// Response is then reversed so the newest entry shows first, as expected in a UI.
cashBookRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(`SELECT * FROM cash_book ORDER BY entry_date ASC, id ASC`)
      .all() as any[];

    let running = 0;
    const withBalance = rows.map((row) => {
      running += row.type === "income" ? row.amount : -row.amount;
      return { ...row, running_balance: running };
    });

    res.json(withBalance.reverse());
  })
);

// GET /api/cash-book/balance — just the current total, for a dashboard widget
cashBookRouter.get(
  "/balance",
  asyncHandler(async (_req, res) => {
    const row = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) -
           COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as balance
         FROM cash_book`
      )
      .get();
    res.json(row);
  })
);

// POST /api/cash-book — manual entry (e.g. rent, utilities, misc income)
// Note: sales, supplier payments, and courier payments write here automatically
// via their own routes — this endpoint is for entries with no other source.
cashBookRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = entryInput.parse(req.body);

    const result = db
      .prepare(
        `INSERT INTO cash_book (type, category, payment_method, reference_id, amount, notes, entry_date)
         VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
      )
      .run(
        data.type,
        data.category,
        data.payment_method ?? null,
        data.reference_id ?? null,
        data.amount,
        data.notes ?? null,
        data.entry_date ?? null
      );

    const created = db.prepare(`SELECT * FROM cash_book WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(created);
  })
);

// Shared 24-hour edit/delete window — applies to ANY entry, including
// ones auto-created by sales/purchases/payments, since mistakes happen
// regardless of source. Past 24 hours, an entry is locked — by then a
// daily report may already have been read, and changing history after
// that point causes more confusion than the original mistake would have.
function assertWithinEditWindow(entry: { entry_date: string }) {
  const entryTime = new Date(entry.entry_date).getTime();
  const hoursSince = (Date.now() - entryTime) / (1000 * 60 * 60);
  if (hoursSince > 24) {
    throw new ApiError(409, "This entry is more than 24 hours old and can no longer be edited or deleted.");
  }
}

const editEntryInput = z.object({
  type: z.enum(["income", "expense"]).optional(),
  category: z.string().min(1).optional(),
  payment_method: z.string().optional(),
  amount: z.number().positive().optional(),
  notes: z.string().optional(),
});

// PUT /api/cash-book/:id — fix a mistake within 24 hours of the entry
// being created. Admin-only (enforced by the router-level requireRole
// above). Applies to any entry, not just manually-added ones.
cashBookRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM cash_book WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Cash book entry not found");
    assertWithinEditWindow(existing);

    const data = editEntryInput.parse(req.body);
    db.prepare(
      `UPDATE cash_book SET type = ?, category = ?, payment_method = ?, amount = ?, notes = ? WHERE id = ?`
    ).run(
      data.type ?? existing.type,
      data.category ?? existing.category,
      data.payment_method !== undefined ? data.payment_method : existing.payment_method,
      data.amount ?? existing.amount,
      data.notes !== undefined ? data.notes : existing.notes,
      req.params.id
    );

    const updated = db.prepare(`SELECT * FROM cash_book WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// DELETE /api/cash-book/:id — same 24-hour rule as editing, applies to
// any entry regardless of source.
cashBookRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM cash_book WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Cash book entry not found");
    assertWithinEditWindow(existing);

    db.prepare(`DELETE FROM cash_book WHERE id = ?`).run(req.params.id);
    res.status(204).send();
  })
);

const transferInput = z.object({
  direction: z.enum(["cash_to_bank", "bank_to_cash"]),
  amount: z.number().positive(),
  notes: z.string().optional(),
});

// POST /api/cash-book/transfer — move money between cash-in-hand and the
// bank account. This is neither real income nor a real expense — no
// money enters or leaves the business, it just changes WHERE it's held
// — but the ledger only has 'income'/'expense' as types, so a transfer
// is represented as a matched PAIR: one expense entry (money leaving
// that method) and one income entry (money arriving in the other),
// both tagged category='transfer' and cross-referencing each other's id
// via reference_id, so they're always recognizable as one linked move
// rather than two coincidental entries. Net effect on the overall
// balance is zero, exactly as a transfer should be.
cashBookRouter.post(
  "/transfer",
  asyncHandler(async (req, res) => {
    const data = transferInput.parse(req.body);

    const fromMethod = data.direction === "cash_to_bank" ? "cash" : "bank_transfer";
    const toMethod = data.direction === "cash_to_bank" ? "bank_transfer" : "cash";
    const noteSuffix = data.notes?.trim() ? ` — ${data.notes.trim()}` : "";

    const runTransfer = db.transaction(() => {
      const outResult = db
        .prepare(`INSERT INTO cash_book (type, category, payment_method, amount, notes) VALUES ('expense', 'transfer', ?, ?, ?)`)
        .run(fromMethod, data.amount, `Transfer to ${toMethod === "cash" ? "cash in hand" : "bank"}${noteSuffix}`);
      const outId = outResult.lastInsertRowid;

      const inResult = db
        .prepare(
          `INSERT INTO cash_book (type, category, payment_method, reference_id, amount, notes) VALUES ('income', 'transfer', ?, ?, ?, ?)`
        )
        .run(toMethod, outId, data.amount, `Transfer from ${fromMethod === "cash" ? "cash in hand" : "bank"}${noteSuffix}`);
      const inId = inResult.lastInsertRowid;

      // Link the first entry back to the second now that its id exists.
      db.prepare(`UPDATE cash_book SET reference_id = ? WHERE id = ?`).run(inId, outId);

      return { outId, inId };
    });

    const { outId, inId } = runTransfer();
    const entries = db
      .prepare(`SELECT * FROM cash_book WHERE id IN (?, ?) ORDER BY id ASC`)
      .all(outId, inId);
    res.status(201).json(entries);
  })
);
