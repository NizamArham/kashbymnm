import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "../db/connection";
import { signToken, requireAuth, requireRole } from "../lib/auth";
import { ApiError, asyncHandler } from "../lib/errors";

export const authRouter = Router();

// The very first account ever created for this shop (Nizam Arham) — the
// actual owner's login. Hardcoded so it can never be demoted or deleted
// through the app, no matter who else becomes an admin later.
const PROTECTED_ADMIN_ID = 1;

const loginInput = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const createUserInput = z.object({
  username: z.string().min(3),
  password: z.string().min(6),
  role: z.enum(["admin", "staff"]),
  name: z.string().optional(),
  job_title: z.string().optional(),
  joined_date: z.string().optional(),
  nic: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  salary: z.number().nonnegative().optional(),
  bank_name: z.string().optional(),
  bank_account_no: z.string().optional(),
  bank_account_name: z.string().optional(),
  reports_to: z.number().int().positive().optional(),
});

// Same fields, all optional — used for editing an existing profile.
// Username is editable here (unlike at creation, it's not required) so an
// admin can fix or rename a login the same way they'd reset its password.
const updateUserInput = createUserInput.partial().omit({ password: true });

// Basic HR fields any staff member can see about themself or a colleague
// — no salary, no bank details. Admins get the full row via a separate
// select; this is what a non-admin's own profile (and any lookups like
// "who does this person report to") is built from.
const BASIC_FIELD_LIST = ["id", "username", "role", "name", "job_title", "joined_date", "nic", "phone", "address", "reports_to", "created_at"];
const FULL_FIELD_LIST = [...BASIC_FIELD_LIST, "salary", "bank_name", "bank_account_no", "bank_account_name"];

function selectClause(fields: string[], alias: string): string {
  return fields.map((f) => `${alias}.${f}`).join(", ");
}

// POST /api/auth/login
authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const data = loginInput.parse(req.body);

    const user = db
      .prepare(`SELECT * FROM users WHERE username = ?`)
      .get(data.username) as any;

    if (!user) throw new ApiError(401, "Incorrect username or password");

    const valid = bcrypt.compareSync(data.password, user.password_hash);
    if (!valid) throw new ApiError(401, "Incorrect username or password");

    const token = signToken({
      id: user.id,
      username: user.username,
      role: user.role,
      name: user.name,
    });

    // Record this login so the person's profile can show a real activity
    // log (when they logged in, and for how long once they log out).
    const loginResult = db.prepare(`INSERT INTO login_activity (user_id) VALUES (?)`).run(user.id);

    res.json({
      token,
      login_activity_id: loginResult.lastInsertRowid,
      user: { id: user.id, username: user.username, role: user.role, name: user.name },
    });
  })
);

// POST /api/auth/logout — records the logout timestamp against the login
// row created at sign-in, so a session's duration can be shown later.
authRouter.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    const bodySchema = z.object({ login_activity_id: z.number().int().positive().optional() });
    const { login_activity_id } = bodySchema.parse(req.body);

    if (login_activity_id) {
      db.prepare(`UPDATE login_activity SET logout_at = datetime('now', '+330 minutes') WHERE id = ? AND user_id = ?`).run(
        login_activity_id,
        req.user!.id
      );
    } else {
      // Fallback: close out this user's most recent still-open session,
      // in case the frontend didn't have the id handy (e.g. after a
      // page reload wiped in-memory state).
      db.prepare(
        `UPDATE login_activity SET logout_at = datetime('now', '+330 minutes')
         WHERE user_id = ? AND logout_at IS NULL
         ORDER BY id DESC LIMIT 1`
      ).run(req.user!.id);
    }

    res.status(204).send();
  })
);

// GET /api/auth/me — confirms who you are, useful for the frontend on page load
authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(req.user);
  })
);

// POST /api/auth/users — admin-only: create a new login (e.g. a staff account)
authRouter.post(
  "/users",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const data = createUserInput.parse(req.body);

    const existing = db.prepare(`SELECT id FROM users WHERE username = ?`).get(data.username);
    if (existing) throw new ApiError(409, "That username is already taken");

    if (data.reports_to) {
      const manager = db.prepare(`SELECT id FROM users WHERE id = ?`).get(data.reports_to);
      if (!manager) throw new ApiError(400, "The selected manager does not exist");
    }

    const password_hash = bcrypt.hashSync(data.password, 10);

    const result = db
      .prepare(
        `INSERT INTO users
           (username, password_hash, role, name, job_title, joined_date, nic, phone, address,
            salary, bank_name, bank_account_no, bank_account_name, reports_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.username,
        password_hash,
        data.role,
        data.name ?? null,
        data.job_title ?? null,
        data.joined_date ?? null,
        data.nic ?? null,
        data.phone ?? null,
        data.address ?? null,
        data.salary ?? null,
        data.bank_name ?? null,
        data.bank_account_no ?? null,
        data.bank_account_name ?? null,
        data.reports_to ?? null
      );

    const created = db.prepare(`SELECT ${FULL_FIELD_LIST.join(", ")} FROM users WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(created);
  })
);

// GET /api/auth/users — admin-only: list all logins with full HR details
// (salary/bank included), used for the admin's staff management view.
authRouter.get(
  "/users",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT ${selectClause(FULL_FIELD_LIST, "u")}, manager.name as reports_to_name
         FROM users u
         LEFT JOIN users manager ON manager.id = u.reports_to
         ORDER BY u.id`
      )
      .all();
    res.json(rows);
  })
);

// GET /api/auth/users/:id — a person's own basic profile, or an admin
// viewing anyone's full profile. Staff can only fetch their own id here;
// enforced below rather than trusting the frontend to ask nicely.
authRouter.get(
  "/users/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    const isSelf = targetId === req.user!.id;
    const isAdmin = req.user!.role === "admin";

    if (!isSelf && !isAdmin) {
      throw new ApiError(403, "You can only view your own profile");
    }

    const fields = isAdmin ? FULL_FIELD_LIST : BASIC_FIELD_LIST;
    const row = db
      .prepare(
        `SELECT ${selectClause(fields, "u")}, manager.name as reports_to_name
         FROM users u
         LEFT JOIN users manager ON manager.id = u.reports_to
         WHERE u.id = ?`
      )
      .get(targetId);

    if (!row) throw new ApiError(404, "User not found");
    res.json(row);
  })
);

// PUT /api/auth/users/:id — admin-only: edit a staff member's HR details
// (including salary/bank). Staff cannot edit their own record through
// this endpoint — per the business rule, bank detail changes go through
// an admin request, not self-service.
authRouter.put(
  "/users/:id",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id) as any;
    if (!existing) throw new ApiError(404, "User not found");

    const data = updateUserInput.parse(req.body);
    const merged = { ...existing, ...data };

    if (merged.reports_to && Number(merged.reports_to) === Number(req.params.id)) {
      throw new ApiError(400, "A user cannot report to themself");
    }

    if (Number(req.params.id) === PROTECTED_ADMIN_ID && merged.role !== "admin") {
      throw new ApiError(400, "The primary admin account's role can't be changed");
    }

    if (data.username && data.username !== existing.username) {
      const usernameTaken = db.prepare(`SELECT id FROM users WHERE username = ? AND id != ?`).get(data.username, req.params.id);
      if (usernameTaken) throw new ApiError(409, "That username is already taken");
    }

    db.prepare(
      `UPDATE users SET
         username = ?, name = ?, job_title = ?, joined_date = ?, nic = ?, phone = ?, address = ?,
         salary = ?, bank_name = ?, bank_account_no = ?, bank_account_name = ?, reports_to = ?, role = ?
       WHERE id = ?`
    ).run(
      merged.username,
      merged.name,
      merged.job_title,
      merged.joined_date,
      merged.nic,
      merged.phone,
      merged.address,
      merged.salary,
      merged.bank_name,
      merged.bank_account_no,
      merged.bank_account_name,
      merged.reports_to,
      merged.role,
      req.params.id
    );

    const updated = db.prepare(`SELECT ${FULL_FIELD_LIST.join(", ")} FROM users WHERE id = ?`).get(req.params.id);
    res.json(updated);
  })
);

// PUT /api/auth/users/:id/password — admin-only: set a new password for
// a login, no old password required. This is the "staff forgot their
// password" recovery path — an admin can always reset it, since staff
// have no self-service password change of their own.
authRouter.put(
  "/users/:id/password",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT id FROM users WHERE id = ?`).get(req.params.id);
    if (!existing) throw new ApiError(404, "User not found");

    const { password } = z.object({ password: z.string().min(6) }).parse(req.body);
    const password_hash = bcrypt.hashSync(password, 10);

    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(password_hash, req.params.id);
    res.status(204).send();
  })
);

// DELETE /api/auth/users/:id — admin-only: remove a login
authRouter.delete(
  "/users/:id",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const existing = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
    if (!existing) throw new ApiError(404, "User not found");

    if (Number(req.params.id) === PROTECTED_ADMIN_ID) {
      throw new ApiError(403, "The primary admin account can't be removed");
    }

    // Attendance is real payroll history, not disposable — unlike
    // login_activity below, it's never safe to silently delete just
    // because the account is going away.
    const attendanceCount = db.prepare(`SELECT COUNT(*) as cnt FROM attendance WHERE user_id = ?`).get(req.params.id) as {
      cnt: number;
    };
    if (attendanceCount.cnt > 0) {
      throw new ApiError(
        409,
        `This staff member has ${attendanceCount.cnt} attendance record(s) on file. Removing their login would leave that history pointing at nobody, so it can't be done while it exists.`
      );
    }

    // login_activity is only ever read back through this same user's own
    // profile page — once the account is gone there's nothing left to
    // view it against, so it's safe (and necessary) to clear before the
    // FK on user_id would otherwise block the delete below.
    db.prepare(`DELETE FROM login_activity WHERE user_id = ?`).run(req.params.id);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(req.params.id);
    res.status(204).send();
  })
);

// GET /api/auth/users/:id/activity — a person's own login history, or an
// admin viewing anyone's. This is what the profile's "Activity Log" tab
// is built from — when they logged in and out, and for how long.
authRouter.get(
  "/users/:id/activity",
  requireAuth,
  asyncHandler(async (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    const isSelf = targetId === req.user!.id;
    const isAdmin = req.user!.role === "admin";

    if (!isSelf && !isAdmin) {
      throw new ApiError(403, "You can only view your own activity log");
    }

    const rows = db
      .prepare(`SELECT * FROM login_activity WHERE user_id = ? ORDER BY login_at DESC LIMIT 100`)
      .all(targetId);

    res.json(rows);
  })
);
