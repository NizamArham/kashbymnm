import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, AuthUser } from "../lib/auth";
import { requireAdminOrApproval, approveIfNeeded, arrivalApprovalReasons, recordedByAdmin, actorOf } from "../lib/approval";
import { logAudit } from "../lib/auditLog";
import { nextTransactionCode } from "../lib/codes";
import { getPartner } from "../lib/deliveryPartners";
import { itemInActiveExchange } from "../lib/exchanges";
import { customerShareOf, itemInActivePickup, listPickups, pickupById } from "../lib/onlineReturns";
import { approveReturnRequest } from "./returns";
import { bookCourierCharge } from "./courierReconciliation";

// A COURIER RETURN, step by step (see lib/onlineReturns.ts for the stages):
//   request → admin approves (the customer may send it back) → [customer sent it] → we mark it received (which service, tracking number,
//   what we paid) → we inspect it and file a report (each item sellable / damaged / can't take back, and who pays the delivery) → an admin
//   approves the report (stock back, credit granted, refund owed) → the refund is paid with the customer's bank details and marked done
//   (cash book) → completed. An admin's own request / report is approved on the spot ("Auto-approved (recorded by admin)").

export const returnPickupsRouter = Router();

returnPickupsRouter.use(requireAuth);

const NOW = `datetime('now', '+330 minutes')`;

// GET /api/return-pickups?status=open|closed|pending|report|all — the courier returns, newest first. open = approved and not finished;
// pending = requests waiting for an admin's yes; report = inspection reports waiting for an admin; all = everything but pending requests.
returnPickupsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = String(req.query.status ?? "open");
    const status = q === "closed" || q === "all" || q === "pending" || q === "report" ? q : "open";
    res.json(listPickups(status));
  })
);

returnPickupsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = pickupById(req.params.id);
    if (!row) throw new ApiError(404, "Courier return not found");
    res.json(row);
  })
);

function load(id: string | number): any {
  const pickup = pickupById(id) as any;
  if (!pickup) throw new ApiError(404, "Courier return not found");
  return pickup;
}

const needStage = (pickup: any, stages: string[], what: string) => {
  if (!stages.includes(pickup.stage)) {
    throw new ApiError(409, `${what} isn't possible now — this return is ${pickup.stage.replace(/_/g, " ")}.`);
  }
};

// The service that carries / carried the parcel: one of our couriers (by code), or any other service by name. Either is fine; both are
// optional until the parcel is marked received.
const serviceInput = {
  delivery_partner: z.string().optional(),
  service_name: z.string().trim().max(60).optional(),
  package_weight_kg: z.number().positive().optional(),
  tracking_number: z.string().trim().max(60).optional(),
};

function resolveService(data: { delivery_partner?: string; service_name?: string }) {
  if (data.delivery_partner) {
    const partner = getPartner(data.delivery_partner);
    if (!partner || !partner.is_active || partner.kind !== "courier") throw new ApiError(400, "Pick one of the couriers, or name the other service.");
    return { code: partner.code, name: null as string | null, label: partner.name };
  }
  if (data.service_name) return { code: "", name: data.service_name, label: data.service_name };
  return null;
}

const createInput = z.object({
  sale_id: z.number().int().positive(),
  sale_item_ids: z.array(z.number().int().positive()).min(1, "Pick at least one item").max(30),
  // How the customer would like to be paid back — settled when the parcel has been inspected.
  resolution: z.enum(["refund", "store_credit"]),
  reason: z.string().trim().min(1, "A reason is required"),
  ...serviceInput,
});

// POST /api/return-pickups — the customer of a delivered online order wants to send items back. A REQUEST: an admin's own is approved on
// the spot, a cashier's waits in the approval list until an admin says yes (the customer is told to send it after that). The condition of
// what comes back isn't known yet, so approving only gives permission to send it — nothing about stock or money moves, and the
// courier, the delivery charge and who pays it are settled when the parcel arrives and has been inspected.
returnPickupsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = createInput.parse(req.body);
    if (new Set(data.sale_item_ids).size !== data.sale_item_ids.length) throw new ApiError(400, "The same item is listed twice.");

    const sale = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(data.sale_id) as any;
    if (!sale) throw new ApiError(404, "Sale not found");
    if (sale.status !== "completed" || sale.is_voided) throw new ApiError(409, "That invoice isn't an open completed sale.");
    if (sale.sale_type !== "online") throw new ApiError(409, "A courier return is for an online order — a shop sale is returned at the shop.");
    const delivery = db.prepare(`SELECT delivery_status FROM deliveries WHERE sale_id = ?`).get(sale.id) as { delivery_status: string } | undefined;
    if (!delivery || delivery.delivery_status !== "delivered") throw new ApiError(409, "That order hasn't been delivered yet — there's nothing to send back.");
    if (data.resolution === "store_credit" && !sale.customer_id) {
      throw new ApiError(400, "Store credit needs a real customer account — this sale has none. Use a refund instead.");
    }
    const service = resolveService(data);

    for (const itemId of data.sale_item_ids) {
      const item = db
        .prepare(
          `SELECT si.id, COALESCE(p.product_title, si.product_snapshot) AS title FROM sale_items si
           LEFT JOIN inventory i ON i.id = si.inventory_id LEFT JOIN products p ON p.id = i.product_id
           WHERE si.id = ? AND si.sale_id = ?`
        )
        .get(itemId, sale.id) as { id: number; title: string | null } | undefined;
      if (!item) throw new ApiError(400, "One of those items isn't on this invoice.");
      const label = item.title ?? "An item";
      if (db.prepare(`SELECT 1 FROM returns WHERE sale_item_id = ?`).get(itemId)) throw new ApiError(409, `${label} has already been returned.`);
      if (db.prepare(`SELECT 1 FROM return_requests WHERE sale_item_id = ? AND status IN ('pending', 'approved')`).get(itemId)) {
        throw new ApiError(409, `${label} already has a pending or approved return request.`);
      }
      if (itemInActiveExchange(itemId)) throw new ApiError(409, `${label} is part of an online exchange.`);
      if (itemInActivePickup(itemId)) throw new ApiError(409, `${label} is already being returned by courier.`);
    }

    const approver = recordedByAdmin(req, res, "Recording a courier return");
    const created = db.transaction(() => {
      const r = db
        .prepare(
          `INSERT INTO online_returns (sale_id, customer_id, delivery_partner, service_name, package_weight_kg, resolution, reason, tracking_number, requested_by,
                                       approval_status, approved_by, approved_at, auto_approved, stage)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE ${NOW} END, ?, ?)`
        )
        .run(
          sale.id,
          sale.customer_id ?? null,
          service?.code ?? "",
          service?.name ?? null,
          data.package_weight_kg ?? null,
          data.resolution,
          data.reason,
          data.tracking_number || null,
          req.user!.id,
          approver ? "approved" : "pending",
          approver?.id ?? null,
          approver?.id ?? null,
          approver ? 1 : 0,
          approver ? "approved" : "requested"
        );
      const id = Number(r.lastInsertRowid);
      for (const itemId of data.sale_item_ids) db.prepare(`INSERT INTO online_return_items (pickup_id, sale_item_id) VALUES (?, ?)`).run(id, itemId);
      return id;
    })();

    logAudit(
      approver ?? req.user!,
      approver ? "return_pickup_booked" : "return_pickup_requested",
      "sale",
      sale.id,
      `${sale.invoice}: courier return ${approver ? "recorded — Auto-approved (recorded by admin)" : "requested — waiting for approval"} for ${data.sale_item_ids.length} item${
        data.sale_item_ids.length === 1 ? "" : "s"
      } (${data.resolution === "refund" ? "refund" : "store credit"}) — ${data.reason}`
    );
    res.status(201).json(pickupById(created));
  })
);

// PUT /api/return-pickups/:id/approve — an admin's yes (or a cashier with an admin's password at the till): the customer may now send it
// back. An item of a no-returns product needs an override reason, the same as an in-store return does.
returnPickupsRouter.put(
  "/:id/approve",
  requireAdminOrApproval("Approving a courier return"),
  asyncHandler(async (req, res) => {
    const data = z.object({ override_reason: z.string().trim().max(200).optional() }).parse(req.body ?? {});
    const pickup = load(req.params.id);
    needStage(pickup, ["requested"], "Approving it");
    const noReturns = pickup.items.filter((i: any) => i.allow_returns === 0);
    if (noReturns.length > 0 && !data.override_reason) {
      throw new ApiError(400, `${noReturns.map((i: any) => i.title ?? "An item").join(", ")} ${noReturns.length === 1 ? "is a no-returns product" : "are no-returns products"} — approving needs an override reason.`);
    }
    db.prepare(
      `UPDATE online_returns
       SET approval_status = 'approved', stage = 'approved', approved_by = ?, approved_at = ${NOW}, auto_approved = 0, decision_reason = ?
       WHERE id = ?`
    ).run(actorOf(req).id, data.override_reason ?? null, pickup.id);
    logAudit(
      actorOf(req),
      "return_pickup_approved",
      "sale",
      pickup.sale_id,
      `${pickup.invoice}: courier return approved${data.override_reason ? ` (no-returns override: ${data.override_reason})` : ""}`
    );
    res.json(pickupById(pickup.id));
  })
);

// PUT /api/return-pickups/:id/decline — an admin says no. The request is closed (its items are free to be returned another way) and
// the reason stays on it so the person who asked can see why.
returnPickupsRouter.put(
  "/:id/decline",
  requireAdminOrApproval("Declining a courier return"),
  asyncHandler(async (req, res) => {
    const data = z.object({ reason: z.string().trim().min(1, "A reason is required to decline").max(200) }).parse(req.body ?? {});
    const pickup = load(req.params.id);
    needStage(pickup, ["requested"], "Declining it");
    db.transaction(() => {
      db.prepare(`UPDATE online_return_items SET status = 'cancelled' WHERE pickup_id = ?`).run(pickup.id);
      db.prepare(
        `UPDATE online_returns
         SET approval_status = 'declined', stage = 'declined', status = 'cancelled', approved_by = ?, approved_at = ${NOW},
             decision_reason = ?, closed_at = ${NOW}
         WHERE id = ?`
      ).run(actorOf(req).id, data.reason, pickup.id);
    })();
    logAudit(actorOf(req), "return_pickup_declined", "sale", pickup.sale_id, `${pickup.invoice}: courier return declined — ${data.reason}`);
    res.json(pickupById(pickup.id));
  })
);

// PUT /api/return-pickups/:id/cancel — it isn't coming back after all (the customer changed their mind, or it never arrived — which is
// the customer's end). Only before it is on hand; nothing was moved, so nothing is undone and the items can be returned another way.
returnPickupsRouter.put(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    const pickup = load(req.params.id);
    needStage(pickup, ["requested", "approved", "on_the_way"], "Cancelling it");
    // Withdrawing a request still waiting for approval is anyone's call; calling off an approved one is an admin's.
    if (pickup.stage !== "requested") approveIfNeeded(req, res, ["cancelling an approved return"], "Cancelling a courier return");
    db.transaction(() => {
      db.prepare(`UPDATE online_return_items SET status = 'cancelled' WHERE pickup_id = ?`).run(pickup.id);
      db.prepare(`UPDATE online_returns SET status = 'cancelled', stage = 'cancelled', closed_at = ${NOW} WHERE id = ?`).run(pickup.id);
    })();
    logAudit(actorOf(req), "return_pickup_cancelled", "sale", pickup.sale_id, `${pickup.invoice}: courier return cancelled`);
    res.json(pickupById(pickup.id));
  })
);

// The tracking rule: a parcel is sent / received with a tracking number — or the person says outright that there isn't one, which is allowed
// but written down ("Customer shipped without tracking — risk accepted"): until it is received the risk is the customer's.
const NO_TRACKING = "Customer shipped without tracking — risk accepted";

// PUT /api/return-pickups/:id/sent — the customer has sent it: with which service and the tracking number (or the note that there is none).
// Anyone can note it; a parcel can also be marked received straight from "approved".
returnPickupsRouter.put(
  "/:id/sent",
  asyncHandler(async (req, res) => {
    const data = z.object({ ...serviceInput, no_tracking_ack: z.boolean().optional() }).parse(req.body ?? {});
    const pickup = load(req.params.id);
    needStage(pickup, ["approved", "on_the_way"], "Marking it sent");
    const service = resolveService(data);
    const tracking = data.tracking_number || pickup.tracking_number;
    if (!tracking && !data.no_tracking_ack) {
      throw new ApiError(400, "Enter the tracking number — or say the customer shipped it without one (the risk is then theirs).");
    }
    db.prepare(
      `UPDATE online_returns
       SET stage = 'on_the_way', sent_at = COALESCE(sent_at, ${NOW}),
           delivery_partner = ?, service_name = ?, package_weight_kg = COALESCE(?, package_weight_kg), tracking_number = COALESCE(?, tracking_number),
           sent_without_tracking = ?
       WHERE id = ?`
    ).run(
      service ? service.code : pickup.delivery_partner,
      service ? service.name : pickup.service_name,
      data.package_weight_kg ?? null,
      data.tracking_number || null,
      tracking ? 0 : 1,
      pickup.id
    );
    logAudit(
      actorOf(req),
      "return_pickup_sent",
      "sale",
      pickup.sale_id,
      `${pickup.invoice}: courier return on its way back${service ? ` with ${service.label}` : ""}${tracking ? ` (tracking ${tracking})` : ` — ${NO_TRACKING}`}`
    );
    res.json(pickupById(pickup.id));
  })
);

// PUT /api/return-pickups/:id/received — the parcel is on hand: with which service, its tracking number, what we paid for it (if we did —
// often the customer paid their own way, so 0) and a quick look at each item: ok / damaged / missing from the parcel. Anyone can tick
// them; Damaged or Missing needs an admin's password. Every tick is recorded with who and when. A charge for one of our couriers is
// booked against them once; any other service is paid outside the system. Stock and money don't move yet — the parcel still has to be
// inspected and the report approved.
returnPickupsRouter.put(
  "/:id/received",
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        ...serviceInput,
        pickup_charge: z.number().nonnegative().default(0),
        no_tracking_ack: z.boolean().optional(),
        items: z.array(z.object({ sale_item_id: z.number().int().positive(), condition: z.enum(["ok", "damaged", "missing"]) })).min(1),
      })
      .parse(req.body ?? {});
    const pickup = load(req.params.id);
    needStage(pickup, ["approved", "on_the_way"], "Marking it received");

    const waiting = new Map<number, any>(pickup.items.filter((i: any) => i.status === "awaiting").map((i: any) => [i.sale_item_id, i]));
    const seen = new Set<number>();
    for (const o of data.items) {
      if (!waiting.has(o.sale_item_id) || seen.has(o.sale_item_id)) throw new ApiError(409, "One of those items isn't on this return.");
      seen.add(o.sale_item_id);
    }
    if (seen.size !== waiting.size) throw new ApiError(400, "Tick every item in the parcel — OK, Damaged or Missing.");

    const service = resolveService(data);
    if (!service && !pickup.partner_name) throw new ApiError(400, "Say which service brought it — one of the couriers, or name the other service.");
    const tracking = data.tracking_number || pickup.tracking_number;
    if (!tracking && !data.no_tracking_ack && !pickup.sent_without_tracking) {
      throw new ApiError(400, "Enter the tracking number — or say it came without one (the risk was the customer's).");
    }
    // All OK: anyone at the shop. Damaged or Missing: an admin, or an admin's password at the till.
    approveIfNeeded(
      req,
      res,
      arrivalApprovalReasons(data.items.map((o) => (o.condition === "missing" ? "not_returned" : o.condition === "damaged" ? "damaged" : "clean"))),
      "Marking a parcel received"
    );

    const actor = actorOf(req);
    const code = service ? service.code : pickup.delivery_partner;
    db.transaction(() => {
      db.prepare(
        `UPDATE online_returns
         SET stage = 'received', received_at = ${NOW}, received_by = ?, sent_at = COALESCE(sent_at, ${NOW}),
             delivery_partner = ?, service_name = ?, package_weight_kg = COALESCE(?, package_weight_kg),
             tracking_number = COALESCE(?, tracking_number), pickup_charge = ?, sent_without_tracking = ?
         WHERE id = ?`
      ).run(actor.id, code, service ? service.name : pickup.service_name, data.package_weight_kg ?? null, data.tracking_number || null, data.pickup_charge, tracking ? 0 : 1, pickup.id);
      for (const o of data.items) {
        db.prepare(`UPDATE online_return_items SET arrival_condition = ?, arrival_by = ?, arrival_at = ${NOW} WHERE pickup_id = ? AND sale_item_id = ?`).run(
          o.condition,
          actor.id,
          pickup.id,
          o.sale_item_id
        );
      }
      if (code && data.pickup_charge > 0 && !pickup.pickup_booked) {
        bookCourierCharge(code, data.pickup_charge, `Return delivery — ${pickup.invoice}`, actor);
        db.prepare(`UPDATE online_returns SET pickup_booked = 1 WHERE id = ?`).run(pickup.id);
      }
    })();
    const after = pickupById(pickup.id) as any;
    const label = { ok: "OK", damaged: "Damaged", missing: "Missing item" } as const;
    logAudit(
      actor,
      "return_pickup_parcel_received",
      "sale",
      pickup.sale_id,
      `${pickup.invoice}: courier return parcel received with ${after.partner_name}${tracking ? ` (tracking ${tracking})` : ` — ${NO_TRACKING}`}${
        data.pickup_charge > 0 ? `, we paid Rs. ${data.pickup_charge.toLocaleString()}` : ""
      }`
    );
    // One record per tick: who, when, condition.
    for (const o of data.items) {
      const item = waiting.get(o.sale_item_id);
      logAudit(actor, "return_pickup_item_checked", "sale", pickup.sale_id, `${pickup.invoice}: ${item.title ?? "item"} — ${label[o.condition]}`);
    }
    res.json(after);
  })
);

// What a report does once it is approved: each item that is taken back is a normal return (stock back on the shelf, or to damaged;
// loyalty points reversed; store credit granted) with the customer's share of the delivery charge held back from it — but a cash or bank
// refund is only OWED now (refund_due), and reaches the cash book when it is paid. An item that can't be taken back stays with the customer's
// problem: no return, no refund.
function executeReport(pickupId: number, actor: AuthUser, opts: { auto: boolean; reason?: string }) {
  const pickup = pickupById(pickupId) as any;
  const waiting = pickup.items.filter((i: any) => i.status === "awaiting");
  let pool = Math.max(0, customerShareOf(pickup.pickup_charge, pickup.customer_share_pct) - pickup.share_used);
  let heldBack = 0;
  let refundDue = 0;
  let creditGiven = 0;
  let took = 0;

  db.transaction(() => {
    for (const item of waiting) {
      // Sellable goes back on the shelf; damaged or missing parts go to the damaged bucket; anything else (not per policy, or not in the
      // parcel at all) isn't taken back.
      const takenBack = item.arrival_condition !== "missing" && ["clean", "damaged", "missing_parts"].includes(item.verdict);
      if (!takenBack) {
        db.prepare(`UPDATE online_return_items SET status = 'not_returned', verdict = ? WHERE id = ?`).run(item.arrival_condition === "missing" ? "not_received" : item.verdict ?? "not_per_policy", item.id);
        continue;
      }
      const request = db
        .prepare(
          `INSERT INTO return_requests (sale_item_id, quantity, condition, resolution, credit_expiry_days, reason, requested_by, is_admin_override)
           VALUES (?, 1, ?, ?, 45, ?, ?, ?)`
        )
        .run(
          item.sale_item_id,
          item.verdict === "clean" ? "clean" : "damaged",
          pickup.resolution === "refund" ? "refund" : "store_credit_exchange",
          `Courier return — ${pickup.reason}`,
          pickup.requested_by ?? actor.id,
          item.allow_returns === 0 ? 1 : 0
        );
      approveReturnRequest(
        request.lastInsertRowid as number,
        actor,
        { decision_reason: "Taken back after inspection" },
        { deduct: pool, deferPayout: true }
      );
      const ret = db
        .prepare(`SELECT r.id, r.refund_amount, r.pickup_deduction, r.resolution FROM return_requests rr JOIN returns r ON r.id = rr.return_id WHERE rr.id = ?`)
        .get(request.lastInsertRowid) as { id: number; refund_amount: number; pickup_deduction: number; resolution: string };
      pool -= ret.pickup_deduction;
      heldBack += ret.pickup_deduction;
      if (ret.resolution === "refund") refundDue += ret.refund_amount;
      else creditGiven += item.amount - ret.pickup_deduction;
      took++;
      db.prepare(`UPDATE online_return_items SET status = 'received', item_condition = ?, return_id = ?, deduction = ? WHERE id = ?`).run(
        item.verdict === "clean" ? "clean" : "damaged",
        ret.id,
        ret.pickup_deduction,
        item.id
      );
    }
    // The inspection may propose paying back less than everything the items come to (a damaged piece, say): the difference is held back
    // from the refund / credit. More than the items allow is refused.
    const owed = pickup.resolution === "refund" ? refundDue : creditGiven;
    if (pickup.report_proposed !== null && pickup.report_proposed !== undefined) {
      if (pickup.report_proposed > owed + 0.5) {
        throw new ApiError(400, `The proposed Rs. ${Math.round(pickup.report_proposed).toLocaleString()} is more than the most that can go back (Rs. ${owed.toLocaleString()}) — send the report back to be corrected.`);
      }
      let cut = owed - pickup.report_proposed;
      if (cut > 0.5) {
        const rows = db
          .prepare(`SELECT r.id, r.refund_amount FROM online_return_items oi JOIN returns r ON r.id = oi.return_id WHERE oi.pickup_id = ? AND oi.status = 'received' ORDER BY oi.id DESC`)
          .all(pickup.id) as { id: number; refund_amount: number }[];
        for (const r of rows) {
          if (cut <= 0) break;
          if (pickup.resolution === "refund") {
            const take = Math.min(cut, r.refund_amount);
            if (take <= 0) continue;
            db.prepare(`UPDATE returns SET refund_amount = refund_amount - ?, inspection_deduction = inspection_deduction + ? WHERE id = ?`).run(take, take, r.id);
            cut -= take;
          } else {
            const credit = db.prepare(`SELECT id, amount FROM store_credit_transactions WHERE reference_id = ? AND reason = 'return_exchange' ORDER BY id DESC LIMIT 1`).get(r.id) as { id: number; amount: number } | undefined;
            const take = Math.min(cut, credit?.amount ?? 0);
            if (!credit || take <= 0) continue;
            db.prepare(`UPDATE store_credit_transactions SET amount = amount - ? WHERE id = ?`).run(take, credit.id);
            db.prepare(`UPDATE returns SET inspection_deduction = inspection_deduction + ? WHERE id = ?`).run(take, r.id);
            cut -= take;
          }
        }
        if (pickup.resolution === "refund") refundDue = Math.round(pickup.report_proposed * 100) / 100;
        else creditGiven = Math.round(pickup.report_proposed * 100) / 100;
      }
    }
    const finished = !(pickup.resolution === "refund" && refundDue > 0);
    db.prepare(
      `UPDATE online_returns
       SET share_used = share_used + ?, status = ?, stage = ?, report_status = 'approved', report_decided_by = ?, report_decided_at = ${NOW},
           report_decision_reason = ?, report_auto_approved = ?, refund_due = ?, closed_at = CASE WHEN ? = 1 THEN ${NOW} ELSE NULL END
       WHERE id = ?`
    ).run(heldBack, took > 0 ? "received" : "not_returned", finished ? "completed" : "refund_due", actor.id, opts.reason ?? null, opts.auto ? 1 : 0, refundDue, finished ? 1 : 0, pickup.id);
  })();

  logAudit(
    actor,
    "return_pickup_report_approved",
    "sale",
    pickup.sale_id,
    `${pickup.invoice}: inspection report ${opts.auto ? "Auto-approved (recorded by admin)" : "approved"} — ${took} item${took === 1 ? "" : "s"} taken back${
      waiting.length - took ? `, ${waiting.length - took} not` : ""
    }${refundDue > 0 ? `; Rs. ${refundDue.toLocaleString()} refund due` : ""}${creditGiven > 0 ? `; Rs. ${creditGiven.toLocaleString()} store credit granted` : ""}${
      heldBack > 0 ? `; Rs. ${heldBack.toLocaleString()} held back for the delivery charge` : ""
    }`
  );
}

const reportInput = z.object({
  // What the inspection found, for every item that arrived: sellable ("clean"), damaged or with missing parts (taken back, to the damaged
  // bucket — not resold), or not per policy (can't be taken back).
  items: z
    .array(z.object({ sale_item_id: z.number().int().positive(), verdict: z.enum(["clean", "damaged", "missing_parts", "not_per_policy"]) }))
    .min(1),
  // What to pay the customer back in total (refund or credit); left out = everything the items come to, less the delivery share.
  proposed_amount: z.number().nonnegative().optional(),
  // How the customer is paid back, if that changed from what they first asked for.
  resolution: z.enum(["refund", "store_credit"]).optional(),
  // Who pays the delivery charge we paid: 0 = we do, 50 = half and half, 100 = the customer.
  customer_share_pct: z.number().int().min(0).max(100).optional(),
  note: z.string().trim().max(300).optional(),
});

// PUT /api/return-pickups/:id/report — the parcel has been inspected: the report (condition of each item that arrived, who pays the delivery
// charge, what to pay the customer back) goes to an admin, who approves the split and the amount together. An admin's own report is
// approved straight away. Items ticked Missing at the door are left out — nothing came back for them.
returnPickupsRouter.put(
  "/:id/report",
  asyncHandler(async (req, res) => {
    const data = reportInput.parse(req.body);
    const pickup = load(req.params.id);
    needStage(pickup, ["received"], "Filing the inspection report");

    const toInspect = new Map<number, any>(
      pickup.items.filter((i: any) => i.status === "awaiting" && i.arrival_condition !== "missing").map((i: any) => [i.sale_item_id, i])
    );
    const seen = new Set<number>();
    for (const o of data.items) {
      if (!toInspect.has(o.sale_item_id) || seen.has(o.sale_item_id)) throw new ApiError(409, "One of those items isn't waiting for inspection on this return.");
      seen.add(o.sale_item_id);
    }
    if (seen.size !== toInspect.size) throw new ApiError(400, "Give the condition of every item that arrived.");
    const resolution = data.resolution ?? pickup.resolution;
    if (resolution === "store_credit" && !pickup.customer_id) throw new ApiError(400, "Store credit needs a real customer account — this sale has none. Use a refund instead.");
    if (pickup.pickup_charge > 0 && data.customer_share_pct === undefined) throw new ApiError(400, "Choose who pays the delivery charge — us, half and half, or the customer.");

    const approver = recordedByAdmin(req, res, "Recording an inspection report");
    db.transaction(() => {
      for (const o of data.items) db.prepare(`UPDATE online_return_items SET verdict = ? WHERE pickup_id = ? AND sale_item_id = ?`).run(o.verdict, pickup.id, o.sale_item_id);
      db.prepare(
        `UPDATE online_returns
         SET resolution = ?, customer_share_pct = ?, report_note = ?, report_by = ?, report_at = ${NOW}, report_status = 'pending',
             report_decision_reason = NULL, report_proposed = ?, stage = 'report_pending'
         WHERE id = ?`
      ).run(resolution, data.customer_share_pct ?? pickup.customer_share_pct, data.note ?? null, req.user!.id, data.proposed_amount ?? null, pickup.id);
      // An admin's own report needs no one else's yes — approved in the same step (and undone with it if that fails).
      if (approver) executeReport(pickup.id, approver, { auto: true });
    })();
    const count = (v: string) => data.items.filter((o) => o.verdict === v).length;
    logAudit(
      req.user!,
      "return_pickup_reported",
      "sale",
      pickup.sale_id,
      `${pickup.invoice}: inspection report filed — ${count("clean")} sellable, ${count("damaged")} damaged, ${count("missing_parts")} missing parts, ${count("not_per_policy")} not per policy; delivery charge ${
        data.customer_share_pct === undefined ? "n/a" : data.customer_share_pct === 0 ? "we pay" : data.customer_share_pct === 100 ? "customer pays" : `customer pays ${data.customer_share_pct}%`
      }${data.proposed_amount !== undefined ? `; proposed Rs. ${Math.round(data.proposed_amount).toLocaleString()}` : ""}`
    );
    res.json(pickupById(pickup.id));
  })
);

// PUT /api/return-pickups/:id/report/approve — an admin accepts the report: stock goes back, credit is granted, a refund becomes due.
returnPickupsRouter.put(
  "/:id/report/approve",
  requireAdminOrApproval("Approving an inspection report"),
  asyncHandler(async (req, res) => {
    const data = z.object({ reason: z.string().trim().max(200).optional() }).parse(req.body ?? {});
    const pickup = load(req.params.id);
    needStage(pickup, ["report_pending"], "Approving the report");
    executeReport(pickup.id, actorOf(req), { auto: false, reason: data.reason });
    res.json(pickupById(pickup.id));
  })
);

// PUT /api/return-pickups/:id/report/send-back — the admin wants another look: back to "received" with the reason, for a new report.
returnPickupsRouter.put(
  "/:id/report/send-back",
  requireAdminOrApproval("Sending an inspection report back"),
  asyncHandler(async (req, res) => {
    const data = z.object({ reason: z.string().trim().min(1, "Say what needs another look").max(200) }).parse(req.body ?? {});
    const pickup = load(req.params.id);
    needStage(pickup, ["report_pending"], "Sending the report back");
    db.prepare(
      `UPDATE online_returns
       SET stage = 'received', report_status = 'sent_back', report_decided_by = ?, report_decided_at = ${NOW}, report_decision_reason = ?
       WHERE id = ?`
    ).run(actorOf(req).id, data.reason, pickup.id);
    logAudit(actorOf(req), "return_pickup_report_sent_back", "sale", pickup.sale_id, `${pickup.invoice}: inspection report sent back — ${data.reason}`);
    res.json(pickupById(pickup.id));
  })
);

// PUT /api/return-pickups/:id/refund — the refund has been paid (cash from the till, or a transfer to one of the customer's saved bank
// accounts): THIS is when it reaches the cash book. The return is then completed.
returnPickupsRouter.put(
  "/:id/refund",
  asyncHandler(async (req, res) => {
    const data = z.object({ method: z.enum(["cash", "bank_transfer"]), bank_account_id: z.number().int().positive().optional() }).parse(req.body ?? {});
    const pickup = load(req.params.id);
    needStage(pickup, ["refund_due"], "Marking the refund paid");
    if (data.method === "bank_transfer") {
      if (!pickup.customer_id) throw new ApiError(400, "This sale has no customer — a bank transfer refund needs one. Use cash.");
      if (!data.bank_account_id) throw new ApiError(400, "Pick the customer's bank account the refund went to — or add their bank details first.");
      const account = db.prepare(`SELECT id FROM customer_bank_accounts WHERE id = ? AND customer_id = ?`).get(data.bank_account_id, pickup.customer_id);
      if (!account) throw new ApiError(400, "That bank account isn't on file for this customer");
    }
    const actor = actorOf(req);
    let paid = 0;
    db.transaction(() => {
      for (const item of pickup.items.filter((i: any) => i.return_id && i.refund_amount > 0)) {
        db.prepare(
          `INSERT INTO cash_book (transaction_code, type, category, payment_method, reference_id, amount, notes)
           VALUES (?, 'expense', 'return_refund', ?, ?, ?, ?)`
        ).run(nextTransactionCode(), data.method, item.return_id, item.refund_amount, `Refund for invoice ${pickup.invoice} (courier return)`);
        paid += item.refund_amount;
      }
      db.prepare(
        `UPDATE online_returns
         SET stage = 'completed', refund_method = ?, refund_account_id = ?, refunded_at = ${NOW}, refunded_by = ?, closed_at = ${NOW}
         WHERE id = ?`
      ).run(data.method, data.method === "bank_transfer" ? data.bank_account_id : null, actor.id, pickup.id);
    })();
    logAudit(
      actor,
      "return_pickup_refunded",
      "sale",
      pickup.sale_id,
      `${pickup.invoice}: courier return refund of Rs. ${paid.toLocaleString()} paid by ${data.method === "cash" ? "cash" : "bank transfer"} and booked in the cash book`
    );
    res.json(pickupById(pickup.id));
  })
);
