// This app is only ever used in Sri Lanka, so "today" and other date
// boundaries should always mean Sri Lanka's calendar day (UTC+5:30, no
// DST) — not whatever timezone the viewing device happens to be set to.
// Adding the fixed offset to the current UTC instant and reading it back
// with the UTC getters gives Sri Lanka's wall-clock date/time regardless
// of the device's own local timezone.
const SRI_LANKA_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function sriLankaNow(): Date {
  return new Date(Date.now() + SRI_LANKA_OFFSET_MS);
}

// "YYYY-MM-DD" for the current date in Sri Lanka, for prefix-matching
// against stored "YYYY-MM-DD HH:MM:SS" timestamps.
export function todayInSriLanka(): string {
  const d = sriLankaNow();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
