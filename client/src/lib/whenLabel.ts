import { formatDateTime } from "./dates";

// "2026-10-17 23:59:59" -> "17 Oct, 11:59 pm"  (kept as a name; the one date style lives in lib/dates.ts)
export function whenLabel(stamp: string): string {
  return formatDateTime(stamp);
}
