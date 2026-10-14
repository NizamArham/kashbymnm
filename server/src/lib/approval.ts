import bcrypt from "bcryptjs";
import { Request, Response, NextFunction } from "express";
import { db } from "../db/connection";
import { ApiError } from "./errors";
import { AuthUser } from "./auth";
import { logAudit } from "./auditLog";

// "Admin approval at the till": an action a cashier can't do alone can be OK'd on the spot by any
// admin typing their password, without logging in as them. The password travels with that ONE request
// (the X-Admin-Approval header) and is checked there and then — nothing is remembered, so the next
// action asks again. The admin who approved is the one the action and the audit log are credited to.
export const APPROVAL_HEADER = "x-admin-approval";

// Guessing admin passwords from a till isn't allowed: a few wrong tries and that till waits.
const MAX_WRONG_TRIES = 5;
const WINDOW_MS = 5 * 60 * 1000;
const wrongTries = new Map<number, number[]>();

// Which admin does this password belong to? (Passwords are only ever stored as hashes, so each admin's
// is checked in turn — there are only ever a handful.) `askedBy` is the cashier session asking, for
// the wrong-guess limit.
export function findAdminByPassword(password: string, askedBy: number): AuthUser | null {
  const now = Date.now();
  const recent = (wrongTries.get(askedBy) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_WRONG_TRIES) {
    throw new ApiError(429, "Too many wrong passwords — wait a few minutes and try again.");
  }

  const admins = db.prepare(`SELECT id, username, name, password_hash FROM users WHERE role = 'admin'`).all() as {
    id: number;
    username: string;
    name: string | null;
    password_hash: string;
  }[];
  for (const admin of admins) {
    if (bcrypt.compareSync(password, admin.password_hash)) {
      wrongTries.delete(askedBy);
      return { id: admin.id, username: admin.username, role: "admin", name: admin.name };
    }
  }
  wrongTries.set(askedBy, [...recent, now]);
  return null;
}

// The admin whose password came with this request, or null if none was sent. A password that isn't
// any admin's is refused outright (403, not 401 — the app reads a 401 as "session expired").
export function approverFor(req: Request): AuthUser | null {
  const raw = req.headers[APPROVAL_HEADER];
  if (typeof raw !== "string" || raw === "") return null;
  let password: string;
  try {
    password = decodeURIComponent(raw); // sent URI-encoded so any character is safe in a header
  } catch {
    throw new ApiError(400, "Couldn't read the approval password");
  }
  const admin = findAdminByPassword(password, req.user!.id);
  if (!admin) throw new ApiError(403, "That isn't an admin's password.", "wrong_approval");
  return admin;
}

// Once the approved action has gone through, say so in the audit log, under the admin who approved.
function recordApproval(req: Request, res: Response, approver: AuthUser, what: string) {
  const cashier = req.user!.name ?? req.user!.username;
  res.once("finish", () => {
    if (res.statusCode < 400) logAudit(approver, "till_approval", "till", null, `${what} — approved at ${cashier}'s till`);
  });
}

// Route guard for an admin-only action that an admin can also OK from a cashier's screen: an admin
// passes straight through; anyone else needs an admin's password sent with this request.
export function requireAdminOrApproval(what: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) throw new ApiError(401, "Not logged in");
    if (req.user.role === "admin") return next();
    const approver = approverFor(req);
    if (!approver) throw new ApiError(403, `${what} needs an admin's password.`, "needs_approval");
    req.approver = approver;
    recordApproval(req, res, approver, what);
    next();
  };
}

// The same, for a rule that depends on what's in the request (how big the discount is...): nothing is
// asked unless `reasons` says something needs an admin's OK, and an admin's own sale never does.
export function approveIfNeeded(req: Request, res: Response, reasons: string[], what: string): AuthUser | null {
  if (reasons.length === 0 || req.user!.role === "admin") return null;
  const approver = approverFor(req);
  if (!approver) throw new ApiError(403, `${what} needs an admin's password: ${reasons.join("; ")}.`, "needs_approval");
  req.approver = approver;
  recordApproval(req, res, approver, `${what} (${reasons.join("; ")})`);
  return approver;
}

// Who a decision is credited to: the admin who approved it at the till, else whoever is signed in.
export const actorOf = (req: Request): AuthUser => req.approver ?? req.user!;
