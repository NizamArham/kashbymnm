import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";
import { applyReturnCharge } from "./courierReconciliation";
import { citypakCreateOrder } from "../lib/citypak";
import { fardarCreateParcel } from "../lib/fardar";
import { syncCitypak } from "../lib/courierSync";
import { getPartner, planDelivery } from "../lib/deliveryPartners";
import { logAudit } from "../lib/auditLog";

export const deliveriesRouter = Router();

// Admin only, per the access model (staff don't handle courier/delivery logistics).
deliveriesRouter.use(requireAuth, requireRole("admin"));

const deliveryInput = z.object({
  sale_id: z.number().int().positive(),
  address_id: z.number().int().positive().optional(),
  courier_name: z.string().optional(),
  tracking_number: z.string().optional(),
  delivery_fee: z.number().nonnegative().default(0),
  notes: z.string().optional(),
});

function nextWaybillNumber(): string {
  const row = db
    .prepare(`SELECT waybill_number FROM deliveries WHERE waybill_number LIKE 'WB-%' ORDER BY id DESC LIMIT 1`)
    .get() as { waybill_number: string } | undefined;
  let nextNum = 1;
  if (row?.waybill_number) {
    const num = parseInt(row.waybill_number.split("-")[1], 10);
    if (!isNaN(num)) nextNum = num + 1;
  }
  return `WB-${String(nextNum).padStart(5, "0")}`;
}

// GET /api/deliveries — optionally filter by ?status=
deliveriesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const where = req.query.status ? "WHERE deliveries.delivery_status = ?" : "";
    const params = req.query.status ? [req.query.status] : [];

    const rows = db
      .prepare(
        `SELECT deliveries.*, sales.invoice, sales.date as sale_date, sales.total as sale_total,
                sales.customer_id as customer_id,
                customers.name as customer_name, customers.phone as customer_phone,
                customer_addresses.address_line1, customer_addresses.address_line2, customer_addresses.city
         FROM deliveries
         JOIN sales ON sales.id = deliveries.sale_id
         LEFT JOIN customers ON customers.id = sales.customer_id
         LEFT JOIN customer_addresses ON customer_addresses.id = deliveries.address_id
         ${where}
         ORDER BY deliveries.id DESC`
      )
      .all(...params);
    res.json(rows);
  })
);

// GET /api/deliveries/:id — includes sale items, needed for the waybill
deliveriesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = db
      .prepare(
        `SELECT deliveries.*, sales.invoice, sales.date as sale_date, sales.total as sale_total,
                sales.customer_id as customer_id,
                customers.name as customer_name, customers.phone as customer_phone,
                customer_addresses.address_line1, customer_addresses.address_line2, customer_addresses.city
         FROM deliveries
         JOIN sales ON sales.id = deliveries.sale_id
         LEFT JOIN customers ON customers.id = sales.customer_id
         LEFT JOIN customer_addresses ON customer_addresses.id = deliveries.address_id
         WHERE deliveries.id = ?`
      )
      .get(req.params.id) as any;
    if (!row) throw new ApiError(404, "Delivery not found");

    const items = db
      .prepare(
        `SELECT sale_items.*, COALESCE(products.product_title, sale_items.product_snapshot) as product_title,
                products.brand, inventory.sku, inventory.size, inventory.color
         FROM sale_items
         LEFT JOIN inventory ON inventory.id = sale_items.inventory_id
         LEFT JOIN products ON products.id = inventory.product_id
         WHERE sale_items.sale_id = ?`
      )
      .all(row.sale_id);

    res.json({ ...row, items });
  })
);

// POST /api/deliveries — create a delivery record for a sale
deliveriesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = deliveryInput.parse(req.body);

    const sale = db.prepare(`SELECT id FROM sales WHERE id = ?`).get(data.sale_id);
    if (!sale) throw new ApiError(400, "Referenced sale does not exist");

    if (data.address_id) {
      const address = db
        .prepare(`SELECT id FROM customer_addresses WHERE id = ?`)
        .get(data.address_id);
      if (!address) throw new ApiError(400, "Referenced address does not exist");
    }

    const result = db
      .prepare(
        `INSERT INTO deliveries (sale_id, address_id, courier_name, tracking_number, delivery_fee, notes)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.sale_id,
        data.address_id ?? null,
        data.courier_name ?? null,
        data.tracking_number ?? null,
        data.delivery_fee,
        data.notes ?? null
      );

    const created = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(created);
  })
);

// PUT /api/deliveries/:id/address — switches this order to a different one
// of the customer's saved addresses. Needed because the address on a
// delivery is fixed at order time (whichever one was picked at checkout),
// so a customer with 2+ saved addresses — or one whose attached address
// turns out to be missing/incomplete — otherwise has no way to be
// corrected here before confirming.
deliveriesRouter.put(
  "/:id/address",
  asyncHandler(async (req, res) => {
    const { address_id } = z.object({ address_id: z.number().int().positive() }).parse(req.body);

    const delivery = db
      .prepare(`SELECT deliveries.id, sales.customer_id FROM deliveries JOIN sales ON sales.id = deliveries.sale_id WHERE deliveries.id = ?`)
      .get(req.params.id) as { id: number; customer_id: number | null } | undefined;
    if (!delivery) throw new ApiError(404, "Delivery not found");

    const address = db.prepare(`SELECT id FROM customer_addresses WHERE id = ? AND customer_id = ?`).get(address_id, delivery.customer_id);
    if (!address) throw new ApiError(400, "That address doesn't belong to this order's customer");

    db.prepare(`UPDATE deliveries SET address_id = ? WHERE id = ?`).run(address_id, req.params.id);
    const updated = db
      .prepare(
        `SELECT deliveries.*, customer_addresses.address_line1, customer_addresses.address_line2, customer_addresses.city
         FROM deliveries
         LEFT JOIN customer_addresses ON customer_addresses.id = deliveries.address_id
         WHERE deliveries.id = ?`
      )
      .get(req.params.id);
    res.json(updated);
  })
);

// POST /api/deliveries/:id/citypak-order — creates the shipment on
// CityPak's side via their API (rather than staff creating it manually
// on CityPak's own portal and pasting the tracking number back here).
// Only valid for orders already assigned to CityPak as the delivery
// partner; the returned tracking number is handed back to the client to
// feed into the normal /pack flow exactly as a manually-typed one would.
deliveriesRouter.post(
  "/:id/citypak-order",
  asyncHandler(async (req, res) => {
    const delivery = db
      .prepare(
        `SELECT deliveries.*, sales.invoice, sales.customer_id,
                customers.name as customer_name, customers.phone as customer_phone,
                customer_addresses.address_line1, customer_addresses.address_line2, customer_addresses.city
         FROM deliveries
         JOIN sales ON sales.id = deliveries.sale_id
         LEFT JOIN customers ON customers.id = sales.customer_id
         LEFT JOIN customer_addresses ON customer_addresses.id = deliveries.address_id
         WHERE deliveries.id = ?`
      )
      .get(req.params.id) as any;
    if (!delivery) throw new ApiError(404, "Delivery not found");
    if (delivery.delivery_partner !== "CPAK") {
      throw new ApiError(400, "This order isn't assigned to CityPak as its delivery partner");
    }
    if (!delivery.address_line1 || !delivery.city) {
      throw new ApiError(400, "This order has no delivery address on file");
    }
    if (!delivery.customer_phone) {
      throw new ApiError(400, "This order's customer has no phone number on file");
    }

    const business = db.prepare(`SELECT * FROM business_info LIMIT 1`).get() as any;
    if (!business?.address_line1 || !business?.city || !business?.phone) {
      throw new ApiError(400, "Add your business address, city, and phone in General Settings before creating CityPak shipments");
    }

    const weightKg = delivery.package_weight_kg && delivery.package_weight_kg > 0 ? delivery.package_weight_kg : 0.5;

    const result = await citypakCreateOrder({
      reference: delivery.invoice,
      from_name: business.business_name || "M&M Clothing",
      from_address_line_1: business.address_line1,
      from_address_line_2: business.address_line2 || undefined,
      from_address_line_4: business.city,
      from_contact_name: business.business_name || "M&M Clothing",
      from_contact_1: business.phone,
      to_name: delivery.customer_name || "Customer",
      to_address_line_1: delivery.address_line1,
      to_address_line_2: delivery.address_line2 || undefined,
      to_address_line_4: delivery.city,
      to_contact_name: delivery.customer_name || "Customer",
      to_contact_1: delivery.customer_phone,
      description: `Order ${delivery.invoice}`.slice(0, 128),
      weight_g: Math.round(weightKg * 1000),
      cash_on_delivery_amount: delivery.cod_amount || 0,
      number_of_pieces: 1,
    });

    db.prepare(`UPDATE deliveries SET citypak_order_id = ? WHERE id = ?`).run(result.order_id, req.params.id);

    res.json({ tracking_number: result.tracking_number, order_id: result.order_id });
  })
);

// Sri Lankan mobile/landline numbers are stored however they were typed
// (often without the leading 0, e.g. 775441297) — Fardar wants the usual
// 10-digit form, so numbers are tidied to that before they're sent.
function toLocalPhone(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("94") && digits.length === 11) return `0${digits.slice(2)}`;
  if (digits.length === 9) return `0${digits}`;
  return digits;
}

// POST /api/deliveries/:id/fardar-order — creates the parcel on Fardar's
// side via their API and hands back the waybill number to use as this
// order's tracking number (the same role as /citypak-order). Our own
// waybill label is still what gets printed. The tracking number is saved
// on the delivery straight away: Fardar has no way for this system to
// cancel a parcel, so a second click (or reopening the window) must not
// quietly book a duplicate.
deliveriesRouter.post(
  "/:id/fardar-order",
  asyncHandler(async (req, res) => {
    const delivery = db
      .prepare(
        `SELECT deliveries.*, sales.invoice,
                customers.name as customer_name, customers.phone as customer_phone, customers.phone2 as customer_phone2,
                customer_addresses.address_line1, customer_addresses.address_line2, customer_addresses.city
         FROM deliveries
         JOIN sales ON sales.id = deliveries.sale_id
         LEFT JOIN customers ON customers.id = sales.customer_id
         LEFT JOIN customer_addresses ON customer_addresses.id = deliveries.address_id
         WHERE deliveries.id = ?`
      )
      .get(req.params.id) as any;
    if (!delivery) throw new ApiError(404, "Delivery not found");
    if (delivery.delivery_partner !== "FDR") {
      throw new ApiError(400, "This order isn't assigned to Fardar as its delivery partner");
    }
    if (delivery.tracking_number && delivery.tracking_number !== delivery.invoice) {
      throw new ApiError(
        409,
        `This order already has a Fardar waybill (${delivery.tracking_number}) — use that rather than booking a second parcel.`
      );
    }
    if (!delivery.address_line1 || !delivery.city) {
      throw new ApiError(400, "This order has no delivery address on file");
    }
    const phone1 = toLocalPhone(delivery.customer_phone);
    if (!phone1) throw new ApiError(400, "This order's customer has no phone number on file");

    // One entry per product, quantities added up — the same grouping the
    // bill and the waybill label use.
    const itemRows = db
      .prepare(
        `SELECT COALESCE(products.product_title, sale_items.product_snapshot, 'Item') AS title, SUM(sale_items.quantity) AS qty
         FROM sale_items
         LEFT JOIN inventory ON inventory.id = sale_items.inventory_id
         LEFT JOIN products ON products.id = inventory.product_id
         WHERE sale_items.sale_id = ?
         GROUP BY title`
      )
      .all(delivery.sale_id) as { title: string; qty: number }[];
    const description = itemRows.map((r) => `${r.title} x${r.qty}`).join(", ").slice(0, 150) || `Order ${delivery.invoice}`;

    const phone2 = toLocalPhone(delivery.customer_phone2);
    const waybill = await fardarCreateParcel({
      order_id: delivery.invoice,
      parcel_weight: delivery.package_weight_kg && delivery.package_weight_kg > 0 ? delivery.package_weight_kg : 0.5,
      parcel_description: description,
      recipient_name: delivery.customer_name || "Customer",
      recipient_contact_1: phone1,
      recipient_contact_2: phone2 && phone2 !== phone1 ? phone2 : undefined,
      recipient_address: [delivery.address_line1, delivery.address_line2].filter(Boolean).join(", "),
      // Postal-list names carry a district code ("Talawa(KG)") that
      // isn't part of the city's name.
      recipient_city: String(delivery.city).replace(/\s*\(.*?\)\s*$/, "").trim(),
      // What the courier collects on delivery (0 when it's prepaid).
      amount: delivery.cod_amount || 0,
      exchange: false,
    });

    db.prepare(`UPDATE deliveries SET tracking_number = ? WHERE id = ?`).run(waybill, delivery.id);
    res.json({ tracking_number: waybill });
  })
);

// POST /api/deliveries/sync-couriers — ask CityPak right now where the
// open parcels are, instead of waiting for the automatic check. (Fardar
// has no lookup — it sends its updates to /api/webhooks/fardar itself.)
deliveriesRouter.post(
  "/sync-couriers",
  asyncHandler(async (_req, res) => {
    if (!process.env.CITYPAK_API_TOKEN) {
      throw new ApiError(400, "CityPak isn't configured — add CITYPAK_BASE_URL and CITYPAK_API_TOKEN to server/.env, then restart the server.");
    }
    res.json(await syncCitypak());
  })
);

// PUT /api/deliveries/:id/partner — switch which delivery partner an
// order ships with, any time before the courier actually has it
// (pending or packed — once dispatched, COD and settlement are already
// tied to that courier).
// - Another courier: only the partner changes. The delivery charge the
//   customer was quoted (and any COD) is left exactly as agreed — the
//   courier's own cost is worked out from ITS tariff at settlement.
// - Uber / PickMe-style on-demand: priced the same way POS does it —
//   the fare is typed in, plus who pays (customer / free / we pay now).
// The previous courier's tracking number and waybill no longer mean
// anything, so they're cleared (a packed order goes back to pending to
// get a fresh waybill) and the old details are kept in the notes.
deliveriesRouter.put(
  "/:id/partner",
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        delivery_partner: z.string().min(1),
        delivery_fare: z.number().nonnegative().optional(),
        delivery_paid_by: z.enum(["customer", "shop", "shop_upfront"]).optional(),
      })
      .parse(req.body);

    const d = db
      .prepare(
        `SELECT deliveries.*, sales.invoice, sales.is_voided, sales.payment_method AS sale_payment_method
         FROM deliveries JOIN sales ON sales.id = deliveries.sale_id
         WHERE deliveries.id = ?`
      )
      .get(req.params.id) as any;
    if (!d) throw new ApiError(404, "Delivery not found");
    if (d.is_voided) throw new ApiError(409, "This order's sale was voided — there's nothing to reassign.");
    if (d.delivery_status !== "pending" && d.delivery_status !== "packed") {
      throw new ApiError(409, `This order is already ${d.delivery_status} — the courier has it, so its partner can't be changed anymore.`);
    }

    const partner = getPartner(data.delivery_partner);
    if (!partner || !partner.is_active) throw new ApiError(400, "That delivery partner isn't available — pick another one.");
    if (partner.code === d.delivery_partner) throw new ApiError(400, `This order is already assigned to ${partner.name}.`);
    const oldPartner = getPartner(d.delivery_partner);

    let fee: number = d.delivery_fee;
    let cod: number = d.cod_amount;
    let isFree: number = d.is_free_delivery;
    let paidBy: string | null = null;
    let actualFare: number | null = null;

    if (partner.kind === "on_demand") {
      if (!(data.delivery_fare && data.delivery_fare > 0)) {
        throw new ApiError(400, `Enter the delivery fare for ${partner.name}.`);
      }
      const plan = planDelivery(
        { is_free_delivery: false, delivery_fare: data.delivery_fare, delivery_paid_by: data.delivery_paid_by },
        partner
      );
      if (d.fee_paid > plan.fee) {
        throw new ApiError(
          409,
          `The customer already paid Rs. ${d.fee_paid.toLocaleString()} for delivery, which is more than the Rs. ${plan.fee.toLocaleString()} this would charge — choose "Customer pays" with a fare of at least that.`
        );
      }
      // A credit order only ever collects the fee on delivery; an
      // ordinary one owes whatever was unpaid, adjusted by how the
      // delivery charge changed.
      cod = d.sale_payment_method === "credit" ? plan.fee : Math.max(0, d.cod_amount - d.delivery_fee + plan.fee);
      fee = plan.fee;
      isFree = plan.isFree ? 1 : 0;
      paidBy = plan.paidBy;
      actualFare = plan.actualFare;
    }

    const trackingBefore: string | null = d.tracking_number && d.tracking_number !== d.invoice ? d.tracking_number : null;
    const note = `Reassigned from ${oldPartner?.name ?? d.delivery_partner ?? "no partner"}${
      trackingBefore ? ` (tracking ${trackingBefore})` : ""
    } to ${partner.name}`;

    db.prepare(
      `UPDATE deliveries
       SET delivery_partner = ?, delivery_fee = ?, cod_amount = ?, is_free_delivery = ?,
           delivery_paid_by = ?, actual_fare = ?,
           tracking_number = ?, citypak_order_id = NULL,
           delivery_status = 'pending', waybill_number = NULL, packed_at = NULL,
           notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || char(10) || ? END
       WHERE id = ?`
    ).run(
      partner.code,
      fee,
      cod,
      isFree,
      paidBy,
      actualFare,
      // an on-demand app has no tracking numbers, so the invoice number
      // stands in; a courier gets its own once the waybill is generated
      partner.kind === "on_demand" ? d.invoice : null,
      note,
      note,
      d.id
    );

    logAudit(req.user!, "delivery_partner_change", "delivery", d.id, `${d.invoice}: ${note}`);
    res.json(db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(d.id));
  })
);

// PUT /api/deliveries/:id/pack — Pending -> Packed, generates the waybill
// number. This is the "Generate Waybill" action from the Pending tab.
// The address is reviewable (and switchable, to another of the
// customer's saved ones) right there in the same modal before packing,
// so there's no separate "confirm address" gate to pass first.
deliveriesRouter.put(
  "/:id/pack",
  asyncHandler(async (req, res) => {
    const data = z.object({ courier_name: z.string().optional(), tracking_number: z.string().optional() }).parse(req.body);
    const existing = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Delivery not found");
    if (existing.delivery_status !== "pending") {
      throw new ApiError(409, `This order is already ${existing.delivery_status} — only pending orders can be packed.`);
    }

    const waybill_number = nextWaybillNumber();
    db.prepare(
      `UPDATE deliveries
       SET delivery_status = 'packed', waybill_number = ?, packed_at = datetime('now', '+330 minutes'),
           address_confirmed = 1, address_confirmed_at = datetime('now', '+330 minutes'),
           courier_name = COALESCE(?, courier_name), tracking_number = COALESCE(?, tracking_number)
       WHERE id = ?`
    ).run(waybill_number, data.courier_name ?? null, data.tracking_number ?? null, req.params.id);

    const updated = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// PUT /api/deliveries/:id/dispatch — Packed -> Dispatched
deliveriesRouter.put(
  "/:id/dispatch",
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Delivery not found");
    if (existing.delivery_status !== "packed") {
      throw new ApiError(409, "Only packed orders (with a waybill) can be dispatched.");
    }

    db.prepare(`UPDATE deliveries SET delivery_status = 'dispatched', dispatched_at = datetime('now', '+330 minutes') WHERE id = ?`).run(req.params.id);
    const updated = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// PUT /api/deliveries/:id/deliver — Dispatched -> Delivered
deliveriesRouter.put(
  "/:id/deliver",
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Delivery not found");
    if (existing.delivery_status !== "dispatched") {
      throw new ApiError(409, "Only dispatched orders can be marked delivered.");
    }

    db.prepare(`UPDATE deliveries SET delivery_status = 'delivered', delivery_date = datetime('now', '+330 minutes') WHERE id = ?`).run(req.params.id);
    const updated = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// PUT /api/deliveries/:id/return — reachable from packed or dispatched;
// a separate terminal state rather than a step in the forward pipeline.
deliveriesRouter.put(
  "/:id/return",
  asyncHandler(async (req, res) => {
    const data = z.object({ notes: z.string().optional() }).parse(req.body);
    const existing = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "Delivery not found");
    if (!["packed", "dispatched"].includes(existing.delivery_status)) {
      throw new ApiError(409, "Only packed or dispatched orders can be marked returned.");
    }

    db.prepare(`UPDATE deliveries SET delivery_status = 'returned', notes = COALESCE(?, notes) WHERE id = ?`).run(
      data.notes ?? null,
      req.params.id
    );

    // Only a delivery the courier actually had (dispatched) incurs a
    // return-trip fee — one that never left "packed" was never picked up,
    // so there's no return leg for the courier to charge for.
    if (existing.delivery_status === "dispatched") {
      applyReturnCharge(existing);
    }

    const updated = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

