# M&M Clothing — Database Schema Design (v2)

Single branch for now (no `branch_id` anywhere) — trivial to add back later
by adding one column per table when you open branch #2.

---

## 1. business_info
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| business_name | TEXT | |
| address_line1 | TEXT | |
| address_line2 | TEXT | |
| city | TEXT | |
| phone | TEXT | |
| email | TEXT | |
| bank_name | TEXT | |
| bank_account_no | TEXT | |
| bank_account_name | TEXT | |
| notes | TEXT | |

---

## 2. customers
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| customer_code | TEXT UNIQUE | e.g. C-0001 |
| name | TEXT | |
| phone | TEXT | |
| loyalty_points | INTEGER | **calculated**, live from sales |
| balance_due | REAL | **calculated**, live from sales |
| created_at | DATETIME | |

### 2a. customer_addresses (new — a customer can have several)
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| customer_id | INTEGER FK -> customers | |
| address_line1 | TEXT | |
| address_line2 | TEXT | |
| city | TEXT | |
| is_default | BOOLEAN | exactly one default per customer (enforced in app logic) |

Deliveries reference `customer_addresses.id`, so you pick which saved
address a given order ships to.

---

## 3. suppliers
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| supplier_code | TEXT UNIQUE | e.g. S-0001 |
| name | TEXT | |
| phone | TEXT | |
| city | TEXT | |
| notes | TEXT | |
| balance_owed | REAL | **calculated**, live from purchases − supplier_payments |

---

## 4. products (catalog-level — one row per style, not per unit)
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| product_title | TEXT | |
| brand | TEXT | |
| category | TEXT | |
| qty | INTEGER | **calculated** — count of its `inventory` rows with status='available' |
| cost_price | REAL | per-piece cost |
| selling_price | REAL | |
| supplier_code | TEXT FK -> suppliers.supplier_code | |
| image_path | TEXT | for catalog site |
| created_at | DATETIME | |

**On `qty`:** since inventory is tracked per physical unit (below), "qty"
for a product is really *"how many available inventory rows exist for
this product."* Recommend treating this as a live count (SQL COUNT()),
not a stored number that could drift out of sync — same reasoning as
avoiding fragile Excel formulas. It'll still just look like a normal field
in the UI; you won't be able to hand-edit it into an inconsistent state.

---

## 5. inventory (physical units — one row per individual item)
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| product_id | INTEGER FK -> products | |
| size | TEXT | |
| color | TEXT | |
| sku | TEXT UNIQUE | |
| barcode | TEXT UNIQUE, NULLABLE | for barcode scanning at POS |
| status | TEXT | 'available' or 'sold' |
| created_at | DATETIME | |

A product like "Nike Hoodie" might have 5 inventory rows: S/Black,
S/Blue, M/Black, M/Blue, L/Black — each with its own SKU and barcode,
each independently available or sold.

**Consequence for sales (flagged below):** a sale needs to know exactly
*which physical item* left the shop, not just "a Nike Hoodie" in the
abstract. So `sale_items` should reference `inventory.id`, not
`product_id` directly.

---

## 6. sales
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| invoice | TEXT UNIQUE | e.g. INV-0001 |
| customer_id | INTEGER FK -> customers, NULLABLE | nullable = walk-in/guest |
| salesperson | TEXT | |
| date | DATETIME | |
| subtotal | REAL | |
| discount | REAL | |
| total | REAL | |
| amount_paid | REAL | |
| payment_status | TEXT | 'paid', 'partial', 'unpaid' |
| payment_method | TEXT | |
| loyalty_points_earned | INTEGER | **calculated** at sale time and stored (locks in rate at time of sale) |

## 6a. sale_items
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| sale_id | INTEGER FK -> sales | |
| inventory_id | INTEGER FK -> inventory | **the specific unit sold** — flagged, see below |
| quantity | INTEGER | normally 1, since inventory is per-unit |
| unit_price | REAL | price at time of sale |
| line_total | REAL | |

> **Flag for your confirmation:** I changed `product_id` → `inventory_id`
> here. Since inventory is tracked per physical unit (size/color/SKU/
> barcode), a sale needs to record *which unit* was sold — otherwise you
> lose the ability to know which size sold, or to mark that exact barcode
> as sold. If you actually sell in bulk quantities per style (e.g. "sold 3
> of this hoodie" without caring which specific unit), tell me and I'll
> adjust — but for a barcode-per-item system, `inventory_id` is what makes
> scanning-at-checkout work.

---

## 7. purchases
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| purchase_code | TEXT UNIQUE | |
| supplier_id | INTEGER FK -> suppliers | |
| purchase_date | DATETIME | |
| total_cost | REAL | |
| amount_paid | REAL | |
| payment_status | TEXT | 'paid', 'partial', 'unpaid' |

## 7a. purchase_items
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| purchase_id | INTEGER FK -> purchases | |
| product_id | INTEGER FK -> products | |
| quantity | INTEGER | |
| unit_cost | REAL | |

*(Receiving a purchase is what creates new `inventory` rows — e.g. you buy
5 units of a hoodie, purchase_items records qty=5, and 5 new inventory
rows get generated for you to assign size/color/SKU/barcode to.)*

---

## 8. supplier_payments
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| supplier_id | INTEGER FK -> suppliers | |
| purchase_id | INTEGER FK -> purchases, NULLABLE | |
| amount | REAL | |
| payment_date | DATETIME | |
| method | TEXT | |
| is_partial | BOOLEAN | |
| notes | TEXT | |

Supplier Summary = a computed report (purchases total − payments total per
supplier), not a stored table.

---

## 9. deliveries
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| sale_id | INTEGER FK -> sales | |
| address_id | INTEGER FK -> customer_addresses | which saved address this ships to |
| courier_name | TEXT | |
| tracking_number | TEXT | |
| delivery_status | TEXT | 'pending', 'shipped', 'delivered', 'returned' |
| delivery_date | DATETIME | |
| delivery_fee | REAL | |
| notes | TEXT | |

---

## 10. courier_payments
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| courier_name | TEXT | |
| delivery_id | INTEGER FK -> deliveries, NULLABLE | |
| amount | REAL | |
| payment_date | DATETIME | |
| notes | TEXT | |

---

## 11. cash_book
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| entry_date | DATETIME | |
| type | TEXT | 'income' or 'expense' |
| category | TEXT | 'sale', 'supplier_payment', 'courier_payment', 'other' |
| reference_id | INTEGER | links back to source record |
| amount | REAL | |
| running_balance | REAL | **calculated** on read, ordered by date |
| notes | TEXT | |

---

## Summary of changes from v1
- Removed all `branch_id` columns (single branch for now)
- Removed `inventory_movements` ledger — inventory is now per-unit with a
  simple status flag instead
- Split products (catalog/style-level) from inventory (physical unit-level
  with size/color/SKU/**barcode**)
- Added `customer_addresses` (multiple addresses per customer, one default)
- `deliveries.address_id` now points to a specific saved address
- `sale_items` now references `inventory_id` (specific unit) — **flagged
  above for your confirmation**, the one structural judgment call I made
  rather than direct transcription

## One open question
Confirm the `sale_items` → `inventory_id` change above is what you want
(vs. selling by product + quantity without tracking individual units).
Everything else in this draft is ready to build from as-is.
