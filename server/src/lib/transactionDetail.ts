import { db } from "../db/connection";

export interface TransactionEntry {
  id: number;
  entry_date: string;
  type: string;
  category: string;
  reference_id: number | null;
}

export interface TransactionParty {
  // "supplier" = money paid to them, "customer" = money received from them, "courier" = a settlement received from a courier.
  kind: "supplier" | "customer" | "courier";
  id: number | null;
  name: string;
  code: string | null;
}

// What a cash book entry was for — who the money went to or came from, and the purchase or invoice it was against — so a lookup of a
// transaction ID can say more than its note does. Everything the cash book points at (reference_id) is traced here; entries that point at
// nothing (a transfer between cash and bank, a plain note) just have no party. Also the running balance as it stood right after the
// entry (the cash book page's own order: by date, then entry).
export function transactionContext(entry: TransactionEntry): {
  party: TransactionParty | null;
  purchase: { id: number; purchase_code: string } | null;
  sale: { id: number; invoice: string } | null;
  balance_after: number;
} {
  let party: TransactionParty | null = null;
  let purchase: { id: number; purchase_code: string } | null = null;
  let sale: { id: number; invoice: string } | null = null;
  const ref = entry.reference_id;

  if (ref) {
    if (entry.category === "supplier_payment") {
      const r = db
        .prepare(
          `SELECT s.id AS supplier_id, s.name, s.supplier_code, pu.id AS purchase_id, pu.purchase_code
           FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id LEFT JOIN purchases pu ON pu.id = sp.purchase_id
           WHERE sp.id = ?`
        )
        .get(ref) as any;
      if (r) {
        party = { kind: "supplier", id: r.supplier_id, name: r.name, code: r.supplier_code };
        if (r.purchase_id) purchase = { id: r.purchase_id, purchase_code: r.purchase_code };
      }
    } else if (entry.category === "purchase" || entry.category === "purchase_other_costs") {
      const r = db
        .prepare(
          `SELECT pu.id AS purchase_id, pu.purchase_code, s.id AS supplier_id, s.name, s.supplier_code
           FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id WHERE pu.id = ?`
        )
        .get(ref) as any;
      if (r) {
        party = { kind: "supplier", id: r.supplier_id, name: r.name, code: r.supplier_code };
        purchase = { id: r.purchase_id, purchase_code: r.purchase_code };
      }
    } else if (entry.category === "sale" || entry.category === "sale_void") {
      const r = db
        .prepare(`SELECT s.id, s.invoice, c.id AS customer_id, c.name, c.customer_code FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`)
        .get(ref) as any;
      if (r) {
        sale = { id: r.id, invoice: r.invoice };
        if (r.customer_id) party = { kind: "customer", id: r.customer_id, name: r.name, code: r.customer_code };
      }
    } else if (entry.category === "customer_payment" || entry.category === "customer_credit") {
      const r = db.prepare(`SELECT id, name, customer_code FROM customers WHERE id = ?`).get(ref) as any;
      if (r) party = { kind: "customer", id: r.id, name: r.name, code: r.customer_code };
    } else if (entry.category === "courier_settlement") {
      const r = db
        .prepare(
          `SELECT cs.courier_partner, COALESCE(dp.name, cs.courier_partner) AS name
           FROM courier_settlements cs LEFT JOIN delivery_partners dp ON dp.code = cs.courier_partner WHERE cs.id = ?`
        )
        .get(ref) as any;
      if (r) party = { kind: "courier", id: null, name: r.name, code: r.courier_partner };
    } else if (entry.category === "return_refund") {
      const r = db
        .prepare(
          `SELECT s.id AS sale_id, s.invoice, c.id AS customer_id, c.name, c.customer_code
           FROM returns rt JOIN sale_items si ON si.id = rt.sale_item_id JOIN sales s ON s.id = si.sale_id LEFT JOIN customers c ON c.id = s.customer_id
           WHERE rt.id = ?`
        )
        .get(ref) as any;
      if (r) {
        sale = { id: r.sale_id, invoice: r.invoice };
        if (r.customer_id) party = { kind: "customer", id: r.customer_id, name: r.name, code: r.customer_code };
      }
    }
  }

  const balanceAfter = db
    .prepare(
      `SELECT COALESCE(SUM(CASE type WHEN 'income' THEN amount ELSE -amount END), 0) AS total
       FROM cash_book WHERE entry_date < ? OR (entry_date = ? AND id <= ?)`
    )
    .get(entry.entry_date, entry.entry_date, entry.id) as { total: number };

  return { party, purchase, sale, balance_after: Math.round(balanceAfter.total * 100) / 100 };
}
