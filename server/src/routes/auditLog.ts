import { Router } from "express";
import { db } from "../db/connection";
import { asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const auditLogRouter = Router();

// Audit trail — admin only, same access model as Cash Book/Suppliers.
auditLogRouter.use(requireAuth, requireRole("admin"));

// Capped at the most recent 1000 entries — plenty for a small shop's
// review window, and keeps the response bounded as the table grows
// over months/years without needing pagination yet.
auditLogRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT id, staff_id, staff_name, action, entity_type, entity_id, description, created_at
         FROM audit_log ORDER BY id DESC LIMIT 1000`
      )
      .all();
    res.json(rows);
  })
);
