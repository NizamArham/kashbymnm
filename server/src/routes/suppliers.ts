import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { generateSupplierCode } from "../lib/codes";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const suppliersRouter = Router();

// Suppliers are financial/business data — admin only, per the access model.
suppliersRouter.use(requireAuth, requireRole("admin"));

const supplierInput = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  city: z.string().optional(),
  notes: z.string().optional(),
});

const bankAccountInput = z.object({
  bank_name: z.string().min(1, "Bank name is required"),
  account_name: z.string().min(1, "Account holder name is required"),
  account_number: z.string().min(1, "Account number is required"),
  branch: z.string().optional(),
  is_default: z.boolean().optional(),
});

// balance_owed = total purchases from this supplier - total payments made
// - any available credit (from damaged-goods returns the supplier agreed
// to cover as a future discount rather than an immediate cash refund).
// credit_balance is shown separately so it's clear WHY the owed amount
// is lower than raw purchases-minus-payments would suggest.
const BALANCE_SUBQUERY = `
  COALESCE((SELECT SUM(total_cost) FROM purchases WHERE supplier_id = suppliers.id), 0)
  -
  COALESCE((SELECT SUM(amount_paid) FROM purchases WHERE supplier_id = suppliers.id), 0)
  -
  COALESCE((SELECT SUM(amount) FROM supplier_credit_transactions WHERE supplier_id = suppliers.id), 0)
  AS balance_owed,
  COALESCE((SELECT SUM(amount) FROM supplier_credit_transactions WHERE supplier_id = suppliers.id), 0)
  AS credit_balance
`;

// GET /api/suppliers — list all, with live balance_owed
suppliersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(`SELECT suppliers.*, ${BALANCE_SUBQUERY} FROM suppliers ORDER BY id DESC`)
      .all();
    res.json(rows);
  })
);

// GET /api/suppliers/:id
suppliersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = db
      .prepare(`SELECT suppliers.*, ${BALANCE_SUBQUERY} FROM suppliers WHERE id = ?`)
      .get(req.params.id) as any;
    if (!row) throw new ApiError(404, "Supplier not found");

    const bankAccounts = db
      .prepare(`SELECT * FROM supplier_bank_accounts WHERE supplier_id = ? ORDER BY is_default DESC, id ASC`)
      .all(req.params.id);

    res.json({ ...row, bank_accounts: bankAccounts });
  })
);

// ---- Nested bank accounts ----

// POST /api/suppliers/:id/bank-accounts
suppliersRouter.post(
  "/:id/bank-accounts",
  asyncHandler(async (req, res) => {
    const supplier = db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.id);
    if (!supplier) throw new ApiError(404, "Supplier not found");

    const data = bankAccountInput.parse(req.body);
    const isDefault = data.is_default ? 1 : 0;

    if (isDefault) {
      db.prepare(`UPDATE supplier_bank_accounts SET is_default = 0 WHERE supplier_id = ?`).run(req.params.id);
    }

    const result = db
      .prepare(
        `INSERT INTO supplier_bank_accounts (supplier_id, bank_name, account_name, account_number, branch, is_default)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(req.params.id, data.bank_name, data.account_name, data.account_number, data.branch ?? null, isDefault);

    const created = db.prepare(`SELECT * FROM supplier_bank_accounts WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(created);
  })
);

// PUT /api/suppliers/:id/bank-accounts/:accountId
suppliersRouter.put(
  "/:id/bank-accounts/:accountId",
  asyncHandler(async (req, res) => {
    const existing = db
      .prepare(`SELECT * FROM supplier_bank_accounts WHERE id = ? AND supplier_id = ?`)
      .get(req.params.accountId, req.params.id) as any;
    if (!existing) throw new ApiError(404, "Bank account not found for this supplier");

    const data = bankAccountInput.partial().parse(req.body);
    const merged = { ...existing, ...data };
    const isDefault = merged.is_default ? 1 : 0;

    if (isDefault) {
      db.prepare(`UPDATE supplier_bank_accounts SET is_default = 0 WHERE supplier_id = ? AND id != ?`).run(
        req.params.id,
        req.params.accountId
      );
    }

    db.prepare(
      `UPDATE supplier_bank_accounts SET bank_name = ?, account_name = ?, account_number = ?, branch = ?, is_default = ? WHERE id = ?`
    ).run(merged.bank_name, merged.account_name, merged.account_number, merged.branch, isDefault, req.params.accountId);

    const updated = db.prepare(`SELECT * FROM supplier_bank_accounts WHERE id = ?`).get(req.params.accountId);
    res.json(updated);
  })
);

// DELETE /api/suppliers/:id/bank-accounts/:accountId
suppliersRouter.delete(
  "/:id/bank-accounts/:accountId",
  asyncHandler(async (req, res) => {
    const existing = db
      .prepare(`SELECT * FROM supplier_bank_accounts WHERE id = ? AND supplier_id = ?`)
      .get(req.params.accountId, req.params.id);
    if (!existing) throw new ApiError(404, "Bank account not found for this supplier");

    db.prepare(`DELETE FROM supplier_bank_accounts WHERE id = ?`).run(req.params.accountId);
    res.status(204).send();
  })
);

// POST /api/suppliers — create, auto-generating supplier_code
suppliersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = supplierInput.parse(req.body);
    const supplier_code = generateSupplierCode(data.name, data.phone);

    const result = db
      .prepare(
        `INSERT INTO suppliers (supplier_code, name, phone, city, notes)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(supplier_code, data.name, data.phone ?? null, data.city ?? null, data.notes ?? null);

    const created = db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(created);
  })
);

// PUT /api/suppliers/:id — update editable fields (not the code)
suppliersRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const data = supplierInput.partial().parse(req.body);
    const existing = db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.id);
    if (!existing) throw new ApiError(404, "Supplier not found");

    const merged = { ...existing, ...data } as any;
    db.prepare(
      `UPDATE suppliers SET name = ?, phone = ?, city = ?, notes = ? WHERE id = ?`
    ).run(merged.name, merged.phone, merged.city, merged.notes, req.params.id);

    const updated = db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// DELETE /api/suppliers/:id — blocked if supplier has purchases/products (referential safety)
suppliersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.id);
    if (!existing) throw new ApiError(404, "Supplier not found");

    const hasProducts = db
      .prepare(`SELECT COUNT(*) as cnt FROM products WHERE supplier_id = ?`)
      .get(req.params.id) as { cnt: number };
    const hasPurchases = db
      .prepare(`SELECT COUNT(*) as cnt FROM purchases WHERE supplier_id = ?`)
      .get(req.params.id) as { cnt: number };

    if (hasProducts.cnt > 0 || hasPurchases.cnt > 0) {
      throw new ApiError(
        409,
        "Cannot delete supplier with existing products or purchases. Consider keeping the record for history."
      );
    }

    db.prepare(`DELETE FROM suppliers WHERE id = ?`).run(req.params.id);
    res.status(204).send();
  })
);
