# M&M Clothing — Backend API Reference

Base URL when running locally: `http://localhost:4000/api`

All request/response bodies are JSON. All endpoints validate input and
return clear error messages (400/404/409) rather than crashing.

---

## Business Info
- `GET /business-info` — get the single business info record
- `PUT /business-info` — create or update it

## Customers
- `GET /customers` — list all, with live `loyalty_points` and `balance_due`
- `GET /customers/:id` — one customer, including their saved `addresses`
- `POST /customers` — create (auto-generates `customer_code`)
- `PUT /customers/:id` — update name/phone
- `DELETE /customers/:id` — blocked if they have sales history

### Customer addresses (nested)
- `POST /customers/:id/addresses` — add a saved address (set `is_default: true` to make it the default; clears the flag on others automatically)
- `PUT /customers/:id/addresses/:addressId` — edit an address
- `DELETE /customers/:id/addresses/:addressId` — blocked if used in a delivery

## Suppliers
- `GET /suppliers` — list all, with live `balance_owed`
- `GET /suppliers/:id`
- `POST /suppliers` — create (auto-generates `supplier_code`)
- `PUT /suppliers/:id`
- `DELETE /suppliers/:id` — blocked if they have products or purchases

## Products (catalog-level styles)
- `GET /products` — list all, with live `qty` (count of available inventory units) and supplier name
- `GET /products/:id`
- `POST /products` — create a new style
- `PUT /products/:id`
- `DELETE /products/:id` — blocked if inventory units exist for it

## Inventory (individual physical units)
- `GET /inventory` — list all units; filter with `?status=available` or `?product_id=5`
- `GET /inventory/:id`
- `GET /inventory/barcode/:barcode` — look up a unit by scanned barcode (for POS)
- `POST /inventory` — add a single unit manually (auto-generates SKU)
- `PUT /inventory/:id` — edit size/color/barcode (status is not editable here — see Sales)
- `DELETE /inventory/:id` — blocked if the unit was ever sold

## Sales (POS)
- `GET /sales` — list all
- `GET /sales/:id` — includes line items
- `POST /sales` — create a sale. Body:
  ```json
  {
    "customer_id": 3,
    "salesperson": "Nizam",
    "items": [{ "inventory_id": 12, "unit_price": 3500 }],
    "discount": 0,
    "amount_paid": 3500,
    "payment_method": "cash"
  }
  ```
  This one call: creates the sale, creates its line items, **flips each
  sold inventory unit's status to `sold`**, calculates loyalty points
  (1 point per Rs. 1000 of total), and logs the payment to the cash book.
  All of it happens in a single transaction — if anything fails (e.g. an
  item is already sold), nothing is saved.
- `PUT /sales/:id/payment` — record an additional payment on a
  partially-paid sale. Body: `{ "amount": 1000 }`

## Purchases (stock received from suppliers)
- `GET /purchases` — list all
- `GET /purchases/:id` — includes line items
- `POST /purchases` — record stock received. Body:
  ```json
  {
    "supplier_id": 2,
    "items": [{ "product_id": 5, "quantity": 3, "unit_cost": 1200 }],
    "amount_paid": 3600
  }
  ```
  This **creates one new inventory row per unit** (quantity 3 → 3 new
  rows, status `available`, auto-generated SKU). The response includes
  `new_inventory_ids` so you know which rows to go assign size/color/
  barcode to next via `PUT /inventory/:id`.

## Supplier Payments
- `GET /supplier-payments` — filter with `?supplier_id=2`
- `POST /supplier-payments` — record a standalone payment (also logs to cash book, and updates the linked purchase's payment status if `purchase_id` is given)
- `GET /supplier-payments/summary` — the "Supplier Summary" report: total purchased, total paid, and balance owed, per supplier — computed live, not stored

## Deliveries
- `GET /deliveries` — filter with `?status=pending`
- `GET /deliveries/:id`
- `POST /deliveries` — create a delivery for a sale, optionally tied to one of the customer's saved addresses via `address_id`
- `PUT /deliveries/:id/status` — update status through `pending → shipped → delivered/returned`

## Courier Payments
- `GET /courier-payments`
- `POST /courier-payments` — record a payment to a courier (also logs to cash book)

## Cash Book
- `GET /cash-book` — full ledger, newest first, each row includes a live `running_balance`
- `GET /cash-book/balance` — just the current total balance
- `POST /cash-book` — manual entry for anything with no other source (rent, utilities, etc.) — use `category: "other"`
- `DELETE /cash-book/:id` — only works on manually-entered rows (`category: "other"`); automatic entries from sales/payments can't be deleted directly, since that would silently disagree with the sale/payment record they came from

---

## Design notes worth knowing

- **Loyalty points**: 1 point per Rs. 1000 of a sale's total, calculated
  and stored at the moment of sale (so it doesn't change if you edit
  prices later).
- **Codes** (`customer_code`, `supplier_code`, `invoice`, `purchase_code`,
  SKU): all auto-generated sequentially — you never type these in.
- **Inventory status**: flips to `sold` automatically the instant a sale
  is recorded — no manual step needed.
- **Balances** (customer `balance_due`, supplier `balance_owed`, cash book
  `running_balance`): always computed live from the underlying records,
  never stored — so they can never silently drift out of sync the way a
  hand-edited spreadsheet cell can.
