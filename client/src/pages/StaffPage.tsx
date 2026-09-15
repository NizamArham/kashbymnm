import { useState, useEffect, FormEvent, Fragment, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { BriefcaseBusiness, CalendarDays, DollarSign, Landmark, Pencil, Phone, Plus, Search, ShieldCheck, UserRound } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { api, ApiRequestError } from "../lib/api";
import { StaffMember } from "../lib/types";
import {
  PageHeader,
  Card,
  Input,
  Label,
  FormGroup,
  ErrorText,
  SuccessText,
  Button,
  Table,
  Th,
  Td,
  Dropdown,
  DatePicker,
} from "../components/ui";

const JOB_TITLES = ["Cashier", "Sales Assistant", "Store Manager", "Inventory Assistant", "Delivery Coordinator"];

export default function StaffPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [staffList, setStaffList] = useState<StaffMember[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
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

  const filteredStaff = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return staffList;
    return staffList.filter((s) =>
      [String(s.id), s.username, s.name, s.nic, s.job_title, s.role, s.reports_to_name]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query))
    );
  }, [searchQuery, staffList]);

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
    <div>
      <PageHeader
        title="Staff"
        subtitle="Create logins, assign roles, and manage employment details."
        action={
          <Button variant="primary" onClick={() => navigate("/staff/add")} className="inline-flex items-center gap-1.5">
            <Plus size={16} />
            Add staff
          </Button>
        }
      />

      {showCreate && <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-5 mb-5">
        <Card>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Staff & HR</h2>
            <p className="text-xs text-gray-400">Create logins, assign roles, and manage employment details.</p>
          </div>
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
                <Dropdown
                  value={newRole}
                  onChange={(value) => setNewRole(value as "admin" | "staff")}
                  options={[{ value: "staff", label: "Staff" }, { value: "admin", label: "Admin" }]}
                />
              </FormGroup>
              <FormGroup>
                <Label>Job title</Label>
                <Dropdown value={newJobTitle} onChange={setNewJobTitle} placeholder="— Select —" options={JOB_TITLES.map((t) => ({ value: t, label: t }))} />
              </FormGroup>
              <FormGroup>
                <Label>Joined date</Label>
                <DatePicker value={newJoinedDate} onChange={setNewJoinedDate} />
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
            </div>
          </form>
        )}

        </Card>

        <Card className="h-fit lg:sticky lg:top-6">
          <h2 className="text-base font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <UserRound size={18} className="text-gray-600" />
            Staff Preview
          </h2>
          <div className="mb-4 pb-4 border-b border-gray-100">
            <p className="text-lg font-semibold text-gray-900">{newName.trim() || "New staff member"}</p>
            <p className="text-xs text-gray-400 mt-1">Preview updates as you type</p>
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <UserRound size={15} className="text-gray-400" />
              <span className="text-gray-700">@{newUsername.trim() || "username"}</span>
            </div>
            <div className="flex items-center gap-2">
              <ShieldCheck size={15} className="text-gray-400" />
              <span className="text-gray-700 capitalize">{newRole} account</span>
            </div>
            <div className="flex items-center gap-2">
              <BriefcaseBusiness size={15} className="text-gray-400" />
              <span className="text-gray-700">{newJobTitle || "No job title selected"}</span>
            </div>
            <div className="flex items-center gap-2">
              <Phone size={15} className="text-gray-400" />
              <span className="text-gray-700">{newPhone.trim() || "No phone added"}</span>
            </div>
            <div className="flex items-center gap-2">
              <CalendarDays size={15} className="text-gray-400" />
              <span className="text-gray-700">{newJoinedDate || "No joining date"}</span>
            </div>
            <div className="flex items-center gap-2">
              <DollarSign size={15} className="text-gray-400" />
              <span className="text-gray-700">{newSalary ? `Rs. ${parseFloat(newSalary).toLocaleString()}` : "No salary added"}</span>
            </div>
            <div className="flex items-start gap-2">
              <Landmark size={15} className="text-gray-400 mt-0.5" />
              <span className="text-gray-700">{newBankName.trim() || "No bank details added"}</span>
            </div>
          </div>
        </Card>
      </div>}

      <Card className="p-0 overflow-hidden">
        <div className="border-b border-gray-100 p-3">
          <div className="relative max-w-sm">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by ID, name, role, or job title..."
              className="pl-9 py-2 text-sm"
            />
          </div>
        </div>

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
            {filteredStaff.map((s) => {
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
                                    <Dropdown
                                      value={editForm.role}
                                      onChange={(value) => setEditForm((f) => ({ ...f, role: value }))}
                                      options={[{ value: "staff", label: "Staff" }, { value: "admin", label: "Admin" }]}
                                    />
                                  </FormGroup>
                                  <FormGroup>
                                    <Label>Joined date</Label>
                                    <DatePicker value={editForm.joined_date} onChange={(value) => setEditForm((f) => ({ ...f, joined_date: value }))} />
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
        {filteredStaff.length === 0 && <p className="px-4 py-6 text-center text-sm text-gray-400">No staff members match your search.</p>}
      </Card>
    </div>
  );
}
