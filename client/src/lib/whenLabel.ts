// "2026-10-17 23:59:59" -> "17 Oct, 11:59 pm"
export function whenLabel(stamp: string): string {
  const d = new Date(stamp.replace(" ", "T"));
  return Number.isNaN(d.getTime())
    ? stamp.slice(0, 16)
    : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
}
