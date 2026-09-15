import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";
import { computeFifoAllocation } from "./customers";

export const chequesRouter = Router();

// Cheque tracking touches real money movement — admin only, same as
// Cash Book and Supplier Payments.
chequesRouter.use(requireAuth, requireRole("admin"));

// Reverses exactly THIS cheque's own contribution to whatever sales its
// stored allocation touched — walking backward from the most recently
// settled sale, same rule used for a bounce (see the /bounce route
// below), reused here so editing a cheque's amount and bouncing it stay
// mathematically consistent with each other.
function reverseChequeAllocation(receiptAmount: number, allocationsJson: string) {
  const allocations = JSON.parse(allocationsJson) as { sale_id: number; applied: number }[];
  let remainingToReverse = receiptAmount;
  for (let i = allocations.length - 1; i >= 0 && remainingToReverse > 0; i--) {
    const a = allocations[i];
    const reverseAmount = Math.min(a.applied, remainingToReverse);
    const sale = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(a.sale_id) as any;
    if (sale) {
      const restoredAmountPaid = Math.max(0, sale.amount_paid - reverseAmount);
      const restoredStatus = restoredAmountPaid >= sale.total ? "paid" : restoredAmountPaid > 0 ? "partial" : "unpaid";
      db.prepare(`UPDATE sales SET amount_paid = ?, payment_status = ? WHERE id = ?`).run(
        restoredAmountPaid,
        restoredStatus,
        a.sale_id
      );
    }
    remainingToReverse -= reverseAmount;
  }
}

const CHEQUE_SELECT = `
  SELECT cheque_receipts.*, customers.name as customer_name, customers.customer_code,
         transfer.id as transfer_id, transfer.supplier_id as transferred_to_supplier_id,
         transfer.date_given as transfer_date, suppliers.name as transferred_to_supplier_name
  FROM cheque_receipts
  JOIN customers ON customers.id = cheque_receipts.customer_id
  LEFT JOIN cheque_transfers transfer ON transfer.cheque_receipt_id = cheque_receipts.id
  LEFT JOIN suppliers ON suppliers.id = transfer.supplier_id
`;

// GET /api/cheques — all cheques, newest received first. Optionally
// ?status=in_hand to power the "cheques in hand" tab (today's on top,
// so it reads as a to-deposit reminder list).
chequesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const conditions: string[] = [];
    const params: any[] = [];
    if (req.query.status) {
      conditions.push("cheque_receipts.status = ?");
      params.push(req.query.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = db.prepare(`${CHEQUE_SELECT} ${where} ORDER BY cheque_receipts.date_received DESC`).all(...params);
    res.json(rows);
  })
);

// GET /api/cheques/search?number=... — exact-match lookup by cheque
// number, the same "type it, search, pick the one match" pattern as
// looking up a purchase/sale by its code elsewhere in the app. Only
// cheques still in_hand are eligible (already-transferred or
// cleared/bounced cheques can't be spent again).
chequesRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const number = String(req.query.number ?? "").trim();
    if (!number) throw new ApiError(400, "A cheque number is required");

    const rows = db
      .prepare(`${CHEQUE_SELECT} WHERE cheque_receipts.status = 'in_hand' AND cheque_receipts.cheque_number = ?`)
      .all(number);

    res.json(rows);
  })
);

const editReceiptInput = z.object({
  cheque_number: z.string().min(1).optional(),
  bank_name: z.string().min(1).optional(),
  cheque_date: z.string().optional(),
  amount: z.number().positive().optional(),
});

// PUT /api/cheques/:id — fix a mistake on a received cheque. Only
// allowed while still in_hand — once it's been handed to a supplier or
// cleared, this is blocked (see the locked design: editing a
// settled/transferred cheque would mean also untangling a real Cash
// Book entry or a supplier payment, which is out of scope here).
// Changing the amount is the one field with a real side effect: this
// cheque's current contribution to the customer's sales is reversed
// first, then a fresh FIFO allocation is computed and applied for the
// new amount, so it never drifts out of sync with what's actually owed.
chequesRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const receipt = db.prepare(`SELECT * FROM cheque_receipts WHERE id = ?`).get(req.params.id) as any;
    if (!receipt) throw new ApiError(404, "Cheque not found");
    if (receipt.status !== "in_hand") {
      throw new ApiError(409, `This cheque is ${receipt.status.replace("_", " ")} and can no longer be edited — only a cheque still in hand can be changed.`);
    }

    const data = editReceiptInput.parse(req.body);

    const runEdit = db.transaction(() => {
      let newAllocationsJson = receipt.sale_allocations;

      if (data.amount != null && data.amount !== receipt.amount) {
        reverseChequeAllocation(receipt.amount, receipt.sale_allocations);
        const { allocations } = computeFifoAllocation(receipt.customer_id, data.amount);
        if (allocations.length === 0) {
          throw new ApiError(409, "This customer has no outstanding sales to apply the new amount against");
        }
        for (const a of allocations) {
          db.prepare(`UPDATE sales SET amount_paid = ?, payment_status = ? WHERE id = ?`).run(
            a.new_amount_paid,
            a.new_status,
            a.sale_id
          );
        }
        newAllocationsJson = JSON.stringify(allocations);
      }

      db.prepare(
        `UPDATE cheque_receipts SET cheque_number = ?, bank_name = ?, cheque_date = ?, amount = ?, sale_allocations = ? WHERE id = ?`
      ).run(
        data.cheque_number?.trim() ?? receipt.cheque_number,
        data.bank_name?.trim() ?? receipt.bank_name,
        data.cheque_date ?? receipt.cheque_date,
        data.amount ?? receipt.amount,
        newAllocationsJson,
        req.params.id
      );
    });

    runEdit();
    const updated = db.prepare(`${CHEQUE_SELECT} WHERE cheque_receipts.id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// DELETE /api/cheques/:id — remove a received cheque entered by
// mistake. Only allowed while still in_hand — reverses its allocation
// on the customer's sales, then deletes the row entirely.
chequesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const receipt = db.prepare(`SELECT * FROM cheque_receipts WHERE id = ?`).get(req.params.id) as any;
    if (!receipt) throw new ApiError(404, "Cheque not found");
    if (receipt.status !== "in_hand") {
      throw new ApiError(409, `This cheque is ${receipt.status.replace("_", " ")} and can no longer be deleted — only a cheque still in hand can be removed.`);
    }

    const runDelete = db.transaction(() => {
      reverseChequeAllocation(receipt.amount, receipt.sale_allocations);
      db.prepare(`DELETE FROM cheque_receipts WHERE id = ?`).run(req.params.id);
    });

    runDelete();
    res.status(204).send();
  })
);

const payBySupplierChequeInput = z.object({
  cheque_receipt_id: z.number().int().positive(),
  supplier_id: z.number().int().positive(),
  purchase_id: z.number().int().positive().optional(),
  notes: z.string().optional(),
});

// POST /api/cheques/pay-supplier — hand an in-hand cheque to a supplier
// as payment. Creates the linking cheque_transfers row AND a normal
// supplier_payments row (so the supplier's balance reduces immediately,
// per the locked design), but — same as receiving the cheque — no
// cash_book entry yet, since real cash still hasn't moved. That only
// happens when the cheque is later marked cleared.
chequesRouter.post(
  "/pay-supplier",
  asyncHandler(async (req, res) => {
    const data = payBySupplierChequeInput.parse(req.body);

    const receipt = db.prepare(`SELECT * FROM cheque_receipts WHERE id = ?`).get(data.cheque_receipt_id) as any;
    if (!receipt) throw new ApiError(404, "Cheque not found");
    if (receipt.status !== "in_hand") {
      throw new ApiError(409, `This cheque is ${receipt.status.replace("_", " ")} and can't be used for a new payment.`);
    }

    const supplier = db.prepare(`SELECT id, name FROM suppliers WHERE id = ?`).get(data.supplier_id) as any;
    if (!supplier) throw new ApiError(400, "Referenced supplier does not exist");

    const runTransfer = db.transaction(() => {
      const paymentResult = db
        .prepare(
          `INSERT INTO supplier_payments (supplier_id, purchase_id, amount, method, notes)
           VALUES (?, ?, ?, 'cheque', ?)`
        )
        .run(
          data.supplier_id,
          data.purchase_id ?? null,
          receipt.amount,
          `Cheque #${receipt.cheque_number} (${receipt.bank_name})${data.notes?.trim() ? ` — ${data.notes.trim()}` : ""}`
        );

      if (data.purchase_id) {
        const purchase = db.prepare(`SELECT * FROM purchases WHERE id = ?`).get(data.purchase_id) as any;
        if (purchase) {
          const newAmountPaid = purchase.amount_paid + receipt.amount;
          const newStatus = newAmountPaid >= purchase.total_cost ? "paid" : "partial";
          db.prepare(`UPDATE purchases SET amount_paid = ?, payment_status = ? WHERE id = ?`).run(
            newAmountPaid,
            newStatus,
            data.purchase_id
          );
        }
      }

      const transferResult = db
        .prepare(
          `INSERT INTO cheque_transfers (cheque_receipt_id, supplier_id, supplier_payment_id, notes)
           VALUES (?, ?, ?, ?)`
        )
        .run(data.cheque_receipt_id, data.supplier_id, paymentResult.lastInsertRowid, data.notes ?? null);

      db.prepare(`UPDATE cheque_receipts SET status = 'given_to_supplier' WHERE id = ?`).run(data.cheque_receipt_id);

      return transferResult.lastInsertRowid;
    });

    const transferId = runTransfer();
    const updated = db.prepare(`${CHEQUE_SELECT} WHERE cheque_receipts.id = ?`).get(data.cheque_receipt_id);
    res.status(201).json({ cheque: updated, transfer_id: transferId });
  })
);

const batchOwnChequeInput = z.object({
  cheque_number: z.string().min(1),
  bank_name: z.string().min(1),
  amount: z.number().positive(),
  cheque_date: z.string(),
});

const batchPaySupplierInput = z.object({
  supplier_id: z.number().int().positive(),
  purchase_id: z.number().int().positive().optional(),
  notes: z.string().optional(),
  // Mixed freely — some in-hand cheques (by id), some fresh own cheques
  // (full details) — a single supplier payment can be made up of both.
  in_hand_cheque_ids: z.array(z.number().int().positive()).default([]),
  own_cheques: z.array(batchOwnChequeInput).default([]),
});

// POST /api/cheques/pay-supplier-batch — pay a supplier using SEVERAL
// cheques in one action, any mix of in-hand (already received from a
// customer) and freshly-written own cheques. Each cheque still becomes
// its own independent record — its own supplier_payments row, its own
// cheque_transfers or cheques_issued row — so each can individually
// clear or bounce later without affecting the others. All processed in
// one transaction: either the whole batch succeeds or none of it does.
chequesRouter.post(
  "/pay-supplier-batch",
  asyncHandler(async (req, res) => {
    const data = batchPaySupplierInput.parse(req.body);

    if (data.in_hand_cheque_ids.length === 0 && data.own_cheques.length === 0) {
      throw new ApiError(400, "Add at least one cheque");
    }

    const supplier = db.prepare(`SELECT id, name FROM suppliers WHERE id = ?`).get(data.supplier_id) as any;
    if (!supplier) throw new ApiError(400, "Referenced supplier does not exist");

    // Validate every in-hand cheque up front, before touching anything
    // — so a bad id partway through a large batch doesn't leave earlier
    // cheques half-processed (the transaction below would roll them
    // back anyway, but failing fast here gives a clearer error).
    const inHandReceipts: any[] = [];
    for (const id of data.in_hand_cheque_ids) {
      const receipt = db.prepare(`SELECT * FROM cheque_receipts WHERE id = ?`).get(id) as any;
      if (!receipt) throw new ApiError(404, `Cheque ${id} not found`);
      if (receipt.status !== "in_hand") {
        throw new ApiError(409, `Cheque #${receipt.cheque_number} is ${receipt.status.replace("_", " ")} and can't be used for a new payment.`);
      }
      inHandReceipts.push(receipt);
    }

    let totalApplied = 0;

    const runBatch = db.transaction(() => {
      function applyToPurchase(amount: number) {
        totalApplied += amount;
        if (data.purchase_id) {
          const purchase = db.prepare(`SELECT * FROM purchases WHERE id = ?`).get(data.purchase_id) as any;
          if (purchase) {
            const newAmountPaid = purchase.amount_paid + amount;
            const newStatus = newAmountPaid >= purchase.total_cost ? "paid" : "partial";
            db.prepare(`UPDATE purchases SET amount_paid = ?, payment_status = ? WHERE id = ?`).run(
              newAmountPaid,
              newStatus,
              data.purchase_id
            );
          }
        }
      }

      for (const receipt of inHandReceipts) {
        const paymentResult = db
          .prepare(
            `INSERT INTO supplier_payments (supplier_id, purchase_id, amount, method, notes)
             VALUES (?, ?, ?, 'cheque', ?)`
          )
          .run(
            data.supplier_id,
            data.purchase_id ?? null,
            receipt.amount,
            `Cheque #${receipt.cheque_number} (${receipt.bank_name})${data.notes?.trim() ? ` — ${data.notes.trim()}` : ""}`
          );
        applyToPurchase(receipt.amount);

        db.prepare(
          `INSERT INTO cheque_transfers (cheque_receipt_id, supplier_id, supplier_payment_id, notes)
           VALUES (?, ?, ?, ?)`
        ).run(receipt.id, data.supplier_id, paymentResult.lastInsertRowid, data.notes ?? null);

        db.prepare(`UPDATE cheque_receipts SET status = 'given_to_supplier' WHERE id = ?`).run(receipt.id);
      }

      for (const c of data.own_cheques) {
        const paymentResult = db
          .prepare(
            `INSERT INTO supplier_payments (supplier_id, purchase_id, amount, method, notes)
             VALUES (?, ?, ?, 'cheque', ?)`
          )
          .run(
            data.supplier_id,
            data.purchase_id ?? null,
            c.amount,
            `Cheque #${c.cheque_number} (${c.bank_name})${data.notes?.trim() ? ` — ${data.notes.trim()}` : ""}`
          );
        applyToPurchase(c.amount);

        db.prepare(
          `INSERT INTO cheques_issued (cheque_number, bank_name, amount, cheque_date, supplier_id, supplier_payment_id, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(c.cheque_number.trim(), c.bank_name.trim(), c.amount, c.cheque_date, data.supplier_id, paymentResult.lastInsertRowid, data.notes ?? null);
      }
    });

    runBatch();

    res.status(201).json({
      supplier_id: data.supplier_id,
      cheque_count: data.in_hand_cheque_ids.length + data.own_cheques.length,
      total_applied: totalApplied,
    });
  })
);

const clearInput = z.object({ payment_method: z.enum(["cash", "bank_transfer"]).optional() });

// PUT /api/cheques/:id/clear — the cheque was honored. THIS is the
// moment real cash_book movement actually happens:
// - Never transferred (still in_hand or deposited by the business
//   itself): an INCOME entry, since it's money landing in the account.
// - Transferred to a supplier: an EXPENSE entry instead, since from the
//   business's own books this is the moment that money genuinely left
//   (even though the physical cheque came from a customer) — the
//   supplier's balance was already reduced when the cheque was handed
//   over, so this only affects the cash book, not the supplier record.
chequesRouter.put(
  "/:id/clear",
  asyncHandler(async (req, res) => {
    const receipt = db.prepare(`SELECT * FROM cheque_receipts WHERE id = ?`).get(req.params.id) as any;
    if (!receipt) throw new ApiError(404, "Cheque not found");
    if (receipt.status === "cleared" || receipt.status === "bounced") {
      throw new ApiError(409, `This cheque is already ${receipt.status}`);
    }

    const transfer = db.prepare(`SELECT * FROM cheque_transfers WHERE cheque_receipt_id = ?`).get(req.params.id) as
      | any
      | undefined;
    const data = clearInput.parse(req.body);

    const runClear = db.transaction(() => {
      db.prepare(`UPDATE cheque_receipts SET status = 'cleared', cleared_at = datetime('now') WHERE id = ?`).run(req.params.id);

      if (transfer) {
        db.prepare(
          `INSERT INTO cash_book (type, category, payment_method, reference_id, amount, notes)
           VALUES ('expense', 'supplier_payment', 'cheque', ?, ?, ?)`
        ).run(transfer.supplier_payment_id, receipt.amount, `Cheque #${receipt.cheque_number} cleared — paid to supplier`);
      } else {
        db.prepare(
          `INSERT INTO cash_book (type, category, payment_method, reference_id, amount, notes)
           VALUES ('income', 'customer_payment', ?, ?, ?, ?)`
        ).run(
          data.payment_method ?? "bank_transfer",
          req.params.id,
          receipt.amount,
          `Cheque #${receipt.cheque_number} cleared — received from customer`
        );
      }
    });

    runClear();
    const updated = db.prepare(`${CHEQUE_SELECT} WHERE cheque_receipts.id = ?`).get(req.params.id);
    res.json(updated);
  })
);

const bounceInput = z.object({ reason: z.string().min(1, "A reason is required") });

// PUT /api/cheques/:id/bounce — the cheque was dishonored. Reverses
// whatever it had settled:
// - The originating customer's sales go back to their pre-payment
//   state (using the stored sale_allocations, so this is exact — not a
//   guess at what to undo).
// - If it had ALSO been passed to a supplier, that supplier's payment
//   is reversed too (their balance goes back up) — ONE bounce, BOTH
//   sides affected, exactly as intended.
// No cash_book entry is created or removed here, since a bounce never
// reached the "real cash moved" stage in the first place.
chequesRouter.put(
  "/:id/bounce",
  asyncHandler(async (req, res) => {
    const receipt = db.prepare(`SELECT * FROM cheque_receipts WHERE id = ?`).get(req.params.id) as any;
    if (!receipt) throw new ApiError(404, "Cheque not found");
    if (receipt.status === "cleared" || receipt.status === "bounced") {
      throw new ApiError(409, `This cheque is already ${receipt.status}`);
    }

    const data = bounceInput.parse(req.body);

    const transfer = db.prepare(`SELECT * FROM cheque_transfers WHERE cheque_receipt_id = ?`).get(req.params.id) as
      | any
      | undefined;

    const runBounce = db.transaction(() => {
      // This cheque may share its stored allocation with OTHER cheques
      // from the same batch (see the customers payment endpoint) — a
      // bounce must only undo THIS cheque's own amount, not the whole
      // combined payment. See reverseChequeAllocation for the exact rule.
      reverseChequeAllocation(receipt.amount, receipt.sale_allocations);

      // If this cheque had ALSO been passed to a supplier, reverse that
      // side too — delete the supplier_payments row it created, which
      // is enough on its own since the supplier's balance is always
      // computed live from purchases minus payments.
      if (transfer?.supplier_payment_id) {
        db.prepare(`DELETE FROM supplier_payments WHERE id = ?`).run(transfer.supplier_payment_id);
      }

      db.prepare(
        `UPDATE cheque_receipts SET status = 'bounced', bounced_at = datetime('now'), bounced_reason = ? WHERE id = ?`
      ).run(data.reason, req.params.id);
    });

    runBounce();
    const updated = db.prepare(`${CHEQUE_SELECT} WHERE cheque_receipts.id = ?`).get(req.params.id);
    res.json({ cheque: updated, affected_supplier: transfer ? true : false });
  })
);

// ---------------------------------------------------------------------------
// Self-written cheques — issued from the business's OWN account straight to
// a supplier, with no customer or transfer involved. Simpler lifecycle than
// a received cheque, but the same core rules: issuing reduces the
// supplier's balance immediately, clearing creates the real cash_book
// expense, bouncing reverses the supplier payment.
// ---------------------------------------------------------------------------

const issueChequeInput = z.object({
  cheque_number: z.string().min(1),
  bank_name: z.string().min(1),
  amount: z.number().positive(),
  cheque_date: z.string(),
  supplier_id: z.number().int().positive(),
  purchase_id: z.number().int().positive().optional(),
  notes: z.string().optional(),
});

// GET /api/cheques/issued — every self-written cheque, newest first.
chequesRouter.get(
  "/issued",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT cheques_issued.*, suppliers.name as supplier_name
         FROM cheques_issued
         JOIN suppliers ON suppliers.id = cheques_issued.supplier_id
         ORDER BY cheques_issued.date_issued DESC`
      )
      .all();
    res.json(rows);
  })
);

// POST /api/cheques/issued — write a new cheque to a supplier directly.
chequesRouter.post(
  "/issued",
  asyncHandler(async (req, res) => {
    const data = issueChequeInput.parse(req.body);

    const supplier = db.prepare(`SELECT id FROM suppliers WHERE id = ?`).get(data.supplier_id);
    if (!supplier) throw new ApiError(400, "Referenced supplier does not exist");

    const runIssue = db.transaction(() => {
      const paymentResult = db
        .prepare(
          `INSERT INTO supplier_payments (supplier_id, purchase_id, amount, method, notes)
           VALUES (?, ?, ?, 'cheque', ?)`
        )
        .run(
          data.supplier_id,
          data.purchase_id ?? null,
          data.amount,
          `Cheque #${data.cheque_number} (${data.bank_name})${data.notes?.trim() ? ` — ${data.notes.trim()}` : ""}`
        );

      if (data.purchase_id) {
        const purchase = db.prepare(`SELECT * FROM purchases WHERE id = ?`).get(data.purchase_id) as any;
        if (purchase) {
          const newAmountPaid = purchase.amount_paid + data.amount;
          const newStatus = newAmountPaid >= purchase.total_cost ? "paid" : "partial";
          db.prepare(`UPDATE purchases SET amount_paid = ?, payment_status = ? WHERE id = ?`).run(
            newAmountPaid,
            newStatus,
            data.purchase_id
          );
        }
      }

      const issuedResult = db
        .prepare(
          `INSERT INTO cheques_issued (cheque_number, bank_name, amount, cheque_date, supplier_id, supplier_payment_id, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          data.cheque_number,
          data.bank_name,
          data.amount,
          data.cheque_date,
          data.supplier_id,
          paymentResult.lastInsertRowid,
          data.notes ?? null
        );

      return issuedResult.lastInsertRowid;
    });

    const issuedId = runIssue();
    const created = db
      .prepare(
        `SELECT cheques_issued.*, suppliers.name as supplier_name
         FROM cheques_issued JOIN suppliers ON suppliers.id = cheques_issued.supplier_id
         WHERE cheques_issued.id = ?`
      )
      .get(issuedId);
    res.status(201).json(created);
  })
);

const editIssuedInput = z.object({
  cheque_number: z.string().min(1).optional(),
  bank_name: z.string().min(1).optional(),
  cheque_date: z.string().optional(),
  amount: z.number().positive().optional(),
});

// PUT /api/cheques/issued/:id — fix a mistake on a self-written cheque.
// Only allowed while still pending — once cleared, this is blocked (see
// the locked design). Changing the amount also adjusts the linked
// supplier_payments row and, if tied to a specific purchase, that
// purchase's amount_paid — so the supplier's balance never drifts out
// of sync with what this cheque actually says.
chequesRouter.put(
  "/issued/:id",
  asyncHandler(async (req, res) => {
    const issued = db.prepare(`SELECT * FROM cheques_issued WHERE id = ?`).get(req.params.id) as any;
    if (!issued) throw new ApiError(404, "Cheque not found");
    if (issued.status !== "pending") {
      throw new ApiError(409, `This cheque is already ${issued.status} and can no longer be edited.`);
    }

    const data = editIssuedInput.parse(req.body);

    const runEdit = db.transaction(() => {
      if (data.amount != null && data.amount !== issued.amount && issued.supplier_payment_id) {
        const payment = db.prepare(`SELECT * FROM supplier_payments WHERE id = ?`).get(issued.supplier_payment_id) as any;
        if (payment) {
          db.prepare(`UPDATE supplier_payments SET amount = ? WHERE id = ?`).run(data.amount, issued.supplier_payment_id);
          if (payment.purchase_id) {
            const purchase = db.prepare(`SELECT * FROM purchases WHERE id = ?`).get(payment.purchase_id) as any;
            if (purchase) {
              const newAmountPaid = purchase.amount_paid - issued.amount + data.amount;
              const newStatus = newAmountPaid >= purchase.total_cost ? "paid" : newAmountPaid > 0 ? "partial" : "unpaid";
              db.prepare(`UPDATE purchases SET amount_paid = ?, payment_status = ? WHERE id = ?`).run(
                Math.max(0, newAmountPaid),
                newStatus,
                payment.purchase_id
              );
            }
          }
        }
      }

      db.prepare(
        `UPDATE cheques_issued SET cheque_number = ?, bank_name = ?, cheque_date = ?, amount = ? WHERE id = ?`
      ).run(
        data.cheque_number?.trim() ?? issued.cheque_number,
        data.bank_name?.trim() ?? issued.bank_name,
        data.cheque_date ?? issued.cheque_date,
        data.amount ?? issued.amount,
        req.params.id
      );
    });

    runEdit();
    const updated = db
      .prepare(
        `SELECT cheques_issued.*, suppliers.name as supplier_name
         FROM cheques_issued JOIN suppliers ON suppliers.id = cheques_issued.supplier_id
         WHERE cheques_issued.id = ?`
      )
      .get(req.params.id);
    res.json(updated);
  })
);

// DELETE /api/cheques/issued/:id — remove a self-written cheque entered
// by mistake. Only allowed while still pending — reverses the supplier
// payment (and purchase balance) it created, then deletes the row.
chequesRouter.delete(
  "/issued/:id",
  asyncHandler(async (req, res) => {
    const issued = db.prepare(`SELECT * FROM cheques_issued WHERE id = ?`).get(req.params.id) as any;
    if (!issued) throw new ApiError(404, "Cheque not found");
    if (issued.status !== "pending") {
      throw new ApiError(409, `This cheque is already ${issued.status} and can no longer be deleted.`);
    }

    const runDelete = db.transaction(() => {
      if (issued.supplier_payment_id) {
        db.prepare(`DELETE FROM supplier_payments WHERE id = ?`).run(issued.supplier_payment_id);
      }
      db.prepare(`DELETE FROM cheques_issued WHERE id = ?`).run(req.params.id);
    });

    runDelete();
    res.status(204).send();
  })
);

// PUT /api/cheques/issued/:id/clear — the cheque was honored. Creates
// the real cash_book expense now, since that's the moment the money
// actually left the business.
chequesRouter.put(
  "/issued/:id/clear",
  asyncHandler(async (req, res) => {
    const issued = db.prepare(`SELECT * FROM cheques_issued WHERE id = ?`).get(req.params.id) as any;
    if (!issued) throw new ApiError(404, "Cheque not found");
    if (issued.status !== "pending") throw new ApiError(409, `This cheque is already ${issued.status}`);

    const runClear = db.transaction(() => {
      db.prepare(`UPDATE cheques_issued SET status = 'cleared', cleared_at = datetime('now') WHERE id = ?`).run(req.params.id);
      db.prepare(
        `INSERT INTO cash_book (type, category, payment_method, reference_id, amount, notes)
         VALUES ('expense', 'supplier_payment', 'cheque', ?, ?, ?)`
      ).run(issued.supplier_payment_id, issued.amount, `Cheque #${issued.cheque_number} cleared — paid to supplier`);
    });

    runClear();
    const updated = db
      .prepare(
        `SELECT cheques_issued.*, suppliers.name as supplier_name
         FROM cheques_issued JOIN suppliers ON suppliers.id = cheques_issued.supplier_id
         WHERE cheques_issued.id = ?`
      )
      .get(req.params.id);
    res.json(updated);
  })
);

// PUT /api/cheques/issued/:id/bounce — the cheque was dishonored.
// Reverses the supplier payment it created, so their balance goes back
// up as still owed.
chequesRouter.put(
  "/issued/:id/bounce",
  asyncHandler(async (req, res) => {
    const issued = db.prepare(`SELECT * FROM cheques_issued WHERE id = ?`).get(req.params.id) as any;
    if (!issued) throw new ApiError(404, "Cheque not found");
    if (issued.status !== "pending") throw new ApiError(409, `This cheque is already ${issued.status}`);

    const data = bounceInput.parse(req.body);

    const runBounce = db.transaction(() => {
      if (issued.supplier_payment_id) {
        db.prepare(`DELETE FROM supplier_payments WHERE id = ?`).run(issued.supplier_payment_id);
      }
      db.prepare(
        `UPDATE cheques_issued SET status = 'bounced', bounced_at = datetime('now'), bounced_reason = ? WHERE id = ?`
      ).run(data.reason, req.params.id);
    });

    runBounce();
    const updated = db
      .prepare(
        `SELECT cheques_issued.*, suppliers.name as supplier_name
         FROM cheques_issued JOIN suppliers ON suppliers.id = cheques_issued.supplier_id
         WHERE cheques_issued.id = ?`
      )
      .get(req.params.id);
    res.json(updated);
  })
);

// GET /api/cheques/dashboard-reminders — cheques needing attention today
// or tomorrow, driven by cheque_date (the date WRITTEN on the cheque,
// not when it was received/issued — that's the date that's actually
// bankable). Covers both directions: customer cheques still in_hand
// (not yet deposited or passed on), and self-written cheques not yet
// cleared.
chequesRouter.get(
  "/dashboard-reminders",
  asyncHandler(async (_req, res) => {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const tomorrowStr = new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const inHand = db
      .prepare(
        `SELECT cheque_receipts.id, cheque_receipts.cheque_number, cheque_receipts.bank_name, cheque_receipts.amount,
                cheque_receipts.cheque_date, customers.name as customer_name
         FROM cheque_receipts
         JOIN customers ON customers.id = cheque_receipts.customer_id
         WHERE cheque_receipts.status = 'in_hand' AND date(cheque_receipts.cheque_date) IN (?, ?)
         ORDER BY cheque_receipts.cheque_date ASC`
      )
      .all(todayStr, tomorrowStr);

    const issued = db
      .prepare(
        `SELECT cheques_issued.id, cheques_issued.cheque_number, cheques_issued.bank_name, cheques_issued.amount,
                cheques_issued.cheque_date, suppliers.name as supplier_name
         FROM cheques_issued
         JOIN suppliers ON suppliers.id = cheques_issued.supplier_id
         WHERE cheques_issued.status = 'pending' AND date(cheques_issued.cheque_date) IN (?, ?)
         ORDER BY cheques_issued.cheque_date ASC`
      )
      .all(todayStr, tomorrowStr);

    res.json({ to_deposit: inHand, to_pay: issued });
  })
);
