// The one way the app writes a date or a moment in time on screen.
//
//   formatDateTime("2026-10-18 18:43:07")  ->  "18 Oct, 6:43 pm"        (this year)
//   formatDateTime("2025-12-30 09:05:00")  ->  "30 Dec 2025, 9:05 am"   (any other year)
//   formatDate("2026-10-18")               ->  "18 Oct"
//   formatDate("2025-12-30")               ->  "30 Dec 2025"
//
// Stored stamps are already Sri Lanka wall-clock time ("YYYY-MM-DD HH:MM:SS" or the "T" form), so they're read as written:
// no timezone conversion, whatever the device's own zone is. The year only appears when it isn't this year, so a list reads
// short but an old record is never ambiguous.
//
// This is for the screen. Printed documents (receipts, slips, PDF reports) keep their own fuller formats.

import { todayInSriLanka } from "./time";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;

function parts(value: string | null | undefined) {
  if (!value) return null;
  const m = STAMP.exec(value);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(m[1]), month, day: Number(m[3]), hour: m[4] !== undefined ? Number(m[4]) : null, minute: m[5] !== undefined ? Number(m[5]) : null };
}

function dayText(p: { year: number; month: number; day: number }) {
  const thisYear = Number(todayInSriLanka().slice(0, 4));
  return `${p.day} ${MONTHS[p.month - 1]}${p.year === thisYear ? "" : ` ${p.year}`}`;
}

// "18 Oct" — a day, with no time.
export function formatDate(value: string | null | undefined, empty = "—"): string {
  const p = parts(value);
  return p ? dayText(p) : value ? value.slice(0, 10) : empty;
}

// "18 Oct, 6:43 pm" — a moment. A stamp with no time on it comes out as just the day.
export function formatDateTime(value: string | null | undefined, empty = "—"): string {
  const p = parts(value);
  if (!p) return value ? value.slice(0, 16) : empty;
  const time = formatTime(value);
  return time ? `${dayText(p)}, ${time}` : dayText(p);
}

// "6:43 pm" — just the time of day, or null when the stamp has none.
export function formatTime(value: string | null | undefined): string | null {
  const p = parts(value);
  if (!p || p.hour === null || p.minute === null) return null;
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${String(p.minute).padStart(2, "0")} ${p.hour < 12 ? "am" : "pm"}`;
}

// "YYYY-MM-DD" for a Date, in the device's own calendar, and a day shifted by some number of days.
const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const todayIso = () => isoOf(new Date());
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return isoOf(d);
}
