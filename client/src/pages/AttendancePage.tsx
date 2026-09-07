import { useState, useEffect } from "react";
import { ClipboardCheck } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { DailyAttendanceRow, AttendanceStatus } from "../lib/types";
import { PageHeader, Card, ErrorText } from "../components/ui";

const STATUS_OPTIONS: { value: AttendanceStatus; label: string; activeClass: string }[] = [
  { value: "present", label: "Present", activeClass: "bg-green-600 text-white" },
  { value: "half_day", label: "Half day", activeClass: "bg-amber-500 text-white" },
  { value: "leave", label: "Leave", activeClass: "bg-gray-500 text-white" },
  { value: "absent", label: "Absent", activeClass: "bg-red-600 text-white" },
];

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function AttendancePage() {
  const [date, setDate] = useState(() => toISODate(new Date()));
  const [staff, setStaff] = useState<DailyAttendanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<{ date: string; staff: DailyAttendanceRow[] }>(`/attendance?date=${date}`);
      setStaff(result.staff);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load attendance");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  async function mark(userId: number, status: AttendanceStatus) {
    setSavingId(userId);
    try {
      await api.post("/attendance", { user_id: userId, attendance_date: date, status });
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to save attendance");
    } finally {
      setSavingId(null);
    }
  }

  const markedCount = staff.filter((s) => s.status).length;

  return (
    <div>
      <PageHeader
        title="Attendance"
        subtitle="Mark each staff member's attendance for the selected day."
        action={
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-gray-400"
          />
        }
      />

      {error && <ErrorText>{error}</ErrorText>}

      {!loading && (
        <p className="text-xs text-gray-400 mb-3">
          {markedCount} of {staff.length} marked for {date}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : staff.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <ClipboardCheck size={40} className="mx-auto mb-2" />
          <p>No staff accounts yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {staff.map((s) => (
            <Card key={s.user_id} className="flex items-center justify-between py-3">
              <div>
                <p className="text-sm font-medium text-gray-900">{s.name ?? "—"}</p>
                <p className="text-xs text-gray-400">{s.job_title ?? "—"}</p>
              </div>
              <div className="flex items-center gap-2">
                {s.status && <span className="text-xs text-gray-400 mr-1">Marked {s.marked_at?.slice(11, 16)}</span>}
                {STATUS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => mark(s.user_id, opt.value)}
                    disabled={savingId === s.user_id}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition disabled:opacity-50 ${
                      s.status === opt.value ? opt.activeClass : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
