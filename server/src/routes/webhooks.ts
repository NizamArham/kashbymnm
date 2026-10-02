import { Router, Request } from "express";
import express from "express";
import crypto from "crypto";
import { db } from "../db/connection";
import { asyncHandler } from "../lib/errors";
import { applyCourierStatus, interpretCourierStatus, logCourierStatus } from "../lib/courierStatus";

// Endpoints that outside services call (no login) — so each one is
// protected by a secret in its address instead, and does as little as it
// can: look up one order and record/advance its status.
export const webhooksRouter = Router();

// Fardar's callback is plain form data, and their own sample code posts
// it the PHP-curl way — which is multipart/form-data, not the
// url-encoded form express can read out of the box. This reads the simple
// text fields of either (no files are ever involved).
function parseMultipartFields(body: Buffer, contentType: string): Record<string, string> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const marker = boundary ? `--${boundary[1] ?? boundary[2]}` : null;
  const fields: Record<string, string> = {};
  if (!marker) return fields;
  for (const part of body.toString("utf8").split(marker)) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const name = /name="([^"]+)"/i.exec(part.slice(0, headerEnd))?.[1];
    if (!name) continue;
    fields[name] = part.slice(headerEnd + 4).replace(/\r\n$/, "");
  }
  return fields;
}

function readFields(req: Request): Record<string, string> {
  const contentType = String(req.headers["content-type"] ?? "");
  if (Buffer.isBuffer(req.body)) return parseMultipartFields(req.body, contentType);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((req.body ?? {}) as Record<string, unknown>)) out[k] = String(v ?? "");
  return out;
}

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// POST /api/webhooks/fardar/:secret — Fardar's status callback. They send
// waybill_id, the current status (their docs call it current_status in
// the table and delivery_status in the sample code, so either is
// accepted) and last_update_time. Always answers 200 for a valid secret —
// including for waybills that aren't ours — so their endpoint test passes.
webhooksRouter.post(
  "/fardar/:secret",
  express.raw({ type: "multipart/form-data", limit: "100kb" }),
  express.urlencoded({ extended: false, limit: "100kb" }),
  asyncHandler(async (req, res) => {
    const expected = process.env.FARDAR_WEBHOOK_SECRET;
    if (!expected) {
      res.status(503).json({ error: "Fardar callbacks aren't set up — add FARDAR_WEBHOOK_SECRET to server/.env." });
      return;
    }
    if (!secretMatches(req.params.secret, expected)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const f = readFields(req);
    const waybill = (f.waybill_id ?? f.waybill_no ?? "").trim();
    const statusText = (f.current_status ?? f.delivery_status ?? f.status ?? "").trim();
    const courierTime = (f.last_update_time ?? "").trim() || null;

    const delivery = waybill
      ? (db.prepare(`SELECT id FROM deliveries WHERE delivery_partner = 'FDR' AND tracking_number = ? ORDER BY id DESC LIMIT 1`).get(waybill) as
          | { id: number }
          | undefined)
      : undefined;

    if (!delivery) {
      logCourierStatus("Fardar", waybill || null, statusText, courierTime, "no matching order");
      res.json({ status: 200, message: "OK" });
      return;
    }

    const outcome = applyCourierStatus({
      deliveryId: delivery.id,
      courier: "Fardar",
      rawStatus: statusText,
      courierTime,
      state: interpretCourierStatus(statusText),
    });
    logCourierStatus("Fardar", waybill, statusText, courierTime, outcome.changed ? outcome.to : "recorded only");
    res.json({ status: 200, message: "OK" });
  })
);
