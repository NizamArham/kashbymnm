import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ClipboardCheck } from "lucide-react";
import { PageLoader } from "./Loader";
import { api, ApiRequestError } from "../lib/api";
import { AttendanceStatus, MonthRegister, MonthRegisterRow } from "../lib/types";
import { ATTENDANCE_STATUSES, daysText, monthLabel, shiftMonth, statusMeta } from "../lib/attendanceStatus";
import { downloadTabularReport, buildReportFilename, todayLongDate } from "../lib/reportPdf";
import { Button, Card, EmptyState, ErrorText } from "./ui";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const dayIso = (month: string, d: number) => `${month}-${String(d).padStart(2, "0")}`;
const weekdayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

// The monthly register: everyone down the side, the days across, each person's totals on the right. Tap a day to open it (and fix it) on the
// daily screen. "Worked days" = present + half a day for each half day — the number a month's pay is worked out from.
export default function AttendanceMonth({ month, onMonthChange, onOpenDay, today }: { month: string; onMonthChange: (m: string) => void; onOpenDay: (date: string) => void; today: string }) {
  const [data, setData] = useState<MonthRegister | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<MonthRegister>(`/attendance/month?month=${month}`)
      .then((r) => !cancelled && setData(r))
      .catch((err) => !cancelled && setError(err instanceof ApiRequestError ? err.message : "Failed to load the register"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [month]);

  const thisMonth = today.slice(0, 7);
  const days = data ? Array.from({ length: data.days_in_month }, (_, i) => i + 1) : [];

  // What a day's cell shows for one person: their mark, a faint dot if it should have been marked and wasn't, or nothing if it doesn't count.
  function cellState(p: MonthRegisterRow, iso: string): { kind: "mark"; status: AttendanceStatus } | { kind: "missing" } | { kind: "na" } {
    const status = p.days[iso];
    if (status) return { kind: "mark", status };
    if (iso > today || (p.joined_date && p.joined_date > iso) || !p.tracked) return { kind: "na" };
    return { kind: "missing" };
  }

  function downloadPdf() {
    if (!data) return;
    const letter = (p: MonthRegisterRow, iso: string) => {
      const c = cellState(p, iso);
      return c.kind === "mark" ? statusMeta(c.status).letter : c.kind === "missing" ? "·" : "";
    };
    downloadTabularReport({
      headerLabel: "M&M Clothing — Attendance Register",
      headerFields: [
        { label: "Report", value: "Attendance Register" },
        { label: "Month", value: monthLabel(month) },
        { label: "Generated", value: todayLongDate() },
      ],
      rangeLabel: monthLabel(month),
      orientation: "landscape",
      columns: [
        { label: "Name", width: 95 },
        ...days.map((d) => ({ label: String(d), width: 15, align: "center" as const, tight: true })),
        { label: "Worked", width: 48, align: "right" as const, tight: true },
        { label: "P", width: 20, align: "right" as const, tight: true },
        { label: "H", width: 20, align: "right" as const, tight: true },
        { label: "L", width: 20, align: "right" as const, tight: true },
        { label: "A", width: 20, align: "right" as const, tight: true },
        { label: "Not marked", width: 56, align: "right" as const, tight: true },
      ],
      rows: data.staff.map((p) => ({
        cells: [p.name, ...days.map((d) => letter(p, dayIso(month, d))), daysText(p.totals.worked_days), String(p.totals.present), String(p.totals.half_day), String(p.totals.leave), String(p.totals.absent), String(p.totals.unmarked)],
      })),
      summaryLines: [
        { text: "P = present   H = half day   L = leave   A = absent   · = not marked   (blank = a day that hasn't come, or before they joined)" },
        { text: "Worked = present days + half a day for each half day." },
      ],
      filename: buildReportFilename("Attendance Register", month),
    });
  }

  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <button onClick={() => onMonthChange(shiftMonth(month, -1))} className="rounded-xl border border-gray-200 bg-white p-2.5 text-gray-600 hover:bg-gray-50" aria-label="Previous month" title="Previous month">
          <ChevronLeft size={16} />
        </button>
        <span className="min-w-[9.5rem] text-center text-sm font-medium text-gray-900">{monthLabel(month)}</span>
        <button
          onClick={() => onMonthChange(shiftMonth(month, 1))}
          disabled={month >= thisMonth}
          className="rounded-xl border border-gray-200 bg-white p-2.5 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white"
          aria-label="Next month"
          title="Next month"
        >
          <ChevronRight size={16} />
        </button>
        {month !== thisMonth && (
          <button onClick={() => onMonthChange(thisMonth)} className="text-xs text-gray-500 hover:text-gray-700 underline">
            This month
          </button>
        )}
        <Button onClick={downloadPdf} disabled={!data || data.staff.length === 0} className="ml-auto inline-flex items-center gap-1.5">
          <Download size={14} />
          Download PDF
        </Button>
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-xs text-gray-500">
        {ATTENDANCE_STATUSES.map((s) => (
          <span key={s.value} className="inline-flex items-center gap-1.5">
            <span className={`inline-flex h-5 w-5 items-center justify-center rounded text-[11px] font-semibold ${s.chipClass}`}>{s.letter}</span>
            {s.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded text-base leading-none text-amber-500">•</span>
          Not marked
        </span>
        <span>Tap a day to open it.</span>
      </div>

      {loading ? (
        <PageLoader />
      ) : !data || data.staff.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="No attendance for this month" subtitle="Mark attendance on the Daily tab and it appears here." />
      ) : (
        <Card className="p-0 overflow-clip">
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 bg-white text-left px-3 py-2 text-xs font-medium text-gray-500 border-b border-gray-100 min-w-[9rem]">Name</th>
                  <th className="px-2.5 py-2 text-right text-xs font-medium text-gray-900 border-b border-gray-100 whitespace-nowrap">Worked</th>
                  {["P", "H", "L", "A"].map((l) => (
                    <th key={l} className="px-1.5 py-2 text-right text-xs font-medium text-gray-500 border-b border-gray-100">{l}</th>
                  ))}
                  <th className="px-2.5 py-2 text-right text-xs font-medium text-gray-500 border-b border-gray-100 border-r whitespace-nowrap">Not marked</th>
                  {days.map((d) => {
                    const iso = dayIso(month, d);
                    const weekend = weekdayOf(iso) === 0;
                    return (
                      <th key={d} className={`px-px py-1.5 text-center text-[11px] font-medium border-b border-gray-100 min-w-[1.4rem] ${iso === today ? "text-gray-900 bg-gray-100" : weekend ? "text-gray-400 bg-gray-50" : "text-gray-500"}`}>
                        <div>{d}</div>
                        <div className="font-normal text-[10px]">{WEEKDAYS[weekdayOf(iso)]}</div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {data.staff.map((p) => (
                  <tr key={p.user_id}>
                    <td className="sticky left-0 z-10 bg-white px-3 py-2 border-b border-gray-50 min-w-[9rem]">
                      <p className="font-medium text-gray-900 leading-tight">{p.name}</p>
                      <p className="text-xs text-gray-500 leading-tight">{p.tracked ? p.job_title ?? "" : "Attendance no longer kept"}</p>
                    </td>
                    <td className="px-2.5 py-2 text-right font-semibold text-gray-900 tabular-nums border-b border-gray-50">{daysText(p.totals.worked_days)}</td>
                    <td className="px-1.5 py-2 text-right tabular-nums text-gray-600 border-b border-gray-50">{p.totals.present}</td>
                    <td className="px-1.5 py-2 text-right tabular-nums text-gray-600 border-b border-gray-50">{p.totals.half_day}</td>
                    <td className="px-1.5 py-2 text-right tabular-nums text-gray-600 border-b border-gray-50">{p.totals.leave}</td>
                    <td className="px-1.5 py-2 text-right tabular-nums text-gray-600 border-b border-gray-50">{p.totals.absent}</td>
                    <td className={`px-2.5 py-2 text-right tabular-nums border-b border-gray-50 border-r ${p.totals.unmarked > 0 ? "text-amber-600 font-medium" : "text-gray-400"}`}>{p.totals.unmarked}</td>
                    {days.map((d) => {
                      const iso = dayIso(month, d);
                      const c = cellState(p, iso);
                      const tip = c.kind === "mark" ? `${statusMeta(c.status).label}${p.notes[iso] ? ` — ${p.notes[iso]}` : ""}` : c.kind === "missing" ? "Not marked" : "";
                      return (
                        <td key={d} className={`px-px py-1.5 text-center border-b border-gray-50 ${iso === today ? "bg-gray-50" : weekdayOf(iso) === 0 ? "bg-gray-50/60" : ""}`}>
                          {c.kind === "na" ? (
                            <span className="text-gray-200">·</span>
                          ) : (
                            <button
                              onClick={() => onOpenDay(iso)}
                              title={tip}
                              aria-label={`${p.name}, ${iso}: ${tip}`}
                              className={`inline-flex h-5 w-5 items-center justify-center rounded text-[11px] font-semibold hover:ring-2 hover:ring-gray-300 ${c.kind === "mark" ? statusMeta(c.status).chipClass : "text-amber-500 text-base leading-none"}`}
                            >
                              {c.kind === "mark" ? statusMeta(c.status).letter : "•"}
                            </button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500 px-4 py-3 border-t border-gray-100">
            <strong className="font-medium text-gray-700">Worked</strong> = present days + half a day for each half day. A day that hasn't come yet, or is before someone joined, isn't counted as "not marked".
          </p>
        </Card>
      )}
    </div>
  );
}
