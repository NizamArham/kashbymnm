import { AttendanceStatus } from "./types";

// How each mark looks and reads, everywhere attendance is shown (the daily screen, the monthly register, its PDF).
export const ATTENDANCE_STATUSES: { value: AttendanceStatus; label: string; letter: string; activeClass: string; chipClass: string }[] = [
  { value: "present", label: "Present", letter: "P", activeClass: "bg-green-600 text-white", chipClass: "bg-green-100 text-green-800" },
  { value: "half_day", label: "Half day", letter: "H", activeClass: "bg-amber-500 text-white", chipClass: "bg-amber-100 text-amber-800" },
  { value: "leave", label: "Leave", letter: "L", activeClass: "bg-gray-500 text-white", chipClass: "bg-gray-200 text-gray-700" },
  { value: "absent", label: "Absent", letter: "A", activeClass: "bg-red-600 text-white", chipClass: "bg-red-100 text-red-700" },
];

export const statusMeta = (status: AttendanceStatus) => ATTENDANCE_STATUSES.find((s) => s.value === status)!;

// "November 2026" from "2026-11".
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Worked days read as 18, or 18.5 — never 18.0.
export const daysText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
