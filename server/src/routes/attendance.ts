import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const attendanceRouter = Router();

// Marking attendance is an admin/manager action — staff don't self-report
// here, matching how a real attendance register works.
attendanceRouter.use(requireAuth, requireRole("admin"));

const markInput = z.object({
  user_id: z.number().int().positive(),
  attendance_date: z.string(), // "YYYY-MM-DD"
  status: z.enum(["present", "absent", "half_day", "leave"]).default("present"),
  notes: z.string().optional(),
});

// POST /api/attendance — mark (or re-mark) one person's attendance for a
// specific date. Re-marking the same person+date overwrites the earlier
// entry rather than creating a duplicate, since a day only has one real
// attendance status.
attendanceRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = markInput.parse(req.body);

    const user = db.prepare(`SELECT id FROM users WHERE id = ?`).get(data.user_id);
    if (!user) throw new ApiError(400, "That staff member does not exist");

    db.prepare(
      `INSERT INTO attendance (user_id, attendance_date, status, marked_by, notes)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, attendance_date)
       DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by,
                     notes = excluded.notes, marked_at = datetime('now')`
    ).run(data.user_id, data.attendance_date, data.status, req.user!.id, data.notes ?? null);

    const saved = db
      .prepare(`SELECT * FROM attendance WHERE user_id = ? AND attendance_date = ?`)
      .get(data.user_id, data.attendance_date);
    res.status(201).json(saved);
  })
);

// GET /api/attendance?date=YYYY-MM-DD — everyone's attendance for one day,
// the shape the daily marking screen actually needs (list of staff, each
// with whether/how they've been marked yet today).
attendanceRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const date = String(req.query.date ?? new Date().toISOString().slice(0, 10));

    const rows = db
      .prepare(
        `SELECT users.id as user_id, users.name, users.job_title,
                attendance.id as attendance_id, attendance.status, attendance.marked_at, attendance.notes
         FROM users
         LEFT JOIN attendance ON attendance.user_id = users.id AND attendance.attendance_date = ?
         ORDER BY users.name`
      )
      .all(date);

    res.json({ date, staff: rows });
  })
);

// GET /api/attendance/:userId?start=YYYY-MM-DD&end=YYYY-MM-DD — one
// person's attendance history over a range, plus simple totals (days
// present/absent/leave), which is what answers "how many days did they
// work this month" without the admin counting by hand.
attendanceRouter.get(
  "/:userId",
  asyncHandler(async (req, res) => {
    const start = String(req.query.start ?? "0000-01-01");
    const end = String(req.query.end ?? "9999-12-31");

    const records = db
      .prepare(
        `SELECT * FROM attendance
         WHERE user_id = ? AND attendance_date BETWEEN ? AND ?
         ORDER BY attendance_date DESC`
      )
      .all(req.params.userId, start, end) as { status: string }[];

    const totals = { present: 0, absent: 0, half_day: 0, leave: 0 };
    for (const r of records) {
      if (r.status in totals) totals[r.status as keyof typeof totals]++;
    }

    res.json({ records, totals });
  })
);
