import { useEffect, useState, FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { BriefcaseBusiness, CalendarDays, DollarSign, Landmark, Phone, ShieldCheck, UserRound } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { StaffMember } from "../lib/types";
import { PageHeader, Card, Input, Label, FormGroup, ErrorText, SuccessText, Button, Dropdown, DatePicker } from "../components/ui";

const JOB_TITLES = ["Cashier", "Sales Assistant", "Store Manager", "Inventory Assistant", "Delivery Coordinator"];

export default function AddStaffPage() {
  const navigate = useNavigate();
  const [staffList, setStaffList] = useState<StaffMember[]>([]);
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
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get<StaffMember[]>("/auth/users").then(setStaffList).catch(() => {});
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (newUsername.trim().length < 3 || newPassword.length < 6) {
      setError("Username needs 3+ characters and password needs 6+ characters");
      return;
    }

    setSubmitting(true);
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
      setSuccess(`Account "${newUsername.trim()}" created.`);
      setTimeout(() => navigate("/staff"), 900);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to create account");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader title="Add Staff" subtitle="Create a login and add employment details." />
      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-5">
          <Card>
            <div className="grid grid-cols-2 gap-3">
              <FormGroup><Label>Username</Label><Input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} /></FormGroup>
              <FormGroup><Label>Password</Label><Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></FormGroup>
              <FormGroup><Label>Display name</Label><Input value={newName} onChange={(e) => setNewName(e.target.value)} /></FormGroup>
              <FormGroup>
                <Label>System role</Label>
                <Dropdown
                  value={newRole}
                  onChange={(value) => setNewRole(value as "admin" | "staff")}
                  options={[{ value: "staff", label: "Staff" }, { value: "admin", label: "Admin" }]}
                />
              </FormGroup>
              <FormGroup><Label>Job title</Label><Dropdown value={newJobTitle} onChange={setNewJobTitle} placeholder="— Select —" options={JOB_TITLES.map((t) => ({ value: t, label: t }))} /></FormGroup>
              <FormGroup><Label>Joined date</Label><DatePicker value={newJoinedDate} onChange={setNewJoinedDate} /></FormGroup>
              <FormGroup><Label>NIC</Label><Input value={newNic} onChange={(e) => setNewNic(e.target.value)} /></FormGroup>
              <FormGroup><Label>Phone</Label><Input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} /></FormGroup>
              <FormGroup><Label>Reports to</Label><Dropdown value={newReportsTo} onChange={setNewReportsTo} placeholder="— None —" options={staffList.map((s) => ({ value: String(s.id), label: s.name ?? s.username }))} /></FormGroup>
              <FormGroup><Label>Salary (Rs.)</Label><Input type="number" min="0" value={newSalary} onChange={(e) => setNewSalary(e.target.value)} /></FormGroup>
            </div>
            <FormGroup><Label>Address</Label><Input value={newAddress} onChange={(e) => setNewAddress(e.target.value)} /></FormGroup>
            <div className="grid grid-cols-3 gap-3">
              <FormGroup><Label>Bank name</Label><Input value={newBankName} onChange={(e) => setNewBankName(e.target.value)} /></FormGroup>
              <FormGroup><Label>Account number</Label><Input value={newBankAccountNo} onChange={(e) => setNewBankAccountNo(e.target.value)} /></FormGroup>
              <FormGroup><Label>Account name</Label><Input value={newBankAccountName} onChange={(e) => setNewBankAccountName(e.target.value)} /></FormGroup>
            </div>
            {error && <ErrorText>{error}</ErrorText>}
            {success && <SuccessText>{success}</SuccessText>}
            <div className="flex gap-2 mt-2">
              <Button type="submit" variant="primary" disabled={submitting}>{submitting ? "Creating..." : "Create login"}</Button>
              <Button type="button" onClick={() => navigate(-1)}>Cancel</Button>
            </div>
          </Card>

          <Card className="h-fit lg:sticky lg:top-6">
            <h2 className="text-base font-semibold text-gray-900 mb-4 flex items-center gap-2"><UserRound size={18} className="text-gray-600" /> Staff Preview</h2>
            <div className="mb-4 pb-4 border-b border-gray-100"><p className="text-lg font-semibold text-gray-900">{newName.trim() || "New staff member"}</p><p className="text-xs text-gray-400 mt-1">Preview updates as you type</p></div>
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2"><UserRound size={15} className="text-gray-400" /><span>@{newUsername.trim() || "username"}</span></div>
              <div className="flex items-center gap-2"><ShieldCheck size={15} className="text-gray-400" /><span className="capitalize">{newRole} account</span></div>
              <div className="flex items-center gap-2"><BriefcaseBusiness size={15} className="text-gray-400" /><span>{newJobTitle || "No job title selected"}</span></div>
              <div className="flex items-center gap-2"><Phone size={15} className="text-gray-400" /><span>{newPhone.trim() || "No phone added"}</span></div>
              <div className="flex items-center gap-2"><CalendarDays size={15} className="text-gray-400" /><span>{newJoinedDate || "No joining date"}</span></div>
              <div className="flex items-center gap-2"><DollarSign size={15} className="text-gray-400" /><span>{newSalary ? `Rs. ${parseFloat(newSalary).toLocaleString()}` : "No salary added"}</span></div>
              <div className="flex items-start gap-2"><Landmark size={15} className="text-gray-400 mt-0.5" /><span>{newBankName.trim() || "No bank details added"}</span></div>
            </div>
          </Card>
        </div>
      </form>
    </div>
  );
}
