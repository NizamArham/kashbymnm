export type UserRole = "admin" | "staff";

export interface AuthUser {
  id: number;
  username: string;
  role: UserRole;
  name: string | null;
  // An admin working the till in a staff-level session (see Cashier mode in the sidebar).
  cashier_mode?: boolean;
}

// Full HR record — salary/bank fields are only ever populated by the
// backend when the requester is an admin; a staff member fetching their
// own profile gets these as undefined, not zeroed out (so the frontend
// can tell "not shown to you" apart from "genuinely blank").
export interface StaffMember {
  id: number;
  username: string;
  role: UserRole;
  name: string | null;
  job_title: string | null;
  joined_date: string | null;
  nic: string | null;
  phone: string | null;
  address: string | null;
  reports_to: number | null;
  reports_to_name?: string | null;
  created_at: string;
  salary?: number | null;
  bank_name?: string | null;
  bank_account_no?: string | null;
  bank_account_name?: string | null;
}

export type AttendanceStatus = "present" | "absent" | "half_day" | "leave";

export interface AttendanceRecord {
  id: number;
  user_id: number;
  attendance_date: string;
  status: AttendanceStatus;
  marked_at: string;
  marked_by: number | null;
  notes: string | null;
}

export interface DailyAttendanceRow {
  user_id: number;
  name: string | null;
  job_title: string | null;
  attendance_id: number | null;
  status: AttendanceStatus | null;
  marked_at: string | null;
  notes: string | null;
}

export interface LoginActivityEntry {
  id: number;
  user_id: number;
  login_at: string;
  logout_at: string | null;
}

export interface LoyaltyTransaction {
  id: number;
  customer_id: number;
  points: number;
  reason: "sale" | "bonus_grant" | "manual_adjustment" | "redemption";
  reference_id: number | null;
  notes: string | null;
  created_at: string;
}

export interface Supplier {
  id: number;
  supplier_code: string;
  name: string;
  phone: string | null;
  city: string | null;
  notes: string | null;
  balance_owed: number;
  credit_balance: number;
  bank_accounts?: BankAccount[];
  // Only on the single-supplier fetch (the profile page's figures).
  purchase_count?: number;
  total_purchased?: number;
  last_purchase_date?: string | null;
  last_payment_date?: string | null;
  pending_sort_count?: number;
  product_count?: number;
  // Cheques written to them that haven't cleared yet.
  pending_cheque_count?: number;
  pending_cheque_total?: number;
}

export interface Product {
  id: number;
  product_title: string;
  brand: string | null;
  category: string | null;
  cost_price?: number; // absent for staff
  selling_price: number;
  supplier_id: number | null;
  supplier_name?: string;
  supplier_code?: string;
  image_path: string | null;
  is_public: number;
  allow_returns: number;
  product_type: "FO" | "OG" | "OR" | "OP" | "IM";
  qty: number;
  created_at: string;
}

export interface CategoryLowStock {
  category: string;
  total_available: number;
  low_stock: boolean;
}

export interface SubCategory {
  id: number;
  name: string;
}

export interface Category {
  id: number;
  name: string;
  sub_categories: SubCategory[];
}

export type InventoryStatus = "available" | "sold" | "damaged" | "gifted" | "stolen" | "lost" | "removed";

export type RemovalReason = "Damaged" | "Gifted" | "Staff Use" | "Stolen" | "Lost" | "Other";

export interface InventoryUnit {
  id: number;
  product_id: number;
  size: string | null;
  color: string | null;
  sku: string;
  barcode: string | null;
  cost_price?: number | null;
  selling_price?: number | null;
  purchase_item_id?: number | null;
  batch_supplier_id?: number | null;
  batch_supplier_name?: string | null;
  batch_supplier_code?: string | null;
  status: InventoryStatus;
  removal_reason?: RemovalReason | null;
  removal_note?: string | null;
  created_at: string;
  // 1 while the piece is being held for a payment request (set on stock lists; ?sellable=1 leaves held pieces out).
  is_held?: number;
  product_title?: string;
  brand?: string;
  product_selling_price?: number;
  category?: string | null;
}

export interface CustomerAddress {
  id: number;
  customer_id: number;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  is_default: number;
}

export interface BankAccount {
  id: number;
  bank_name: string;
  account_name: string;
  account_number: string;
  branch: string | null;
  is_default: number;
}

export type CustomerGender = "male" | "female" | "unspecified";

export interface Customer {
  id: number;
  customer_code: string;
  name: string;
  phone: string | null;
  phone2: string | null;
  gender: CustomerGender;
  loyalty_points: number;
  // A customer who never earns points (a wholesale buyer) — new sales for
  // them earn none; set by an admin, always with a reason.
  loyalty_blocked?: number;
  loyalty_block_reason?: string | null;
  balance_due: number;
  // COD the courier delivered and collected but hasn't paid over yet — not owed by the customer.
  with_courier?: number;
  // COD on orders still on their way — collected at the door, not owed on account.
  on_delivery?: number;
  store_credit_balance: number;
  last_order_date: string | null;
  // Only on a cashier's search results: true when what was typed is this customer's full name, number or
  // code (their phone then shows in full — otherwise just its last three digits).
  exact_match?: boolean;
  is_suspended: number;
  suspended_reason: string | null;
  suspended_at: string | null;
  reactivated_reason: string | null;
  reactivated_at: string | null;
  created_at: string;
  addresses?: CustomerAddress[];
  bank_accounts?: BankAccount[];
}

export type SaleType = "in_store" | "online";
export type PaymentStatus = "paid" | "partial" | "unpaid";

export interface SaleItem {
  id: number;
  sale_id: number;
  inventory_id: number;
  quantity: number;
  unit_price: number;
  line_total: number;
  original_selling_price?: number;
  is_returned?: number;
  allow_returns?: number;
  sku?: string;
  size?: string | null;
  color?: string | null;
  barcode?: string | null;
  product_id?: number | null;
  product_title?: string;
  brand?: string;
}

// An online exchange: this order replaces an item the customer already has from a
// delivered order, and the courier collects the old item with the delivery.
export interface SaleExchangeItem {
  id: number;
  old_sale_item_id: number;
  old_invoice: string;
  title: string | null;
  size: string | null;
  color: string | null;
  // This item's value, and the part of it that comes off the replacement order.
  credit_amount: number;
  applied_share: number;
  status: "awaiting" | "received" | "not_returned" | "cancelled";
  item_condition: "clean" | "damaged" | null;
}

export interface SaleExchange {
  id: number;
  new_sale_id: number;
  // The old items being collected (an exchange can cover several, and the
  // replacement order can hold more pieces than were returned).
  items: SaleExchangeItem[];
  // All the old items' value together, and how much of it comes off the replacement's total.
  credit_amount: number;
  applied_amount: number;
  // The charge for bringing the old items back, the share the customer pays (0 / 50 / 100) and what that was.
  pickup_charge: number;
  customer_share_pct: number;
  pickup_collected: number;
  // Set when the old items come back separately, by another service, instead of with the delivery of the new order.
  return_service?: string | null;
  status: "awaiting_pickup" | "received" | "not_returned" | "cancelled";
  item_condition: "clean" | "damaged" | null;
  note: string | null;
  closed_at: string | null;
}

// A quotation for an exchange by delivery: what was quoted and what the customer has to pay to confirm it.
export interface ExchangeQuote {
  old_sale_item_ids: number[];
  delivery_partner: string;
  partner_name: string;
  package_weight_kg: number;
  is_free_delivery: boolean;
  pickup_charge: number;
  customer_share_pct: number;
  return_service?: string | null;
  old_items: {
    sale_item_id: number;
    unit_price: number;
    old_invoice: string;
    title: string | null;
    size: string | null;
    color: string | null;
    // 0 = a no-returns (final sale) product
    allow_returns?: number;
  }[];
  credit_amount: number;
  applied_amount: number;
  delivery_fee: number;
  pickup_collected: number;
  amount_to_pay: number;
}

// An exchange as listed with the items on their way back: the exchange itself, plus its replacement order, customer and whether
// that replacement has been delivered yet.
export interface ExchangeOnTheWay extends SaleExchange {
  new_invoice: string;
  customer_name: string | null;
  delivery_status: string | null;
  partner_name: string | null;
  created_at: string;
}

// A return by courier: items of a delivered online order the courier is to collect, with the courier's pickup charge and who pays it.
export interface ReturnPickupItem {
  id: number;
  sale_item_id: number;
  title: string | null;
  size: string | null;
  color: string | null;
  sku: string | null;
  amount: number;
  allow_returns: number;
  status: "awaiting" | "received" | "not_returned" | "cancelled";
  item_condition: "clean" | "damaged" | null;
  refund_amount: number | null;
  deduction: number;
  // The quick look when the parcel was opened (ok = good, damaged = bad, with an optional reason), and the inspection's verdict on the item.
  arrival_condition: "ok" | "damaged" | "missing" | null;
  arrival_note: string | null;
  arrival_at: string | null;
  verdict: "clean" | "damaged" | "missing_parts" | "not_per_policy" | "not_received" | null;
}

// Where a courier return is: asked for, approved (the customer may send it), on its way, on hand, report waiting for an admin, refund owed,
// done. Declined / cancelled end it early.
export type ReturnStage = "requested" | "approved" | "on_the_way" | "received" | "report_pending" | "refund_due" | "completed" | "declined" | "cancelled" | "rejected";

export interface ReturnPickup {
  id: number;
  sale_id: number;
  invoice: string;
  customer_id: number | null;
  customer_name: string | null;
  delivery_partner: string;
  // The service that carried it — null until the customer or the shop says which.
  partner_name: string | null;
  package_weight_kg: number | null;
  // What we paid for the return parcel (0 until the parcel is marked received, and often 0 after).
  pickup_charge: number;
  customer_share_pct: number;
  customer_share: number;
  // How much of the customer's share has been held back from what they were paid so far.
  share_used: number;
  resolution: "refund" | "store_credit";
  reason: string;
  tracking_number: string | null;
  status: "awaiting_pickup" | "received" | "not_returned" | "cancelled";
  // A courier return is a request first: 'pending' until an admin says yes (an admin's own is approved on the spot — auto_approved).
  approval_status: ApprovalState;
  auto_approved: number;
  approved_by_name: string | null;
  approved_at: string | null;
  // Why it was declined — or the override reason for a no-returns item that was approved anyway.
  decision_reason: string | null;
  stage: ReturnStage;
  sent_at: string | null;
  sent_without_tracking: number;
  received_at: string | null;
  received_by_name: string | null;
  // The inspection report: none → pending (waiting for an admin) → approved, or sent_back for another look.
  report_status: "none" | "pending" | "approved" | "sent_back" | "rejected";
  report_note: string | null;
  report_by_name: string | null;
  report_at: string | null;
  report_decided_by_name: string | null;
  report_decision_reason: string | null;
  report_auto_approved: number;
  // What the inspection proposed to pay the customer back in total (null = everything the items come to, less the delivery share).
  report_proposed: number | null;
  // What is owed to the customer once the report is approved, and how / when it was paid.
  refund_due: number;
  refund_method: "cash" | "bank_transfer" | null;
  refund_account_label: string | null;
  refunded_at: string | null;
  refunded_by_name: string | null;
  created_at: string;
  closed_at: string | null;
  requested_by_name: string | null;
  items: ReturnPickupItem[];
}

// Where a request stands with the admin. null/absent on a record that needs no approval (or predates approvals) — treat as approved.
export type ApprovalState = "pending" | "approved" | "declined";

// Everything waiting for an admin's yes, whichever way it came (Returns → To approve).
export interface ReturnApprovals {
  in_store: ReturnRequest[];
  // Courier return requests waiting for a yes, and inspection reports of courier returns that have arrived.
  courier: ReturnPickup[];
  courier_reports: ReturnPickup[];
  exchanges: (Sale & {
    customer_phone?: string | null;
    new_items: { unit_price: number; title: string | null; size: string | null; color: string | null }[];
  })[];
}

// An exchange that took items out of an invoice — shown on that (old) invoice.
export interface SaleExchangeOut {
  exchange_id: number;
  new_sale_id: number;
  new_invoice: string;
  status: SaleExchange["status"];
  items: {
    id: number;
    old_sale_item_id: number;
    status: SaleExchangeItem["status"];
    item_condition: "clean" | "damaged" | null;
    credit_amount: number;
    title: string | null;
    size: string | null;
    color: string | null;
  }[];
}

export interface SalePaymentEntry {
  id: number;
  entry_date: string;
  type: "income" | "expense";
  amount: number;
  payment_method: string | null;
  notes: string | null;
  transaction_code: string | null;
}

export interface Sale {
  id: number;
  invoice: string;
  customer_id: number | null;
  customer_name?: string;
  customer_code?: string;
  customer_phone?: string | null;
  deleted_customer_snapshot?: string | null;
  salesperson: string | null;
  date: string;
  subtotal: number;
  discount: number;
  manual_discount: number;
  coupon_discount: number;
  coupon_code: string | null;
  total: number;
  amount_paid: number;
  payment_status: PaymentStatus;
  payment_method: string | null;
  sale_type: SaleType;
  loyalty_points_earned: number;
  // A wholesale order earns no loyalty points.
  is_wholesale?: number;
  amount_received: number | null;
  change_due: number;
  overpaid_amount: number;
  is_voided: number;
  voided_at: string | null;
  void_reason: string | null;
  // A quotation is a row in this same table, saved before any money
  // changed hands — see server/src/routes/sales.ts. "completed" is a
  // real sale; "quotation" hasn't touched stock, cash book, or loyalty
  // yet, and amount_paid/payment_status are left at 0/"unpaid" until
  // it's converted.
  status: "quotation" | "completed";
  quotation_valid_until: string | null;
  // Part of amount_paid that was settled with store credit rather than
  // cash/card — only on the single-sale GET, not the list.
  store_credit_applied?: number;
  // Which credit that was, e.g. "Return on invoice STR261X0240".
  store_credit_sources?: { amount: number; label: string }[];
  items?: SaleItem[];
  delivery_address?: { address_line1: string | null; address_line2: string | null; city: string | null } | null;
  delivery_partner?: string | null;
  // From the partner's own record, so a bill can print the real name
  // without having the partner list loaded.
  delivery_partner_name?: string | null;
  delivery_partner_waybill_code?: string | null;
  delivery_partner_kind?: "courier" | "on_demand" | null;
  // The courier's own waybill / tracking number, once there is one (for an
  // on-demand app it's just the invoice number again).
  delivery_tracking_number?: string | null;
  // What the customer is charged for delivery on this order, and how.
  delivery_fee?: number | null;
  delivery_is_free?: number | null;
  delivery_paid_by?: "customer" | "shop" | null;
  // Set when the customer pays the rider directly, so there's no fare to charge.
  delivery_rider_direct?: number | null;
  // The on-demand fare, when known — null/absent while the order is on hold waiting for it.
  delivery_actual_fare?: number | null;
  delivery_cod_amount?: number | null;
  // How much of that delivery fee was already paid at checkout.
  delivery_fee_paid?: number | null;
  // For an exchange paid up front: the part of the customer's pickup-charge share that was.
  delivery_pickup_prepaid?: number | null;
  delivery_status?: DeliveryStatus | null;
  // When each stage of the delivery happened (single-sale GET only).
  delivery_waybill_number?: string | null;
  delivery_packed_at?: string | null;
  delivery_dispatched_at?: string | null;
  delivery_delivered_at?: string | null;
  // The cash book's entries against this bill (single-sale GET only).
  payments?: SalePaymentEntry[];
  exchange?: SaleExchange | null;
  // On a quotation for an exchange by delivery (set on the quotation's own page / on lists).
  exchange_draft?: string | null;
  exchange_quote?: ExchangeQuote | null;
  // For a payment request: when the hold on its pieces ends (null/absent when it holds none).
  hold_until?: string | null;
  // On a delivery exchange request: waiting for an admin's yes ('pending'), approved (the order can be made), or declined. An admin's own is
  // auto-approved ("recorded by admin"). null on anything else.
  approval_status?: ApprovalState | null;
  auto_approved?: number | null;
  approved_at?: string | null;
  decision_reason?: string | null;
  // How this invoice figures in an exchange (set on sales lists and searches):
  // its own items are being / were swapped (out), or it is the replacement order (in).
  exchange_out_status?: "awaiting" | "received" | "not_returned" | null;
  exchange_out_invoice?: string | null;
  exchange_out_sale_id?: number | null;
  exchange_in_status?: SaleExchange["status"] | null;
  exchange_in_from?: string | null;
  // On one invoice's own page: the exchanges that took items out of it.
  exchanged_out?: SaleExchangeOut[];
  // The returns by delivery recorded for this invoice's items.
  return_pickups?: ReturnPickup[];
}

export interface Coupon {
  id: number;
  code: string;
  discount_type: "percent" | "fixed";
  discount_value: number;
  is_active: number;
  expires_at: string | null;
  created_at: string;
}

export interface GiftVoucher {
  id: number;
  code: string;
  initial_value: number;
  remaining_value: number;
  validity_days: number;
  activated_at: string | null;
  expires_at: string | null;
  is_enabled: number;
  notes: string | null;
  created_at: string;
}

export interface ReturnRecord {
  id: number;
  sale_item_id: number;
  condition: "clean" | "damaged";
  resolution: "refund" | "exchange";
  refund_amount: number;
  exchange_inventory_id: number | null;
  reason: string | null;
  return_date: string;
  sale_id?: number;
  unit_price?: number;
  invoice?: string;
  sku?: string;
  product_title?: string;
}

export interface ReturnRequest {
  id: number;
  sale_item_id: number;
  quantity: number;
  condition: "clean" | "damaged";
  resolution: "refund" | "exchange" | "store_credit_exchange";
  exchange_inventory_id: number | null;
  credit_expiry_days: number | null;
  reason: string;
  status: "pending" | "approved" | "declined";
  requested_by: number | null;
  requested_by_name: string | null;
  requested_at: string;
  decided_by: number | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  is_admin_override: number;
  // 1 = an admin recorded it themselves, so it was approved on the spot.
  auto_approved?: number;
  return_id: number | null;
  // Joined fields for display
  sale_id: number;
  unit_price: number;
  deleted_customer_snapshot?: string | null;
  item_quantity: number;
  invoice: string;
  customer_id: number | null;
  customer_name: string | null;
  sku: string;
  color?: string | null;
  size?: string | null;
  product_title: string;
  product_id: number | null;
  allow_returns: number;
  refund_amount?: number | null;
  // 1 once a refund for this return has actually been paid (it is in the cash book) — only then is there a payment slip to print.
  refund_paid?: number;
}

export type DeliveryStatus = "pending" | "packed" | "dispatched" | "delivered" | "returned" | "cancelled";

export interface DeliveryItem {
  id: number;
  quantity: number;
  unit_price: number;
  line_total: number;
  product_title?: string;
  brand?: string;
  sku?: string;
  size?: string | null;
  color?: string | null;
}

// A dispatched parcel the courier couldn't deliver, on its way back to the shop.
export interface ParcelComingBack {
  id: number;
  sale_id: number;
  invoice: string;
  customer_name: string | null;
  partner_name: string | null;
  waybill_number: string | null;
  tracking_number: string | null;
  cod_amount: number;
  sale_total: number;
  coming_back_at: string;
  items: { title: string | null; size: string | null; color: string | null; unit_price: number }[];
  exchange?: SaleExchange | null;
}

export interface Delivery {
  id: number;
  sale_id: number;
  // Set when the courier couldn't deliver this dispatched parcel and it is on its way back.
  coming_back_at?: string | null;
  address_id: number | null;
  courier_name: string | null;
  tracking_number: string | null;
  delivery_partner: string | null;
  citypak_order_id: number | null;
  package_weight_kg: number | null;
  address_confirmed: number;
  address_confirmed_at: string | null;
  is_free_delivery: number;
  cod_amount: number;
  delivery_status: DeliveryStatus;
  waybill_number: string | null;
  packed_at: string | null;
  dispatched_at: string | null;
  delivery_date: string | null;
  delivery_fee: number;
  // On-demand partners only (Uber, PickMe Flash...): who bears the fare,
  // and what the ride actually costs (kept even when we pay it and the
  // customer's delivery_fee is 0).
  delivery_paid_by?: "customer" | "shop" | null;
  // 1 when the customer pays the rider themselves — there is no fare to record.
  rider_direct?: number | null;
  // null for an on-demand order that is on hold, waiting for its fare to be entered.
  actual_fare?: number | null;
  // The courier's own latest status wording and when they reported it —
  // shown as-is next to our delivery_status.
  courier_status?: string | null;
  courier_status_at?: string | null;
  notes: string | null;
  // Set when this delivery is also collecting an old item (an online exchange).
  exchange?: SaleExchange | null;
  invoice?: string;
  sale_date?: string;
  sale_total?: number;
  customer_id?: number | null;
  customer_name?: string;
  customer_phone?: string | null;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  items?: DeliveryItem[];
}

export interface CashBookEntry {
  id: number;
  transaction_code: string | null;
  entry_date: string;
  type: "income" | "expense";
  category: string;
  payment_method: string | null;
  reference_id: number | null;
  amount: number;
  running_balance: number;
  notes: string | null;
}

export interface AuditLogEntry {
  id: number;
  staff_id: number | null;
  staff_name: string;
  action: string;
  entity_type: string;
  entity_id: number | null;
  description: string;
  created_at: string;
}

export interface SupplierPayment {
  id: number;
  supplier_id: number;
  supplier_name: string;
  purchase_id: number | null;
  amount: number;
  method: string | null;
  is_partial: number;
  notes: string | null;
  payment_date: string;
}

export interface SupplierBalance {
  id: number;
  supplier_code: string;
  name: string;
  total_purchased: number;
  total_paid: number;
  balance_owed: number;
}

// Traced back from a supplier_payments row of method "cheque" — either the
// shop's own cheque written straight to the supplier ("issued"), or a
// customer's cheque the shop received and later handed on to the supplier
// instead of depositing it ("transferred", carrying the customer it came
// from too).
export interface ChequeInfo {
  source: "issued" | "transferred";
  cheque_number: string;
  bank_name: string;
  amount: number;
  cheque_date: string;
  // When we gave an issued cheque to the supplier (not the date written on it).
  date_issued?: string;
  status: string;
  date_received?: string;
  from_customer_name?: string;
  from_customer_code?: string;
  transfer_date?: string;
  branch: string | null;
  is_crossed: number;
  // Who the cheque was actually made out to, exactly as written. Null
  // means it was made out to "Cash".
  payee_name: string | null;
  // When the bank cleared or bounced it; null while it is still pending.
  settled_at?: string | null;
}

export interface BusinessInfo {
  id: number;
  business_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  bank_name: string | null;
  bank_account_no: string | null;
  bank_account_name: string | null;
  notes: string | null;
}

export interface PendingPurchaseLine {
  id: number;
  purchase_id: number;
  description: string;
  quantity: number;
  unit_cost: number;
  is_fulfilled: number;
  fulfilled_purchase_item_id: number | null;
}

export interface PendingPurchaseLine {
  id: number;
  purchase_id: number;
  description: string;
  quantity: number;
  unit_cost: number;
  fulfilled_quantity: number;
  is_fulfilled: number;
  fulfilled_purchase_item_id: number | null;
  product_type: "FO" | "OG" | "OR" | "OP" | "IM";
}

export interface PurchaseExpense {
  id: number;
  purchase_id: number;
  label: string;
  amount: number;
  created_at: string;
}

export interface PurchaseReturnItem {
  id: number;
  purchase_return_id: number;
  pending_line_id: number | null;
  inventory_id: number | null;
  quantity: number;
  unit_cost: number;
}

export interface PurchaseReturn {
  id: number;
  purchase_id: number;
  supplier_id: number;
  supplier_name: string;
  purchase_code: string;
  total_amount: number;
  reason: string;
  resolution: "cash_refund" | "supplier_credit";
  notes: string | null;
  created_at: string;
  items: PurchaseReturnItem[];
}

export interface AvailableUnit {
  id: number;
  sku: string;
  barcode: string | null;
  size: string | null;
  color: string | null;
  cost_price: number | null;
  product_id: number;
  product_title: string;
}

export interface Purchase {
  id: number;
  purchase_code: string;
  supplier_id: number;
  supplier_name: string;
  purchase_date: string;
  total_cost: number;
  amount_paid: number;
  payment_status: "paid" | "partial" | "unpaid";
  fulfillment_status: "pending" | "fulfilled";
  description: string | null;
  lines?: PendingPurchaseLine[];
  expenses?: PurchaseExpense[];
}

export interface CourierReconciliationOrder {
  id: number;
  delivery_id: number;
  courier_partner: string;
  cod_amount: number;
  courier_charge: number;
  // Return-trip fee — only nonzero once the order was actually dispatched
  // (the courier had it) and then came back.
  return_charge: number;
  notes: string | null;
  // The charge starts as the tariff's ESTIMATE; 1 once someone has checked it
  // against the courier's real bill (or typed the real figure in).
  charge_confirmed: number;
  // The system's original estimate, kept for comparison after the real charge is entered.
  estimated_charge: number | null;
  // The weight the courier actually billed on, if it differed from what was entered at dispatch.
  actual_weight_kg: number | null;
  // The weight entered at dispatch.
  package_weight_kg: number | null;
  // What the courier's tariff says for the weight on record.
  tariff_charge: number;
  created_at: string;
  updated_at: string;
  delivery_status: DeliveryStatus;
  tracking_number: string | null;
  waybill_number: string | null;
  sale_id: number;
  invoice: string;
  sale_date: string;
  customer_name: string | null;
}

// One courier's figures. balance = expected_net − settled_total + adjustments_total:
// positive = they owe the shop, negative = the shop owes them.
export interface CourierSummary {
  courier_partner: string;
  cod_collected: number;
  courier_charges: number;
  expected_net: number;
  delivered_orders: number;
  // Delivered/returned orders whose charge is still an estimate.
  estimated_orders: number;
  settled_total: number;
  adjustments_total: number;
  balance: number;
}

// A recorded correction to a courier's balance, with the reason. No money moves.
export interface CourierAdjustment {
  id: number;
  courier_partner: string;
  amount: number;
  reason: string;
  balance_before: number;
  balance_after: number;
  staff_name: string | null;
  created_at: string;
}

export interface CourierReconciliationData {
  summary: CourierSummary[];
  settlements: CourierSettlement[];
  adjustments: CourierAdjustment[];
  orders: CourierReconciliationOrder[];
}

export interface CourierSettlement {
  id: number;
  courier_partner: string;
  week_start: string;
  week_end: string;
  amount_received: number;
  received_date: string;
  notes: string | null;
}

// A settlement plus how it was received, as listed on the Payment records page.
export interface CourierSettlementRecord extends CourierSettlement {
  payment_method: string | null;
  transaction_code: string | null;
}

export interface CourierPaymentRecords {
  settlements: CourierSettlementRecord[];
  adjustments: CourierAdjustment[];
}
