import { useSearchParams } from "react-router-dom";
import { PageHeader, TabToggle } from "../components/ui";
import AttendanceDaily from "../components/AttendanceDaily";
import AttendanceMonth from "../components/AttendanceMonth";
import { todayInSriLanka } from "../lib/time";

type AttendanceTab = "day" | "month";

const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isMonth = (v: string | null): v is string => !!v && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

// Who came in. The Daily tab is where it's marked (one day at a time); the Monthly tab is the register — every person, every day, and the
// month's totals — which is what a month's pay is worked out from. The tab, day and month live in the address, so a link or a refresh keeps them.
export default function AttendancePage() {
  const [params, setParams] = useSearchParams();
  const today = todayInSriLanka();
  const tab: AttendanceTab = params.get("tab") === "month" ? "month" : "day";
  const date = isDate(params.get("date")) && params.get("date")! <= today ? params.get("date")! : today;
  const month = isMonth(params.get("month")) && params.get("month")! <= today.slice(0, 7) ? params.get("month")! : today.slice(0, 7);

  const go = (next: Record<string, string>) => setParams(next, { replace: true });
  const showDay = (d: string) => go(d === today ? {} : { date: d });
  const showMonth = (m: string) => go({ tab: "month", ...(m === today.slice(0, 7) ? {} : { month: m }) });

  return (
    <div>
      <PageHeader
        title="Attendance"
        subtitle={tab === "day" ? "Mark each staff member's attendance for the day." : "Every person, every day, and the month's totals."}
        tabs={
          <TabToggle
            value={tab}
            onChange={(v) => (v === "day" ? go(date === today ? {} : { date }) : showMonth(month))}
            options={[
              { value: "day", label: "Daily" },
              { value: "month", label: "Monthly" },
            ]}
          />
        }
      />
      {tab === "day" ? (
        <AttendanceDaily date={date} today={today} onDateChange={showDay} />
      ) : (
        <AttendanceMonth month={month} today={today} onMonthChange={showMonth} onOpenDay={showDay} />
      )}
    </div>
  );
}
