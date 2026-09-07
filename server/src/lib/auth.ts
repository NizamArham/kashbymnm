import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { ApiError } from "./errors";

// In a real hosted app this would be a long random secret kept out of code.
// Since this system runs entirely on your own machine with no public
// internet exposure, a fixed secret here is fine — nobody outside your
// computer can ever reach this server to attempt to forge a token.
const JWT_SECRET = process.env.JWT_SECRET || "mm-clothing-local-secret-change-if-you-ever-host-this";

export type UserRole = "admin" | "staff";

export interface AuthUser {
  id: number;
  username: string;
  role: UserRole;
  name: string | null;
}

export function signToken(user: AuthUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: "12h" });
}

// Extends Express's Request type so req.user is recognized by TypeScript
// everywhere after the requireAuth middleware runs.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// Reads the "Authorization: Bearer <token>" header, verifies it, and
// attaches the decoded user to req.user. Every protected route needs this
// middleware to run first.
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new ApiError(401, "Not logged in");
  }

  const token = header.slice("Bearer ".length);
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
    req.user = decoded;
    next();
  } catch {
    throw new ApiError(401, "Session expired or invalid — please log in again");
  }
}

// Restricts a route to specific roles. Use after requireAuth.
// Example: router.post("/", requireAuth, requireRole("admin"), handler)
export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw new ApiError(401, "Not logged in");
    }
    if (!allowedRoles.includes(req.user.role)) {
      throw new ApiError(403, "You don't have permission to do this");
    }
    next();
  };
}
