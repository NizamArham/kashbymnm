import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { nextInvoiceCode, InvoiceCategory, nextTransactionCode, nextQuotationCode, invoiceCodeFromQuotation } from "../lib/codes";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";
import { logAudit } from "../lib/auditLog";
import { getPartner, planDelivery, DeliveryPartnerRow } from "../lib/deliveryPartners";
import { storeCreditSources } from "../lib/storeCreditSources";
import { loyaltyBalance } from "../lib/loyalty";
import { SALE_EXCHANGE_FLAGS_SQL, cancelExchangeForSale, checkExchangeSources, exchangeForSale, exchangesOutOfSale } from "../lib/exchanges";

export const salesRouter = Router();

// POS is used by both admin and staff — just needs login, no role restriction.
salesRouter.use(requireAuth);

// Loyalty points = 1% of the sale's total, rounded down to a whole point
// (e.g. Rs. 2500 spent -> 25 points). Matches the business's real,
// established rule.
export const LOYALTY_RATE_PERCENT = 0.01;

const saleItemInput = z.object({
  inventory_id: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
});

const saleInput = z.object({
  customer_id: z.number().int().positive().optional(),
  salesperson: z.string().optional(),
  items: z.array(saleItemInput).min(1),
  // Manual discount — staff-entered, either a percentage of the subtotal
  // or a flat amount. Kept separate from any coupon applied, per the
  // requirement that the two be tracked separately for audit even
  // though they combine into one line on the receipt.
  manual_discount_type: z.enum(["percent", "fixed"]).optional(),
  manual_discount_value: z.number().nonnegative().optional(),
  coupon_code: z.string().optional(),
  amount_paid: z.number().nonnegative().default(0),
  payment_method: z.string().optional(),
  // Store credit the customer has from a past overpayment, applied
  // against this sale's total. Validated server-side against their real
  // balance — never trusted as a client-supplied final amount.
  store_credit_applied: z.number().nonnegative().default(0),
  // Cash-specific: how much cash was actually handed over, so change due
  // can be computed and shown later in Sale History rather than just
  // the net amount_paid after change was given.
  amount_received: z.number().nonnegative().optional(),
  // When cash tendered exceeds the total, this is the explicit choice
  // of what happens to the extra — true = keep it as store credit on
  // the customer's account, false/absent = hand back as change (the
  // default, matching how a normal cash sale works). Never assumed —
  // the person at checkout picks this each time it's relevant.
  keep_cash_overpayment_as_credit: z.boolean().default(false),
  sale_type: z.enum(["in_store", "online"]).default("in_store"),
  // Delivery details — only meaningful for sale_type "online", ignored
  // otherwise. Weight and partner determine the delivery fee (Rs. 450
  // first kg + Rs. 100/extra kg), which is skipped entirely if
  // is_free_delivery is set — though the underlying order total still
  // needs settling either now or as COD.
  // A code from the admin-managed delivery_partners table — checked
  // against it (and that it's active) at checkout, not a fixed list.
  delivery_partner: z.string().optional(),
  package_weight_kg: z.number().nonnegative().optional(),
  is_free_delivery: z.boolean().default(false),
  // On-demand partners (Uber, PickMe Flash...) have no weight tariff —
  // the actual fare is typed in per order, and delivery_paid_by says who
  // bears it: 'customer' (charged to them), 'shop' (free delivery, we
  // pay) or 'rider_direct' (the customer pays the rider themselves —
  // no fare to record). The fare can be left out when
  // the ride isn't booked yet: the order then waits, fare to be
  // confirmed, until it's entered. Ignored for ordinary couriers.
  delivery_fare: z.number().nonnegative().optional(),
  delivery_paid_by: z.enum(["customer", "shop", "rider_direct"]).optional(),
  // When true, the product total is tracked as customer credit (balance
  // due) rather than collected at all today — only the delivery fee is
  // ever COD in this case, regardless of amount_paid.
  is_credit_order: z.boolean().default(false),
  // A wholesale order earns no loyalty points. (A customer marked as never
  // earning points is treated the same way, whatever this says.)
  is_wholesale: z.boolean().default(false),
  // Set when this checkout is the final step of a saved quotation that
  // was reopened in POS — the quotation is consumed (deleted) in the
  // same transaction that creates the real sale, so it can't be
  // converted twice.
  quotation_id: z.number().int().positive().optional(),
  // An online exchange: this order replaces item(s) the customer already has
  // from delivered orders, and the courier collects the old items when it
  // delivers this one. The order can hold as many pieces as they like — the old
  // items' value comes off its total. customer_share_pct is how much of the
  // courier's pickup charge the customer pays (0 = we pay, 50 = half and half,
  // 100 = they pay).
  exchange: z
    .object({
      old_sale_item_ids: z.array(z.number().int().positive()).min(1).max(20),
      pickup_charge: z.number().nonnegative().default(0),
      customer_share_pct: z.number().int().min(0).max(100).default(0),
    })
    .optional(),
});

// A quotation only ever needs the "what are we selling, to whom, at
// what price" half of saleInput — nothing about payment, since nothing
// is being paid yet. Delivery details are decided later too, at real
// checkout, once the customer has actually committed.
const quotationInput = z.object({
  customer_id: z.number().int().positive().optional(),
  salesperson: z.string().optional(),
  items: z.array(saleItemInput).min(1),
  manual_discount_type: z.enum(["percent", "fixed"]).optional(),
  manual_discount_value: z.number().nonnegative().optional(),
  coupon_code: z.string().optional(),
  sale_type: z.enum(["in_store", "online"]).default("in_store"),
  // How many days this quote is good for, counted from today — a
  // quotation has no real "expiry" mechanism (nothing is reserved), this
  // is purely what prints on the bill so the customer knows by when to
  // confirm and pay.
  valid_days: z.number().int().positive().max(365).default(7),
});

// Validates every item against real stock and computes subtotal/discount/
// total exactly once — shared by a real checkout (POST /) and a
// quotation (POST /quotations), so a quoted price can never drift from
// what the same cart would actually charge at real checkout time.
interface ItemPricing {
  inventoryRows: any[];
  subtotal: number;
  manual_discount: number;
  coupon_discount: number;
  coupon_code: string | null;
  discount: number;
  total: number;
  loyalty_points_earned: number;
}

function priceItems(
  items: { inventory_id: number; unit_price: number }[],
  manualDiscountType: "percent" | "fixed" | undefined,
  manualDiscountValue: number | undefined,
  couponCodeInput: string | undefined
): ItemPricing {
  const inventoryRows = items.map((item) => {
    const row = db.prepare(`SELECT * FROM inventory WHERE id = ?`).get(item.inventory_id) as any;
    if (!row) {
      throw new ApiError(400, `Inventory unit ${item.inventory_id} does not exist`);
    }
    if (row.status !== "available") {
      throw new ApiError(
        409,
        `Inventory unit ${item.inventory_id} (SKU ${row.sku}) is already sold and cannot be sold again`
      );
    }
    return row;
  });

  const subtotal = items.reduce((sum, item) => sum + item.unit_price, 0);

  const manual_discount =
    manualDiscountType === "percent" ? Math.round((subtotal * (manualDiscountValue ?? 0)) / 100) : manualDiscountValue ?? 0;

  let coupon_discount = 0;
  let coupon_code: string | null = null;
  if (couponCodeInput) {
    const code = couponCodeInput.trim().toUpperCase();
    const coupon = db.prepare(`SELECT * FROM coupons WHERE code = ?`).get(code) as any;
    if (!coupon) throw new ApiError(400, `No coupon with code "${code}"`);
    if (!coupon.is_active) throw new ApiError(400, `Coupon "${code}" is no longer active`);
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      throw new ApiError(400, `Coupon "${code}" has expired`);
    }
    coupon_discount =
      coupon.discount_type === "percent" ? Math.round((subtotal * coupon.discount_value) / 100) : coupon.discount_value;
    coupon_code = code;
  }

  const discount = manual_discount + coupon_discount;
  const total = Math.max(0, subtotal - discount);
  const loyalty_points_earned = Math.floor(total * LOYALTY_RATE_PERCENT);

  return { inventoryRows, subtotal, manual_discount, coupon_discount, coupon_code, discount, total, loyalty_points_earned };
}

// The cash/change/store-credit math for a real checkout (POST /).
interface PaymentOutcomeInput {
  total: number;
  customer_id?: number;
  amount_paid: number;
  payment_method?: string;
  amount_received?: number;
  keep_cash_overpayment_as_credit: boolean;
  store_credit_applied: number;
  // Delivery fee the customer owes ON TOP of the product total and may
  // pay at checkout (prepaid online order). 0 for in-store sales and for
  // credit orders, where the fee is collected on delivery instead.
  fee_payable: number;
}
interface PaymentOutcome {
  storeCreditApplied: number;
  effectiveAmountPaid: number;
  // Payments cover the product total first, then the delivery fee —
  // sales.amount_paid only ever records the product part (feePaid is
  // kept on the delivery), so paying product + delivery up front never
  // looks like an overpayment or a negative balance.
  productAmountPaid: number;
  feePaid: number;
  payment_status: "paid" | "partial" | "unpaid";
  change_due: number;
  overpaid_amount: number;
}

function computePaymentOutcome(input: PaymentOutcomeInput): PaymentOutcome {
  let storeCreditApplied = 0;
  if (input.store_credit_applied > 0) {
    if (!input.customer_id) {
      throw new ApiError(400, "Store credit can only be applied for a selected customer.");
    }
    const balanceRow = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) as balance FROM store_credit_transactions
         WHERE customer_id = ? AND (expires_at IS NULL OR expires_at > datetime('now', '+330 minutes') OR amount < 0)`
      )
      .get(input.customer_id) as { balance: number };
    storeCreditApplied = Math.min(input.store_credit_applied, balanceRow.balance, input.total);
  }

  const cashExtra =
    input.payment_method === "cash" && input.amount_received != null && input.amount_received > input.total
      ? input.amount_received - input.total
      : 0;
  const change_due = cashExtra > 0 && !input.keep_cash_overpayment_as_credit ? cashExtra : 0;

  const effectiveAmountPaid = input.amount_paid - change_due + storeCreditApplied;

  let payment_status: "paid" | "partial" | "unpaid" = "unpaid";
  if (effectiveAmountPaid >= input.total && input.total > 0) payment_status = "paid";
  else if (effectiveAmountPaid > 0) payment_status = "partial";

  // Only what's beyond the product AND its delivery fee is an
  // overpayment — the fee portion was legitimately owed.
  const overpaid_amount =
    input.payment_method !== "cash" && input.amount_paid > input.total + input.fee_payable
      ? input.amount_paid - input.total - input.fee_payable
      : cashExtra > 0 && input.keep_cash_overpayment_as_credit
      ? cashExtra
      : 0;

  const feePaid = Math.min(Math.max(0, effectiveAmountPaid - input.total), input.fee_payable);
  const productAmountPaid = effectiveAmountPaid - feePaid;

  return { storeCreditApplied, effectiveAmountPaid, productAmountPaid, feePaid, payment_status, change_due, overpaid_amount };
}

// GET /api/sales — list all, with customer name. Optionally
// ?customer_id=N to scope to just one customer's order history — used
// by the customer order history page, so it doesn't have to fetch
// every sale in the system just to filter client-side.
//
// Defaults to real sales only (status = 'completed') — a saved
// quotation is a row in this same table, but it was never actually
// sold, so Sale History, the Dashboard, and every other screen that
// calls this with no ?status would otherwise show an unpaid draft
// mixed in with real orders. Pass ?status=quotation to see quotations
// instead (used by the Quotations page).
salesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const conditions: string[] = ["sales.status = ?"];
    const params: any[] = [req.query.status === "quotation" ? "quotation" : "completed"];
    if (req.query.customer_id) {
      conditions.push("sales.customer_id = ?");
      params.push(req.query.customer_id);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT sales.*, customers.name as customer_name, customers.customer_code,
                deliveries.delivery_partner, delivery_partners.kind as delivery_partner_kind,
                deliveries.delivery_status as delivery_status,
                ${SALE_EXCHANGE_FLAGS_SQL}
         FROM sales
         LEFT JOIN customers ON customers.id = sales.customer_id
         LEFT JOIN deliveries ON deliveries.sale_id = sales.id
         LEFT JOIN delivery_partners ON delivery_partners.code = deliveries.delivery_partner
         ${where}
         ORDER BY sales.id DESC`
      )
      .all(...params);
    res.json(rows);
  })
);

// GET /api/sales/:id — includes line items
salesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const sale = db
      .prepare(
        `SELECT sales.*, customers.name as customer_name, customers.customer_code,
                customers.phone as customer_phone, deliveries.delivery_partner,
                delivery_partners.name as delivery_partner_name,
                delivery_partners.waybill_code as delivery_partner_waybill_code,
                delivery_partners.kind as delivery_partner_kind,
                deliveries.delivery_fee, deliveries.is_free_delivery as delivery_is_free,
                deliveries.delivery_paid_by, deliveries.actual_fare as delivery_actual_fare,
                deliveries.rider_direct as delivery_rider_direct, deliveries.cod_amount as delivery_cod_amount,
                deliveries.fee_paid as delivery_fee_paid, deliveries.delivery_status,
                deliveries.tracking_number as delivery_tracking_number
         FROM sales
         LEFT JOIN customers ON customers.id = sales.customer_id
         LEFT JOIN deliveries ON deliveries.sale_id = sales.id
         LEFT JOIN delivery_partners ON delivery_partners.code = deliveries.delivery_partner
         WHERE sales.id = ?`
      )
      .get(req.params.id) as any;
    if (!sale) throw new ApiError(404, "Sale not found");

    const items = db
      .prepare(
        `SELECT sale_items.*, inventory.sku, inventory.size, inventory.color, inventory.barcode,
                inventory.selling_price AS original_selling_price,
                COALESCE(products.product_title, sale_items.product_snapshot) as product_title,
                products.id AS product_id,
                products.brand, COALESCE(products.allow_returns, 1) as allow_returns,
                (SELECT COUNT(*) FROM returns WHERE returns.sale_item_id = sale_items.id) as is_returned
         FROM sale_items
         LEFT JOIN inventory ON inventory.id = sale_items.inventory_id
         LEFT JOIN products ON products.id = inventory.product_id
         WHERE sale_items.sale_id = ?`
      )
      .all(req.params.id);

    // Online/COD orders ship somewhere — pull that delivery address in
    // too, so a receipt for one of these can show where it was sent.
    let delivery_address: { address_line1: string | null; address_line2: string | null; city: string | null } | null = null;
    if (sale.sale_type === "online") {
      delivery_address = db
        .prepare(
          `SELECT customer_addresses.address_line1, customer_addresses.address_line2, customer_addresses.city
           FROM deliveries
           LEFT JOIN customer_addresses ON customer_addresses.id = deliveries.address_id
           WHERE deliveries.sale_id = ?`
        )
        .get(req.params.id) as typeof delivery_address;
    }

    // How much of this sale was settled with the customer's store
    // credit (e.g. from a return) — it's inside amount_paid but isn't
    // cash, so a bill has to show it separately or the balance due
    // looks wrong next to the total.
    const { credit } = db
      .prepare(
        `SELECT COALESCE(SUM(-amount), 0) as credit FROM store_credit_transactions
         WHERE reference_id = ? AND reason = 'redemption'`
      )
      .get(req.params.id) as { credit: number };

    res.json({
      ...sale,
      items,
      delivery_address,
      exchange: exchangeForSale(sale.id),
      exchanged_out: exchangesOutOfSale(sale.id),
      store_credit_applied: credit,
      store_credit_sources: credit > 0 ? storeCreditSources(sale.id, sale.customer_id) : [],
    });
  })
);

// POST /api/sales — create a sale (POS checkout).
// This is the one operation that touches three tables together, so it
// runs as a single SQLite transaction: either everything succeeds
// (sale + items + inventory flips to 'sold') or nothing is saved at all.
salesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = saleInput.parse(req.body);

    // Checking out a reopened quotation — it must still be open, or it
    // was already converted/cancelled from somewhere else (another
    // tab, another cashier) and this would double-sell it.
    let quotationInvoice: string | null = null;
    if (data.quotation_id) {
      const quote = db.prepare(`SELECT invoice FROM sales WHERE id = ? AND status = 'quotation'`).get(data.quotation_id) as
        | { invoice: string }
        | undefined;
      if (!quote) {
        throw new ApiError(409, "That quotation is no longer open — it may have already been converted or cancelled.");
      }
      quotationInvoice = quote.invoice;
    }

    let loyaltyBlocked = false;
    if (data.customer_id) {
      const customer = db.prepare(`SELECT id, is_suspended, loyalty_blocked FROM customers WHERE id = ?`).get(data.customer_id) as
        | { id: number; is_suspended: number; loyalty_blocked: number }
        | undefined;
      if (!customer) throw new ApiError(400, "Referenced customer does not exist");
      if (customer.is_suspended) {
        throw new ApiError(409, "This customer is suspended and can't be attached to a new sale until reactivated.");
      }
      loyaltyBlocked = customer.loyalty_blocked === 1;
    }

    // The delivery partner has to be a real, currently-active one. An
    // on-demand one (Uber, PickMe...) has no tariff — its fare is typed
    // in, or left for later (planDelivery below decides what's allowed).
    let partner: DeliveryPartnerRow | undefined;
    if (data.sale_type === "online" && data.delivery_partner) {
      partner = getPartner(data.delivery_partner);
      if (!partner || !partner.is_active) {
        throw new ApiError(400, "That delivery partner isn't available — pick another one.");
      }
    }

    // Credit — in-store or online — is never extended to a walk-in.
    // Enforced here, not just in the UI, since a balance owed needs a
    // real customer record to actually be collectable later.
    const isCredit = data.payment_method === "credit" || data.is_credit_order;
    if (isCredit && !data.customer_id) {
      throw new ApiError(400, "Credit sales require a selected customer — it isn't offered to walk-ins.");
    }

    // An online exchange has to start from an item this customer really has from
    // a delivered order, and be delivered by a partner who can collect it.
    let exchangeSources: ReturnType<typeof checkExchangeSources> | null = null;
    if (data.exchange) {
      if (data.sale_type !== "online") throw new ApiError(400, "An exchange by delivery has to be an online order.");
      if (!partner) throw new ApiError(400, "Pick the delivery partner who will deliver the replacement and collect the old item.");
      if (isCredit) throw new ApiError(400, "An exchange can't be billed on credit.");
      exchangeSources = checkExchangeSources(data.exchange.old_sale_item_ids, data.customer_id);
    }

    // Validate every inventory item up front (must exist and be
    // available) and compute subtotal/discount/total — shared with the
    // quotation endpoint below so a quoted price is always exactly what
    // a real checkout of the same cart would charge.
    const priced = priceItems(data.items, data.manual_discount_type, data.manual_discount_value, data.coupon_code);
    const { subtotal, manual_discount, coupon_discount, coupon_code, discount, total } = priced;
    // Wholesale orders, and customers marked as never earning points, get
    // none — the sale is simply recorded without any.
    const isWholesale = data.is_wholesale || loyaltyBlocked;
    const loyalty_points_earned = isWholesale ? 0 : priced.loyalty_points_earned;

    // Store credit, cash/change, and the resulting payment_status —
    // validated against the customer's REAL store credit balance, never
    // trusted as a client-supplied number.
    const deliveryPlan = data.sale_type === "online" ? planDelivery(data, partner) : null;
    const { storeCreditApplied, productAmountPaid, feePaid, payment_status, change_due, overpaid_amount } = computePaymentOutcome({
      total,
      customer_id: data.customer_id,
      amount_paid: data.amount_paid,
      payment_method: data.payment_method,
      amount_received: data.amount_received,
      keep_cash_overpayment_as_credit: data.keep_cash_overpayment_as_credit,
      store_credit_applied: data.store_credit_applied,
      fee_payable: deliveryPlan && !data.is_credit_order ? deliveryPlan.fee : 0,
    });

    // A sale settled entirely out of store credit took no money at all.
    // The form's default method ("cash") would otherwise get stored and
    // put it under Cash Sales with nothing in the till — so it's recorded
    // as what it really was.
    const storedPaymentMethod =
      storeCreditApplied > 0 && data.amount_paid - change_due <= 0 && !isCredit ? "store_credit" : data.payment_method ?? null;

    // Which of the 5 invoice categories this sale falls into, driving
    // both the invoice prefix and its own independent sequence:
    // STR (in-store paid), SCR (in-store credit), OCD (online COD),
    // OCR (online credit), OPS (online fully paid, nothing owed).
    // is_credit_order is the source of truth for "is this a credit sale"
    // — payment_method may legitimately be "cash"/"card"/"bank_transfer"
    // even on a credit sale, if a partial amount came in through one of
    // those channels, so it can't be used to infer credit status.
    let invoiceCategory: InvoiceCategory;
    if (data.sale_type === "in_store") {
      invoiceCategory = data.is_credit_order || data.payment_method === "credit" ? "SCR" : "STR";
    } else {
      if (data.is_credit_order) invoiceCategory = "OCR";
      else if (payment_status === "paid") invoiceCategory = "OPS";
      else invoiceCategory = "OCD";
    }

    // A checked-out quotation keeps its number — same day code and
    // sequence, just the real category prefix — so the customer's
    // quote and their invoice are visibly the same order.
    const invoice =
      (quotationInvoice && invoiceCodeFromQuotation(quotationInvoice, invoiceCategory)) || nextInvoiceCode(invoiceCategory);

    // What the exchange comes to: the old items' value together comes off this order's
    // total (never more than the total — the rest stays as store credit, or is
    // refunded when the items are received), shared out over the items in order so each
    // one knows its part. The customer's share of the pickup charge is collected with the COD.
    const exchangePlan = exchangeSources
      ? (() => {
          const creditAmount = exchangeSources.reduce((sum, s) => sum + s.unit_price, 0);
          const applied = Math.min(creditAmount, total);
          let pool = applied;
          const items = exchangeSources.map((s) => {
            const share = Math.min(s.unit_price, pool);
            pool -= share;
            return { saleItemId: s.sale_item_id, credit: s.unit_price, share };
          });
          return {
            items,
            creditAmount,
            applied,
            pickupCharge: data.exchange!.pickup_charge,
            sharePct: data.exchange!.customer_share_pct,
            pickupCollected: Math.round((data.exchange!.pickup_charge * data.exchange!.customer_share_pct) / 100),
          };
        })()
      : null;

    // better-sqlite3 transactions are synchronous, which fits perfectly
    // here — no partial writes possible if something throws mid-way.
    const runSaleTransaction = db.transaction(() => {
      const saleResult = db
        .prepare(
          `INSERT INTO sales
             (invoice, customer_id, salesperson, subtotal, discount, manual_discount, coupon_discount, coupon_code,
              total, amount_paid, payment_status, payment_method, sale_type, loyalty_points_earned, is_wholesale,
              amount_received, change_due, overpaid_amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          invoice,
          data.customer_id ?? null,
          data.salesperson ?? null,
          subtotal,
          discount,
          manual_discount,
          coupon_discount,
          coupon_code,
          total,
          productAmountPaid,
          payment_status,
          storedPaymentMethod,
          data.sale_type,
          loyalty_points_earned,
          isWholesale ? 1 : 0,
          data.amount_received ?? null,
          change_due,
          overpaid_amount
        );

      const saleId = saleResult.lastInsertRowid;

      // Redeeming store credit spends it back down with a negative entry
      // — the ledger is what makes the running balance trustworthy.
      if (storeCreditApplied > 0 && data.customer_id) {
        db.prepare(
          `INSERT INTO store_credit_transactions (customer_id, amount, reason, reference_id, notes)
           VALUES (?, ?, 'redemption', ?, ?)`
        ).run(data.customer_id, -storeCreditApplied, saleId, `Applied to invoice ${invoice}`);
      }

      // An overpayment grants store credit for a future purchase, rather
      // than being silently kept as extra income with no record of whom
      // it's owed back to.
      if (overpaid_amount > 0 && data.customer_id) {
        db.prepare(
          `INSERT INTO store_credit_transactions (customer_id, amount, reason, reference_id, notes)
           VALUES (?, ?, 'overpayment', ?, ?)`
        ).run(data.customer_id, overpaid_amount, saleId, `Overpayment on invoice ${invoice}`);
      }

      // Record this as a real transaction, not just a number on the sale
      // — this is what lets a customer's loyalty history actually be
      // reviewed later (when points were earned, from which sale).
      if (data.customer_id && loyalty_points_earned > 0) {
        db.prepare(
          `INSERT INTO loyalty_transactions (customer_id, points, reason, reference_id, notes)
           VALUES (?, ?, 'sale', ?, ?)`
        ).run(data.customer_id, loyalty_points_earned, saleId, `Earned from invoice ${invoice}`);
      }

      for (const item of data.items) {
        db.prepare(
          `INSERT INTO sale_items (sale_id, inventory_id, quantity, unit_price, line_total)
           VALUES (?, ?, 1, ?, ?)`
        ).run(saleId, item.inventory_id, item.unit_price, item.unit_price);

        // Flip the specific physical unit to 'sold' — auto, per your instruction.
        db.prepare(`UPDATE inventory SET status = 'sold' WHERE id = ?`).run(item.inventory_id);
      }

      // Mirror the sale into the cash book as an income entry — net of
      // any change handed back, since that cash left the register again
      // in the same transaction and was never actually retained.
      const netCashPaid = data.amount_paid - change_due;
      if (netCashPaid > 0) {
        db.prepare(
          `INSERT INTO cash_book (transaction_code, type, category, payment_method, reference_id, amount, notes)
           VALUES (?, 'income', 'sale', ?, ?, ?, ?)`
        ).run(nextTransactionCode(), data.payment_method ?? null, saleId, netCashPaid, `Payment for invoice ${invoice}`);
      }

      // Online sales need to ship — auto-create a pending delivery using
      // the customer's default saved address, if they have one and a
      // customer was attached to the sale at all.
      if (data.sale_type === "online") {
        let defaultAddressId: number | null = null;
        if (data.customer_id) {
          const defaultAddress = db
            .prepare(
              `SELECT id FROM customer_addresses WHERE customer_id = ? AND is_default = 1 LIMIT 1`
            )
            .get(data.customer_id) as { id: number } | undefined;
          defaultAddressId = defaultAddress?.id ?? null;
        }
        // An exchange goes back to the same door the old item was delivered to.
        if (exchangeSources?.[0]?.address_id) defaultAddressId = exchangeSources[0].address_id;

        const { isOnDemand, paidBy, riderDirect, actualFare, isFree, fee: delivery_fee } = deliveryPlan!;
        // COD to collect = whatever of the order wasn't already paid,
        // plus the delivery fee (0 if free) — a fixed figure computed
        // once at order time, not recalculated later against a sale
        // that may since have had a return or an added payment.
        // COD = (order total + delivery fee) minus whatever was already
        // paid, floored at 0 — UNLESS the product is on credit, in which
        // case COD is only ever the delivery fee, since the product
        // total is tracked as balance due instead of being collected now.
        // For an exchange the old item's value comes off (once it's collected)
        // and the customer's share of the pickup charge rides along.
        const cod_amount = data.is_credit_order
          ? delivery_fee
          : Math.max(0, total - (exchangePlan?.applied ?? 0) + delivery_fee + (exchangePlan?.pickupCollected ?? 0) - data.amount_paid);

        db.prepare(
          `INSERT INTO deliveries
             (sale_id, address_id, delivery_status, delivery_partner, package_weight_kg,
              is_free_delivery, delivery_fee, cod_amount, tracking_number, delivery_paid_by, actual_fare, rider_direct, fee_paid,
              pickup_collected, notes)
           VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          saleId,
          defaultAddressId,
          data.delivery_partner ?? null,
          data.package_weight_kg ?? null,
          isFree ? 1 : 0,
          delivery_fee,
          cod_amount,
          // An on-demand app has no tracking numbers of its own, so the
          // invoice number doubles as the shipment's tracking barcode.
          isOnDemand ? invoice : null,
          paidBy,
          actualFare,
          riderDirect ? 1 : 0,
          feePaid,
          exchangePlan?.pickupCollected ?? 0,
          exchangeSources
            ? `EXCHANGE — collect the old item${exchangeSources.length > 1 ? "s" : ""} from the customer: ${exchangeSources
                .map(
                  (s) =>
                    `${s.product_title ?? "item"}${[s.size, s.color].filter(Boolean).length ? ` (${[s.size, s.color].filter(Boolean).join(", ")})` : ""} from ${s.invoice}`
                )
                .join("; ")}`
            : null
        );

        if (exchangePlan) {
          const exchangeId = db
            .prepare(
              `INSERT INTO online_exchanges
                 (new_sale_id, old_sale_item_id, credit_amount, applied_amount, pickup_charge, customer_share_pct, pickup_collected)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              saleId,
              exchangePlan.items[0].saleItemId,
              exchangePlan.creditAmount,
              exchangePlan.applied,
              exchangePlan.pickupCharge,
              exchangePlan.sharePct,
              exchangePlan.pickupCollected
            ).lastInsertRowid;
          for (const it of exchangePlan.items) {
            db.prepare(
              `INSERT INTO online_exchange_items (exchange_id, old_sale_item_id, credit_amount, applied_share) VALUES (?, ?, ?, ?)`
            ).run(exchangeId, it.saleItemId, it.credit, it.share);
          }
        }
      }

      // The quotation this sale came from is fully replaced by the
      // real sale now — nothing about it (stock, cash, loyalty) was
      // ever applied, so deleting it (cascading to its items) leaves
      // nothing to reverse.
      if (data.quotation_id) {
        db.prepare(`DELETE FROM sales WHERE id = ? AND status = 'quotation'`).run(data.quotation_id);
      }

      return saleId;
    });

    const saleId = runSaleTransaction();

    const created = db
      .prepare(
        `SELECT sales.*, customers.name as customer_name
         FROM sales LEFT JOIN customers ON customers.id = sales.customer_id
         WHERE sales.id = ?`
      )
      .get(saleId);

    res.status(201).json(created);
  })
);

// POST /api/sales/quotations — save the current cart as a quotation: a
// price-confirmation bill to send the customer before they've actually
// paid, not a real sale. Nothing is committed here — no inventory unit
// is flipped to 'sold', no cash book entry, no loyalty points, no
// delivery. Turning a quotation into a real sale happens by reopening it
// in POS and checking out normally with quotation_id set — see POST /.
salesRouter.post(
  "/quotations",
  asyncHandler(async (req, res) => {
    const data = quotationInput.parse(req.body);

    if (data.customer_id) {
      const customer = db.prepare(`SELECT id, is_suspended FROM customers WHERE id = ?`).get(data.customer_id) as
        | { id: number; is_suspended: number }
        | undefined;
      if (!customer) throw new ApiError(400, "Referenced customer does not exist");
      if (customer.is_suspended) {
        throw new ApiError(409, "This customer is suspended and can't be attached to a new quotation until reactivated.");
      }
    }

    const { subtotal, manual_discount, coupon_discount, coupon_code, discount, total, loyalty_points_earned } = priceItems(
      data.items,
      data.manual_discount_type,
      data.manual_discount_value,
      data.coupon_code
    );

    const invoice = nextQuotationCode();
    const { d: validUntil } = db
      .prepare(`SELECT datetime('now', '+330 minutes', '+' || ? || ' days') as d`)
      .get(data.valid_days) as { d: string };

    const runQuotationTransaction = db.transaction(() => {
      const saleResult = db
        .prepare(
          `INSERT INTO sales
             (invoice, customer_id, salesperson, subtotal, discount, manual_discount, coupon_discount, coupon_code,
              total, amount_paid, payment_status, sale_type, loyalty_points_earned, status, quotation_valid_until)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'unpaid', ?, ?, 'quotation', ?)`
        )
        .run(
          invoice,
          data.customer_id ?? null,
          data.salesperson ?? null,
          subtotal,
          discount,
          manual_discount,
          coupon_discount,
          coupon_code,
          total,
          data.sale_type,
          loyalty_points_earned,
          validUntil
        );

      const saleId = saleResult.lastInsertRowid;

      // Items are recorded against the exact physical units in the
      // cart, same shape as a real sale — but inventory status is left
      // untouched ('available'), since nothing has actually sold yet.
      // If one of these specific units gets sold to someone else before
      // this quotation is converted, that's caught and surfaced at
      // conversion time, not reserved against up front.
      for (const item of data.items) {
        db.prepare(
          `INSERT INTO sale_items (sale_id, inventory_id, quantity, unit_price, line_total)
           VALUES (?, ?, 1, ?, ?)`
        ).run(saleId, item.inventory_id, item.unit_price, item.unit_price);
      }

      return saleId;
    });

    const saleId = runQuotationTransaction();

    const created = db
      .prepare(
        `SELECT sales.*, customers.name as customer_name
         FROM sales LEFT JOIN customers ON customers.id = sales.customer_id
         WHERE sales.id = ?`
      )
      .get(saleId);

    res.status(201).json(created);
  })
);

// PUT /api/sales/quotations/:id — edit an open quotation after the
// customer asked for changes: the whole cart is re-sent (items, discount,
// coupon, customer, type) and replaces what was saved, keeping the same
// number so a bill already sent to the customer still refers to it.
// Pricing is recomputed with the same priceItems() as a new quote or a
// real checkout, and the validity window restarts from today.
salesRouter.put(
  "/quotations/:id",
  asyncHandler(async (req, res) => {
    const data = quotationInput.parse(req.body);

    const existing = db.prepare(`SELECT id, status FROM sales WHERE id = ?`).get(req.params.id) as
      | { id: number; status: string }
      | undefined;
    if (!existing) throw new ApiError(404, "Quotation not found");
    if (existing.status !== "quotation") throw new ApiError(409, "Only an open quotation can be edited.");

    if (data.customer_id) {
      const customer = db.prepare(`SELECT id, is_suspended FROM customers WHERE id = ?`).get(data.customer_id) as
        | { id: number; is_suspended: number }
        | undefined;
      if (!customer) throw new ApiError(400, "Referenced customer does not exist");
      if (customer.is_suspended) {
        throw new ApiError(409, "This customer is suspended and can't be attached to a quotation until reactivated.");
      }
    }

    const { subtotal, manual_discount, coupon_discount, coupon_code, discount, total, loyalty_points_earned } = priceItems(
      data.items,
      data.manual_discount_type,
      data.manual_discount_value,
      data.coupon_code
    );

    const { d: validUntil } = db
      .prepare(`SELECT datetime('now', '+330 minutes', '+' || ? || ' days') as d`)
      .get(data.valid_days) as { d: string };

    db.transaction(() => {
      db.prepare(
        `UPDATE sales SET customer_id = ?, salesperson = ?, subtotal = ?, discount = ?, manual_discount = ?,
                coupon_discount = ?, coupon_code = ?, total = ?, sale_type = ?, loyalty_points_earned = ?,
                quotation_valid_until = ?
         WHERE id = ?`
      ).run(
        data.customer_id ?? null,
        data.salesperson ?? null,
        subtotal,
        discount,
        manual_discount,
        coupon_discount,
        coupon_code,
        total,
        data.sale_type,
        loyalty_points_earned,
        validUntil,
        existing.id
      );

      db.prepare(`DELETE FROM sale_items WHERE sale_id = ?`).run(existing.id);
      for (const item of data.items) {
        db.prepare(
          `INSERT INTO sale_items (sale_id, inventory_id, quantity, unit_price, line_total)
           VALUES (?, ?, 1, ?, ?)`
        ).run(existing.id, item.inventory_id, item.unit_price, item.unit_price);
      }
    })();

    const updated = db
      .prepare(
        `SELECT sales.*, customers.name as customer_name
         FROM sales LEFT JOIN customers ON customers.id = sales.customer_id
         WHERE sales.id = ?`
      )
      .get(existing.id);

    res.json(updated);
  })
);

// DELETE /api/sales/:id/quotation — cancel a quotation that was never
// converted. Safe to actually delete (cascades to its sale_items) since
// nothing about it was ever committed anywhere else — no stock, cash
// book, or loyalty entry exists to reverse.
salesRouter.delete(
  "/:id/quotation",
  asyncHandler(async (req, res) => {
    const sale = db.prepare(`SELECT id, status FROM sales WHERE id = ?`).get(req.params.id) as
      | { id: number; status: string }
      | undefined;
    if (!sale) throw new ApiError(404, "Quotation not found");
    if (sale.status !== "quotation") throw new ApiError(409, "Only a quotation that hasn't been converted can be cancelled this way.");

    db.prepare(`DELETE FROM sales WHERE id = ?`).run(sale.id);
    res.status(204).send();
  })
);

// PUT /api/sales/:id/payment — record an additional payment against an existing sale
// (handles the "partial payment paid off later" case)
salesRouter.put(
  "/:id/payment",
  asyncHandler(async (req, res) => {
    const amountSchema = z.object({ amount: z.number().positive(), payment_method: z.string().optional() });
    const { amount, payment_method } = amountSchema.parse(req.body);

    const sale = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(req.params.id) as any;
    if (!sale) throw new ApiError(404, "Sale not found");

    const newAmountPaid = sale.amount_paid + amount;
    let payment_status: "paid" | "partial" | "unpaid" = "unpaid";
    if (newAmountPaid >= sale.total) payment_status = "paid";
    else if (newAmountPaid > 0) payment_status = "partial";

    const runPaymentTransaction = db.transaction(() => {
      db.prepare(`UPDATE sales SET amount_paid = ?, payment_status = ? WHERE id = ?`).run(
        newAmountPaid,
        payment_status,
        req.params.id
      );

      db.prepare(
        `INSERT INTO cash_book (transaction_code, type, category, payment_method, reference_id, amount, notes)
         VALUES (?, 'income', 'sale', ?, ?, ?, ?)`
      ).run(nextTransactionCode(), payment_method ?? null, req.params.id, amount, `Additional payment for invoice ${sale.invoice}`);
    });

    runPaymentTransaction();

    const updated = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// PUT /api/sales/:id/confirm-cod — "Mark as paid / COD collected", for an
// order that WAS delivered by the shop itself (not a courier) and paid
// for on delivery. One atomic action: creates a cashbook entry for the
// exact order total and flips payment_status to 'paid', together — never
// two separate steps someone could do one of and forget the other.
// Exact amount only (no partial/discount handling) — a mismatch between
// what was collected and the order total is handled manually outside
// the system, per the owner's own call.
salesRouter.put(
  "/:id/confirm-cod",
  asyncHandler(async (req, res) => {
    const bodySchema = z.object({ payment_method: z.enum(["cash", "bank_transfer", "card"]) });
    const { payment_method } = bodySchema.parse(req.body);

    const sale = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(req.params.id) as any;
    if (!sale) throw new ApiError(404, "Sale not found");
    if (sale.is_voided) throw new ApiError(409, "This sale has been voided");
    if (sale.payment_status === "paid") throw new ApiError(409, "This sale is already marked as paid");

    // This action is only for orders the shop delivered itself (D2D). A
    // courier-delivered order (CPAK/DEX) holds the cash until settlement
    // — confirming it here would wrongly record money that hasn't
    // actually reached the shop yet, and would also make that delivery
    // invisible to courier settlement, since the system would think it
    // was already paid. No delivery record at all is treated the same
    // as self-delivered, since no courier was ever assigned to it.
    // An on-demand partner (Uber, PickMe...) isn't a courier that holds
    // COD for later settlement either — whoever delivers hands the cash
    // straight over — so it's confirmed here like a self-delivery.
    const delivery = db
      .prepare(
        `SELECT deliveries.delivery_partner, delivery_partners.kind as kind
         FROM deliveries LEFT JOIN delivery_partners ON delivery_partners.code = deliveries.delivery_partner
         WHERE deliveries.sale_id = ?`
      )
      .get(req.params.id) as { delivery_partner: string | null; kind: string | null } | undefined;
    if (delivery && delivery.delivery_partner && delivery.delivery_partner !== "D2D" && delivery.kind !== "on_demand") {
      throw new ApiError(
        409,
        "This order was shipped via a courier — its COD is collected by them and settled separately, not confirmed here."
      );
    }

    const remaining = sale.total - sale.amount_paid;
    if (remaining <= 0) throw new ApiError(409, "This sale has nothing outstanding to collect");

    const runConfirm = db.transaction(() => {
      db.prepare(`UPDATE sales SET amount_paid = total, payment_status = 'paid' WHERE id = ?`).run(req.params.id);

      db.prepare(
        `INSERT INTO cash_book (transaction_code, type, category, payment_method, reference_id, amount, notes)
         VALUES (?, 'income', 'sale', ?, ?, ?, ?)`
      ).run(nextTransactionCode(), payment_method, req.params.id, remaining, `COD collected on delivery — invoice ${sale.invoice}`);
    });

    runConfirm();

    const updated = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// PUT /api/sales/:id/undo-cod — reverse a "Mark as paid / COD collected"
// confirmation made by mistake, within 24 hours of it happening. Only
// undoes what that specific action did: restores amount_paid/status to
// what they were right before it, and removes the ONE cash book entry
// it created (matched precisely by its note text, not just category +
// reference_id, since a sale could separately have an earlier partial
// payment entry that must NOT be touched by this). Never touches stock
// or the delivery — for anything bigger than a payment-recording
// mistake, voiding the whole sale is the right tool, not this.
salesRouter.put(
  "/:id/undo-cod",
  asyncHandler(async (req, res) => {
    const sale = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(req.params.id) as any;
    if (!sale) throw new ApiError(404, "Sale not found");

    const noteMarker = `COD collected on delivery — invoice ${sale.invoice}`;
    const entry = db
      .prepare(`SELECT * FROM cash_book WHERE category = 'sale' AND reference_id = ? AND notes = ? ORDER BY id DESC LIMIT 1`)
      .get(req.params.id, noteMarker) as any;
    if (!entry) throw new ApiError(404, "No COD confirmation found for this sale to undo");

    const hoursSince = (Date.now() - new Date(entry.entry_date).getTime()) / (1000 * 60 * 60);
    if (hoursSince > 24) {
      throw new ApiError(409, "This confirmation is more than 24 hours old and can no longer be undone this way.");
    }

    // Never delete the original entry — a real financial ledger should
    // show both the mistake and the correction as real events, not
    // pretend the first one never happened. Undoing twice is blocked by
    // checking a reversal for this exact entry doesn't already exist.
    const reversalNote = `Reversed payment of invoice ${sale.invoice} (COD confirmation undone)`;
    const alreadyReversed = db
      .prepare(`SELECT id FROM cash_book WHERE category = 'sale' AND reference_id = ? AND notes = ?`)
      .get(req.params.id, reversalNote);
    if (alreadyReversed) throw new ApiError(409, "This confirmation has already been undone");

    const runUndo = db.transaction(() => {
      const restoredAmountPaid = Math.max(0, sale.amount_paid - entry.amount);
      let restoredStatus: "paid" | "partial" | "unpaid" = "unpaid";
      if (restoredAmountPaid >= sale.total && sale.total > 0) restoredStatus = "paid";
      else if (restoredAmountPaid > 0) restoredStatus = "partial";

      db.prepare(`UPDATE sales SET amount_paid = ?, payment_status = ? WHERE id = ?`).run(
        restoredAmountPaid,
        restoredStatus,
        req.params.id
      );

      db.prepare(
        `INSERT INTO cash_book (transaction_code, type, category, payment_method, reference_id, amount, notes)
         VALUES (?, 'expense', 'sale', ?, ?, ?, ?)`
      ).run(nextTransactionCode(), entry.payment_method, req.params.id, entry.amount, reversalNote);
    });

    runUndo();

    const updated = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);
// PUT /api/sales/:id/wholesale — admin-only. Marks a sale that already went
// through as wholesale and takes back the loyalty points it earned (one
// ledger entry, so the history shows it). If the customer has already
// spent some of those points (redeemed for store credit), only what's still
// there is taken back and the rest is reported, not clawed out of negative.
salesRouter.put(
  "/:id/wholesale",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().max(200).optional() }).parse(req.body);
    const sale = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(req.params.id) as any;
    if (!sale) throw new ApiError(404, "Sale not found");
    if (sale.status === "quotation") throw new ApiError(409, "A quotation hasn't earned any points.");
    if (sale.is_voided) throw new ApiError(409, "This sale was voided — its points were already reversed.");
    if (sale.is_wholesale) throw new ApiError(409, "This sale is already marked wholesale.");

    const earned: number = sale.loyalty_points_earned;
    const available = sale.customer_id ? Math.max(0, loyaltyBalance(sale.customer_id)) : 0;
    const removed = Math.min(earned, available);

    db.transaction(() => {
      db.prepare(`UPDATE sales SET is_wholesale = 1, loyalty_points_earned = 0 WHERE id = ?`).run(sale.id);
      if (removed > 0) {
        db.prepare(
          `INSERT INTO loyalty_transactions (customer_id, points, reason, reference_id, notes)
           VALUES (?, ?, 'manual_adjustment', ?, ?)`
        ).run(sale.customer_id, -removed, sale.id, `Wholesale order — points removed, invoice ${sale.invoice}${reason ? ` (${reason})` : ""}`);
      }
    })();

    logAudit(
      req.user!,
      "sale_wholesale",
      "sale",
      sale.id,
      `${sale.invoice}: marked wholesale — ${removed} loyalty points removed${removed < earned ? ` (${earned - removed} had already been spent)` : ""}${reason ? ` — ${reason}` : ""}`
    );
    res.json({ sale: db.prepare(`SELECT * FROM sales WHERE id = ?`).get(sale.id), points_removed: removed, points_already_used: earned - removed });
  })
);

// billing mistake: every sold unit goes back to 'available', the income
// entry is reversed in the cash book, and any pending delivery is
// cancelled. The sale record itself is kept (is_voided = 1) rather than
// deleted, so it stays visible in Sale History for audit — including
// the original prices, which is what lets a receipt still show
// "was Rs. X, sold at Rs. Y" after the fact.
salesRouter.put(
  "/:id/void",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const reasonInput = z.object({ reason: z.string().optional() }).parse(req.body);

    const sale = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(req.params.id) as any;
    if (!sale) throw new ApiError(404, "Sale not found");
    if (sale.is_voided) throw new ApiError(409, "This sale has already been voided.");

    const items = db.prepare(`SELECT * FROM sale_items WHERE sale_id = ?`).all(req.params.id) as any[];

    const runVoidTransaction = db.transaction(() => {
      // A voided replacement order ends its exchange too: the old item stays with
      // the customer, nothing was taken off anything.
      cancelExchangeForSale(sale.id, "The replacement invoice was voided");

      // Return each physical unit to sellable stock.
      for (const item of items) {
        db.prepare(`UPDATE inventory SET status = 'available' WHERE id = ?`).run(item.inventory_id);
      }

      // Reverse the income entry, so cash-on-hand and reports reflect
      // that this money was never actually kept. sale.amount_paid also
      // includes any store credit redeemed toward this sale (see the
      // effectiveAmountPaid calc on create) — that portion was never real
      // cash/bank money and was never added to the cash book as income in
      // the first place, so it must be excluded here too or this reversal
      // overstates the expense and fabricates a cash shortfall.
      const creditRedeemed = db
        .prepare(
          `SELECT COALESCE(SUM(-amount), 0) as total FROM store_credit_transactions
           WHERE reference_id = ? AND reason = 'redemption'`
        )
        .get(sale.id) as { total: number };
      // A prepaid online order also took in its delivery fee up front
      // (kept on the delivery, not in amount_paid) — give that back too.
      const feePaidRow = db.prepare(`SELECT COALESCE(SUM(fee_paid), 0) as total FROM deliveries WHERE sale_id = ?`).get(sale.id) as {
        total: number;
      };
      const cashPortionPaid = sale.amount_paid + feePaidRow.total - creditRedeemed.total;
      if (cashPortionPaid > 0) {
        db.prepare(
          `INSERT INTO cash_book (transaction_code, type, category, payment_method, reference_id, amount, notes)
           VALUES (?, 'expense', 'sale_void', ?, ?, ?, ?)`
        ).run(nextTransactionCode(), sale.payment_method ?? null, sale.id, cashPortionPaid, `Reversal of voided invoice ${sale.invoice}`);
      }

      // Cancel any delivery tied to this sale rather than leaving it
      // stranded in the pipeline for an order that no longer exists.
      db.prepare(`UPDATE deliveries SET delivery_status = 'cancelled', notes = 'Sale voided' WHERE sale_id = ?`).run(sale.id);

      // Reverse any loyalty points this sale earned with an explicit
      // negative entry, so the ledger itself tells the full story rather
      // than relying only on customer queries filtering out voided sales.
      if (sale.customer_id && sale.loyalty_points_earned > 0) {
        db.prepare(
          `INSERT INTO loyalty_transactions (customer_id, points, reason, reference_id, notes)
           VALUES (?, ?, 'manual_adjustment', ?, ?)`
        ).run(sale.customer_id, -sale.loyalty_points_earned, sale.id, `Reversal — invoice ${sale.invoice} voided`);
      }

      // Reverse any store credit this sale granted (overpayment) or spent
      // (redemption) — a voided sale should leave the customer's credit
      // balance exactly as if the sale had never happened.
      const creditEntries = db
        .prepare(`SELECT * FROM store_credit_transactions WHERE reference_id = ?`)
        .all(sale.id) as { amount: number }[];
      for (const entry of creditEntries) {
        db.prepare(
          `INSERT INTO store_credit_transactions (customer_id, amount, reason, reference_id, notes)
           VALUES (?, ?, 'manual_adjustment', ?, ?)`
        ).run(sale.customer_id, -entry.amount, sale.id, `Reversal — invoice ${sale.invoice} voided`);
      }

      db.prepare(
        `UPDATE sales SET is_voided = 1, voided_at = datetime('now', '+330 minutes'), void_reason = ? WHERE id = ?`
      ).run(reasonInput.reason ?? null, req.params.id);
    });

    runVoidTransaction();

    logAudit(
      req.user!,
      "sale_void",
      "sale",
      sale.id,
      `Voided sale ${sale.invoice} (Rs. ${sale.total.toLocaleString()})${reasonInput.reason ? ` — ${reasonInput.reason}` : ""}`
    );

    const updated = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);
