import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { db } from "../db/connection";

// A safety copy of the database every day, kept OFF the live data folder so one bad disk (or one bad day) can't take the data and its only
// backup together. By default it goes to iCloud Drive ("Kash Backups"), which syncs by itself; BACKUP_DIR points it anywhere else, and
// BACKUP_DIR=off turns it off. One file per day (mm-clothing-2026-11-11.db), the newest BACKUP_KEEP_DAYS (30) kept.
//
// Each copy is made with SQLite's own online backup (a consistent snapshot even while the shop is working), then opened and integrity-checked
// before it is trusted — a copy that fails the check is thrown away and the failure is reported in Settings, never silently kept.
// It checks every 30 minutes while the server runs, so a Mac that was asleep at night backs up as soon as it's awake.

const ICLOUD = path.join(os.homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs");
const FILE_RE = /^mm-clothing-(\d{4}-\d{2}-\d{2})\.db$/;

let running = false;
let lastError: string | null = null;
let lastErrorAt: string | null = null;

export function backupFolder(): { dir: string | null; kind: "icloud" | "custom" | "local" | "off" } {
  const configured = process.env.BACKUP_DIR?.trim();
  if (configured?.toLowerCase() === "off") return { dir: null, kind: "off" };
  if (configured) return { dir: configured, kind: "custom" };
  if (fs.existsSync(ICLOUD)) return { dir: path.join(ICLOUD, "Kash Backups"), kind: "icloud" };
  return { dir: path.join(__dirname, "..", "..", "data", "auto-backups"), kind: "local" };
}

const keepDays = () => Math.max(1, Number(process.env.BACKUP_KEEP_DAYS) || 30);

// Today's date on the shop's clock (the Mac's), as YYYY-MM-DD.
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dailyFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
  } catch {
    return [];
  }
}

export function backupStatus() {
  const { dir, kind } = backupFolder();
  const files = dir ? dailyFiles(dir) : [];
  const newest = files.length ? files[files.length - 1] : null;
  let newestAt: string | null = null;
  if (dir && newest) {
    try {
      newestAt = fs.statSync(path.join(dir, newest)).mtime.toISOString();
    } catch {
      newestAt = null;
    }
  }
  return { enabled: !!dir, folder: dir, kind, keep_days: keepDays(), count: files.length, newest_file: newest, newest_at: newestAt, last_error: lastError, last_error_at: lastErrorAt };
}

// Makes today's copy unless it's already there. Returns what happened.
export async function runBackup(): Promise<"made" | "already_done" | "off"> {
  const { dir } = backupFolder();
  if (!dir) return "off";
  if (running) return "already_done";
  running = true;
  const tmp = path.join(os.tmpdir(), `kash-auto-${Date.now()}.db`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, `mm-clothing-${today()}.db`);
    if (fs.existsSync(finalPath)) return "already_done";

    await db.backup(tmp);
    // Saved as one plain file (not in WAL mode), so opening or restoring a copy never needs side files; then checked before it is trusted.
    const check = new Database(tmp, { fileMustExist: true });
    let verdict: unknown;
    try {
      check.pragma("journal_mode = DELETE");
      verdict = check.pragma("integrity_check", { simple: true });
    } finally {
      check.close();
    }
    if (verdict !== "ok") throw new Error(`the copy failed its integrity check (${String(verdict)})`);

    fs.copyFileSync(tmp, `${finalPath}.partial`);
    fs.renameSync(`${finalPath}.partial`, finalPath);

    // Older copies beyond the newest N come off.
    const files = dailyFiles(dir);
    for (const old of files.slice(0, Math.max(0, files.length - keepDays()))) fs.unlinkSync(path.join(dir, old));

    lastError = null;
    lastErrorAt = null;
    console.log(`[backup] saved ${path.basename(finalPath)} to ${dir}`);
    return "made";
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    lastErrorAt = new Date().toISOString();
    console.error("[backup] failed:", lastError);
    throw err;
  } finally {
    running = false;
    fs.rmSync(tmp, { force: true });
  }
}

// First check a minute after the server starts, then every 30 minutes.
export function startAutoBackup(intervalMs = 30 * 60 * 1000) {
  if (!backupFolder().dir) return;
  const run = () => runBackup().catch(() => {});
  setTimeout(run, 60 * 1000);
  setInterval(run, intervalMs);
}
