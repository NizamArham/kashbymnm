import { useState, useEffect, FormEvent, Fragment, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Pencil, Plus, Search } from "lucide-react";
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
