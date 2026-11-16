import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ClipboardCheck, CheckCheck, CalendarRange } from "lucide-react";
import { PageLoader } from "./Loader";
import { api, ApiRequestError } from "../lib/api";
import { AttendanceStatus, DailyAttendance } from "../lib/types";
import { ATTENDANCE_STATUSES } from "../lib/attendanceStatus";
import { Button, Card, EmptyState, ErrorText, SuccessText, ActionMenu, Modal } from "./ui";
import { useConfirm } from "./Feedback";
import { addDaysIso, formatDate, formatTime } from "../lib/dates";

// One day: tap a status next to each name. "Mark everyone present" does the usual busy-morning tap; a wrong tap is cleared with "Clear".
export default function AttendanceDaily({ date, onDateChange, today }: { date: string; onDateChange: (d: string) => void; today: string }) {
  const { confirm } = useConfirm();
  const [data, setData] = useState<DailyAttendance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  // The note being typed for each person (saved when they leave the box).
  const [notes, setNotes] = useState<Record<number, string>>({});

  // "Fill several days": catch up a run of days in one go, without changing anything already marked.
  const [showFill, setShowFill] = useState(false);
  const [fillFrom, setFillFrom] = useState("");
  const [fillTo, setFillTo] = useState("");
  const [fillStatus, setFillStatus] = useState<AttendanceStatus>("present");
  const [fillSkipSundays, setFillSkipSundays] = useState(false);
  const [fillPeople, setFillPeople] = useState<number[]>([]);
  const [filling, setFilling] = useState(false);
  const [fillError, setFillError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load(showSpinner = true) {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const result = await api.get<DailyAttendance>(`/attendance?date=${date}`);
      setData(result);
      setNotes(Object.fromEntries(result.staff.map((s) => [s.user_id, s.notes ?? ""])));
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

  async function run(userId: number, action: () => Promise<unknown>, failure: string) {
    setBusyId(userId);
    setError(null);
    try {
      await action();
      await load(false);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : failure);
    } finally {
      setBusyId(null);
    }
  }

  const mark = (userId: number, status: AttendanceStatus, note = notes[userId] ?? "") =>
    run(userId, () => api.post("/attendance", { user_id: userId, attendance_date: date, status, notes: note.trim() || undefined }), "Failed to save attendance");
  const clear = (userId: number) => run(userId, () => api.delete(`/attendance/${userId}/${date}`), "Failed to clear the mark");
  const setTracking = (userId: number, enabled: boolean) => run(userId, () => api.put(`/attendance/tracking/${userId}`, { enabled }), "Failed to change this");

  async function markEveryone() {
    setMarkingAll(true);
    setError(null);
    try {
      await api.post("/attendance/mark-all", { attendance_date: date, status: "present" });
      await load(false);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to mark everyone");
    } finally {
      setMarkingAll(false);
    }
  }

  function openFill() {
    setFillFrom(`${today.slice(0, 8)}01`);
    setFillTo(today);
    setFillStatus("present");
    setFillSkipSundays(false);
    setFillPeople((data?.staff ?? []).map((p) => p.user_id));
    setFillError(null);
    setShowFill(true);
  }

  async function fillDays() {
    setFilling(true);
    setFillError(null);
    try {
      const r = await api.post<{ marked: number; days: number }>("/attendance/fill-range", {
        from: fillFrom,
        to: fillTo,
        status: fillStatus,
        skip_weekdays: fillSkipSundays ? [0] : [],
        user_ids: fillPeople,
      });
      setShowFill(false);
      setMessage(r.marked === 0 ? "Nothing to fill — every day in that range was already marked." : `Filled in ${r.marked} mark${r.marked === 1 ? "" : "s"} over ${r.days} day${r.days === 1 ? "" : "s"}. Anything already marked was left as it was.`);
      await load(false);
    } catch (err) {
      setFillError(err instanceof ApiRequestError ? err.message : "Failed to fill in these days");
    } finally {
      setFilling(false);
    }
  }

  async function stopTracking(userId: number, name: string) {
    const yes = await confirm({
      title: `Stop keeping attendance for ${name}?`,
      message: "They leave this list and the register's \"not marked\" count. Their past marks stay, and you can start again any time.",
      confirmLabel: "Stop keeping",
    });
    if (yes) await setTracking(userId, false);
  }

  const staff = data?.staff ?? [];
  const count = (status: AttendanceStatus) => staff.filter((s) => s.status === status).length;
  const notMarked = staff.filter((s) => !s.status).length;
  const isFuture = date > today;

  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <button onClick={() => onDateChange(addDaysIso(date, -1))} className="rounded-xl border border-gray-200 bg-white p-2.5 text-gray-600 hover:bg-gray-50" aria-label="Previous day" title="Previous day">
          <ChevronLeft size={16} />
        </button>
        <input
          type="date"
          value={date}
          max={today}
          onChange={(e) => e.target.value && onDateChange(e.target.value)}
          className="border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-gray-400"
        />
        <button
          onClick={() => onDateChange(addDaysIso(date, 1))}
          disabled={date >= today}
          className="rounded-xl border border-gray-200 bg-white p-2.5 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white"
          aria-label="Next day"
          title="Next day"
        >
          <ChevronRight size={16} />
        </button>
        {date !== today && (
          <button onClick={() => onDateChange(today)} className="text-xs text-gray-500 hover:text-gray-700 underline">
            Today
          </button>
        )}
        <span className="text-sm text-gray-700 ml-1">{formatDate(date)}</span>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {staff.length > 0 && (
            <Button onClick={openFill} className="inline-flex items-center gap-1.5">
              <CalendarRange size={14} />
              Fill several days
            </Button>
          )}
          {!isFuture && notMarked > 0 && (
            <Button variant="primary" onClick={markEveryone} disabled={markingAll} className="inline-flex items-center gap-1.5">
              <CheckCheck size={14} />
              {markingAll ? "Saving..." : notMarked === staff.length ? "Mark everyone present" : `Mark the other ${notMarked} present`}
            </Button>
          )}
        </div>
      </div>

      {error && <ErrorText>{error}</ErrorText>}
      {message && <SuccessText>{message}</SuccessText>}

      {showFill && (
        <Modal
          size="md"
          onClose={() => setShowFill(false)}
          title="Fill several days"
          subtitle="Catch up a run of days in one go. Days that already have a mark are never changed."
          footer={
            <>
              <Button onClick={() => setShowFill(false)}>Cancel</Button>
              <Button variant="primary" onClick={fillDays} disabled={filling || fillPeople.length === 0 || !fillFrom || !fillTo}>
                {filling ? "Filling..." : "Fill in"}
              </Button>
            </>
          }
        >
          <div className="grid grid-cols-2 gap-3 mb-4">
            <label className="text-xs text-gray-500">
              From
              <input type="date" value={fillFrom} max={today} onChange={(e) => setFillFrom(e.target.value)} className="mt-1 w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-gray-400" />
            </label>
            <label className="text-xs text-gray-500">
              To
              <input type="date" value={fillTo} max={today} onChange={(e) => setFillTo(e.target.value)} className="mt-1 w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-gray-400" />
            </label>
          </div>
          <p className="text-xs text-gray-500 mb-1.5">Mark them as</p>
          <div className="flex gap-2 flex-wrap mb-4">
            {ATTENDANCE_STATUSES.map((opt) => (
              <button key={opt.value} onClick={() => setFillStatus(opt.value)} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${fillStatus === opt.value ? opt.activeClass : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                {opt.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700 mb-4">
            <input type="checkbox" checked={fillSkipSundays} onChange={(e) => setFillSkipSundays(e.target.checked)} className="rounded border-gray-300" />
            Leave out Sundays
          </label>
          <p className="text-xs text-gray-500 mb-1.5">For</p>
          <div className="space-y-1.5">
            {staff.map((p) => (
              <label key={p.user_id} className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={fillPeople.includes(p.user_id)}
                  onChange={(e) => setFillPeople((ids) => (e.target.checked ? [...ids, p.user_id] : ids.filter((id) => id !== p.user_id)))}
                  className="rounded border-gray-300"
                />
                {p.name ?? "—"}
              </label>
            ))}
          </div>
          {fillError && <ErrorText>{fillError}</ErrorText>}
        </Modal>
      )}

      {!loading && staff.length > 0 && (
        <p className="text-xs text-gray-500 mb-3">
          {ATTENDANCE_STATUSES.map((s) => `${s.label} ${count(s.value)}`).join(" · ")} · Not marked {notMarked}
        </p>
      )}

      {loading ? (
        <PageLoader />
      ) : staff.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="No one on the list for this day" subtitle="Add a staff member, or start keeping attendance for someone below." />
      ) : (
        <div className="space-y-2">
          {staff.map((s) => (
            <Card key={s.user_id} className="py-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900">{s.name ?? "—"}</p>
                  <p className="text-xs text-gray-500">{s.job_title ?? "—"}</p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {s.status && s.marked_at && <span className="text-xs text-gray-500 mr-1">Marked {formatTime(s.marked_at) ?? ""}</span>}
                  {ATTENDANCE_STATUSES.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => mark(s.user_id, opt.value)}
                      disabled={busyId === s.user_id || isFuture}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition disabled:opacity-50 ${
                        s.status === opt.value ? opt.activeClass : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                  <ActionMenu
                    items={[
                      ...(s.status ? [{ label: "Clear this mark", onClick: () => clear(s.user_id) }] : []),
                      { label: "Stop keeping attendance", danger: true, onClick: () => stopTracking(s.user_id, s.name ?? "this person") },
                    ]}
                  />
                </div>
              </div>
              {s.status && (
                <input
                  value={notes[s.user_id] ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [s.user_id]: e.target.value }))}
                  onBlur={(e) => e.target.value.trim() !== (s.notes ?? "") && mark(s.user_id, s.status as AttendanceStatus, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  placeholder="Note (optional) — e.g. left at 1pm, sick"
                  maxLength={200}
                  className="mt-2 w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-700 focus:outline-none focus:border-gray-400"
                />
              )}
            </Card>
          ))}
        </div>
      )}

      {data && data.not_tracked.length > 0 && (
        <div className="mt-5 text-xs text-gray-500">
          <p className="mb-1.5">Attendance isn't kept for:</p>
          <div className="flex flex-wrap gap-2">
            {data.not_tracked.map((p) => (
              <span key={p.user_id} className="inline-flex items-center gap-2 rounded-lg bg-gray-100 px-2.5 py-1.5">
                {p.name}
                <button onClick={() => setTracking(p.user_id, true)} className="text-gray-700 underline hover:text-gray-900">
                  Start keeping
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
