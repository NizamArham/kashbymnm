import { Router } from "express";
import { z } from "zod";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";
import { logAudit } from "../lib/auditLog";

export const attendanceRouter = Router();

// Marking attendance is an admin/manager action — staff don't self-report
// here, matching how a real attendance register works. They can read their own
// record, though (the Attendance tab on their profile).
attendanceRouter.use(requireAuth);

// users.attendance_enabled: whether attendance is kept for a login. The technical System Admin account has none, and someone who has left can be
// switched off without losing the history. Additive lazy migration, like the other modules that grew the schema.
const userCols = db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
if (userCols.length > 0 && !userCols.some((c) => c.name === "attendance_enabled")) {
  db.exec(`ALTER TABLE users ADD COLUMN attendance_enabled INTEGER NOT NULL DEFAULT 1`);
  db.exec(`UPDATE users SET attendance_enabled = 0 WHERE username = 'systemadmin'`);
}

const STATUSES = ["present", "absent", "half_day", "leave"] as const;
type Status = (typeof STATUSES)[number];
const STATUS_WORDS: Record<Status, string> = { present: "present", absent: "absent", half_day: "a half day", leave: "on leave" };

// The shop's clock (UTC+5:30), as YYYY-MM-DD.
const todayShop = () => (db.prepare(`SELECT date('now', '+330 minutes') AS d`).get() as { d: string }).d;
const isRealDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// A day that can be marked: a real date, and not one that hasn't come yet.
function assertMarkable(date: string) {
  if (!isRealDate(date)) throw new ApiError(400, "That isn't a valid date");
  if (date > todayShop()) throw new ApiError(400, "Attendance can't be marked for a day that hasn't come yet");
}

// Anyone whose attendance is kept and who had already joined by `date` (no joined date = always counts).
const TRACKED_ON_SQL = `users.attendance_enabled = 1 AND (users.joined_date IS NULL OR users.joined_date = '' OR users.joined_date <= ?)`;

const markInput = z.object({
  user_id: z.number().int().positive(),
  attendance_date: z.string(), // "YYYY-MM-DD"
  status: z.enum(STATUSES).default("present"),
  notes: z.string().trim().max(200).optional(),
});

// POST /api/attendance — mark (or re-mark) one person's attendance for a
// specific date. Re-marking the same person+date overwrites the earlier
// entry rather than creating a duplicate, since a day only has one real
// attendance status.
attendanceRouter.post(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const data = markInput.parse(req.body);
    assertMarkable(data.attendance_date);

    const user = db.prepare(`SELECT id, COALESCE(name, username) AS name FROM users WHERE id = ?`).get(data.user_id) as { id: number; name: string } | undefined;
    if (!user) throw new ApiError(400, "That staff member does not exist");

    db.prepare(
      `INSERT INTO attendance (user_id, attendance_date, status, marked_by, notes)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, attendance_date)
       DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by,
                     notes = excluded.notes, marked_at = datetime('now', '+330 minutes')`
    ).run(data.user_id, data.attendance_date, data.status, req.user!.id, data.notes || null);

    logAudit(req.user!, "attendance_mark", "staff", user.id, `Marked ${user.name} ${STATUS_WORDS[data.status]} for ${longDate(data.attendance_date)}${data.notes ? ` — ${data.notes}` : ""}`);

    const saved = db.prepare(`SELECT * FROM attendance WHERE user_id = ? AND attendance_date = ?`).get(data.user_id, data.attendance_date);
    res.status(201).json(saved);
  })
);

const markAllInput = z.object({ attendance_date: z.string(), status: z.enum(STATUSES).default("present") });

// POST /api/attendance/mark-all — everyone who hasn't been marked yet that day gets the same status (the usual "everyone came in" tap).
// People who already have a mark are left exactly as they are.
attendanceRouter.post(
  "/mark-all",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const data = markAllInput.parse(req.body);
    assertMarkable(data.attendance_date);

    const ids = (
      db
        .prepare(
          `SELECT users.id FROM users
           WHERE ${TRACKED_ON_SQL}
             AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = users.id AND a.attendance_date = ?)`
        )
        .all(data.attendance_date, data.attendance_date) as { id: number }[]
    ).map((r) => r.id);

    const insert = db.prepare(`INSERT INTO attendance (user_id, attendance_date, status, marked_by) VALUES (?, ?, ?, ?)`);
    db.transaction(() => {
      for (const id of ids) insert.run(id, data.attendance_date, data.status, req.user!.id);
    })();

    if (ids.length > 0) {
      logAudit(req.user!, "attendance_mark_all", "staff", null, `Marked ${ids.length} ${ids.length === 1 ? "person" : "people"} ${STATUS_WORDS[data.status]} for ${longDate(data.attendance_date)} (everyone not marked yet)`);
    }
    res.json({ marked: ids.length });
  })
);

const fillRangeInput = z.object({
  from: z.string(),
  to: z.string(),
  status: z.enum(STATUSES).default("present"),
  // 0 = Sunday … 6 = Saturday: days of the week to leave out (a weekly day off).
  skip_weekdays: z.array(z.number().int().min(0).max(6)).default([]),
  // Left out = everyone attendance is kept for.
  user_ids: z.array(z.number().int().positive()).optional(),
});

// POST /api/attendance/fill-range — catch up a run of days in one go: every chosen person gets the status on every day in the range that isn't marked
// yet (days that already have a mark are never changed; days before someone joined are skipped). At most 62 days at a time, none in the future.
attendanceRouter.post(
  "/fill-range",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const data = fillRangeInput.parse(req.body);
    if (!isRealDate(data.from)) throw new ApiError(400, "That isn't a valid start date");
    assertMarkable(data.to);
    if (data.from > data.to) throw new ApiError(400, "The start date is after the end date");
    const dates: string[] = [];
    for (let d = new Date(`${data.from}T00:00:00Z`); d.toISOString().slice(0, 10) <= data.to; d.setUTCDate(d.getUTCDate() + 1)) {
      if (!data.skip_weekdays.includes(d.getUTCDay())) dates.push(d.toISOString().slice(0, 10));
      if (dates.length > 62 || d.getTime() - Date.parse(`${data.from}T00:00:00Z`) > 62 * 86400000) throw new ApiError(400, "That's more than 62 days — fill it in smaller steps");
    }

    const people = (
      db.prepare(`SELECT users.id, users.joined_date FROM users WHERE users.attendance_enabled = 1`).all() as { id: number; joined_date: string | null }[]
    ).filter((p) => !data.user_ids || data.user_ids.includes(p.id));

    const insert = db.prepare(`INSERT OR IGNORE INTO attendance (user_id, attendance_date, status, marked_by) VALUES (?, ?, ?, ?)`);
    let marked = 0;
    db.transaction(() => {
      for (const date of dates) {
        for (const p of people) {
          if (p.joined_date && p.joined_date > date) continue;
          marked += insert.run(p.id, date, data.status, req.user!.id).changes;
        }
      }
    })();

    if (marked > 0) {
      logAudit(
        req.user!,
        "attendance_mark_all",
        "staff",
        null,
        `Filled in ${marked} ${STATUS_WORDS[data.status]} mark${marked === 1 ? "" : "s"} for ${people.length} ${people.length === 1 ? "person" : "people"} from ${longDate(data.from)} to ${longDate(data.to)} (days already marked were left alone)`
      );
    }
    res.json({ marked, days: dates.length, people: people.length });
  })
);

// GET /api/attendance?date=YYYY-MM-DD — everyone's attendance for one day,
// the shape the daily marking screen actually needs (list of staff, each
// with whether/how they've been marked yet today). `not_tracked` lists the logins attendance isn't kept for, so they can be switched back on.
attendanceRouter.get(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const today = todayShop();
    const date = String(req.query.date ?? today);
    if (!isRealDate(date)) throw new ApiError(400, "That isn't a valid date");

    const staff = db
      .prepare(
        `SELECT users.id as user_id, COALESCE(users.name, users.username) as name, users.job_title,
                attendance.id as attendance_id, attendance.status, attendance.marked_at, attendance.notes
         FROM users
         LEFT JOIN attendance ON attendance.user_id = users.id AND attendance.attendance_date = ?
         WHERE ${TRACKED_ON_SQL}
         ORDER BY name`
      )
      .all(date, date);
    const notTracked = db.prepare(`SELECT id as user_id, COALESCE(name, username) as name FROM users WHERE attendance_enabled = 0 ORDER BY name`).all();

    res.json({ date, today, staff, not_tracked: notTracked });
  })
);

// GET /api/attendance/month?month=YYYY-MM — the monthly register: every person, each day's mark, and the month's totals. "Not marked" counts only
// the days from the person's joining date up to today (a day that hasn't come yet isn't missing); "worked days" = present + half a day per half day.
// Someone attendance is no longer kept for still shows in the months they have marks in. (Declared before /:userId so "month" isn't read as an id.)
attendanceRouter.get(
  "/month",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const today = todayShop();
    const month = String(req.query.month ?? today.slice(0, 7));
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiError(400, "That isn't a valid month");
    const [y, m] = month.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const start = `${month}-01`;
    const end = `${month}-${String(daysInMonth).padStart(2, "0")}`;

    const people = db
      .prepare(
        `SELECT users.id AS user_id, COALESCE(users.name, users.username) AS name, users.job_title, users.joined_date, users.attendance_enabled AS tracked
         FROM users
         WHERE (${TRACKED_ON_SQL})
            OR EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = users.id AND a.attendance_date BETWEEN ? AND ?)
         ORDER BY name`
      )
      .all(end, start, end) as { user_id: number; name: string; job_title: string | null; joined_date: string | null; tracked: number }[];

    const records = db
      .prepare(`SELECT user_id, attendance_date, status, notes FROM attendance WHERE attendance_date BETWEEN ? AND ?`)
      .all(start, end) as { user_id: number; attendance_date: string; status: Status; notes: string | null }[];
    const byUser = new Map<number, typeof records>();
    for (const r of records) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);

    const lastDay = today < end ? today : end;
    const result = people.map((p) => {
      const mine = byUser.get(p.user_id) ?? [];
      const days: Record<string, Status> = {};
      const notes: Record<string, string> = {};
      const totals = { present: 0, half_day: 0, leave: 0, absent: 0, unmarked: 0, worked_days: 0 };
      for (const r of mine) {
        days[r.attendance_date] = r.status;
        if (r.notes) notes[r.attendance_date] = r.notes;
        totals[r.status]++;
      }
      totals.worked_days = totals.present + totals.half_day * 0.5;
      if (p.tracked) {
        const first = p.joined_date && p.joined_date > start ? p.joined_date : start;
        for (let d = new Date(`${first}T00:00:00Z`); d.toISOString().slice(0, 10) <= lastDay; d.setUTCDate(d.getUTCDate() + 1)) {
          if (!days[d.toISOString().slice(0, 10)]) totals.unmarked++;
        }
      }
      return { user_id: p.user_id, name: p.name, job_title: p.job_title, joined_date: p.joined_date, tracked: !!p.tracked, days, notes, totals };
    });

    res.json({ month, start, end, days_in_month: daysInMonth, today, staff: result });
  })
);

// PUT /api/attendance/tracking/:userId — switch attendance on or off for a login. Their history stays either way.
attendanceRouter.put(
  "/tracking/:userId",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const user = db.prepare(`SELECT id, COALESCE(name, username) AS name FROM users WHERE id = ?`).get(req.params.userId) as { id: number; name: string } | undefined;
    if (!user) throw new ApiError(404, "That staff member does not exist");
    db.prepare(`UPDATE users SET attendance_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, user.id);
    logAudit(req.user!, "attendance_tracking", "staff", user.id, `${enabled ? "Started" : "Stopped"} keeping attendance for ${user.name}`);
    res.json({ user_id: user.id, enabled });
  })
);

// DELETE /api/attendance/:userId/:date — take a mark off again (a wrong tap), leaving that day not marked.
attendanceRouter.delete(
  "/:userId/:date",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    if (!isRealDate(req.params.date)) throw new ApiError(400, "That isn't a valid date");
    const row = db
      .prepare(
        `SELECT attendance.id, attendance.status, COALESCE(users.name, users.username) AS name
         FROM attendance JOIN users ON users.id = attendance.user_id
         WHERE attendance.user_id = ? AND attendance.attendance_date = ?`
      )
      .get(req.params.userId, req.params.date) as { id: number; status: Status; name: string } | undefined;
    if (!row) throw new ApiError(404, "There is no mark to clear for that day");
    db.prepare(`DELETE FROM attendance WHERE id = ?`).run(row.id);
    logAudit(req.user!, "attendance_clear", "staff", Number(req.params.userId), `Cleared ${row.name}'s mark (${STATUS_WORDS[row.status]}) for ${longDate(req.params.date)}`);
    res.status(204).send();
  })
);

// GET /api/attendance/:userId?start=YYYY-MM-DD&end=YYYY-MM-DD — one
// person's attendance history over a range, plus simple totals (days
// present/absent/leave), which is what answers "how many days did they
// work this month" without the admin counting by hand.
attendanceRouter.get(
  "/:userId",
  asyncHandler(async (req, res) => {
    if (req.user!.role !== "admin" && Number(req.params.userId) !== req.user!.id) {
      throw new ApiError(403, "You can only see your own attendance");
    }
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
