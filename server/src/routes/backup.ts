import { Router } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import nodemailer from "nodemailer";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";

export const backupRouter = Router();

// Backing up the live database — admin only, same access model as
// everything else that touches raw business data.
backupRouter.use(requireAuth, requireRole("admin"));

function backupFileName(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  return `mm-clothing-backup-${stamp}.db`;
}

// Uses better-sqlite3's own online backup API rather than a plain file
// copy — this takes a consistent snapshot even while the live app is
// reading/writing (WAL mode), so the resulting file is never a
// half-written, corrupt copy the way `cp` on a busy DB could be.
async function createSnapshot(): Promise<string> {
  const tempPath = path.join(os.tmpdir(), `kash-backup-${Date.now()}.db`);
  await db.backup(tempPath);
  return tempPath;
}

// GET /api/backup/download — streams a fresh snapshot straight to the
// browser as a file download, then cleans up the temp copy.
backupRouter.get(
  "/download",
  asyncHandler(async (_req, res) => {
    const tempPath = await createSnapshot();
    res.download(tempPath, backupFileName(), (err) => {
      fs.unlink(tempPath, () => {});
      if (err && !res.headersSent) {
        console.error("Backup download failed:", err);
      }
    });
  })
);

function getTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  return nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
}

// POST /api/backup/email — same snapshot, emailed as an attachment to
// whoever's configured in BACKUP_EMAIL_TO (comma-separated). Returns a
// clear, actionable error if the sending account isn't set up yet,
// rather than a generic failure.
backupRouter.post(
  "/email",
  asyncHandler(async (_req, res) => {
    const transporter = getTransporter();
    if (!transporter) {
      throw new ApiError(
        400,
        "Email backup isn't set up yet — add GMAIL_USER and GMAIL_APP_PASSWORD to server/.env, then restart the server."
      );
    }
    const recipients = (process.env.BACKUP_EMAIL_TO ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    if (recipients.length === 0) {
      throw new ApiError(400, "No recipient configured — add BACKUP_EMAIL_TO to server/.env (comma-separated for more than one).");
    }

    const tempPath = await createSnapshot();
    const fileName = backupFileName();
    const dateLabel = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

    try {
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: recipients.join(", "),
        subject: `Kash by M&M — Database backup, ${dateLabel}`,
        text: `Attached is a full database backup taken on ${dateLabel}.\n\nThis file is your entire shop's data — keep it somewhere safe.`,
        attachments: [{ filename: fileName, path: tempPath }],
      });
    } finally {
      fs.unlink(tempPath, () => {});
    }

    res.json({ sent_to: recipients });
  })
);
