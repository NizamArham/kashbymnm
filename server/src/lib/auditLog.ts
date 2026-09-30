import { db } from "../db/connection";
import { AuthUser } from "./auth";

// Every action worth auditing is tagged with one of these — keeps the
// action column a closed set instead of free-form strings that drift
// out of sync with what the Audit Log page knows how to label.
export type AuditAction =
  | "product_delete"
  | "customer_delete"
  | "customer_suspend"
  | "customer_reactivate"
  | "supplier_delete"
  | "staff_edit"
  | "staff_role_change"
  | "staff_password_reset"
  | "staff_delete"
  | "sale_void"
  | "return_approve"
  | "return_decline"
  | "purchase_delete"
  | "cash_book_delete"
  | "cash_book_correction"
  | "cheque_bounce"
  | "cheque_delete"
  | "inventory_remove"
  | "coupon_create"
  | "coupon_edit"
  | "coupon_delete"
  | "gift_voucher_create"
  | "gift_voucher_edit"
  | "gift_voucher_delete";

export function logAudit(
  actor: AuthUser,
  action: AuditAction,
  entityType: string,
  entityId: number | null,
  description: string
) {
  db.prepare(
    `INSERT INTO audit_log (staff_id, staff_name, action, entity_type, entity_id, description)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(actor.id, actor.name ?? actor.username, action, entityType, entityId, description);
}
