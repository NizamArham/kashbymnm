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
  qty: number;
  created_at: string;
}

export interface CategoryLowStock {
  category: string;
  total_available: number;
  low_stock: boolean;
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

export interface Customer {
  id: number;
  customer_code: string;
  name: string;
  phone: string | null;
  phone2: string | null;
  loyalty_points: number;
  balance_due: number;
  last_order_date: string | null;
  created_at: string;
  addresses?: CustomerAddress[];
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
  sku?: string;
  size?: string | null;
  color?: string | null;
  barcode?: string | null;
  product_title?: string;
  brand?: string;
}

export interface Sale {
  id: number;
  invoice: string;
  customer_id: number | null;
  customer_name?: string;
  customer_code?: string;
  customer_phone?: string | null;
  salesperson: string | null;
  date: string;
  subtotal: number;
  discount: number;
  total: number;
  amount_paid: number;
  payment_status: PaymentStatus;
  payment_method: string | null;
  sale_type: SaleType;
  loyalty_points_earned: number;
  is_voided: number;
  voided_at: string | null;
  void_reason: string | null;
  items?: SaleItem[];
  delivery_address?: { address_line1: string | null; address_line2: string | null; city: string | null } | null;
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
  delivery_partner: "CPAK" | "D2D" | "DEX" | null;
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
  notes: string | null;
  invoice?: string;
  sale_date?: string;
  sale_total?: number;
  customer_name?: string;
  customer_phone?: string | null;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  items?: DeliveryItem[];
}

export interface CashBookEntry {
  id: number;
  entry_date: string;
  type: "income" | "expense";
  category: string;
  reference_id: number | null;
  amount: number;
  running_balance: number;
  notes: string | null;
}
