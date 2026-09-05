import { Request, Response, NextFunction } from "express";

export class ApiError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Wraps an async route handler so thrown errors reach the error middleware
// instead of crashing the server or hanging the request.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  // SQLite constraint errors (e.g. UNIQUE, FOREIGN KEY) — surface a
  // readable message instead of a raw stack trace.
  if (err?.code?.startsWith?.("SQLITE_CONSTRAINT")) {
    return res.status(409).json({ error: "Data conflict: " + err.message });
  }

  console.error(err);
  return res.status(500).json({ error: "Internal server error" });
}
