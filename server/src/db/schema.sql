-- M&M Clothing — Database Schema (SQLite)
-- Matches SCHEMA_DESIGN.md v2. Single branch, no inventory ledger,
-- products/inventory split, customer_addresses, inventory_id on sale_items.

PRAGMA foreign_keys = ON;

-- 0. users --------------------------------------------------------------
-- Simple local auth: username + hashed password + role.
-- role determines what the frontend shows AND what the backend allows —
-- enforced in middleware, not just hidden in the UI. job_title is a
-- separate HR label (Cashier, Sales Assistant, etc.) that has no effect
-- on permissions — role alone still governs access.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')),
  name TEXT,
  job_title TEXT,
  joined_date TEXT,
  nic TEXT,
  phone TEXT,
  address TEXT,
  -- Salary and bank details are admin-only to view/edit — staff can see
  -- their own basic details (job title, contact info, joined date,
  -- who they report to) but never their own salary/bank fields through
  -- the API; only an admin can view or change these.
  salary REAL,
  bank_name TEXT,
  bank_account_no TEXT,
  bank_account_name TEXT,
  -- Self-referencing: who this person reports to, for a simple org chart.
  reports_to INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 0a. login_activity ------------------------------------------------------
-- One row per login, with logout_at filled in when they log out (or left
-- null if the session just expired/was never explicitly closed). This is
-- what a staff member's "activity log" on their profile is built from.
CREATE TABLE IF NOT EXISTS login_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  login_at TEXT NOT NULL DEFAULT (datetime('now')),
  logout_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_login_activity_user ON login_activity(user_id);

-- 0b. attendance ------------------------------------------------------------
-- One row per staff member per day. Marked from a dedicated Attendance
-- tab (pick the name, mark present, timestamp saved) rather than
-- inferred from login times, since a staff member might be present
-- without using the system at all that day.
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  attendance_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present','absent','half_day','leave')),
  marked_at TEXT NOT NULL DEFAULT (datetime('now')),
  marked_by INTEGER REFERENCES users(id),
  notes TEXT,
  UNIQUE(user_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_user ON attendance(user_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(attendance_date);

-- 1. business_info -----------------------------------------------------
CREATE TABLE IF NOT EXISTS business_info (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  phone TEXT,
  email TEXT,
  bank_name TEXT,
  bank_account_no TEXT,
  bank_account_name TEXT,
  notes TEXT
);

-- 2. customers -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  phone2 TEXT,
  -- Manually-granted reward points (e.g. a legacy-customer bonus on
  -- import), separate from points earned through actual sales. A
  -- customer's total displayed loyalty_points is this PLUS the live sum
  -- of loyalty_points_earned across their sales.
  bonus_points INTEGER NOT NULL DEFAULT 0,
  -- A suspended customer stays fully in the system — every real record
  -- (sales, loyalty, credit) is untouched — they just can't be selected
  -- for a new sale until reactivated. Admin-only action either way, and
  -- always requires a reason, so there's a genuine record of why.
  is_suspended INTEGER NOT NULL DEFAULT 0 CHECK (is_suspended IN (0,1)),
  suspended_reason TEXT,
  suspended_at TEXT,
  reactivated_reason TEXT,
  reactivated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2a. loyalty_transactions -------------------------------------------------
-- A real ledger of every point change — earned from a sale, manually
-- granted (e.g. the legacy-customer bonus), or adjusted for any other
-- reason — rather than just a computed sum with no history. A
-- customer's current point balance is bonus_points + the sum of all
-- their loyalty_transactions.points, but this table is what actually
-- lets you answer "when did they earn these" or "why was this granted."
CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  points INTEGER NOT NULL, -- positive = earned/granted, negative = redeemed/adjusted down
  reason TEXT NOT NULL CHECK (reason IN ('sale','bonus_grant','manual_adjustment','redemption')),
  reference_id INTEGER, -- e.g. the sale id, when reason = 'sale'
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_customer ON loyalty_transactions(customer_id);

-- 2b. store_credit_transactions ----------------------------------------------
-- A running store-credit ledger, same shape as loyalty_transactions: an
-- overpaid online order grants a positive entry; applying it toward a
-- future sale spends it back down with a negative entry. A customer's
-- current store credit balance is the sum of their entries here — never
-- a raw mutable number, so there's always a real trail of where credit
-- came from and where it went.
CREATE TABLE IF NOT EXISTS store_credit_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount REAL NOT NULL, -- positive = granted (overpayment/return), negative = redeemed against a sale
  reason TEXT NOT NULL CHECK (reason IN ('overpayment','redemption','manual_adjustment','return_exchange')),
  reference_id INTEGER, -- the sale id (or return id, for return_exchange grants) that generated or redeemed this entry
  notes TEXT,
  -- NULL = never expires (overpayment, manual_adjustment — the existing,
  -- unchanged behavior). Set only on 'return_exchange' grants, chosen at
  -- the moment the return is processed (default 45 days; a longer
  -- window is a deliberate exception, not an equal alternative). A
  -- redemption row consuming this credit has no expiry of its own — it's
  -- just a negative entry, the expiry only matters on the grant.
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_store_credit_transactions_customer ON store_credit_transactions(customer_id);

-- 2a-ii. cheque_receipts -----------------------------------------------------
-- A cheque is a single physical instrument, not a payment method like cash
-- or bank transfer — it has a real lifecycle (received, possibly handed on
-- to a supplier, eventually cleared or bounced) and doesn't touch real cash
-- until clearance. This table is the receipt side: the moment a cheque
-- comes IN from a customer. If it's later handed to a supplier instead of
-- being deposited directly, that's a separate, linked cheque_transfers row
-- — deliberately two records, not one that mutates, so the full history
-- ("received from X, given to Y") is always visible without reconstructing
-- it from a change log.
--
-- Status meanings:
--   in_hand         — received, still physically with the business
--   given_to_supplier — handed on as payment (see cheque_transfers)
--   deposited       — sent to the bank directly, awaiting clearance
--   cleared         — the cheque was honored; the real cash_book entry
--                     (income, since this is money coming in) is created
--                     at this point, not before
--   bounced         — dishonored; whatever it had settled is reversed —
--                     the originating customer's sales go back to unpaid,
--                     AND if it had already been passed to a supplier,
--                     that supplier's balance is reinstated too (one
--                     bounce, both sides affected)
CREATE TABLE IF NOT EXISTS cheque_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cheque_number TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  amount REAL NOT NULL,
  cheque_date TEXT NOT NULL, -- the date written on the cheque itself
  date_received TEXT NOT NULL DEFAULT (datetime('now')),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  -- The exact FIFO sale allocations this cheque settled, as JSON
  -- (same shape computeFifoAllocation returns) — needed so a bounce can
  -- reverse precisely those sales back to their prior state, not just
  -- "the customer's balance in general."
  sale_allocations TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_hand' CHECK (status IN ('in_hand','given_to_supplier','deposited','cleared','bounced')),
  cleared_at TEXT,
  bounced_at TEXT,
  bounced_reason TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_cheque_receipts_customer ON cheque_receipts(customer_id);
CREATE INDEX IF NOT EXISTS idx_cheque_receipts_status ON cheque_receipts(status);
CREATE INDEX IF NOT EXISTS idx_cheque_receipts_number ON cheque_receipts(cheque_number);

-- 2a-iii. cheque_transfers ----------------------------------------------------
-- Only exists once a received cheque is handed on to a supplier as
-- payment, instead of being deposited directly. Links back to the
-- original cheque_receipts row, so "search this cheque number" always
-- shows the full chain: received from customer X, given to supplier Y.
CREATE TABLE IF NOT EXISTS cheque_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cheque_receipt_id INTEGER NOT NULL REFERENCES cheque_receipts(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  -- Links to the specific supplier_payments row this transfer created,
  -- so reversing on a bounce knows exactly which payment to undo.
  supplier_payment_id INTEGER REFERENCES supplier_payments(id),
  date_given TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_cheque_transfers_receipt ON cheque_transfers(cheque_receipt_id);
CREATE INDEX IF NOT EXISTS idx_cheque_transfers_supplier ON cheque_transfers(supplier_id);

-- 2a-iv. cheques_issued -------------------------------------------------------
-- A cheque written from the business's OWN bank account, straight to a
-- supplier — genuinely separate from cheque_receipts/cheque_transfers,
-- since there's no customer involved and it can never be passed on
-- further (it's already at its final destination the moment it's
-- written). Same core lifecycle as a received cheque: issuing it
-- reduces the supplier's balance immediately, clearing it creates the
-- real cash_book expense, bouncing it reverses the supplier payment.
CREATE TABLE IF NOT EXISTS cheques_issued (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cheque_number TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  amount REAL NOT NULL,
  cheque_date TEXT NOT NULL, -- the date written on the cheque — drives the "due soon" dashboard reminder
  date_issued TEXT NOT NULL DEFAULT (datetime('now')),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  supplier_payment_id INTEGER REFERENCES supplier_payments(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cleared','bounced')),
  cleared_at TEXT,
  bounced_at TEXT,
  bounced_reason TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_cheques_issued_supplier ON cheques_issued(supplier_id);
CREATE INDEX IF NOT EXISTS idx_cheques_issued_status ON cheques_issued(status);

-- 2b. customer_addresses --------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer
  ON customer_addresses(customer_id);

-- 2c. customer_bank_accounts -------------------------------------------------
-- A customer may have several accounts on file (e.g. a refund needs to
-- go to whichever one they specify) — same multi-record + one-default
-- pattern as customer_addresses above.
CREATE TABLE IF NOT EXISTS customer_bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  bank_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  branch TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_customer_bank_accounts_customer
  ON customer_bank_accounts(customer_id);

-- 3. suppliers -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  city TEXT,
  notes TEXT
);

-- 3a. supplier_bank_accounts --------------------------------------------------
-- Same multi-record + one-default pattern as customer_bank_accounts —
-- needed since you're the one sending money TO a supplier by bank
-- transfer, and they may give you more than one account over time.
CREATE TABLE IF NOT EXISTS supplier_bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  bank_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  branch TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_supplier_bank_accounts_supplier
  ON supplier_bank_accounts(supplier_id);

-- 4. products (catalog-level) ----------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_title TEXT NOT NULL,
  brand TEXT,
  category TEXT,
  cost_price REAL NOT NULL DEFAULT 0,
  selling_price REAL NOT NULL DEFAULT 0,
  supplier_id INTEGER REFERENCES suppliers(id),
  image_path TEXT,
  is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0,1)),
  -- Return policy at the product level: ON by default. When OFF ("Final
  -- Sale — No Returns"), the return button is disabled in POS and
  -- customer-facing sale history — an admin can still force one through
  -- with a logged reason, but it's not offered as a normal action.
  allow_returns INTEGER NOT NULL DEFAULT 1 CHECK (allow_returns IN (0,1)),
  -- Product classification, set once at creation and never changed
  -- afterward — different types of "the same shirt" (e.g. factory
  -- outlet vs. original) are entered as entirely separate product rows
  -- with their own cost/price/supplier, not variants of one product.
  -- FO = Factory Outlet, OG = Original (with labels), OR = Overrun,
  -- OP = Own Production.
  product_type TEXT NOT NULL DEFAULT 'OG' CHECK (product_type IN ('FO','OG','OR','OP')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);

-- 5. inventory (physical units) ---------------------------------------------
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  size TEXT,
  color TEXT,
  sku TEXT UNIQUE,
  barcode TEXT UNIQUE,
  -- Each physical unit remembers what IT actually cost and sells for —
  -- independent of the product's current cost_price/selling_price, which
  -- only reflect the most recent restock. This lets two batches of the
  -- same product coexist at different costs/prices simultaneously.
  cost_price REAL,
  selling_price REAL,
  -- Which purchase batch this specific unit came from — this is what
  -- actually lets a physical unit be traced back to its supplier, not
  -- just its cost. Nullable because older units (created before this
  -- link existed) won't have one; new restocks always set it.
  purchase_item_id INTEGER REFERENCES purchase_items(id),
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available','sold','damaged','gifted','stolen','lost','removed')),
  -- Only set when status is a write-off reason (not 'available' or 'sold').
  removal_reason TEXT CHECK (removal_reason IN ('Damaged','Gifted','Staff Use','Stolen','Lost','Other')),
  removal_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_product ON inventory(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_status ON inventory(status);

-- 5a. coupons ----------------------------------------------------------------
-- Admin-managed discount codes. discount_type/discount_value together
-- define the reward (e.g. type='percent', value=10 -> "10% off"; or
-- type='fixed', value=500 -> "Rs. 500 off"). is_active lets a code be
-- turned off without deleting its history of past use. expires_at is
-- optional — a code with no expiry stays valid indefinitely.
CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent','fixed')),
  discount_value REAL NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 6. sales -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice TEXT UNIQUE NOT NULL,
  -- ON DELETE SET NULL: if a customer with real sales history is
  -- deliberately hard-deleted (a genuine choice, not automatic — see
  -- the customers DELETE route), their sales survive intact with this
  -- set to NULL rather than being blocked or orphaned. Customer IDs
  -- never get reused, so a future different customer can never
  -- accidentally "inherit" this history.
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  -- Set ONLY when customer_id above is nulled out by a deliberate
  -- customer deletion (see the customers DELETE route) — never set for
  -- a genuine walk-in sale, which simply has customer_id = NULL and
  -- this left NULL too. Purely a display snapshot ("[Deleted: John
  -- Silva]" instead of indistinguishable from "Walk-in"), taken right
  -- before the real customer row is removed.
  deleted_customer_snapshot TEXT,
  salesperson TEXT,
  date TEXT NOT NULL DEFAULT (datetime('now')),
  subtotal REAL NOT NULL DEFAULT 0,
  -- discount is the COMBINED total (manual_discount + coupon_discount) —
  -- what actually reduces the sale total, and what the receipt shows as
  -- one line. manual_discount and coupon_discount are kept separately
  -- alongside it purely for audit, so a report can answer "how much did
  -- coupons cost us" vs "how much did staff discount by hand" without
  -- the two ever being confused on the customer-facing receipt.
  discount REAL NOT NULL DEFAULT 0,
  manual_discount REAL NOT NULL DEFAULT 0,
  coupon_discount REAL NOT NULL DEFAULT 0,
  coupon_code TEXT,
  total REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('paid','partial','unpaid')),
  payment_method TEXT,
  sale_type TEXT NOT NULL DEFAULT 'in_store' CHECK (sale_type IN ('in_store','online')),
  loyalty_points_earned INTEGER NOT NULL DEFAULT 0,
  -- Cash-payment specifics, needed to show change due in Sale History
  -- rather than just the net amount_paid.
  amount_received REAL,
  change_due REAL NOT NULL DEFAULT 0,
  -- Online orders can be overpaid (e.g. customer sent slightly more via
  -- bank transfer). Tracked separately so it can be offered back as
  -- store credit on a future purchase rather than silently absorbed.
  overpaid_amount REAL NOT NULL DEFAULT 0,
  -- A voided sale is never deleted — it stays visible in Sale History for
  -- audit, but its stock is returned to inventory, its cash book entry is
  -- reversed, and its loyalty points are clawed back. is_voided is the
  -- flag callers filter/display on; voided_at and void_reason record when
  -- and why for anyone reviewing the history later.
  is_voided INTEGER NOT NULL DEFAULT 0,
  voided_at TEXT,
  void_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);

-- 6a. sale_items ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  inventory_id INTEGER NOT NULL REFERENCES inventory(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL,
  line_total REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_inventory ON sale_items(inventory_id);

-- 6b. return_requests --------------------------------------------------------
-- A return is ALWAYS a request first. Staff submit one against a specific
-- sale item; an admin approves or declines it. Only on approval does a
-- row get written to `returns` below and the actual stock/cash-book/
-- loyalty effects happen — a pending or declined request changes nothing
-- about inventory or money. is_admin_override marks the rare case where
-- an admin forces a return through on a product marked Final Sale
-- (allow_returns = 0), with the reason required and logged.
CREATE TABLE IF NOT EXISTS return_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  condition TEXT NOT NULL CHECK (condition IN ('clean','damaged')),
  resolution TEXT NOT NULL CHECK (resolution IN ('refund','exchange','store_credit_exchange')),
  exchange_inventory_id INTEGER REFERENCES inventory(id),
  -- Only meaningful for store_credit_exchange — how many days the
  -- resulting credit is valid for, chosen at request time (45 is the
  -- real default; anything else is a deliberate exception, not an
  -- equally-weighted option).
  credit_expiry_days INTEGER,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  requested_by INTEGER REFERENCES users(id),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_reason TEXT,
  is_admin_override INTEGER NOT NULL DEFAULT 0 CHECK (is_admin_override IN (0,1)),
  -- Set once the request is approved and a returns row is actually
  -- created for it, so the two stay linked for audit.
  return_id INTEGER REFERENCES returns(id)
);

CREATE INDEX IF NOT EXISTS idx_return_requests_status ON return_requests(status);
CREATE INDEX IF NOT EXISTS idx_return_requests_sale_item ON return_requests(sale_item_id);

-- 6c. returns ----------------------------------------------------------
-- A return against one specific sale_item. condition determines whether
-- the physical unit becomes sellable again or is written off; resolution
-- determines whether cash goes back out, the item is swapped 1:1, or the
-- value becomes expiring store credit toward a genuinely new sale later.
-- A row here only ever exists because a return_requests row was approved
-- — this table is never written to directly from a staff-facing action.
CREATE TABLE IF NOT EXISTS returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
  condition TEXT NOT NULL CHECK (condition IN ('clean','damaged')),
  resolution TEXT NOT NULL CHECK (resolution IN ('refund','exchange','store_credit_exchange')),
  refund_amount REAL NOT NULL DEFAULT 0,
  exchange_inventory_id INTEGER REFERENCES inventory(id),
  reason TEXT,
  return_date TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_returns_sale_item ON returns(sale_item_id);

-- 7. purchases -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_code TEXT UNIQUE NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  purchase_date TEXT NOT NULL DEFAULT (datetime('now')),
  -- For a FULFILLED (regular, non-pending) purchase, total_cost is the
  -- sum of its purchase_items as before. For a PENDING purchase,
  -- total_cost is the sum of its pending_purchase_lines' (qty * cost) —
  -- the real amount owed to the SUPPLIER for goods only. Transport,
  -- commission, and other costs are never part of this number; they're
  -- recorded straight to the cash book as their own expense, since
  -- they're not owed to this supplier.
  total_cost REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('paid','partial','unpaid')),
  -- A real-world purchase often arrives (and gets partially or fully
  -- paid) days before it's actually sorted and entered as specific
  -- products/variants — 'pending' captures that gap. A pending purchase
  -- can have several rough lines (see pending_purchase_lines below),
  -- each fulfilled independently across separate Add Product / restock
  -- actions over time. It only becomes 'fulfilled' when the person
  -- decides they've entered everything from it and marks it done —
  -- never inferred automatically from totals, since only a human
  -- reviewing the physical goods actually knows when it's complete.
  fulfillment_status TEXT NOT NULL DEFAULT 'fulfilled' CHECK (fulfillment_status IN ('pending','fulfilled')),
  -- A rough overall note for the delivery, e.g. "Mixed order from Mr.
  -- Nazeer, Sept batch" — the real per-item detail lives in
  -- pending_purchase_lines.
  description TEXT
);

CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);

-- 7a0. pending_purchase_lines --------------------------------------------
-- The rough per-item breakdown of a pending purchase — a description,
-- quantity, and per-piece cost, entered before anyone knows the exact
-- product/variant this will become. Each line is fulfilled independently:
-- when someone adds a product or restocks and links it to this line, the
-- line is marked fulfilled and remembers which purchase_item resolved it
-- (for tracing "this line became these real units" later). A pending
-- purchase can be marked fully done (fulfillment_status='fulfilled' on
-- the parent purchases row) even with some lines still technically open,
-- since that decision is always a deliberate human call, not automatic.
CREATE TABLE IF NOT EXISTS pending_purchase_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_cost REAL NOT NULL,
  -- How many of this line's expected quantity have actually been entered
  -- so far, across however many separate restock/add-product actions.
  -- Checked as a SOFT warning only against `quantity` — going over is
  -- allowed (an honest miscount or supplier bonus shouldn't be blocked),
  -- but the person sees "70 expected, entering X more" either way.
  fulfilled_quantity INTEGER NOT NULL DEFAULT 0,
  is_fulfilled INTEGER NOT NULL DEFAULT 0 CHECK (is_fulfilled IN (0,1)),
  -- Set once this line is linked to a real restock/add-product action —
  -- points at the purchase_items row that was actually created for it.
  -- If fulfilled across multiple actions, this is the MOST RECENT one.
  fulfilled_purchase_item_id INTEGER REFERENCES purchase_items(id),
  -- The type this line is expected to become (FO/OG/OR/OP) — carried
  -- over as a default when this line is eventually fulfilled into a
  -- real product on Add Product, since the type is normally decided at
  -- the moment the goods are ordered/received.
  product_type TEXT NOT NULL DEFAULT 'OG' CHECK (product_type IN ('FO','OG','OR','OP'))
);

CREATE INDEX IF NOT EXISTS idx_pending_purchase_lines_purchase ON pending_purchase_lines(purchase_id);

-- 7a0b. purchase_expenses --------------------------------------------------
-- Multiple named, non-supplier costs tied to a purchase — transport,
-- commission, loading, whatever else — each its own line so a delivery
-- can have several different cost types recorded separately, all mirrored
-- into the cash book as individual expense entries. None of this is ever
-- owed to the supplier or added to their balance.
CREATE TABLE IF NOT EXISTS purchase_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_purchase_expenses_purchase ON purchase_expenses(purchase_id);

-- 7a0c. supplier_credit_transactions ----------------------------------------
-- A running credit ledger per supplier — same shape as the customer
-- store-credit ledger. A damaged-goods return that the supplier agrees to
-- cover (rather than refund in cash immediately) grants a positive entry
-- here; the credit is then automatically applied against what's owed on
-- a FUTURE purchase from that supplier, reducing the amount you need to
-- pay them. A fully-cash-refunded return never touches this table at
-- all — that money changes hands immediately, nothing to carry forward.
CREATE TABLE IF NOT EXISTS supplier_credit_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  amount REAL NOT NULL, -- positive = granted (damaged-goods credit), negative = applied against a purchase
  reason TEXT NOT NULL CHECK (reason IN ('damaged_goods_credit','applied_to_purchase','manual_adjustment')),
  reference_id INTEGER, -- the purchase id that generated or consumed this entry
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_supplier_credit_transactions_supplier ON supplier_credit_transactions(supplier_id);

-- 7a1. purchase_damage_returns -----------------------------------------------
-- A damaged-goods return against a specific purchase_item — how many
-- units, and how it was resolved: either refunded in cash immediately,
-- or credited to the supplier's running balance for a future purchase.
-- A single "Record Returns" action, covering either scenario:
-- - not yet in inventory: one or more pending_purchase_lines rows are
--   reduced (return_items.pending_line_id set, inventory_id null)
-- - already in inventory: one or more specific inventory units (always
--   'available', never 'sold') are removed and become return_items rows
--   with inventory_id set, pending_line_id null.
-- Either way it's ONE header record with a single reason/resolution —
-- the resolution (cash refund now, or supplier credit for a future
-- purchase) is always the person's own choice, never inferred.
CREATE TABLE IF NOT EXISTS purchase_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  total_amount REAL NOT NULL,
  reason TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('cash_refund','supplier_credit')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_purchase_returns_purchase ON purchase_returns(purchase_id);

-- One row per specific thing being returned within that action — either
-- a quantity off a still-pending line, or one specific inventory unit
-- that physically gets pulled from stock.
CREATE TABLE IF NOT EXISTS purchase_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_return_id INTEGER NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  pending_line_id INTEGER REFERENCES pending_purchase_lines(id),
  inventory_id INTEGER REFERENCES inventory(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_cost REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_purchase_return_items_return ON purchase_return_items(purchase_return_id);

-- 7a. purchase_items -------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_cost REAL NOT NULL,
  size TEXT,
  color TEXT
);

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_product ON purchase_items(product_id);

-- 8. supplier_payments -------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplier_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  purchase_id INTEGER REFERENCES purchases(id),
  amount REAL NOT NULL,
  payment_date TEXT NOT NULL DEFAULT (datetime('now')),
  method TEXT,
  is_partial INTEGER NOT NULL DEFAULT 0 CHECK (is_partial IN (0,1)),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier ON supplier_payments(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_purchase ON supplier_payments(purchase_id);

-- 9. deliveries -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  address_id INTEGER REFERENCES customer_addresses(id),
  courier_name TEXT,
  tracking_number TEXT,
  -- Which of the 3 delivery partners this order ships with. Drives the
  -- waybill's shop code (MNM X CPAK / MNM X D2D / MNM X DEX).
  delivery_partner TEXT CHECK (delivery_partner IN ('CPAK','D2D','DEX')),
  package_weight_kg REAL,
  -- Confirming the delivery address (usually by calling/messaging the
  -- customer) is a hard gate before packing — a bad address caught here
  -- is a phone call; caught after shipping is a costly return. Stored
  -- as a real fact on the delivery, not just a UI checkbox, so it's
  -- part of the audit trail for why an order was or wasn't verified.
  address_confirmed INTEGER NOT NULL DEFAULT 0,
  address_confirmed_at TEXT,
  -- true when the delivery fee was waived — kept separate from
  -- delivery_fee = 0 so "free delivery" is an explicit, visible choice
  -- rather than indistinguishable from "fee not calculated yet".
  is_free_delivery INTEGER NOT NULL DEFAULT 0,
  -- Amount to be collected on delivery (COD). Computed as
  -- (sale total - amount already paid) + delivery fee, and stored so it's
  -- a fixed figure the courier/waybill can show, not recalculated later
  -- against a sale that may since have had a return or edit.
  cod_amount REAL NOT NULL DEFAULT 0,
  -- Tracking pipeline: pending (just placed) -> packed (waybill generated)
  -- -> dispatched (handed to courier) -> delivered. 'returned' is a
  -- separate terminal state reachable from packed/dispatched, not a step
  -- in the normal forward flow. 'cancelled' is distinct from 'returned':
  -- it means the underlying sale was voided (never a real order to begin
  -- with), not that a real shipment came back from the customer.
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending','packed','dispatched','delivered','returned','cancelled')),
  waybill_number TEXT,
  packed_at TEXT,
  dispatched_at TEXT,
  delivery_date TEXT,
  delivery_fee REAL NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_deliveries_sale ON deliveries(sale_id);

-- 10. courier_payments --------------------------------------------------------
CREATE TABLE IF NOT EXISTS courier_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  courier_name TEXT,
  delivery_id INTEGER REFERENCES deliveries(id),
  amount REAL NOT NULL,
  payment_date TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_courier_payments_delivery ON courier_payments(delivery_id);

-- 11. cash_book -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS cash_book (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL CHECK (type IN ('income','expense')),
  category TEXT NOT NULL,
  -- How this entry was actually settled (cash/card/bank_transfer/credit)
  -- — needed to answer "how much cash is physically on hand" vs "how
  -- much is in the bank account", not just a lump total.
  payment_method TEXT,
  reference_id INTEGER,
  amount REAL NOT NULL,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_cash_book_date ON cash_book(entry_date);
