import { db } from "../db/connection";
import { logSystemAudit } from "./auditLog";
import { applyReturnCharge } from "../routes/courierReconciliation";

// What a courier's own status wording means for OUR delivery pipeline.
// Couriers each use their own phrases and (for Fardar) the list isn't
// published, so only clear signals are acted on:
//   'delivered'  — the parcel reached the customer
//   'returned'   — it came back to us
//   'in_transit' — the courier has it (picked up / on its way)
//   null         — anything else (kept on screen as the courier's text,
//                  but never moves the order)
// A negative ("undelivered", "delivery attempted", "return initiated")
// always wins over the positive word inside it, so a failed attempt can't
// be mistaken for a delivery.
export type CourierState = "delivered" | "returned" | "in_transit" | null;

export function interpretCourierStatus(text: string | null | undefined): CourierState {
  const t = (text ?? "").toLowerCase().trim();
  if (!t) return null;

  if (/\b(un-?delivered|not delivered|failed|attempt(ed)?|unable|undeliverable|pending|cancel)/.test(t)) {
    return /\b(returned|return(ed)? to (sender|shop|origin|shipper)|rto)\b/.test(t) ? "returned" : null;
  }
  if (/\breturn(ing)?\b.*\b(initiated|in progress|process|requested|pending)\b/.test(t) || /\b(initiated|in progress|process|requested)\b.*\breturn/.test(t)) {
    return null;
  }
  if (/\b(returned|return(ed)? to (sender|shop|origin|shipper)|back to (sender|shop|origin)|rto)\b/.test(t)) return "returned";
  if (/\b(delivered|delivery completed|successfully delivered)\b/.test(t) && !/out for delivery/.test(t)) return "delivered";
  if (/(in transit|transit|dispatch|picked|pick-?up|collected|out for delivery|on the way|shipped|arrived|received at|hub)/.test(t)) {
    return "in_transit";
  }
  return null;
}

// "2026-10-02 14:20:05" (or with a T) is kept as sent; anything else is
// replaced with now, so delivery_date etc. are always a real timestamp.
function normaliseTime(raw: string | null | undefined): string {
  if (raw && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw.trim())) return raw.trim().replace("T", " ").slice(0, 19);
  return (db.prepare(`SELECT datetime('now', '+330 minutes') AS n`).get() as { n: string }).n;
}

export interface CourierUpdate {
  deliveryId: number;
  courier: string; // for the log / audit wording: "CityPak", "Fardar"
  rawStatus: string;
  courierTime?: string | null;
  state: CourierState;
}

// Records the courier's status on the delivery and, when it's a clear
// forward move, advances the order exactly as the manual buttons would
// (Dispatch / Delivered / Returned, including the return-trip charge) —
// never backwards, and never touching an order that's cancelled, still
// pending, or already finished.
export function applyCourierStatus(u: CourierUpdate): { changed: boolean; from: string; to: string } {
  const d = db
    .prepare(
      `SELECT deliveries.*, sales.invoice, sales.is_voided FROM deliveries
       JOIN sales ON sales.id = deliveries.sale_id WHERE deliveries.id = ?`
    )
    .get(u.deliveryId) as any;
  if (!d) return { changed: false, from: "", to: "" };

  const when = normaliseTime(u.courierTime);
  let target: "dispatched" | "delivered" | "returned" | null = null;
  if (!d.is_voided) {
    if (u.state === "delivered" && (d.delivery_status === "packed" || d.delivery_status === "dispatched")) target = "delivered";
    else if (u.state === "returned" && (d.delivery_status === "packed" || d.delivery_status === "dispatched")) target = "returned";
    else if (u.state === "in_transit" && d.delivery_status === "packed") target = "dispatched";
  }

  // Updates can arrive out of order or repeated. Once an order is
  // delivered or returned, a later "in transit" (or any other earlier-stage
  // wording) is ignored, and a status older than the one already shown
  // never replaces it — otherwise a finished order could end up showing
  // "Courier: In transit".
  const finished = d.delivery_status === "delivered" || d.delivery_status === "returned";
  const isStale = !!(u.courierTime && d.courier_status_at && u.courierTime.trim() < d.courier_status_at);
  const showText = !(finished && u.state !== "delivered" && u.state !== "returned") && !isStale;

  db.transaction(() => {
    if (showText) {
      db.prepare(`UPDATE deliveries SET courier_status = ?, courier_status_at = ? WHERE id = ?`).run(u.rawStatus, u.courierTime?.trim() || when, d.id);
    }
    if (!target) return;

    // A courier that reports delivery or return had the parcel, even if
    // nobody pressed Dispatch — stamp it so settlement picks the order up.
    if (!d.dispatched_at) db.prepare(`UPDATE deliveries SET dispatched_at = ? WHERE id = ?`).run(when, d.id);

    if (target === "dispatched") {
      db.prepare(`UPDATE deliveries SET delivery_status = 'dispatched' WHERE id = ?`).run(d.id);
    } else if (target === "delivered") {
      db.prepare(`UPDATE deliveries SET delivery_status = 'delivered', delivery_date = ? WHERE id = ?`).run(when, d.id);
    } else {
      db.prepare(
        `UPDATE deliveries SET delivery_status = 'returned',
                notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || char(10) || ? END
         WHERE id = ?`
      ).run(`Returned — ${u.courier} reported: ${u.rawStatus}`, `Returned — ${u.courier} reported: ${u.rawStatus}`, d.id);
      // The courier did the trip, so the return leg is charged — same as
      // marking a dispatched order returned by hand.
      applyReturnCharge({ ...d, id: d.id });
    }
  })();

  if (target) {
    logSystemAudit(
      `${u.courier} (automatic)`,
      "delivery_status_sync",
      "delivery",
      d.id,
      `${d.invoice}: ${d.delivery_status} → ${target} — ${u.courier} reported "${u.rawStatus}"`
    );
  }
  return { changed: !!target, from: d.delivery_status, to: target ?? d.delivery_status };
}

export function logCourierStatus(courier: string, trackingNumber: string | null, statusText: string, courierTime: string | null, actionTaken: string) {
  db.prepare(
    `INSERT INTO courier_status_log (courier, tracking_number, status_text, courier_time, action_taken) VALUES (?, ?, ?, ?, ?)`
  ).run(courier, trackingNumber, statusText, courierTime, actionTaken);
}
