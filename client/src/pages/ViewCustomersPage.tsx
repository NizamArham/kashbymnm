import { useEffect, useState, useMemo, Fragment } from "react";
import { Users, Search, MessageCircle, Pencil, Plus, Star, X, ChevronDown, ChevronRight, Wallet, UserX, UserCheck, Trash2, AlertTriangle } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Customer, CustomerAddress, BankAccount } from "../lib/types";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { PageHeader, Card, Table, Th, Td, Input, Button, EmptyState, ErrorText, SuccessText, Label, FormGroup, Dropdown, DatePicker } from "../components/ui";
import { CityPicker } from "../components/CityPicker";

function whatsappLink(phone: string): string {
  const digitsOnly = phone.replace(/\D/g, "").replace(/^0/, "");
  return `https://wa.me/94${digitsOnly}`;
}

// The two receipt texts, phrased so "please settle soon" lands as a
// gentle nudge rather than a demand — used right after a payment is
// recorded, opened for review before sending, never auto-sent silently.
function paymentReceiptMessage(name: string, amount: number, remainingBalance: number): string {
  if (remainingBalance <= 0) {
    return `Hi ${name}! 🙏 We've received your payment of Rs. ${amount.toLocaleString()} — your account with M&M Clothing is now fully settled. Thank you so much for your trust, and see you again soon! 😊`;
  }
  return `Hi ${name}! Thank you for your payment of Rs. ${amount.toLocaleString()} 🙏 Your M&M Clothing balance now stands at Rs. ${remainingBalance.toLocaleString()}. Whenever it's convenient, feel free to settle the rest — no rush at all. We really appreciate you! 😊`;
}

function whatsappMessageLink(phone: string, message: string): string {
  const digitsOnly = phone.replace(/\D/g, "").replace(/^0/, "");
  return `https://wa.me/94${digitsOnly}?text=${encodeURIComponent(message)}`;
}

export default function ViewCustomersPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<Customer | null>(null);
  const [creditBreakdown, setCreditBreakdown] = useState<{ amount: number; reason: string; expires_at: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", phone: "", phone2: "" });
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState<string | null>(null);

  const [showAddAddress, setShowAddAddress] = useState(false);
  const [newAddr, setNewAddr] = useState({ address_line1: "", address_line2: "", city: "" });
  const [addrError, setAddrError] = useState<string | null>(null);

  const [showAddBankAccount, setShowAddBankAccount] = useState(false);
  const [newBankAccount, setNewBankAccount] = useState({ bank_name: "", account_name: "", account_number: "", branch: "" });
  const [bankAccountError, setBankAccountError] = useState<string | null>(null);
  const [editingBankAccountId, setEditingBankAccountId] = useState<number | null>(null);
  const [editBankAccount, setEditBankAccount] = useState({ bank_name: "", account_name: "", account_number: "", branch: "" });
  const [editBankAccountError, setEditBankAccountError] = useState<string | null>(null);

  // Record Payment — one amount, applied FIFO across the customer's
  // outstanding sales. Live preview updates as the amount changes, so
  // the person sees exactly what it'll cover before confirming.
  const [payingCustomer, setPayingCustomer] = useState<Customer | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "bank_transfer" | "cheque" | "other">("cash");
  // Cheques received are a real LIST — a customer often hands over
  // several at once, each with its own real amount, not identical
  // ones. All amounts are summed and FIFO-allocated together as one
  // combined payment once submitted.
  const [chequeNumber, setChequeNumber] = useState("");
  const [chequeBankName, setChequeBankName] = useState("");
  const [chequeAmount, setChequeAmount] = useState("");
  const [chequeDate, setChequeDate] = useState("");
  const [chequeListError, setChequeListError] = useState<string | null>(null);
  const [chequeList, setChequeList] = useState<{ cheque_number: string; bank_name: string; amount: number; cheque_date: string }[]>([]);
  const chequeListTotal = chequeList.reduce((sum, c) => sum + c.amount, 0);
  const [paymentNotes, setPaymentNotes] = useState("");
  const [paymentPreview, setPaymentPreview] = useState<{
    allocations: { sale_id: number; invoice: string; date: string; owed_before: number; applied: number; new_status: string }[];
    unapplied: number;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  // After a successful payment, the receipt link waits here for the
  // person to review and send themselves — never opened automatically.
  const [receiptAfterPayment, setReceiptAfterPayment] = useState<{ name: string; phone: string | null; message: string } | null>(null);

  // Suspend / reactivate — both admin-only, both require a real reason,
  // kept as a genuine audit trail rather than a silent toggle.
  const [suspendTarget, setSuspendTarget] = useState<Customer | null>(null);
  const [suspendReason, setSuspendReason] = useState("");
  const [suspendError, setSuspendError] = useState<string | null>(null);
  const [suspendSubmitting, setSuspendSubmitting] = useState(false);

  const [reactivateTarget, setReactivateTarget] = useState<Customer | null>(null);
  const [reactivateReason, setReactivateReason] = useState("");
  const [reactivateError, setReactivateError] = useState<string | null>(null);
  const [reactivateSubmitting, setReactivateSubmitting] = useState(false);

  // Delete — two real steps. First attempt may come back with a warning
  // (customer has sales); deleteWarning holds that message, and clicking
  // delete again sends confirm=true to actually go through with it.
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null);
  const [deleteWarning, setDeleteWarning] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  const [editingAddressId, setEditingAddressId] = useState<number | null>(null);
  const [editAddr, setEditAddr] = useState({ address_line1: "", address_line2: "", city: "" });
  const [editAddrError, setEditAddrError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setCustomers(await api.get<Customer[]>("/customers"));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load customers");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Live preview — refetches the FIFO breakdown a moment after the
  // relevant amount stops changing, so it doesn't fire on every
  // keystroke. For cheque, that's the sum of the whole list (several
  // cheques settle together as one combined payment); otherwise it's
  // just the plain amount field.
  useEffect(() => {
    const previewAmount = paymentMethod === "cheque" ? chequeListTotal : parseFloat(paymentAmount) || 0;
    if (!payingCustomer || previewAmount <= 0) {
      setPaymentPreview(null);
      return;
    }
    setPreviewLoading(true);
    const timeout = setTimeout(() => {
      api
        .post<{
          allocations: { sale_id: number; invoice: string; date: string; owed_before: number; applied: number; new_status: string }[];
          unapplied: number;
        }>(`/customers/${payingCustomer.id}/payment-preview`, { amount: previewAmount })
        .then((result) => setPaymentPreview(result))
        .catch(() => setPaymentPreview(null))
        .finally(() => setPreviewLoading(false));
    }, 400);
    return () => clearTimeout(timeout);
  }, [paymentAmount, paymentMethod, chequeListTotal, payingCustomer]);

  async function toggleExpand(c: Customer) {
    if (expandedId === c.id) {
      setExpandedId(null);
      setExpandedDetail(null);
      setCreditBreakdown([]);
      setIsEditing(false);
      setShowAddAddress(false);
      return;
    }
    setExpandedId(c.id);
    setIsEditing(false);
    setShowAddAddress(false);
    setEditError(null);
    setEditSuccess(null);
    const full = await api.get<Customer>(`/customers/${c.id}`);
    setExpandedDetail(full);
    setEditForm({ name: full.name, phone: full.phone ?? "", phone2: full.phone2 ?? "" });
    if (full.store_credit_balance > 0) {
      const breakdown = await api.get<{ amount: number; reason: string; expires_at: string | null }[]>(
        `/customers/${c.id}/credit-breakdown`
      );
      setCreditBreakdown(breakdown);
    } else {
      setCreditBreakdown([]);
    }
  }

  async function refreshExpanded(id: number) {
    const full = await api.get<Customer>(`/customers/${id}`);
    setExpandedDetail(full);
    if (full.store_credit_balance > 0) {
      const breakdown = await api.get<{ amount: number; reason: string; expires_at: string | null }[]>(
        `/customers/${id}/credit-breakdown`
      );
      setCreditBreakdown(breakdown);
    } else {
      setCreditBreakdown([]);
    }
  }

  function openPayment(c: Customer) {
    setPayingCustomer(c);
    setPaymentAmount("");
    setPaymentMethod("cash");
    setPaymentNotes("");
    setPaymentPreview(null);
    setPaymentError(null);
    setChequeNumber("");
    setChequeBankName("");
    setChequeAmount("");
    setChequeDate("");
    setChequeListError(null);
    setChequeList([]);
  }

  function addCheque() {
    setChequeListError(null);
    const amt = parseFloat(chequeAmount);
    if (!chequeNumber.trim() || !chequeBankName.trim() || !amt || amt <= 0 || !chequeDate) {
      setChequeListError("Cheque number, bank name, a valid amount, and date are all required");
      return;
    }
    setChequeList((list) => [...list, { cheque_number: chequeNumber.trim(), bank_name: chequeBankName.trim(), amount: amt, cheque_date: chequeDate }]);
    setChequeNumber("");
    setChequeBankName("");
    setChequeAmount("");
    setChequeDate("");
  }

  function removeCheque(index: number) {
    setChequeList((list) => list.filter((_, i) => i !== index));
  }

  async function handleRecordPayment() {
    if (!payingCustomer) return;
    setPaymentError(null);

    const amount = paymentMethod === "cheque" ? chequeListTotal : parseFloat(paymentAmount) || 0;
    if (!amount || amount <= 0) {
      setPaymentError(paymentMethod === "cheque" ? "Add at least one cheque" : "Enter an amount greater than 0");
      return;
    }

    setPaymentSubmitting(true);
    try {
      const result = await api.post<{ customer: Customer; allocations: any[]; unapplied: number }>(
        `/customers/${payingCustomer.id}/payment`,
        {
          amount: paymentMethod === "cheque" ? undefined : amount,
          method: paymentMethod,
          notes: paymentNotes.trim() || undefined,
          cheques: paymentMethod === "cheque" ? chequeList : undefined,
        }
      );

      const remainingBalance = result.customer.balance_due;
      const message = paymentReceiptMessage(payingCustomer.name, amount, remainingBalance);
      setReceiptAfterPayment({ name: payingCustomer.name, phone: payingCustomer.phone, message });

      setPayingCustomer(null);
      setChequeNumber("");
      setChequeBankName("");
      setChequeAmount("");
      setChequeDate("");
      setChequeList([]);
      load();
      if (expandedId === payingCustomer.id) refreshExpanded(payingCustomer.id);
    } catch (err) {
      setPaymentError(err instanceof ApiRequestError ? err.message : "Failed to record this payment");
    } finally {
      setPaymentSubmitting(false);
    }
  }

  function cancelEdit() {
    if (!expandedDetail) return;
    setIsEditing(false);
    setEditForm({ name: expandedDetail.name, phone: expandedDetail.phone ?? "", phone2: expandedDetail.phone2 ?? "" });
    setEditError(null);
  }

  async function handleSuspend() {
    if (!suspendTarget) return;
    setSuspendError(null);
    if (!suspendReason.trim()) {
      setSuspendError("A reason is required");
      return;
    }
    setSuspendSubmitting(true);
    try {
      await api.put(`/customers/${suspendTarget.id}/suspend`, { reason: suspendReason.trim() });
      setSuspendTarget(null);
      setSuspendReason("");
      load();
      if (expandedId === suspendTarget.id) refreshExpanded(suspendTarget.id);
    } catch (err) {
      setSuspendError(err instanceof ApiRequestError ? err.message : "Failed to suspend this customer");
    } finally {
      setSuspendSubmitting(false);
    }
  }

  async function handleReactivate() {
    if (!reactivateTarget) return;
    setReactivateError(null);
    if (!reactivateReason.trim()) {
      setReactivateError("A reason is required");
      return;
    }
    setReactivateSubmitting(true);
    try {
      await api.put(`/customers/${reactivateTarget.id}/reactivate`, { reason: reactivateReason.trim() });
      setReactivateTarget(null);
      setReactivateReason("");
      load();
      if (expandedId === reactivateTarget.id) refreshExpanded(reactivateTarget.id);
    } catch (err) {
      setReactivateError(err instanceof ApiRequestError ? err.message : "Failed to reactivate this customer");
    } finally {
      setReactivateSubmitting(false);
    }
  }

  function openDelete(c: Customer) {
    setDeleteTarget(c);
    setDeleteWarning(null);
    setDeleteError(null);
  }

  async function handleDelete(confirmed: boolean) {
    if (!deleteTarget) return;
    setDeleteError(null);
    setDeleteSubmitting(true);
    try {
      await api.delete(`/customers/${deleteTarget.id}${confirmed ? "?confirm=true" : ""}`);
      setDeleteTarget(null);
      setDeleteWarning(null);
      if (expandedId === deleteTarget.id) {
        setExpandedId(null);
        setExpandedDetail(null);
      }
      load();
    } catch (err) {
      // A 409 from this specific endpoint is always the sales-history
      // warning (the only case it can produce) — show it as something
      // to confirm past, not a hard failure.
      if (err instanceof ApiRequestError && err.status === 409) {
        setDeleteWarning(err.message);
        return;
      }
      setDeleteError(err instanceof ApiRequestError ? err.message : "Failed to delete this customer");
    } finally {
      setDeleteSubmitting(false);
    }
  }

  async function saveEdit(id: number) {
    setEditError(null);
    setEditSuccess(null);
    if (!editForm.name.trim()) {
      setEditError("Name is required");
      return;
    }
    try {
      await api.put(`/customers/${id}`, {
        name: editForm.name.trim(),
        phone: editForm.phone.trim() || undefined,
        phone2: editForm.phone2.trim() || undefined,
      });
      setEditSuccess("Saved.");
      setIsEditing(false);
      refreshExpanded(id);
      load();
    } catch (err) {
      setEditError(err instanceof ApiRequestError ? err.message : "Failed to update customer");
    }
  }

  async function addAddress(customerId: number) {
    setAddrError(null);
    if (!newAddr.address_line1.trim() && !newAddr.city.trim()) {
      setAddrError("Enter at least an address line or city");
      return;
    }
    try {
      await api.post(`/customers/${customerId}/addresses`, {
        address_line1: newAddr.address_line1.trim() || undefined,
        address_line2: newAddr.address_line2.trim() || undefined,
        city: newAddr.city.trim() || undefined,
        is_default: false,
      });
      setNewAddr({ address_line1: "", address_line2: "", city: "" });
      setShowAddAddress(false);
      refreshExpanded(customerId);
    } catch (err) {
      setAddrError(err instanceof ApiRequestError ? err.message : "Failed to add address");
    }
  }

  async function makeDefault(customerId: number, address: CustomerAddress) {
    try {
      await api.put(`/customers/${customerId}/addresses/${address.id}`, { is_default: true });
      refreshExpanded(customerId);
    } catch {
      // minor action — no need for a full error banner if it fails
    }
  }

  function startEditAddress(a: CustomerAddress) {
    setEditingAddressId(a.id);
    setEditAddr({ address_line1: a.address_line1 ?? "", address_line2: a.address_line2 ?? "", city: a.city ?? "" });
    setEditAddrError(null);
  }

  function cancelEditAddress() {
    setEditingAddressId(null);
    setEditAddrError(null);
  }

  async function saveEditAddress(customerId: number, addressId: number) {
    setEditAddrError(null);
    if (!editAddr.address_line1.trim() && !editAddr.city.trim()) {
      setEditAddrError("Enter at least an address line or city");
      return;
    }
    try {
      await api.put(`/customers/${customerId}/addresses/${addressId}`, {
        address_line1: editAddr.address_line1.trim() || undefined,
        address_line2: editAddr.address_line2.trim() || undefined,
        city: editAddr.city.trim() || undefined,
      });
      setEditingAddressId(null);
      refreshExpanded(customerId);
    } catch (err) {
      setEditAddrError(err instanceof ApiRequestError ? err.message : "Failed to update address");
    }
  }

  async function deleteAddress(customerId: number, addressId: number) {
    if (!confirm("Delete this address?")) return;
    try {
      await api.delete(`/customers/${customerId}/addresses/${addressId}`);
      refreshExpanded(customerId);
    } catch (err) {
      setEditAddrError(err instanceof ApiRequestError ? err.message : "Failed to delete address — it may be in use on a delivery.");
    }
  }

  async function addBankAccount(customerId: number) {
    setBankAccountError(null);
    if (!newBankAccount.bank_name.trim() || !newBankAccount.account_name.trim() || !newBankAccount.account_number.trim()) {
      setBankAccountError("Bank name, account holder name, and account number are all required");
      return;
    }
    try {
      await api.post(`/customers/${customerId}/bank-accounts`, {
        bank_name: newBankAccount.bank_name.trim(),
        account_name: newBankAccount.account_name.trim(),
        account_number: newBankAccount.account_number.trim(),
        branch: newBankAccount.branch.trim() || undefined,
        is_default: false,
      });
      setNewBankAccount({ bank_name: "", account_name: "", account_number: "", branch: "" });
      setShowAddBankAccount(false);
      refreshExpanded(customerId);
    } catch (err) {
      setBankAccountError(err instanceof ApiRequestError ? err.message : "Failed to add bank account");
    }
  }

  async function makeBankAccountDefault(customerId: number, account: BankAccount) {
    try {
      await api.put(`/customers/${customerId}/bank-accounts/${account.id}`, { is_default: true });
      refreshExpanded(customerId);
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

  async function saveEditBankAccount(customerId: number, accountId: number) {
    setEditBankAccountError(null);
    if (!editBankAccount.bank_name.trim() || !editBankAccount.account_name.trim() || !editBankAccount.account_number.trim()) {
      setEditBankAccountError("Bank name, account holder name, and account number are all required");
      return;
    }
    try {
      await api.put(`/customers/${customerId}/bank-accounts/${accountId}`, {
        bank_name: editBankAccount.bank_name.trim(),
        account_name: editBankAccount.account_name.trim(),
        account_number: editBankAccount.account_number.trim(),
        branch: editBankAccount.branch.trim() || undefined,
      });
      setEditingBankAccountId(null);
      refreshExpanded(customerId);
    } catch (err) {
      setEditBankAccountError(err instanceof ApiRequestError ? err.message : "Failed to update bank account");
    }
  }

  async function deleteBankAccount(customerId: number, accountId: number) {
    if (!confirm("Delete this bank account?")) return;
    try {
      await api.delete(`/customers/${customerId}/bank-accounts/${accountId}`);
      refreshExpanded(customerId);
    } catch (err) {
      setEditBankAccountError(err instanceof ApiRequestError ? err.message : "Failed to delete bank account");
    }
  }

  const filteredCustomers = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(trimmed) ||
        c.customer_code.toLowerCase().includes(trimmed) ||
        c.phone?.toLowerCase().includes(trimmed) ||
        c.phone2?.toLowerCase().includes(trimmed)
    );
  }, [customers, query]);

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle="Search to check if a customer already exists, or click a row for details."
        action={
          <Button variant="primary" onClick={() => navigate("/customers/add")} className="inline-flex items-center gap-1.5">
            <Plus size={16} />
            Add customer
          </Button>
        }
      />

      <Card className="mb-5">
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
            <Search size={16} className="text-gray-400" />
          </div>
          <Input className="pl-10" placeholder="Search by name, code, or phone..." value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </Card>

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : filteredCustomers.length === 0 ? (
        <EmptyState icon={Users} title={query ? "No matching customers" : "No customers yet"} />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th></Th>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>Phone</Th>
                <Th>Loyalty points</Th>
                <Th>Balance</Th>
                <Th>Last order</Th>
              </tr>
            </thead>
            <tbody>
              {filteredCustomers.map((c) => {
                const isExpanded = expandedId === c.id;
                const netBalance = c.store_credit_balance - c.balance_due;
                return (
                  <Fragment key={c.id}>
                    <tr onClick={() => toggleExpand(c)} className="cursor-pointer hover:bg-gray-50">
                      <Td className="w-8">
                        {isExpanded ? <ChevronDown size={15} className="text-gray-400" /> : <ChevronRight size={15} className="text-gray-400" />}
                      </Td>
                      <Td>{c.customer_code}</Td>
                      <Td className="font-medium">
                        {c.name}
                        {c.is_suspended === 1 && (
                          <span className="ml-1.5 text-xs font-normal text-red-600">(suspended)</span>
                        )}
                      </Td>
                      <Td>{c.phone ?? "—"}</Td>
                      <Td>
                        <span className="inline-flex items-center gap-1">
                          <Star size={12} className="text-amber-400" />
                          {c.loyalty_points}
                        </span>
                      </Td>
                      <Td className={netBalance < 0 ? "text-red-600 font-medium" : netBalance > 0 ? "text-green-700 font-medium" : ""}>
                        {netBalance === 0 ? "—" : netBalance > 0 ? `+Rs. ${netBalance.toLocaleString()}` : `-Rs. ${Math.abs(netBalance).toLocaleString()}`}
                      </Td>
                      <Td>{c.last_order_date ? c.last_order_date.slice(0, 10) : "—"}</Td>
                    </tr>

                    {isExpanded && expandedDetail && (
                      <tr>
                        <Td colSpan={7} className="bg-gray-50">
                          <div className="py-3 px-1">
                            <div className="flex items-center justify-between mb-4">
                              <div>
                                <h2 className="text-base font-semibold text-gray-900">{expandedDetail.name}</h2>
                                <p className="text-xs text-gray-400">{expandedDetail.customer_code}</p>
                              </div>
                              <button onClick={() => setExpandedId(null)} className="text-gray-400 hover:text-gray-600">
                                <X size={18} />
                              </button>
                            </div>

                            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-5 text-sm">
                              <div>
                                <p className="text-xs text-gray-400">Loyalty points</p>
                                <p className="text-gray-900 font-medium">{expandedDetail.loyalty_points}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400">Balance due</p>
                                <p className="text-gray-900 font-medium">
                                  {expandedDetail.balance_due > 0 ? `Rs. ${expandedDetail.balance_due.toLocaleString()}` : "Settled"}
                                </p>
                                {expandedDetail.balance_due > 0 && (
                                  <button
                                    onClick={() => openPayment(expandedDetail)}
                                    className="inline-flex items-center gap-1 text-xs text-black underline hover:no-underline mt-1"
                                  >
                                    <Wallet size={12} />
                                    Record Payment
                                  </button>
                                )}
                              </div>
                              <div>
                                <p className="text-xs text-gray-400">Store credit</p>
                                <p className="text-gray-900 font-medium">
                                  {expandedDetail.store_credit_balance > 0
                                    ? `Rs. ${expandedDetail.store_credit_balance.toLocaleString()}`
                                    : "—"}
                                </p>
                                {creditBreakdown.length > 0 && (
                                  <div className="mt-1 space-y-0.5">
                                    {creditBreakdown.map((g, i) => {
                                      const daysLeft = g.expires_at
                                        ? Math.ceil((new Date(g.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
                                        : null;
                                      return (
                                        <p key={i} className="text-xs text-gray-400">
                                          +Rs. {g.amount.toLocaleString()}
                                          {g.expires_at
                                            ? ` (expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}, on ${g.expires_at.slice(0, 10)})`
                                            : " (no expiry)"}
                                        </p>
                                      );
                                    })}
                                  </div>
                                )}
                                {expandedDetail.store_credit_balance > 0 && (
                                  <p className="text-xs text-gray-400 mt-1">Applied automatically at checkout</p>
                                )}
                              </div>
                              <div>
                                <p className="text-xs text-gray-400">Last order</p>
                                <p className="text-gray-900 font-medium">
                                  {expandedDetail.last_order_date ? expandedDetail.last_order_date.slice(0, 10) : "No orders yet"}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400">Message</p>
                                {expandedDetail.phone ? (
                                  <a
                                    href={whatsappLink(expandedDetail.phone)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1.5 text-green-600 hover:text-green-700 font-medium"
                                  >
                                    <MessageCircle size={15} />
                                    WhatsApp
                                  </a>
                                ) : (
                                  <p className="text-gray-300">No phone</p>
                                )}
                              </div>
                            </div>

                            {expandedDetail.is_suspended === 1 && (
                              <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 mb-4 flex items-start gap-2">
                                <AlertTriangle size={14} className="text-red-500 flex-shrink-0 mt-0.5" />
                                <div className="text-xs text-red-700">
                                  <p className="font-medium">Suspended</p>
                                  {expandedDetail.suspended_reason && <p className="mt-0.5">{expandedDetail.suspended_reason}</p>}
                                  {expandedDetail.suspended_at && (
                                    <p className="mt-0.5 text-red-500">Since {expandedDetail.suspended_at.slice(0, 10)}</p>
                                  )}
                                </div>
                              </div>
                            )}

                            {isAdmin && (
                              <div className="flex items-center gap-3 mb-4 text-xs">
                                {expandedDetail.is_suspended === 1 ? (
                                  <button
                                    onClick={() => {
                                      setReactivateTarget(expandedDetail);
                                      setReactivateReason("");
                                      setReactivateError(null);
                                    }}
                                    className="inline-flex items-center gap-1 text-gray-500 hover:text-black"
                                  >
                                    <UserCheck size={13} />
                                    Reactivate
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => {
                                      setSuspendTarget(expandedDetail);
                                      setSuspendReason("");
                                      setSuspendError(null);
                                    }}
                                    className="inline-flex items-center gap-1 text-gray-500 hover:text-black"
                                  >
                                    <UserX size={13} />
                                    Suspend
                                  </button>
                                )}
                                <button
                                  onClick={() => openDelete(expandedDetail)}
                                  className="inline-flex items-center gap-1 text-gray-500 hover:text-red-600"
                                >
                                  <Trash2 size={13} />
                                  Delete
                                </button>
                              </div>
                            )}

                            <div className="border-t border-gray-200 pt-4 mb-4">
                              <div className="flex items-center justify-between mb-2">
                                <h3 className="text-sm font-semibold text-gray-900">Contact details</h3>
                                {!isEditing && (
                                  <button
                                    onClick={() => setIsEditing(true)}
                                    className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1"
                                  >
                                    <Pencil size={12} />
                                    Edit
                                  </button>
                                )}
                              </div>

                              {isEditing ? (
                                <>
                                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                    <FormGroup>
                                      <Label>Name</Label>
                                      <Input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
                                    </FormGroup>
                                    <FormGroup>
                                      <Label>Phone</Label>
                                      <Input value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} />
                                    </FormGroup>
                                    <FormGroup>
                                      <Label>Phone 2</Label>
                                      <Input value={editForm.phone2} onChange={(e) => setEditForm((f) => ({ ...f, phone2: e.target.value }))} />
                                    </FormGroup>
                                  </div>
                                  {editError && <ErrorText>{editError}</ErrorText>}
                                  {editSuccess && <SuccessText>{editSuccess}</SuccessText>}
                                  <div className="flex gap-2 mt-2">
                                    <Button size="sm" variant="primary" onClick={() => saveEdit(expandedDetail.id)}>
                                      Save
                                    </Button>
                                    <Button size="sm" onClick={cancelEdit}>
                                      Cancel
                                    </Button>
                                  </div>
                                </>
                              ) : (
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                                  <div>
                                    <p className="text-xs text-gray-400">Name</p>
                                    <p className="text-gray-900">{expandedDetail.name}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-gray-400">Phone</p>
                                    <p className="text-gray-900">{expandedDetail.phone ?? "—"}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-gray-400">Phone 2</p>
                                    <p className="text-gray-900">{expandedDetail.phone2 ?? "—"}</p>
                                  </div>
                                </div>
                              )}
                            </div>

                            <div className="border-t border-gray-200 pt-4">
                              <div className="flex items-center justify-between mb-2">
                                <h3 className="text-sm font-semibold text-gray-900">Saved addresses</h3>
                                {!showAddAddress && (
                                  <button
                                    onClick={() => setShowAddAddress(true)}
                                    className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1"
                                  >
                                    <Plus size={12} />
                                    Add address
                                  </button>
                                )}
                              </div>

                              {(!expandedDetail.addresses || expandedDetail.addresses.length === 0) && !showAddAddress ? (
                                <p className="text-xs text-gray-400">No saved addresses.</p>
                              ) : (
                                <div className="space-y-2">
                                  {expandedDetail.addresses?.map((a) =>
                                    editingAddressId === a.id ? (
                                      <div key={a.id} className="bg-white border border-gray-200 rounded-xl p-3">
                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                          <FormGroup>
                                            <Label>Address line 1</Label>
                                            <Input
                                              value={editAddr.address_line1}
                                              onChange={(e) => setEditAddr((f) => ({ ...f, address_line1: e.target.value }))}
                                            />
                                          </FormGroup>
                                          <FormGroup>
                                            <Label>Address line 2</Label>
                                            <Input
                                              value={editAddr.address_line2}
                                              onChange={(e) => setEditAddr((f) => ({ ...f, address_line2: e.target.value }))}
                                            />
                                          </FormGroup>
                                          <FormGroup>
                                            <Label>City</Label>
                                            <CityPicker value={editAddr.city} onChange={(v) => setEditAddr((f) => ({ ...f, city: v }))} />
                                          </FormGroup>
                                        </div>
                                        {editAddrError && <ErrorText>{editAddrError}</ErrorText>}
                                        <div className="flex gap-2 mt-2">
                                          <Button size="sm" variant="primary" onClick={() => saveEditAddress(expandedDetail.id, a.id)}>
                                            Save
                                          </Button>
                                          <Button size="sm" onClick={cancelEditAddress}>
                                            Cancel
                                          </Button>
                                        </div>
                                      </div>
                                    ) : (
                                      <div key={a.id} className="flex items-center justify-between bg-white border border-gray-100 rounded-lg px-3 py-2 text-sm">
                                        <span className="text-gray-700">
                                          {[a.address_line1, a.address_line2, a.city].filter(Boolean).join(", ") || "—"}
                                        </span>
                                        <div className="flex items-center gap-3 flex-shrink-0">
                                          {a.is_default ? (
                                            <span className="text-xs text-green-600 font-medium">Default</span>
                                          ) : (
                                            <button onClick={() => makeDefault(expandedDetail.id, a)} className="text-xs text-gray-400 hover:text-gray-700">
                                              Make default
                                            </button>
                                          )}
                                          <button onClick={() => startEditAddress(a)} className="text-xs text-gray-400 hover:text-gray-700">
                                            Edit
                                          </button>
                                          <button onClick={() => deleteAddress(expandedDetail.id, a.id)} className="text-xs text-red-400 hover:text-red-600">
                                            Delete
                                          </button>
                                        </div>
                                      </div>
                                    )
                                  )}
                                </div>
                              )}

                              {showAddAddress && (
                                <div className="mt-3 bg-white border border-gray-200 rounded-xl p-3">
                                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                    <FormGroup>
                                      <Label>Address line 1</Label>
                                      <Input value={newAddr.address_line1} onChange={(e) => setNewAddr((f) => ({ ...f, address_line1: e.target.value }))} />
                                    </FormGroup>
                                    <FormGroup>
                                      <Label>Address line 2</Label>
                                      <Input value={newAddr.address_line2} onChange={(e) => setNewAddr((f) => ({ ...f, address_line2: e.target.value }))} />
                                    </FormGroup>
                                    <FormGroup>
                                      <Label>City</Label>
                                      <CityPicker value={newAddr.city} onChange={(v) => setNewAddr((f) => ({ ...f, city: v }))} />
                                    </FormGroup>
                                  </div>
                                  {addrError && <ErrorText>{addrError}</ErrorText>}
                                  <div className="flex gap-2 mt-2">
                                    <Button size="sm" variant="primary" onClick={() => addAddress(expandedDetail.id)}>
                                      Save address
                                    </Button>
                                    <Button size="sm" onClick={() => setShowAddAddress(false)}>
                                      Cancel
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </div>

                            <div className="border-t border-gray-200 pt-4">
                              <div className="flex items-center justify-between mb-2">
                                <h3 className="text-sm font-semibold text-gray-900">Bank accounts</h3>
                                {!showAddBankAccount && (
                                  <button
                                    onClick={() => setShowAddBankAccount(true)}
                                    className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1"
                                  >
                                    <Plus size={12} />
                                    Add account
                                  </button>
                                )}
                              </div>

                              {(!expandedDetail.bank_accounts || expandedDetail.bank_accounts.length === 0) && !showAddBankAccount ? (
                                <p className="text-xs text-gray-400">No bank accounts on file — needed for a bank-transfer refund or payment.</p>
                              ) : (
                                <div className="space-y-2">
                                  {expandedDetail.bank_accounts?.map((a) =>
                                    editingBankAccountId === a.id ? (
                                      <div key={a.id} className="bg-white border border-gray-200 rounded-xl p-3">
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
                                        <div className="flex gap-2 mt-2">
                                          <Button size="sm" variant="primary" onClick={() => saveEditBankAccount(expandedDetail.id, a.id)}>
                                            Save
                                          </Button>
                                          <Button size="sm" onClick={cancelEditBankAccount}>
                                            Cancel
                                          </Button>
                                        </div>
                                      </div>
                                    ) : (
                                      <div key={a.id} className="flex items-center justify-between bg-white border border-gray-100 rounded-lg px-3 py-2 text-sm">
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
                                <div className="mt-3 bg-white border border-gray-200 rounded-xl p-3">
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
                                  <div className="flex gap-2 mt-2">
                                    <Button size="sm" variant="primary" onClick={() => addBankAccount(expandedDetail.id)}>
                                      Save account
                                    </Button>
                                    <Button size="sm" onClick={() => setShowAddBankAccount(false)}>
                                      Cancel
                                    </Button>
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
      )}

      {payingCustomer && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto shadow-2xl">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Record payment — {payingCustomer.name}</h2>
              <button onClick={() => setPayingCustomer(null)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <p className="text-xs text-gray-400 mb-3">
                  Currently owes Rs. {payingCustomer.balance_due.toLocaleString()}. A payment is applied to their oldest unpaid sales
                  first.
                </p>
                {paymentMethod !== "cheque" && (
                  <FormGroup>
                    <Label>Amount received (Rs.)</Label>
                    <Input type="number" min="0" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} />
                  </FormGroup>
                )}
                <FormGroup>
                  <Label>Method</Label>
                  <Dropdown
                    value={paymentMethod}
                    onChange={(v) => setPaymentMethod(v as typeof paymentMethod)}
                    options={[
                      { value: "cash", label: "Cash" },
                      { value: "bank_transfer", label: "Bank transfer" },
                      { value: "cheque", label: "Cheque" },
                      { value: "other", label: "Other" },
                    ]}
                  />
                </FormGroup>

                {paymentMethod === "cheque" && (
                  <div className="border border-gray-200 rounded-xl p-3 mb-3">
                    <p className="text-xs text-gray-400 mb-2">
                      A cheque isn't real cash yet — sales are marked paid now, but nothing hits the Cash Book until it clears (tracked
                      on the Cheques page). Add one or more cheques below — they're summed and applied together.
                    </p>
                    <div className="grid grid-cols-2 gap-2 mb-2">
                      <Input placeholder="Cheque number" value={chequeNumber} onChange={(e) => setChequeNumber(e.target.value)} />
                      <Input placeholder="Bank name" value={chequeBankName} onChange={(e) => setChequeBankName(e.target.value)} />
                      <Input
                        type="number"
                        min="0"
                        placeholder="Amount"
                        value={chequeAmount}
                        onChange={(e) => setChequeAmount(e.target.value)}
                      />
                      <DatePicker value={chequeDate || null} onChange={setChequeDate} placeholder="Cheque date" />
                    </div>
                    {chequeListError && <ErrorText>{chequeListError}</ErrorText>}
                    <Button onClick={addCheque}>Add this cheque</Button>

                    {chequeList.length > 0 && (
                      <div className="mt-3 space-y-1.5">
                        {chequeList.map((c, i) => (
                          <div key={i} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm">
                            <div>
                              <span className="font-medium text-gray-900">
                                #{c.cheque_number} — {c.bank_name}
                              </span>
                              <div className="text-xs text-gray-500">Rs. {c.amount.toLocaleString()}</div>
                            </div>
                            <button onClick={() => removeCheque(i)} className="text-gray-400 hover:text-red-500 text-xs">
                              Remove
                            </button>
                          </div>
                        ))}
                        <div className="flex justify-between text-sm font-medium px-3 pt-1">
                          <span>Total</span>
                          <span>Rs. {chequeListTotal.toLocaleString()}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <FormGroup>
                  <Label>Notes (optional)</Label>
                  <Input value={paymentNotes} onChange={(e) => setPaymentNotes(e.target.value)} />
                </FormGroup>

                {paymentError && <ErrorText>{paymentError}</ErrorText>}
                <div className="flex gap-2 mt-2">
                  <Button variant="primary" onClick={handleRecordPayment} disabled={paymentSubmitting}>
                    {paymentSubmitting ? "Recording..." : "Confirm payment"}
                  </Button>
                  <Button onClick={() => setPayingCustomer(null)}>Cancel</Button>
                </div>
              </div>

              <div>
                <p className="text-xs font-medium text-gray-500 mb-2">How this will apply</p>
                {previewLoading && <p className="text-xs text-gray-400">Calculating...</p>}
                {!previewLoading && (!paymentPreview || paymentPreview.allocations.length === 0) && (
                  <p className="text-xs text-gray-400">Enter an amount to see how it covers their outstanding sales.</p>
                )}
                {paymentPreview && paymentPreview.allocations.length > 0 && (
                  <div className="border border-gray-200 rounded-xl overflow-hidden">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-gray-50">
                          <th className="text-left px-2.5 py-1.5 font-medium text-gray-400">Invoice</th>
                          <th className="text-left px-2.5 py-1.5 font-medium text-gray-400">Owed</th>
                          <th className="text-left px-2.5 py-1.5 font-medium text-gray-400">Applied</th>
                          <th className="text-left px-2.5 py-1.5 font-medium text-gray-400">New status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paymentPreview.allocations.map((a) => (
                          <tr key={a.sale_id} className="border-t border-gray-100">
                            <td className="px-2.5 py-1.5">{a.invoice}</td>
                            <td className="px-2.5 py-1.5">Rs. {a.owed_before.toLocaleString()}</td>
                            <td className="px-2.5 py-1.5">Rs. {a.applied.toLocaleString()}</td>
                            <td className="px-2.5 py-1.5 capitalize">{a.new_status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {paymentPreview.unapplied > 0 && (
                      <p className="text-xs text-gray-400 px-2.5 py-1.5 border-t border-gray-100">
                        Rs. {paymentPreview.unapplied.toLocaleString()} left over after covering everything outstanding.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {receiptAfterPayment && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full shadow-2xl">
            <div className="p-5 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">Payment recorded</h2>
            </div>
            <div className="p-5">
              <p className="text-xs text-gray-400 mb-3">Send a receipt to {receiptAfterPayment.name}? Review it before sending.</p>
              <p className="text-sm text-gray-700 bg-gray-50 rounded-xl p-3 mb-4 whitespace-pre-wrap">{receiptAfterPayment.message}</p>
              <div className="flex gap-2">
                {receiptAfterPayment.phone ? (
                  <a
                    href={whatsappMessageLink(receiptAfterPayment.phone, receiptAfterPayment.message)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setReceiptAfterPayment(null)}
                    className="flex-1 bg-black text-white rounded-xl py-2.5 text-sm font-medium hover:bg-gray-800 transition text-center inline-flex items-center justify-center gap-1.5"
                  >
                    <MessageCircle size={15} />
                    Open in WhatsApp
                  </a>
                ) : (
                  <p className="text-xs text-gray-400 flex-1">No phone number on file for this customer.</p>
                )}
                <button
                  onClick={() => setReceiptAfterPayment(null)}
                  className="flex-1 border border-gray-200 rounded-xl py-2.5 text-sm font-medium hover:bg-gray-50 transition"
                >
                  Skip
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {suspendTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full shadow-2xl">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Suspend {suspendTarget.name}</h2>
              <button onClick={() => setSuspendTarget(null)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5">
              <p className="text-xs text-gray-400 mb-3">
                They'll stay fully in the system — every sale, loyalty point, and credit is untouched — they just can't be selected for a
                new sale until reactivated.
              </p>
              <FormGroup>
                <Label>Reason</Label>
                <Input value={suspendReason} onChange={(e) => setSuspendReason(e.target.value)} placeholder="Why are they being suspended?" />
              </FormGroup>
              {suspendError && <ErrorText>{suspendError}</ErrorText>}
              <div className="flex gap-2 mt-2">
                <Button variant="primary" onClick={handleSuspend} disabled={suspendSubmitting}>
                  {suspendSubmitting ? "Suspending..." : "Suspend"}
                </Button>
                <Button onClick={() => setSuspendTarget(null)}>Cancel</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {reactivateTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full shadow-2xl">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Reactivate {reactivateTarget.name}</h2>
              <button onClick={() => setReactivateTarget(null)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5">
              <FormGroup>
                <Label>Reason</Label>
                <Input
                  value={reactivateReason}
                  onChange={(e) => setReactivateReason(e.target.value)}
                  placeholder="Why are they being reactivated?"
                />
              </FormGroup>
              {reactivateError && <ErrorText>{reactivateError}</ErrorText>}
              <div className="flex gap-2 mt-2">
                <Button variant="primary" onClick={handleReactivate} disabled={reactivateSubmitting}>
                  {reactivateSubmitting ? "Reactivating..." : "Reactivate"}
                </Button>
                <Button onClick={() => setReactivateTarget(null)}>Cancel</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full shadow-2xl">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Delete {deleteTarget.name}?</h2>
              <button
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteWarning(null);
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-5">
              {deleteWarning ? (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
                  <AlertTriangle size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-800">{deleteWarning}</p>
                </div>
              ) : (
                <p className="text-sm text-gray-600 mb-4">
                  This permanently removes their record, including loyalty points and store credit history. This can't be undone.
                </p>
              )}
              {deleteError && <ErrorText>{deleteError}</ErrorText>}
              <div className="flex gap-2">
                <Button variant="danger" onClick={() => handleDelete(deleteWarning !== null)} disabled={deleteSubmitting}>
                  {deleteSubmitting ? "Deleting..." : deleteWarning ? "Delete permanently anyway" : "Delete"}
                </Button>
                <Button
                  onClick={() => {
                    setDeleteTarget(null);
                    setDeleteWarning(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
