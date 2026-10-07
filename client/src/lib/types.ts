export type UserRole = "admin" | "staff";

export interface AuthUser {
  id: number;
  username: string;
  role: UserRole;
  name: string | null;
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
  // The courier's pickup charge, the share the customer pays (0 / 50 / 100) and what that was.
  pickup_charge: number;
  customer_share_pct: number;
  pickup_collected: number;
  status: "awaiting_pickup" | "received" | "not_returned" | "cancelled";
  item_condition: "clean" | "damaged" | null;
  note: string | null;
  closed_at: string | null;
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
  delivery_status?: DeliveryStatus | null;
  exchange?: SaleExchange | null;
  // How this invoice figures in an exchange (set on sales lists and searches):
  // its own items are being / were swapped (out), or it is the replacement order (in).
  exchange_out_status?: "awaiting" | "received" | "not_returned" | null;
  exchange_out_invoice?: string | null;
  exchange_out_sale_id?: number | null;
  exchange_in_status?: SaleExchange["status"] | null;
  exchange_in_from?: string | null;
  // On one invoice's own page: the exchanges that took items out of it.
  exchanged_out?: SaleExchangeOut[];
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

export interface Delivery {
  id: number;
  sale_id: number;
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
