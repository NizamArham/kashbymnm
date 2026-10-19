import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, MessageCircle, Pencil, Plus, ShoppingBag, Trash2, Wallet } from "lucide-react";
import { PageLoader } from "../components/Loader";
import { api, ApiRequestError } from "../lib/api";
import { Supplier, BankAccount } from "../lib/types";
import { Card, Input, Button, ErrorText, SuccessText, Label, FormGroup, ActionMenu, HelpHint } from "../components/ui";
import { CityPicker } from "../components/CityPicker";
import { whatsappNumber } from "../lib/phone";
import { useConfirm } from "../components/Feedback";
import { formatDate } from "../lib/dates";
import SupplierPurchaseHistory from "./SupplierPurchaseHistory";
import SupplierPaymentHistoryPage from "./SupplierPaymentHistoryPage";

type ProfileTab = "purchases" | "payments" | "details";
const TABS: { key: ProfileTab; label: string }[] = [
  { key: "purchases", label: "Purchases" },
  { key: "payments", label: "Payments" },
  { key: "details", label: "Details" },
];

const money = (n: number) => `Rs. ${n.toLocaleString()}`;

const BLANK_ACCOUNT = { bank_name: "", account_name: "", account_number: "", branch: "" };

// One supplier on a page of their own: who they are and what you owe them at the top, what you can do for them in the header, and
// their purchases, payments and contact / bank details underneath — the same layout as a customer's profile.
export default function SupplierProfilePage() {
  const { confirm: confirmDialog } = useConfirm();
  const { id } = useParams<{ id: string }>();
  const supplierId = Number(id);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped whenever something changes, so the tab being looked at reads again.
  const [reloadKey, setReloadKey] = useState(0);

  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", phone: "", city: "", notes: "" });
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState<string | null>(null);

  const [showAddBankAccount, setShowAddBankAccount] = useState(false);
  const [newBankAccount, setNewBankAccount] = useState(BLANK_ACCOUNT);
  const [bankAccountError, setBankAccountError] = useState<string | null>(null);
  const [editingBankAccountId, setEditingBankAccountId] = useState<number | null>(null);
  const [editBankAccount, setEditBankAccount] = useState(BLANK_ACCOUNT);
  const [editBankAccountError, setEditBankAccountError] = useState<string | null>(null);

  const tabParam = searchParams.get("tab");
  const tab: ProfileTab = TABS.some((t) => t.key === tabParam) ? (tabParam as ProfileTab) : "purchases";
  function setTab(next: ProfileTab) {
    setSearchParams(next === "purchases" ? {} : { tab: next }, { replace: true });
  }

  async function refresh() {
    const full = await api.get<Supplier>(`/suppliers/${supplierId}`);
    setSupplier(full);
    setReloadKey((k) => k + 1);
    return full;
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setIsEditing(false);
    refresh()
      .then((full) => {
        if (!cancelled) setEditForm({ name: full.name, phone: full.phone ?? "", city: full.city ?? "", notes: full.notes ?? "" });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiRequestError ? err.message : "Couldn't load this supplier");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierId]);

  function startEdit() {
    if (!supplier) return;
    setEditForm({ name: supplier.name, phone: supplier.phone ?? "", city: supplier.city ?? "", notes: supplier.notes ?? "" });
    setEditError(null);
    setEditSuccess(null);
    setIsEditing(true);
  }

  function cancelEdit() {
    setIsEditing(false);
    setEditError(null);
  }

  async function saveEdit() {
    setEditError(null);
    setEditSuccess(null);
    if (!editForm.name.trim()) {
      setEditError("Name is required");
      return;
    }
    try {
      await api.put(`/suppliers/${supplierId}`, {
        name: editForm.name.trim(),
        phone: editForm.phone.trim() || undefined,
        city: editForm.city.trim() || undefined,
        notes: editForm.notes.trim() || undefined,
      });
      setEditSuccess("Saved.");
      setIsEditing(false);
      refresh();
    } catch (err) {
      setEditError(err instanceof ApiRequestError ? err.message : "Failed to update supplier");
    }
  }

  async function handleDelete() {
    if (!supplier) return;
    if (!(await confirmDialog({ title: "Delete this supplier?", message: "This only works if they have no purchases or products on record.", confirmLabel: "Delete supplier", danger: true }))) return;
    try {
      await api.delete(`/suppliers/${supplierId}`);
      navigate("/suppliers", { replace: true });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to delete supplier");
    }
  }

  async function addBankAccount() {
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
      setNewBankAccount(BLANK_ACCOUNT);
      setShowAddBankAccount(false);
      refresh();
    } catch (err) {
      setBankAccountError(err instanceof ApiRequestError ? err.message : "Failed to add bank account");
    }
  }

  async function makeBankAccountDefault(account: BankAccount) {
    try {
      await api.put(`/suppliers/${supplierId}/bank-accounts/${account.id}`, { is_default: true });
      refresh();
    } catch {
      // minor action — no need for a full error banner if it fails
    }
  }

  function startEditBankAccount(a: BankAccount) {
    setEditingBankAccountId(a.id);
    setEditBankAccount({ bank_name: a.bank_name, account_name: a.account_name, account_number: a.account_number, branch: a.branch ?? "" });
    setEditBankAccountError(null);
  }

  async function saveEditBankAccount(accountId: number) {
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
      refresh();
    } catch (err) {
      setEditBankAccountError(err instanceof ApiRequestError ? err.message : "Failed to update bank account");
    }
  }

  async function deleteBankAccount(accountId: number) {
    if (!(await confirmDialog({ title: "Delete this bank account?", confirmLabel: "Delete", danger: true }))) return;
    try {
      await api.delete(`/suppliers/${supplierId}/bank-accounts/${accountId}`);
      refresh();
    } catch (err) {
      setEditBankAccountError(err instanceof ApiRequestError ? err.message : "Failed to delete bank account");
    }
  }

  const initials = (supplier?.name ?? "?")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const owed = supplier?.balance_owed ?? 0;
  const credit = supplier?.credit_balance ?? 0;
  const pendingCheques = supplier?.pending_cheque_count ?? 0;

  return (
    <div>
      <button onClick={() => navigate(-1)} className="mb-3 inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft size={14} />
        Back
      </button>

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <PageLoader />
      ) : !supplier ? null : (
        <>
          {/* ================= Header: who they are, and what you can do ================= */}
          <Card className="mb-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border border-gray-200 bg-gray-50 text-base font-semibold text-gray-700">
                {initials}
              </div>
              <div className="min-w-0">
                <h1 className="text-xl font-semibold tracking-tight text-gray-900">{supplier.name}</h1>
                <p className="text-sm text-gray-500">
                  {supplier.supplier_code}
                  {supplier.phone ? ` · ${supplier.phone}` : ""}
                  {supplier.city ? ` · ${supplier.city}` : ""}
                </p>
              </div>
              {/* On a phone the buttons are just their icons, so they fit on one row. */}
              <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
                <Button
                  variant="primary"
                  title="Record payment"
                  onClick={() => navigate("/supplier-payments", { state: { paySupplierId: supplier.id } })}
                  className="inline-flex items-center gap-1.5"
                >
                  <Wallet size={16} />
                  <span className="hidden sm:inline">Record payment</span>
                  <span className="sr-only sm:hidden">Record payment</span>
                </Button>
                {supplier.phone && (
                  <a
                    href={`https://wa.me/${whatsappNumber(supplier.phone)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Message on WhatsApp"
                    className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-green-600 transition hover:bg-gray-50"
                  >
                    <MessageCircle size={16} />
                    <span className="hidden sm:inline">WhatsApp</span>
                    <span className="sr-only sm:hidden">WhatsApp</span>
                  </a>
                )}
                <ActionMenu
                  items={[
                    { group: "Supplier", label: "Edit details", icon: <Pencil size={14} />, onClick: () => { setTab("details"); startEdit(); } },
                    { group: "Supplier", label: "Bank accounts", icon: <Wallet size={14} />, onClick: () => setTab("details") },
                    { group: "Purchases", label: "Record a purchase", icon: <ShoppingBag size={14} />, onClick: () => navigate("/purchases") },
                    { group: "Other", label: "Delete supplier", icon: <Trash2 size={14} />, danger: true, onClick: handleDelete },
                  ]}
                />
              </div>
            </div>
          </Card>

          {/* ================= The four numbers ================= */}
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">
                You owe
                <HelpHint text="Calculated live from purchases minus payments made, minus any credit they hold for you." />
              </p>
              <p className={`mt-0.5 text-lg font-semibold tabular-nums ${owed > 0 ? "text-red-600" : "text-gray-900"}`}>
                {owed > 0 ? money(owed) : owed < 0 ? `${money(-owed)} overpaid` : "Settled"}
              </p>
              {pendingCheques > 0 && (
                <p className="mt-0.5 text-xs text-gray-500">
                  {pendingCheques} cheque{pendingCheques === 1 ? "" : "s"} not cleared yet · {money(supplier.pending_cheque_total ?? 0)}
                </p>
              )}
            </div>
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">Credit with them</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900">{credit > 0 ? money(credit) : "—"}</p>
              {credit > 0 && <p className="mt-0.5 text-xs text-gray-500">Comes off your next purchase automatically</p>}
            </div>
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">Total purchased</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900">
                {(supplier.total_purchased ?? 0) > 0 ? money(supplier.total_purchased ?? 0) : "—"}
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                {supplier.purchase_count ?? 0} purchase{supplier.purchase_count === 1 ? "" : "s"}
                {(supplier.pending_sort_count ?? 0) > 0 ? ` · ${supplier.pending_sort_count} not sorted yet` : ""}
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">Last purchase</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900">
                {supplier.last_purchase_date ? formatDate(supplier.last_purchase_date) : "No purchases yet"}
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                {supplier.last_payment_date ? `Last paid ${formatDate(supplier.last_payment_date)}` : "Not paid yet"}
              </p>
            </div>
          </div>

          {/* ================= Purchases / Payments / Details ================= */}
          <div className="mb-4 flex gap-1 overflow-x-auto border-b border-gray-200 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`-mb-px flex-shrink-0 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition ${
                  tab === t.key ? "border-black text-gray-900" : "border-transparent text-gray-500 hover:text-gray-800"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "purchases" && <SupplierPurchaseHistory key={reloadKey} supplierId={supplier.id} />}
          {tab === "payments" && <SupplierPaymentHistoryPage key={reloadKey} supplierId={supplier.id} />}
          {tab === "details" && (
            <div className="space-y-4">
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-900">Contact details</h3>
                  {!isEditing && (
                    <button onClick={startEdit} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800">
                      <Pencil size={12} />
                      Edit
                    </button>
                  )}
                </div>

                {isEditing ? (
                  <>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      <FormGroup>
                        <Label>Name</Label>
                        <Input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
                      </FormGroup>
                      <FormGroup>
                        <Label>Phone</Label>
                        <Input value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} />
                      </FormGroup>
                      <FormGroup>
                        <Label>City</Label>
                        <CityPicker value={editForm.city} onChange={(v) => setEditForm((f) => ({ ...f, city: v }))} />
                      </FormGroup>
                    </div>
                    <FormGroup>
                      <Label>Notes</Label>
                      <Input value={editForm.notes} onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))} />
                    </FormGroup>
                    {editError && <ErrorText>{editError}</ErrorText>}
                    <div className="mt-3 flex justify-end gap-2">
                      <Button size="sm" onClick={cancelEdit}>
                        Cancel
                      </Button>
                      <Button size="sm" variant="primary" onClick={saveEdit}>
                        Save
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
                      <div>
                        <p className="text-xs text-gray-500">Name</p>
                        <p className="text-gray-900">{supplier.name}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">Supplier code</p>
                        <p className="text-gray-900">{supplier.supplier_code}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">Phone</p>
                        <p className="text-gray-900">{supplier.phone ?? "—"}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">City</p>
                        <p className="text-gray-900">{supplier.city ?? "—"}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">Products from this supplier</p>
                        <p className="text-gray-900">{(supplier.product_count ?? 0).toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">Notes</p>
                        <p className="text-gray-900">{supplier.notes ?? "—"}</p>
                      </div>
                    </div>
                    {editSuccess && <SuccessText>{editSuccess}</SuccessText>}
                  </>
                )}
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-900">Bank accounts</h3>
                  {!showAddBankAccount && (
                    <button
                      onClick={() => setShowAddBankAccount(true)}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                    >
                      <Plus size={12} />
                      Add account
                    </button>
                  )}
                </div>

                {(!supplier.bank_accounts || supplier.bank_accounts.length === 0) && !showAddBankAccount ? (
                  <p className="text-xs text-gray-500">No bank accounts on file — needed to pay this supplier by bank transfer.</p>
                ) : (
                  <div className="space-y-2">
                    {supplier.bank_accounts?.map((a) =>
                      editingBankAccountId === a.id ? (
                        <div key={a.id} className="rounded-xl bg-gray-50 p-3">
                          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            <FormGroup>
                              <Label>Bank name</Label>
                              <Input value={editBankAccount.bank_name} onChange={(e) => setEditBankAccount((f) => ({ ...f, bank_name: e.target.value }))} />
                            </FormGroup>
                            <FormGroup>
                              <Label>Branch (optional)</Label>
                              <Input value={editBankAccount.branch} onChange={(e) => setEditBankAccount((f) => ({ ...f, branch: e.target.value }))} />
                            </FormGroup>
                            <FormGroup>
                              <Label>Account holder name</Label>
                              <Input value={editBankAccount.account_name} onChange={(e) => setEditBankAccount((f) => ({ ...f, account_name: e.target.value }))} />
                            </FormGroup>
                            <FormGroup>
                              <Label>Account number</Label>
                              <Input value={editBankAccount.account_number} onChange={(e) => setEditBankAccount((f) => ({ ...f, account_number: e.target.value }))} />
                            </FormGroup>
                          </div>
                          {editBankAccountError && <ErrorText>{editBankAccountError}</ErrorText>}
                          <div className="mt-3 flex justify-end gap-2">
                            <Button size="sm" onClick={() => { setEditingBankAccountId(null); setEditBankAccountError(null); }}>
                              Cancel
                            </Button>
                            <Button size="sm" variant="primary" onClick={() => saveEditBankAccount(a.id)}>
                              Save
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div key={a.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm">
                          <div className="min-w-0">
                            <span className="text-gray-700">
                              {a.bank_name} — {a.account_name} — {a.account_number}
                            </span>
                            {a.branch && <div className="text-xs text-gray-500">{a.branch}</div>}
                          </div>
                          <div className="flex flex-shrink-0 items-center gap-3">
                            {a.is_default ? (
                              <span className="text-xs font-medium text-green-600">Default</span>
                            ) : (
                              <button onClick={() => makeBankAccountDefault(a)} className="text-xs text-gray-500 hover:text-gray-700">
                                Make default
                              </button>
                            )}
                            <button onClick={() => startEditBankAccount(a)} className="text-xs text-gray-500 hover:text-gray-700">
                              Edit
                            </button>
                            <button onClick={() => deleteBankAccount(a.id)} className="text-xs text-red-400 hover:text-red-600">
                              Delete
                            </button>
                          </div>
                        </div>
                      )
                    )}
                    {!showAddBankAccount && editBankAccountError && editingBankAccountId === null && <ErrorText>{editBankAccountError}</ErrorText>}
                  </div>
                )}

                {showAddBankAccount && (
                  <div className="mt-3 rounded-xl bg-gray-50 p-3">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <FormGroup>
                        <Label>Bank name</Label>
                        <Input value={newBankAccount.bank_name} onChange={(e) => setNewBankAccount((f) => ({ ...f, bank_name: e.target.value }))} />
                      </FormGroup>
                      <FormGroup>
                        <Label>Branch (optional)</Label>
                        <Input value={newBankAccount.branch} onChange={(e) => setNewBankAccount((f) => ({ ...f, branch: e.target.value }))} />
                      </FormGroup>
                      <FormGroup>
                        <Label>Account holder name</Label>
                        <Input value={newBankAccount.account_name} onChange={(e) => setNewBankAccount((f) => ({ ...f, account_name: e.target.value }))} />
                      </FormGroup>
                      <FormGroup>
                        <Label>Account number</Label>
                        <Input value={newBankAccount.account_number} onChange={(e) => setNewBankAccount((f) => ({ ...f, account_number: e.target.value }))} />
                      </FormGroup>
                    </div>
                    {bankAccountError && <ErrorText>{bankAccountError}</ErrorText>}
                    <div className="mt-3 flex justify-end gap-2">
                      <Button size="sm" onClick={() => { setShowAddBankAccount(false); setBankAccountError(null); }}>
                        Cancel
                      </Button>
                      <Button size="sm" variant="primary" onClick={addBankAccount}>
                        Save account
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
