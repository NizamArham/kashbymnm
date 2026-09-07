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
        `INSERT INTO cash_book (type, category, reference_id, amount, notes, entry_date)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
      )
      .run(
        data.type,
        data.category,
        data.reference_id ?? null,
        data.amount,
        data.notes ?? null,
        data.entry_date ?? null
      );

    const created = db.prepare(`SELECT * FROM cash_book WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(created);
  })
);

// DELETE /api/cash-book/:id — only for manually-entered rows (category = 'other')
// to avoid orphaning the automatic entries tied to sales/payments
cashBookRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM cash_book WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Cash book entry not found");

    if (existing.category !== "other") {
      throw new ApiError(
        409,
        "This entry was generated automatically from a sale/payment and can't be deleted directly. Adjust the source record instead."
      );
    }

    db.prepare(`DELETE FROM cash_book WHERE id = ?`).run(req.params.id);
    res.status(204).send();
  })
);
