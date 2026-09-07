import { useState, useEffect, FormEvent, Fragment } from "react";
import { User, Pencil } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { api, ApiRequestError } from "../lib/api";
import { StaffMember, AttendanceRecord, LoginActivityEntry } from "../lib/types";
import {
  PageHeader,
  Card,
  Input,
  Select,
  Label,
  FormGroup,
  ErrorText,
  SuccessText,
  Button,
  Table,
  Th,
  Td,
  TabToggle,
  Dropdown,
  Badge,
} from "../components/ui";

type ProfileTab = "profile" | "attendance" | "activity";

function attendanceStatusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "present") return "success";
  if (status === "half_day") return "warning";
  if (status === "leave") return "neutral";
  return "danger";
}

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === "admin";

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

      {isAdmin && activeTab === "profile" && <StaffManagement />}
    </div>
  );
}

function StaffManagement() {
  const { user } = useAuth();
  const [staffList, setStaffList] = useState<StaffMember[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "staff">("staff");
  const [newJobTitle, setNewJobTitle] = useState("");
  const [newJoinedDate, setNewJoinedDate] = useState("");
  const [newNic, setNewNic] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newSalary, setNewSalary] = useState("");
  const [newBankName, setNewBankName] = useState("");
  const [newBankAccountNo, setNewBankAccountNo] = useState("");
  const [newBankAccountName, setNewBankAccountName] = useState("");
  const [newReportsTo, setNewReportsTo] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);

  const JOB_TITLES = ["Cashier", "Sales Assistant", "Store Manager", "Inventory Assistant", "Delivery Coordinator"];

  async function load() {
    try {
      setStaffList(await api.get<StaffMember[]>("/auth/users"));
    } catch {
      // non-critical
    }
  }

  useEffect(() => {
    load();
  }, []);

  function toggleExpand(s: StaffMember) {
    if (expandedId === s.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(s.id);
    setIsEditing(false);
    setEditForm({
      name: s.name ?? "",
      job_title: s.job_title ?? "",
      joined_date: s.joined_date ?? "",
      nic: s.nic ?? "",
      phone: s.phone ?? "",
      address: s.address ?? "",
      salary: s.salary != null ? String(s.salary) : "",
      bank_name: s.bank_name ?? "",
      bank_account_no: s.bank_account_no ?? "",
      bank_account_name: s.bank_account_name ?? "",
      reports_to: s.reports_to != null ? String(s.reports_to) : "",
      role: s.role,
    });
    setEditError(null);
    setEditSuccess(null);
  }

  async function saveEdit(id: number) {
    setEditError(null);
    setEditSuccess(null);
    try {
      await api.put(`/auth/users/${id}`, {
        name: editForm.name || undefined,
        job_title: editForm.job_title || undefined,
        joined_date: editForm.joined_date || undefined,
        nic: editForm.nic || undefined,
        phone: editForm.phone || undefined,
        address: editForm.address || undefined,
        salary: editForm.salary ? parseFloat(editForm.salary) : undefined,
        bank_name: editForm.bank_name || undefined,
        bank_account_no: editForm.bank_account_no || undefined,
        bank_account_name: editForm.bank_account_name || undefined,
        reports_to: editForm.reports_to ? parseInt(editForm.reports_to, 10) : undefined,
        role: editForm.role,
      });
      setEditSuccess("Saved.");
      setIsEditing(false);
      load();
    } catch (err) {
      setEditError(err instanceof ApiRequestError ? err.message : "Failed to update staff member");
    }
  }

  async function handleDeleteUser(id: number) {
    if (!confirm("Remove this login?")) return;
    try {
      await api.delete(`/auth/users/${id}`);
      setExpandedId(null);
      load();
    } catch (err) {
      alert(err instanceof ApiRequestError ? err.message : "Failed to remove account");
    }
  }

  async function handleCreateUser(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreateSuccess(null);

    if (newUsername.length < 3 || newPassword.length < 6) {
      setCreateError("Username needs 3+ characters and password needs 6+ characters");
      return;
    }

    try {
      await api.post("/auth/users", {
        username: newUsername.trim(),
        password: newPassword,
        role: newRole,
        name: newName.trim() || undefined,
        job_title: newJobTitle || undefined,
        joined_date: newJoinedDate || undefined,
        nic: newNic.trim() || undefined,
        phone: newPhone.trim() || undefined,
        address: newAddress.trim() || undefined,
        salary: newSalary ? parseFloat(newSalary) : undefined,
        bank_name: newBankName.trim() || undefined,
        bank_account_no: newBankAccountNo.trim() || undefined,
        bank_account_name: newBankAccountName.trim() || undefined,
        reports_to: newReportsTo ? parseInt(newReportsTo, 10) : undefined,
      });
      setCreateSuccess(`Account "${newUsername}" created.`);
      setNewUsername("");
      setNewPassword("");
      setNewName("");
      setNewJobTitle("");
      setNewJoinedDate("");
      setNewNic("");
      setNewPhone("");
      setNewAddress("");
      setNewSalary("");
      setNewBankName("");
      setNewBankAccountNo("");
      setNewBankAccountName("");
      setNewReportsTo("");
      setShowCreate(false);
      load();
    } catch (err) {
      setCreateError(err instanceof ApiRequestError ? err.message : "Failed to create account");
    }
  }

  return (
    <Card className="max-w-3xl mb-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Staff & HR</h2>
          <p className="text-xs text-gray-400">Create logins, assign roles, and manage employment details.</p>
        </div>
        {!showCreate && (
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            Add staff
          </Button>
        )}
      </div>

      {showCreate && (
        <form onSubmit={handleCreateUser} className="border border-gray-200 rounded-xl p-4 mb-4">
          <div className="grid grid-cols-2 gap-3">
            <FormGroup>
              <Label>Username</Label>
              <Input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} />
            </FormGroup>
            <FormGroup>
              <Label>Password</Label>
              <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </FormGroup>
            <FormGroup>
              <Label>Display name</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} />
            </FormGroup>
            <FormGroup>
              <Label>System role (permissions)</Label>
              <Select value={newRole} onChange={(e) => setNewRole(e.target.value as "admin" | "staff")}>
                <option value="staff">Staff</option>
                <option value="admin">Admin</option>
              </Select>
            </FormGroup>
            <FormGroup>
              <Label>Job title</Label>
              <Dropdown value={newJobTitle} onChange={setNewJobTitle} placeholder="— Select —" options={JOB_TITLES.map((t) => ({ value: t, label: t }))} />
            </FormGroup>
            <FormGroup>
              <Label>Joined date</Label>
              <Input type="date" value={newJoinedDate} onChange={(e) => setNewJoinedDate(e.target.value)} />
            </FormGroup>
            <FormGroup>
              <Label>NIC</Label>
              <Input value={newNic} onChange={(e) => setNewNic(e.target.value)} />
            </FormGroup>
            <FormGroup>
              <Label>Phone</Label>
              <Input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
            </FormGroup>
            <FormGroup>
              <Label>Reports to</Label>
              <Dropdown
                value={newReportsTo}
                onChange={setNewReportsTo}
                placeholder="— None —"
                options={staffList.filter((s) => s.id !== user?.id).map((s) => ({ value: String(s.id), label: s.name ?? s.username }))}
              />
            </FormGroup>
            <FormGroup>
              <Label>Salary (Rs.)</Label>
              <Input type="number" min="0" value={newSalary} onChange={(e) => setNewSalary(e.target.value)} />
            </FormGroup>
          </div>
          <FormGroup>
            <Label>Address</Label>
            <Input value={newAddress} onChange={(e) => setNewAddress(e.target.value)} />
          </FormGroup>
          <div className="grid grid-cols-3 gap-3">
            <FormGroup>
              <Label>Bank name</Label>
              <Input value={newBankName} onChange={(e) => setNewBankName(e.target.value)} />
            </FormGroup>
            <FormGroup>
              <Label>Account number</Label>
              <Input value={newBankAccountNo} onChange={(e) => setNewBankAccountNo(e.target.value)} />
            </FormGroup>
            <FormGroup>
              <Label>Account name</Label>
              <Input value={newBankAccountName} onChange={(e) => setNewBankAccountName(e.target.value)} />
            </FormGroup>
          </div>
          {createError && <ErrorText>{createError}</ErrorText>}
          {createSuccess && <SuccessText>{createSuccess}</SuccessText>}
          <div className="flex gap-2 mt-2">
            <Button type="submit" variant="primary">
              Create login
            </Button>
            <Button onClick={() => setShowCreate(false)}>Cancel</Button>
          </div>
        </form>
      )}

      <Table>
        <thead>
          <tr>
            <Th></Th>
            <Th>Username</Th>
            <Th>Name</Th>
            <Th>Job title</Th>
            <Th>Role</Th>
            <Th>Reports to</Th>
          </tr>
        </thead>
        <tbody>
          {staffList.map((s) => {
            const isExpanded = expandedId === s.id;
            return (
              <Fragment key={s.id}>
                <tr onClick={() => toggleExpand(s)} className="cursor-pointer hover:bg-gray-50">
                  <Td className="w-6">{isExpanded ? "▾" : "▸"}</Td>
                  <Td>{s.username}</Td>
                  <Td className="font-medium">{s.name ?? "—"}</Td>
                  <Td>{s.job_title ?? "—"}</Td>
                  <Td className="capitalize">{s.role}</Td>
                  <Td>{s.reports_to_name ?? "—"}</Td>
                </tr>
                {isExpanded && (
                  <tr>
                    <Td colSpan={6} className="bg-gray-50">
                      <div className="py-3">
                        <div className="bg-white border border-gray-200 rounded-xl p-4">
                          <div className="flex items-center justify-between mb-3">
                            <h3 className="text-sm font-semibold text-gray-900">Staff details</h3>
                            {!isEditing && (
                              <button onClick={() => setIsEditing(true)} className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1">
                                <Pencil size={12} />
                                Edit
                              </button>
                            )}
                          </div>

                          {isEditing ? (
                            <>
                              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                <FormGroup>
                                  <Label>Name</Label>
                                  <Input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
                                </FormGroup>
                                <FormGroup>
                                  <Label>Job title</Label>
                                  <Dropdown
                                    value={editForm.job_title}
                                    onChange={(v) => setEditForm((f) => ({ ...f, job_title: v }))}
                                    placeholder="— Select —"
                                    options={JOB_TITLES.map((t) => ({ value: t, label: t }))}
                                  />
                                </FormGroup>
                                <FormGroup>
                                  <Label>System role</Label>
                                  <Select value={editForm.role} onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value }))}>
                                    <option value="staff">Staff</option>
                                    <option value="admin">Admin</option>
                                  </Select>
                                </FormGroup>
                                <FormGroup>
                                  <Label>Joined date</Label>
                                  <Input type="date" value={editForm.joined_date} onChange={(e) => setEditForm((f) => ({ ...f, joined_date: e.target.value }))} />
                                </FormGroup>
                                <FormGroup>
                                  <Label>NIC</Label>
                                  <Input value={editForm.nic} onChange={(e) => setEditForm((f) => ({ ...f, nic: e.target.value }))} />
                                </FormGroup>
                                <FormGroup>
                                  <Label>Phone</Label>
                                  <Input value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} />
                                </FormGroup>
                                <FormGroup>
                                  <Label>Reports to</Label>
                                  <Dropdown
                                    value={editForm.reports_to}
                                    onChange={(v) => setEditForm((f) => ({ ...f, reports_to: v }))}
                                    placeholder="— None —"
                                    options={staffList.filter((x) => x.id !== s.id).map((x) => ({ value: String(x.id), label: x.name ?? x.username }))}
                                  />
                                </FormGroup>
                                <FormGroup>
                                  <Label>Salary (Rs.)</Label>
                                  <Input type="number" min="0" value={editForm.salary} onChange={(e) => setEditForm((f) => ({ ...f, salary: e.target.value }))} />
                                </FormGroup>
                              </div>
                              <FormGroup>
                                <Label>Address</Label>
                                <Input value={editForm.address} onChange={(e) => setEditForm((f) => ({ ...f, address: e.target.value }))} />
                              </FormGroup>
                              <div className="grid grid-cols-3 gap-3">
                                <FormGroup>
                                  <Label>Bank name</Label>
                                  <Input value={editForm.bank_name} onChange={(e) => setEditForm((f) => ({ ...f, bank_name: e.target.value }))} />
                                </FormGroup>
                                <FormGroup>
                                  <Label>Account number</Label>
                                  <Input
                                    value={editForm.bank_account_no}
                                    onChange={(e) => setEditForm((f) => ({ ...f, bank_account_no: e.target.value }))}
                                  />
                                </FormGroup>
                                <FormGroup>
                                  <Label>Account name</Label>
                                  <Input
                                    value={editForm.bank_account_name}
                                    onChange={(e) => setEditForm((f) => ({ ...f, bank_account_name: e.target.value }))}
                                  />
                                </FormGroup>
                              </div>
                              {editError && <ErrorText>{editError}</ErrorText>}
                              {editSuccess && <SuccessText>{editSuccess}</SuccessText>}
                              <div className="flex gap-2 mt-2">
                                <Button variant="primary" size="sm" onClick={() => saveEdit(s.id)}>
                                  Save changes
                                </Button>
                                <Button size="sm" onClick={() => setIsEditing(false)}>
                                  Cancel
                                </Button>
                                {s.id !== user?.id && (
                                  <Button variant="danger" size="sm" onClick={() => handleDeleteUser(s.id)}>
                                    Remove login
                                  </Button>
                                )}
                              </div>
                            </>
                          ) : (
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                              <div>
                                <p className="text-xs text-gray-400">Joined</p>
                                <p className="text-gray-900">{s.joined_date ?? "—"}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400">NIC</p>
                                <p className="text-gray-900">{s.nic ?? "—"}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400">Phone</p>
                                <p className="text-gray-900">{s.phone ?? "—"}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400">Reports to</p>
                                <p className="text-gray-900">{s.reports_to_name ?? "—"}</p>
                              </div>
                              <div className="col-span-2">
                                <p className="text-xs text-gray-400">Address</p>
                                <p className="text-gray-900">{s.address ?? "—"}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400">Salary</p>
                                <p className="text-gray-900">{s.salary != null ? `Rs. ${s.salary.toLocaleString()}` : "—"}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400">Bank</p>
                                <p className="text-gray-900">{s.bank_name ? `${s.bank_name} (${s.bank_account_no ?? "—"})` : "—"}</p>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </Td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}
