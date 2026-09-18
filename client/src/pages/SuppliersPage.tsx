import { useEffect, useState, useMemo, FormEvent, Fragment } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Truck, ChevronDown, ChevronRight, Pencil, Plus, X } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Supplier, BankAccount } from "../lib/types";
import { PageHeader, Card, Input, Label, FormGroup, ErrorText, SuccessText, Button, Table, Th, Td, EmptyState } from "../components/ui";
import { CityPicker } from "../components/CityPicker";

type ExpandedTab = "details" | "bank" | "payment_history";

export default function SuppliersPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAddModal, setShowAddModal] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<Supplier | null>(null);
  const [expandedTab, setExpandedTab] = useState<ExpandedTab>("details");
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", phone: "", city: "", notes: "" });
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState<string | null>(null);

  const [showAddBankAccount, setShowAddBankAccount] = useState(false);
  const [newBankAccount, setNewBankAccount] = useState({ bank_name: "", account_name: "", account_number: "", branch: "" });
  const [bankAccountError, setBankAccountError] = useState<string | null>(null);
  const [editingBankAccountId, setEditingBankAccountId] = useState<number | null>(null);
  const [editBankAccount, setEditBankAccount] = useState({ bank_name: "", account_name: "", account_number: "", branch: "" });
  const [editBankAccountError, setEditBankAccountError] = useState<string | null>(null);

  const [ledger, setLedger] = useState<{
    entries: { date: string; type: "purchase" | "payment" | "credit" | "return"; label: string; amount: number; effect: number; running_balance: number }[];
    final_balance: number;
  } | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setSuppliers(await api.get<Supplier[]>("/suppliers"));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load suppliers");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Two-tier ordering, most actionable first:
  //   1. Owing  — you still owe this supplier money (balance_owed > 0)
  //   2. Settled — nothing outstanding
  // Stable within each tier, preserving the API's original order (which
  // is id-descending, so newest-added first within each group).
  const sortedSuppliers = useMemo(() => {
    function tier(s: Supplier): number {
      return (s.balance_owed ?? 0) > 0 ? 0 : 1;
    }
    return [...suppliers].sort((a, b) => tier(a) - tier(b));
  }, [suppliers]);

  useEffect(() => {
    const state = location.state as { expandSupplierId?: number } | null;
    if (!state?.expandSupplierId || suppliers.length === 0) return;
    const target = suppliers.find((s) => s.id === state.expandSupplierId);
    if (target) {
      toggleExpand(target).then(() => setExpandedTab("payment_history"));
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suppliers]);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);
    if (!name.trim()) {
      setFormError("Supplier name is required");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/suppliers", { name: name.trim(), phone: phone.trim() || undefined, city: city.trim() || undefined });
      setFormSuccess("Supplier added successfully!");
      setName("");
      setPhone("");
      setCity("");
      load();
      setTimeout(() => setShowAddModal(false), 900);
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? err.message : "Failed to add supplier");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleExpand(s: Supplier) {
    if (expandedId === s.id) {
      setExpandedId(null);
      setExpandedDetail(null);
      return;
    }
    setExpandedId(s.id);
    setExpandedTab("details");
    setIsEditing(false);
    setShowAddBankAccount(false);
    setEditForm({ name: s.name, phone: s.phone ?? "", city: s.city ?? "", notes: s.notes ?? "" });
    setEditError(null);
    setEditSuccess(null);
    setLedger(null);
    setLedgerError(null);
    const full = await api.get<Supplier>(`/suppliers/${s.id}`);
    setExpandedDetail(full);
  }

  async function openPaymentHistory(supplierId: number) {
    setExpandedTab("payment_history");
    if (ledger) return;
    setLedgerLoading(true);
    setLedgerError(null);
    try {
      const result = await api.get<typeof ledger>(`/supplier-payments/ledger/${supplierId}`);
      setLedger(result);
    } catch (err) {
      setLedgerError(err instanceof ApiRequestError ? err.message : "Failed to load payment history");
    } finally {
      setLedgerLoading(false);
    }
  }

  async function refreshExpanded(id: number) {
    const full = await api.get<Supplier>(`/suppliers/${id}`);
    setExpandedDetail(full);
  }

  function cancelEdit(s: Supplier) {
    setIsEditing(false);
    setEditForm({ name: s.name, phone: s.phone ?? "", city: s.city ?? "", notes: s.notes ?? "" });
    setEditError(null);
  }

  async function saveEdit(id: number) {
    setEditError(null);
    setEditSuccess(null);
    if (!editForm.name.trim()) {
      setEditError("Name is required");
      return;
    }
    try {
      await api.put(`/suppliers/${id}`, {
        name: editForm.name.trim(),
        phone: editForm.phone.trim() || undefined,
        city: editForm.city.trim() || undefined,
        notes: editForm.notes.trim() || undefined,
      });
      setEditSuccess("Saved.");
      setIsEditing(false);
      load();
      refreshExpanded(id);
    } catch (err) {
      setEditError(err instanceof ApiRequestError ? err.message : "Failed to update supplier");
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this supplier? This only works if they have no purchases or payments on record.")) return;
    try {
      await api.delete(`/suppliers/${id}`);
      setExpandedId(null);
      setExpandedDetail(null);
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to delete supplier");
    }
  }

  async function addBankAccount(supplierId: number) {
    setBankAccountError(null);
    if (!newBankAccount.bank_name.trim() || !newBankAccount.account_name.trim() || !newBankAccount.account_number.trim()) {
      setBankAccountError("Bank name, account holder name, and account number are all required");
      return;
    }
    try {
      await api.post(`/suppliers/${supplierId}/bank-accounts`, {
        bank_name: newBankAccount.bank_name.trim(),
        account_name: newBankAccount.account_name.trim(),
        account_number: newBankAccount.account_number.trim(),
        branch: newBankAccount.branch.trim() || undefined,
        is_default: false,
      });
      setNewBankAccount({ bank_name: "", account_name: "", account_number: "", branch: "" });
      setShowAddBankAccount(false);
      refreshExpanded(supplierId);
    } catch (err) {
      setBankAccountError(err instanceof ApiRequestError ? err.message : "Failed to add bank account");
    }
  }

  async function makeBankAccountDefault(supplierId: number, account: BankAccount) {
    try {
      await api.put(`/suppliers/${supplierId}/bank-accounts/${account.id}`, { is_default: true });
      refreshExpanded(supplierId);
    } catch {
      // minor action — no need for a full error banner if it fails
    }
  }

  function startEditBankAccount(a: BankAccount) {
    setEditingBankAccountId(a.id);
    setEditBankAccount({ bank_name: a.bank_name, account_name: a.account_name, account_number: a.account_number, branch: a.branch ?? "" });
    setEditBankAccountError(null);
  }

  function cancelEditBankAccount() {
    setEditingBankAccountId(null);
    setEditBankAccountError(null);
  }

  async function saveEditBankAccount(supplierId: number, accountId: number) {
    setEditBankAccountError(null);
    if (!editBankAccount.bank_name.trim() || !editBankAccount.account_name.trim() || !editBankAccount.account_number.trim()) {
      setEditBankAccountError("Bank name, account holder name, and account number are all required");
      return;
    }
    try {
      await api.put(`/suppliers/${supplierId}/bank-accounts/${accountId}`, {
        bank_name: editBankAccount.bank_name.trim(),
        account_name: editBankAccount.account_name.trim(),
        account_number: editBankAccount.account_number.trim(),
        branch: editBankAccount.branch.trim() || undefined,
      });
      setEditingBankAccountId(null);
      refreshExpanded(supplierId);
    } catch (err) {
      setEditBankAccountError(err instanceof ApiRequestError ? err.message : "Failed to update bank account");
    }
  }

  async function deleteBankAccount(supplierId: number, accountId: number) {
    if (!confirm("Delete this bank account?")) return;
    try {
      await api.delete(`/suppliers/${supplierId}/bank-accounts/${accountId}`);
      refreshExpanded(supplierId);
    } catch (err) {
      setEditBankAccountError(err instanceof ApiRequestError ? err.message : "Failed to delete bank account");
    }
  }

  const totalOwed = suppliers.reduce((sum, s) => sum + (s.balance_owed ?? 0), 0);
  const owingCount = suppliers.filter((s) => (s.balance_owed ?? 0) > 0).length;

  return (
    <div>
      <PageHeader
        title="Suppliers"
        subtitle="Click a supplier to view and edit their details. Balance owed is calculated live from purchases minus payments."
        action={
          <button
            onClick={() => {
              setShowAddModal(true);
              setFormError(null);
              setFormSuccess(null);
            }}
            className="flex items-center gap-2 px-4 py-2.5 bg-black text-white rounded-xl text-sm font-medium hover:bg-gray-800 transition"
          >
            <Plus size={16} />
            Add supplier
          </button>
        }
      />

      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Add supplier</h2>
              <button onClick={() => setShowAddModal(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleAdd} className="p-5">
              <FormGroup>
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </FormGroup>
              <FormGroup>
                <Label>Contact</Label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" />
              </FormGroup>
              <FormGroup>
                <Label>Location</Label>
                <CityPicker value={city} onChange={setCity} />
              </FormGroup>
              {formError && <ErrorText>{formError}</ErrorText>}
              {formSuccess && <SuccessText>{formSuccess}</SuccessText>}
              <div className="flex justify-end gap-3 mt-2">
                <Button type="button" onClick={() => setShowAddModal(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={submitting}>
                  {submitting ? "Adding..." : "Add supplier"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : suppliers.length === 0 ? (
        <EmptyState icon={Truck} title="No suppliers yet" />
      ) : (
        <>
          <p className="text-xs text-gray-400 mb-3">
            {owingCount > 0
              ? `${owingCount} supplier${owingCount === 1 ? "" : "s"} awaiting payment — Rs. ${totalOwed.toLocaleString()} total`
              : "All suppliers settled"}
          </p>

          <Card className="p-0 overflow-hidden">
            <Table>
              <thead>
                <tr>
                  <Th></Th>
                  <Th>Code</Th>
                  <Th>Name</Th>
                  <Th>Phone</Th>
                  <Th>City</Th>
                  <Th>Balance owed</Th>
                </tr>
              </thead>
              <tbody>
                {sortedSuppliers.map((s) => {
                  const isExpanded = expandedId === s.id;
                  const owes = (s.balance_owed ?? 0) > 0;
                  return (
                    <Fragment key={s.id}>
                      <tr onClick={() => toggleExpand(s)} className="cursor-pointer hover:bg-gray-50">
                        <Td className="w-8">
                          {isExpanded ? <ChevronDown size={15} className="text-gray-400" /> : <ChevronRight size={15} className="text-gray-400" />}
                        </Td>
                        <Td>{s.supplier_code}</Td>
                        <Td className="font-medium">{s.name}</Td>
                        <Td>{s.phone ?? "—"}</Td>
                        <Td>{s.city ?? "—"}</Td>
                        <Td className={owes ? "font-medium" : "text-gray-500"}>
                          {owes ? `Rs. ${s.balance_owed.toLocaleString()}` : "Settled"}
                        </Td>
                      </tr>
                      {isExpanded && expandedDetail && (
                        <tr>
                          <Td colSpan={6} className="bg-gray-50">
                            <div className="py-3 px-1">
                              <div className="flex items-center justify-between mb-4">
                                <div>
                                  <h2 className="text-base font-semibold text-gray-900">{expandedDetail.name}</h2>
                                  <p className="text-xs text-gray-400">{expandedDetail.supplier_code}</p>
                                </div>
                                <button onClick={() => setExpandedId(null)} className="text-gray-400 hover:text-gray-600">
                                  <X size={18} />
                                </button>
                              </div>

                              <div className="flex items-center gap-1 border-b border-gray-200 mb-4">
                                {(["details", "bank", "payment_history"] as ExpandedTab[]).map((tab) => (
                                  <button
                                    key={tab}
                                    onClick={() => (tab === "payment_history" ? openPaymentHistory(s.id) : setExpandedTab(tab))}
                                    className={`px-3 py-1.5 text-xs font-medium rounded-t-lg transition ${
                                      expandedTab === tab
                                        ? "bg-white border border-b-white border-gray-200 text-gray-900 -mb-px"
                                        : "text-gray-500 hover:text-gray-800"
                                    }`}
                                  >
                                    {tab === "details" ? "Details" : tab === "bank" ? "Bank accounts" : "Payment History"}
                                  </button>
                                ))}
                              </div>

                              {expandedTab === "details" && (
                                <div className="bg-white border border-gray-200 rounded-xl p-4">
                                  <div className="flex items-center justify-between mb-3">
                                    <h3 className="text-sm font-semibold text-gray-900">Supplier details</h3>
                                    {!isEditing && (
                                      <button
                                        onClick={() => setIsEditing(true)}
                                        className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100"
                                      >
                                        <Pencil size={12} />
                                        Edit
                                      </button>
                                    )}
                                  </div>

                                  {isEditing ? (
                                    <>
                                      <div className="grid grid-cols-2 gap-3">
                                        <FormGroup>
                                          <Label>Name</Label>
                                          <Input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
                                        </FormGroup>
                                        <FormGroup>
                                          <Label>Phone</Label>
                                          <Input value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} />
                                        </FormGroup>
                                      </div>
                                      <FormGroup>
                                        <Label>City</Label>
                                        <CityPicker value={editForm.city} onChange={(v) => setEditForm((f) => ({ ...f, city: v }))} />
                                      </FormGroup>
                                      <FormGroup>
                                        <Label>Notes</Label>
                                        <Input value={editForm.notes} onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))} />
                                      </FormGroup>
                                      {editError && <ErrorText>{editError}</ErrorText>}
                                      {editSuccess && <SuccessText>{editSuccess}</SuccessText>}
                                      <div className="flex justify-end gap-2 mt-3">
                                        <Button size="sm" onClick={() => cancelEdit(s)}>
                                          Cancel
                                        </Button>
                                        <Button variant="primary" size="sm" onClick={() => saveEdit(s.id)}>
                                          Save changes
                                        </Button>
                                      </div>
                                      <div className="mt-3 pt-3 border-t border-gray-100">
                                        <button
                                          onClick={() => handleDelete(s.id)}
                                          className="text-xs text-red-500 hover:text-red-700 inline-flex items-center gap-1"
                                        >
                                          Delete supplier
                                        </button>
                                      </div>
                                    </>
                                  ) : (
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                                      <div>
                                        <p className="text-xs text-gray-400">Name</p>
                                        <p className="text-gray-900">{expandedDetail.name}</p>
                                      </div>
                                      <div>
                                        <p className="text-xs text-gray-400">Phone</p>
                                        <p className="text-gray-900">{expandedDetail.phone ?? "—"}</p>
                                      </div>
                                      <div>
                                        <p className="text-xs text-gray-400">City</p>
                                        <p className="text-gray-900">{expandedDetail.city ?? "—"}</p>
                                      </div>
                                      <div>
                                        <p className="text-xs text-gray-400">Notes</p>
                                        <p className="text-gray-900">{expandedDetail.notes ?? "—"}</p>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}

                              {expandedTab === "bank" && (
                                <div className="bg-white border border-gray-200 rounded-xl p-4">
                                  <div className="flex items-center justify-between mb-3">
                                    <h3 className="text-sm font-semibold text-gray-900">Bank accounts</h3>
                                    {!showAddBankAccount && (
                                      <button
                                        onClick={() => setShowAddBankAccount(true)}
                                        className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100"
                                      >
                                        <Plus size={12} />
                                        Add account
                                      </button>
                                    )}
                                  </div>

                                  {(!expandedDetail.bank_accounts || expandedDetail.bank_accounts.length === 0) && !showAddBankAccount ? (
                                    <p className="text-xs text-gray-400">
                                      No bank accounts on file — needed to pay this supplier by bank transfer.
                                    </p>
                                  ) : (
                                    <div className="space-y-2">
                                      {expandedDetail.bank_accounts?.map((a) =>
                                        editingBankAccountId === a.id ? (
                                          <div key={a.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3">
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                              <FormGroup>
                                                <Label>Bank name</Label>
                                                <Input
                                                  value={editBankAccount.bank_name}
                                                  onChange={(e) => setEditBankAccount((f) => ({ ...f, bank_name: e.target.value }))}
                                                />
                                              </FormGroup>
                                              <FormGroup>
                                                <Label>Branch (optional)</Label>
                                                <Input
                                                  value={editBankAccount.branch}
                                                  onChange={(e) => setEditBankAccount((f) => ({ ...f, branch: e.target.value }))}
                                                />
                                              </FormGroup>
                                              <FormGroup>
                                                <Label>Account holder name</Label>
                                                <Input
                                                  value={editBankAccount.account_name}
                                                  onChange={(e) => setEditBankAccount((f) => ({ ...f, account_name: e.target.value }))}
                                                />
                                              </FormGroup>
                                              <FormGroup>
                                                <Label>Account number</Label>
                                                <Input
                                                  value={editBankAccount.account_number}
                                                  onChange={(e) => setEditBankAccount((f) => ({ ...f, account_number: e.target.value }))}
                                                />
                                              </FormGroup>
                                            </div>
                                            {editBankAccountError && <ErrorText>{editBankAccountError}</ErrorText>}
                                            <div className="flex justify-end gap-2 mt-3">
                                              <Button size="sm" onClick={cancelEditBankAccount}>
                                                Cancel
                                              </Button>
                                              <Button size="sm" variant="primary" onClick={() => saveEditBankAccount(expandedDetail.id, a.id)}>
                                                Save
                                              </Button>
                                            </div>
                                          </div>
                                        ) : (
                                          <div key={a.id} className="flex items-center justify-between bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 text-sm">
                                            <div>
                                              <span className="text-gray-700">
                                                {a.bank_name} — {a.account_name} — {a.account_number}
                                              </span>
                                              {a.branch && <div className="text-xs text-gray-400">{a.branch}</div>}
                                            </div>
                                            <div className="flex items-center gap-3 flex-shrink-0">
                                              {a.is_default ? (
                                                <span className="text-xs text-green-600 font-medium">Default</span>
                                              ) : (
                                                <button
                                                  onClick={() => makeBankAccountDefault(expandedDetail.id, a)}
                                                  className="text-xs text-gray-400 hover:text-gray-700"
                                                >
                                                  Make default
                                                </button>
                                              )}
                                              <button onClick={() => startEditBankAccount(a)} className="text-xs text-gray-400 hover:text-gray-700">
                                                Edit
                                              </button>
                                              <button onClick={() => deleteBankAccount(expandedDetail.id, a.id)} className="text-xs text-red-400 hover:text-red-600">
                                                Delete
                                              </button>
                                            </div>
                                          </div>
                                        )
                                      )}
                                    </div>
                                  )}

                                  {showAddBankAccount && (
                                    <div className="mt-3 bg-gray-50 border border-gray-200 rounded-xl p-3">
                                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                        <FormGroup>
                                          <Label>Bank name</Label>
                                          <Input
                                            value={newBankAccount.bank_name}
                                            onChange={(e) => setNewBankAccount((f) => ({ ...f, bank_name: e.target.value }))}
                                          />
                                        </FormGroup>
                                        <FormGroup>
                                          <Label>Branch (optional)</Label>
                                          <Input
                                            value={newBankAccount.branch}
                                            onChange={(e) => setNewBankAccount((f) => ({ ...f, branch: e.target.value }))}
                                          />
                                        </FormGroup>
                                        <FormGroup>
                                          <Label>Account holder name</Label>
                                          <Input
                                            value={newBankAccount.account_name}
                                            onChange={(e) => setNewBankAccount((f) => ({ ...f, account_name: e.target.value }))}
                                          />
                                        </FormGroup>
                                        <FormGroup>
                                          <Label>Account number</Label>
                                          <Input
                                            value={newBankAccount.account_number}
                                            onChange={(e) => setNewBankAccount((f) => ({ ...f, account_number: e.target.value }))}
                                          />
                                        </FormGroup>
                                      </div>
                                      {bankAccountError && <ErrorText>{bankAccountError}</ErrorText>}
                                      <div className="flex justify-end gap-2 mt-3">
                                        <Button size="sm" onClick={() => setShowAddBankAccount(false)}>
                                          Cancel
                                        </Button>
                                        <Button size="sm" variant="primary" onClick={() => addBankAccount(expandedDetail.id)}>
                                          Save account
                                        </Button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}

                              {expandedTab === "payment_history" && (
                                <div className="bg-white border border-gray-200 rounded-xl p-4">
                                  <div className="flex items-center justify-between mb-3">
                                    <h3 className="text-sm font-semibold text-gray-900">Payment history</h3>
                                    {ledger && ledger.entries.length > 0 && (
                                      <button
                                        onClick={() =>
                                          navigate(`/suppliers/${s.id}/payment-history`, { state: { from: "suppliers", supplierId: s.id } })
                                        }
                                        className="text-xs text-gray-500 hover:text-gray-800 underline"
                                      >
                                        View all ({ledger.entries.length})
                                      </button>
                                    )}
                                  </div>
                                  {ledgerLoading ? (
                                    <p className="text-xs text-gray-400">Loading...</p>
                                  ) : ledgerError ? (
                                    <ErrorText>{ledgerError}</ErrorText>
                                  ) : !ledger || ledger.entries.length === 0 ? (
                                    <p className="text-xs text-gray-400">No purchases, payments, credits, or returns on record yet.</p>
                                  ) : (
                                    <div className="border border-gray-200 rounded-xl overflow-hidden">
                                      <table className="w-full text-sm">
                                        <thead>
                                          <tr className="bg-gray-50">
                                            <th className="text-left px-3 py-2 text-xs font-medium text-gray-400">Date</th>
                                            <th className="text-left px-3 py-2 text-xs font-medium text-gray-400">Description</th>
                                            <th className="text-left px-3 py-2 text-xs font-medium text-gray-400">Amount</th>
                                            <th className="text-left px-3 py-2 text-xs font-medium text-gray-400">Balance</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {[...ledger.entries]
                                            .reverse()
                                            .slice(0, 3)
                                            .map((entry, i) => (
                                              <tr key={i} className={i % 2 === 1 ? "bg-gray-50/50" : ""}>
                                                <td className="px-3 py-2 border-t border-gray-50 text-gray-500">{entry.date.slice(0, 10)}</td>
                                                <td className="px-3 py-2 border-t border-gray-50 text-gray-900">{entry.label}</td>
                                                <td
                                                  className={`px-3 py-2 border-t border-gray-50 font-medium ${
                                                    entry.effect === 0 ? "text-gray-400" : entry.type === "purchase" ? "text-gray-900" : "text-green-600"
                                                  }`}
                                                >
                                                  {entry.effect === 0 ? "—" : `${entry.type === "purchase" ? "+" : "-"}Rs. ${entry.amount.toLocaleString()}`}
                                                </td>
                                                <td className="px-3 py-2 border-t border-gray-50 text-gray-500">
                                                  Rs. {entry.running_balance.toLocaleString()}
                                                </td>
                                              </tr>
                                            ))}
                                        </tbody>
                                      </table>
                                      <div className="flex justify-between px-3 py-2 border-t border-gray-200 bg-gray-50 text-sm font-medium">
                                        <span className="text-gray-600">Current balance owed</span>
                                        <span className="text-gray-900">Rs. {ledger.final_balance.toLocaleString()}</span>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
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
        </>
      )}
    </div>
  );
}