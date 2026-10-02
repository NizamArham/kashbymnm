import { db } from "../db/connection";
import { citypakTrackOrder, CitypakTrackingResult } from "./citypak";
import { applyCourierStatus, interpretCourierStatus, logCourierStatus } from "./courierStatus";

export interface SyncSummary {
  checked: number;
  updated: number;
  notFound: number;
  errors: number;
  changes: { invoice: string; from: string; to: string }[];
}

let running = false;

// Asks CityPak where each of our open parcels is (packed or dispatched,
// with a tracking number) and updates the order when they report it
// delivered or returned. The tracker is a parameter only so this can be
// exercised without calling CityPak. CityPak's own is_delivered flag is
// the authority for "delivered"; their event wording is only used for
// "returned" / "picked up", through the same careful matching as every
// other courier, and anything unclear is just shown, never acted on.
export async function syncCitypak(
  track: (trackingNumber: string) => Promise<CitypakTrackingResult> = citypakTrackOrder
): Promise<SyncSummary> {
  const summary: SyncSummary = { checked: 0, updated: 0, notFound: 0, errors: 0, changes: [] };
  if (running) return summary;
  running = true;
  try {
    const open = db
      .prepare(
        `SELECT deliveries.id, deliveries.tracking_number, sales.invoice
         FROM deliveries JOIN sales ON sales.id = deliveries.sale_id
         WHERE deliveries.delivery_partner = 'CPAK' AND deliveries.tracking_number IS NOT NULL
           AND deliveries.delivery_status IN ('packed', 'dispatched') AND sales.is_voided = 0`
      )
      .all() as { id: number; tracking_number: string; invoice: string }[];

    for (const d of open) {
      summary.checked++;
      let result: CitypakTrackingResult;
      try {
        result = await track(d.tracking_number);
      } catch (err: any) {
        // "Invalid Tracking Number" just means CityPak doesn't know this
        // one (e.g. a live parcel looked up with the test account) —
        // nothing to act on, not an error worth shouting about.
        if (/invalid tracking number|not found/i.test(err?.message ?? "")) summary.notFound++;
        else summary.errors++;
        continue;
      }

      const events = result.tracking_history ?? [];
      const latest = events
        .slice()
        .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
        .pop();
      if (!latest && !result.is_delivered) continue;

      const rawStatus = result.is_delivered
        ? latest?.description || "Delivered"
        : [latest?.status_type, latest?.description].filter(Boolean).join(" — ");
      const state = result.is_delivered ? "delivered" : interpretCourierStatus(`${latest?.status_type ?? ""} ${latest?.description ?? ""}`);
      const courierTime = latest ? `${latest.date} ${latest.time}` : null;

      const outcome = applyCourierStatus({ deliveryId: d.id, courier: "CityPak", rawStatus, courierTime, state });
      logCourierStatus("CityPak", d.tracking_number, rawStatus, courierTime, outcome.changed ? outcome.to : "recorded only");
      if (outcome.changed) {
        summary.updated++;
        summary.changes.push({ invoice: d.invoice, from: outcome.from, to: outcome.to });
      }
    }
  } finally {
    running = false;
  }
  return summary;
}

// Checks CityPak every 30 minutes while the server is running (first
// check a couple of minutes after startup, so restarting the server
// doesn't fire a round of lookups each time). Does nothing unless a
// CityPak token is configured.
export function startCourierSync(intervalMs = 30 * 60 * 1000) {
  if (!process.env.CITYPAK_API_TOKEN) return;
  const run = () => {
    syncCitypak().catch((err) => console.error("[courier sync] CityPak check failed:", err?.message ?? err));
  };
  setTimeout(run, 2 * 60 * 1000);
  setInterval(run, intervalMs);
}
