import { useState, useEffect } from "react";
import { User } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import { StaffMember, AttendanceRecord, LoginActivityEntry } from "../lib/types";
import { PageHeader, Card, Button, Table, Th, Td, TabToggle, Badge } from "../components/ui";

type ProfileTab = "profile" | "attendance" | "activity";

function attendanceStatusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "present") return "success";
  if (status === "half_day") return "warning";
  if (status === "leave") return "neutral";
  return "danger";
}

export default function ProfilePage() {
  const { user, logout } = useAuth();

  const [activeTab, setActiveTab] = useState<ProfileTab>("profile");
  const [myProfile, setMyProfile] = useState<StaffMember | null>(null);
  const [attendanceRecords, setAttendanceRecords] = useState<AttendanceRecord[]>([]);
  const [attendanceTotals, setAttendanceTotals] = useState<Record<string, number> | null>(null);
  const [activityLog, setActivityLog] = useState<LoginActivityEntry[]>([]);

  useEffect(() => {
    if (!user) return;
    api.get<StaffMember>(`/auth/users/${user.id}`).then(setMyProfile).catch(() => {});
  }, [user]);

  useEffect(() => {
    if (!user || activeTab !== "attendance") return;
    api
      .get<{ records: AttendanceRecord[]; totals: Record<string, number> }>(`/attendance/${user.id}`)
      .then((r) => {
        setAttendanceRecords(r.records);
        setAttendanceTotals(r.totals);
      })
      .catch(() => {});
  }, [user, activeTab]);

  useEffect(() => {
    if (!user || activeTab !== "activity") return;
    api.get<LoginActivityEntry[]>(`/auth/users/${user.id}/activity`).then(setActivityLog).catch(() => {});
  }, [user, activeTab]);

  function sessionLength(login: string, logoutAt: string | null): string {
    if (!logoutAt) return "Active";
    const ms = new Date(logoutAt).getTime() - new Date(login).getTime();
    const hours = Math.floor(ms / 3600000);
    const mins = Math.round((ms % 3600000) / 60000);
    return `${hours}h ${mins}m`;
  }

  return (
    <div>
      <PageHeader
        title="My profile"
        action={
          <TabToggle
            value={activeTab}
            onChange={setActiveTab}
            options={[
              { value: "profile", label: "Profile" },
              { value: "attendance", label: "Attendance" },
              { value: "activity", label: "Activity Log" },
            ]}
          />
        }
      />

      {activeTab === "profile" && (
        <Card className="max-w-lg mb-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 bg-black rounded-full flex items-center justify-center">
              <User size={20} className="text-white" />
            </div>
            <div>
              <p className="text-base font-semibold text-gray-900">{user?.name ?? user?.username}</p>
              <p className="text-xs text-gray-400 capitalize">
                {myProfile?.job_title ?? user?.role} · @{user?.username}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-gray-400">Joined</p>
              <p className="text-gray-900">{myProfile?.joined_date ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Reports to</p>
              <p className="text-gray-900">{myProfile?.reports_to_name ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Phone</p>
              <p className="text-gray-900">{myProfile?.phone ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">NIC</p>
              <p className="text-gray-900">{myProfile?.nic ?? "—"}</p>
            </div>
            <div className="col-span-2">
              <p className="text-xs text-gray-400">Address</p>
              <p className="text-gray-900">{myProfile?.address ?? "—"}</p>
            </div>
          </div>

          <p className="text-xs text-gray-400 mt-4">
            Need to update your bank details or a mistake in these fields? Ask an admin to update them for you.
          </p>

          <Button onClick={logout} className="mt-4">
            Log out
          </Button>
        </Card>
      )}

      {activeTab === "attendance" && (
        <Card className="max-w-2xl mb-5">
          {attendanceTotals && (
            <div className="grid grid-cols-4 gap-3 mb-4">
              {(["present", "absent", "half_day", "leave"] as const).map((s) => (
                <div key={s} className="bg-gray-50 rounded-xl p-3 text-center">
                  <p className="text-lg font-bold text-gray-900">{attendanceTotals[s] ?? 0}</p>
                  <p className="text-xs text-gray-400 capitalize">{s.replace("_", " ")}</p>
                </div>
              ))}
            </div>
          )}
          {attendanceRecords.length === 0 ? (
            <p className="text-sm text-gray-400">No attendance records yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Status</Th>
                  <Th>Notes</Th>
                </tr>
              </thead>
              <tbody>
                {attendanceRecords.map((r) => (
                  <tr key={r.id}>
                    <Td>{r.attendance_date}</Td>
                    <Td>
                      <Badge label={r.status.replace("_", " ")} tone={attendanceStatusTone(r.status)} />
                    </Td>
                    <Td>{r.notes ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {activeTab === "activity" && (
        <Card className="max-w-2xl mb-5">
          {activityLog.length === 0 ? (
            <p className="text-sm text-gray-400">No activity recorded yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Logged in</Th>
                  <Th>Logged out</Th>
                  <Th>Duration</Th>
                </tr>
              </thead>
              <tbody>
                {activityLog.map((a) => (
                  <tr key={a.id}>
                    <Td>{a.login_at.slice(0, 16).replace("T", " ")}</Td>
                    <Td>{a.logout_at ? a.logout_at.slice(0, 16).replace("T", " ") : "—"}</Td>
                    <Td>{sessionLength(a.login_at, a.logout_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

    </div>
  );
}
