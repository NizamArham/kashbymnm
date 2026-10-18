import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PageLoader } from "../components/Loader";
import { MessageCircle, Pencil, Plus, Star, Wallet, UserX, UserCheck, Trash2, AlertTriangle, ArrowLeft, Building2, FileText, MoreHorizontal, ShoppingBag, Receipt } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Customer, CustomerAddress, BankAccount, CustomerGender } from "../lib/types";
import { useAuth } from "../context/AuthContext";
import { Card, Input, Button, ErrorText, SuccessText, Label, FormGroup, Dropdown, DatePicker, HelpHint, Badge, Modal, ActionMenu, TabToggle } from "../components/ui";
import { CityPicker } from "../components/CityPicker";
import LoyaltyAdjustModal from "../components/LoyaltyAdjustModal";
import StoreCreditRefundModal from "../components/StoreCreditRefundModal";
import StoreCreditGrantModal from "../components/StoreCreditGrantModal";
import { downloadBalanceSlip } from "../lib/balanceSlip";
import { whatsappMessageLink, loyaltyPointsMessage } from "../lib/whatsapp";
import { normalizePhone, phoneError, whatsappNumber } from "../lib/phone";
import PhoneInput from "../components/PhoneInput";
import CustomerOrderHistoryPage from "./CustomerOrderHistoryPage";
import CustomerPaymentHistoryPage from "./CustomerPaymentHistoryPage";
import CustomerLoyaltyHistoryPage from "./CustomerLoyaltyHistoryPage";

function whatsappLink(phone: string): string {
  return `https://wa.me/${whatsappNumber(phone)}`;
}

function paymentReceiptMessage(name: string, amount: number, remainingBalance: number, fromStoreCredit = false): string {
  if (fromStoreCredit) {
    return remainingBalance <= 0
      ? `Hi ${name}, we've used Rs. ${amount.toLocaleString()} of your M&M Clothing store credit toward your account — it's now fully settled. Thank you so much, and see you again soon.`
      : `Hi ${name}, we've used Rs. ${amount.toLocaleString()} of your M&M Clothing store credit toward your account. Your balance now stands at Rs. ${remainingBalance.toLocaleString()}. Thank you!`;
  }
  if (remainingBalance <= 0) {
    return `Hi ${name}, we've received your payment of Rs. ${amount.toLocaleString()} — your account with M&M Clothing is now fully settled. Thank you so much for your trust, and see you again soon.`;
  }
  return `Hi ${name}, thank you for your payment of Rs. ${amount.toLocaleString()}. Your M&M Clothing balance now stands at Rs. ${remainingBalance.toLocaleString()}. Whenever it's convenient, feel free to settle the rest — no rush at all. We really appreciate you.`;
}

type PaymentMethod = "cash" | "bank_transfer" | "cheque" | "other";

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function isPastDate(yyyymmdd: string): boolean {
  if (!yyyymmdd) return false;
  const parsed = new Date(yyyymmdd + "T00:00:00");
  if (isNaN(parsed.getTime())) return false;
  return parsed.getTime() < startOfToday().getTime();
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function PaymentPreviewPane({
  amount,
  loading,
  preview,
  currentBalance,
}: {
  amount: number;
  loading: boolean;
  preview: {
    allocations: { sale_id: number; invoice: string; date: string; owed_before: number; applied: number; new_status: string }[];
    unapplied: number;
  } | null;
  currentBalance: number;
}) {
  if (amount <= 0) {
    return (
      <p className="text-xs text-gray-400 leading-relaxed">
        Enter an amount to see how it covers the customer's oldest unpaid invoices.
      </p>
    );
  }
  if (loading) {
    return <p className="text-xs text-gray-400">Calculating...</p>;
  }
  if (!preview || preview.allocations.length === 0) {
    return <p className="text-xs text-gray-400">Nothing outstanding to apply against.</p>;
  }

  const totalApplied = preview.allocations.reduce((s, a) => s + a.applied, 0);
  const newBalance = Math.max(0, currentBalance - totalApplied);

  return (
    <div className="space-y-3">
      <div className="border border-gray-200 rounded-lg overflow-hidden bg-white divide-y divide-gray-100">
        {preview.allocations.map((a) => (
          <div key={a.sale_id} className="flex items-center justify-between px-3 py-2 text-xs">
            <span className="text-gray-700">{a.invoice}</span>
            <span className="tabular-nums text-gray-900">Rs. {a.applied.toLocaleString()}</span>
          </div>
        ))}
      </div>

      <div className="bg-white border border-gray-100 rounded-lg px-3 py-2 text-xs space-y-1">
        {newBalance > 0 ? (
          <div className="flex justify-between">
            <span className="text-gray-500">New balance</span>
            <span className="font-medium text-gray-900 tabular-nums">
              Rs. {newBalance.toLocaleString()}
            </span>
          </div>
        ) : (
          <div className="flex justify-between">
            <span className="text-gray-500">New balance</span>
            <span className="font-medium text-green-700">Fully settled</span>
          </div>
        )}
        {preview.unapplied > 0 && (
          <div className="flex justify-between">
            <span className="text-gray-500">Left as credit</span>
            <span className="font-medium text-gray-900 tabular-nums">
              Rs. {preview.unapplied.toLocaleString()}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

type ProfileTab = "orders" | "payments" | "points" | "details";
const TABS: { key: ProfileTab; label: string }[] = [
  { key: "orders", label: "Orders" },
  { key: "payments", label: "Payments" },
  { key: "points", label: "Points" },
  { key: "details", label: "Details" },
];

// One customer on a page of their own: who they are and what they owe at the top, what you can do for them in the header,
// and their orders, payments, points and contact details underneath.
export default function CustomerProfilePage() {
  const { id } = useParams<{ id: string }>();
  const customerId = Number(id);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped whenever money or points move, so the tab being looked at reads again.
  const [reloadKey, setReloadKey] = useState(0);
  const [refundCreditFor, setRefundCreditFor] = useState<Customer | null>(null);
  const [addCreditFor, setAddCreditFor] = useState<Customer | null>(null);
  const [creditBreakdown, setCreditBreakdown] = useState<{ amount: number; reason: string; expires_at: string | null }[]>([]);
  const [slippingBalance, setSlippingBalance] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<{ name: string; phone: string; phone2: string; gender: CustomerGender }>({
    name: "",
    phone: "",
    phone2: "",
    gender: "unspecified",
  });
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

  const [payingCustomer, setPayingCustomer] = useState<Customer | null>(null);
  const [paymentStep, setPaymentStep] = useState<1 | 2>(1);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [paymentAmount, setPaymentAmount] = useState("");
  // Under "Other": settle out of the customer's store credit instead of
  // taking money — see the payment endpoint.
  const [deductFromCredit, setDeductFromCredit] = useState(false);
  const [chequeNumber, setChequeNumber] = useState("");
  const [chequeBankName, setChequeBankName] = useState("");
  const [chequeBranch, setChequeBranch] = useState("");
  const [chequeIsCrossed, setChequeIsCrossed] = useState(true);
  // A customer's cheque could be made out to Cash just as easily as to
  // the business by name — default to Cash, not a forced name.
  const [chequePayCash, setChequePayCash] = useState(true);
  const [chequePayeeName, setChequePayeeName] = useState("");
  const [chequeAmount, setChequeAmount] = useState("");
  const [chequeDate, setChequeDate] = useState("");
  const [chequeListError, setChequeListError] = useState<string | null>(null);
  const [chequeList, setChequeList] = useState<{
    cheque_number: string;
    bank_name: string;
    branch: string;
    is_crossed: boolean;
    payee_name: string;
    amount: number;
    cheque_date: string;
    received_date: string;
  }[]>([]);
  const chequeListTotal = chequeList.reduce((sum, c) => sum + c.amount, 0);
  const [paymentNotes, setPaymentNotes] = useState("");
  const [paymentPreview, setPaymentPreview] = useState<{
    allocations: { sale_id: number; invoice: string; date: string; owed_before: number; applied: number; new_status: string }[];
    unapplied: number;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const [receiptAfterPayment, setReceiptAfterPayment] = useState<{ name: string; phone: string | null; message: string } | null>(null);

  const [suspendTarget, setSuspendTarget] = useState<Customer | null>(null);
  const [suspendReason, setSuspendReason] = useState("");
  const [suspendError, setSuspendError] = useState<string | null>(null);
  const [suspendSubmitting, setSuspendSubmitting] = useState(false);

  const [redeemTarget, setRedeemTarget] = useState<Customer | null>(null);
  // The customer whose points are being reduced / who is being stopped from earning (admin only).
  const [loyaltyTarget, setLoyaltyTarget] = useState<Customer | null>(null);
  const [redeemPoints, setRedeemPoints] = useState("");
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeemSubmitting, setRedeemSubmitting] = useState(false);

  const [reactivateTarget, setReactivateTarget] = useState<Customer | null>(null);
  const [reactivateReason, setReactivateReason] = useState("");
  const [reactivateError, setReactivateError] = useState<string | null>(null);
  const [reactivateSubmitting, setReactivateSubmitting] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null);
  const [deleteWarning, setDeleteWarning] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  const [editingAddressId, setEditingAddressId] = useState<number | null>(null);
  const [editAddr, setEditAddr] = useState({ address_line1: "", address_line2: "", city: "" });
  const [editAddrError, setEditAddrError] = useState<string | null>(null);

  const tabParam = searchParams.get("tab");
  const tab: ProfileTab = TABS.some((t) => t.key === tabParam) ? (tabParam as ProfileTab) : "orders";
  function setTab(next: ProfileTab) {
    setSearchParams(next === "orders" ? {} : { tab: next }, { replace: true });
  }

  async function refresh() {
    const full = await api.get<Customer>(`/customers/${customerId}`);
    setCustomer(full);
    if (full.store_credit_balance > 0) {
      setCreditBreakdown(await api.get<{ amount: number; reason: string; expires_at: string | null }[]>(`/customers/${customerId}/credit-breakdown`));
    } else {
      setCreditBreakdown([]);
    }
    setReloadKey((k) => k + 1);
    return full;
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    refresh()
      .then((full) => {
        if (!cancelled) setEditForm({ name: full.name, phone: full.phone ?? "", phone2: full.phone2 ?? "", gender: full.gender });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiRequestError ? err.message : "Couldn't load this customer");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  useEffect(() => {
    const previewAmount = paymentMethod === "cheque" ? chequeListTotal : parseFloat(paymentAmount) || 0;
    if (!payingCustomer || paymentStep !== 2 || previewAmount <= 0) {
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
  }, [paymentAmount, paymentMethod, chequeListTotal, payingCustomer, paymentStep]);

  function openPayment(c: Customer) {
    setPayingCustomer(c);
    setPaymentStep(1);
    setPaymentMethod("cash");
    setPaymentAmount("");
    setDeductFromCredit(false);
    setPaymentNotes("");
    setPaymentPreview(null);
    setPaymentError(null);
    setChequeNumber("");
    setChequeBankName("");
    setChequePayeeName("");
    setChequeAmount("");
    setChequeDate("");
    setChequeListError(null);
    setChequeList([]);
  }

  function chooseMethod(m: PaymentMethod) {
    setPaymentMethod(m);
    setDeductFromCredit(false);
    setPaymentStep(2);
  }

  function addCheque() {
    setChequeListError(null);

    const amt = parseFloat(chequeAmount);

    if (!chequeNumber.trim()) {
      setChequeListError("Cheque number is required");
      return;
    }
    if (!chequeBankName.trim()) {
      setChequeListError("Bank name is required");
      return;
    }
    if (!chequePayCash && !chequePayeeName.trim()) {
      setChequeListError("Enter who the cheque is payable to, or switch back to Cash");
      return;
    }
    if (!amt || amt <= 0) {
      setChequeListError("Enter a valid amount greater than 0");
      return;
    }
    if (!chequeDate) {
      setChequeListError("Cheque date is required");
      return;
    }
    if (isPastDate(chequeDate)) {
      setChequeListError("Cheque date cannot be in the past");
      return;
    }

    setChequeList((list) => [
      ...list,
      {
        cheque_number: chequeNumber.trim(),
        bank_name: chequeBankName.trim(),
        branch: chequeBranch.trim(),
        is_crossed: chequeIsCrossed,
        payee_name: chequePayCash ? "" : chequePayeeName.trim(),
        amount: amt,
        cheque_date: chequeDate,
        received_date: todayIso(),
      },
    ]);

    setChequeNumber("");
    setChequeBankName("");
    setChequeBranch("");
    setChequeIsCrossed(true);
    setChequePayCash(true);
    setChequePayeeName("");
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
    const usingCredit = paymentMethod === "other" && deductFromCredit;
    if (usingCredit && amount > payingCustomer.store_credit_balance) {
      setPaymentError(`Only Rs. ${payingCustomer.store_credit_balance.toLocaleString()} of store credit is available.`);
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
          deduct_from_store_credit: paymentMethod === "other" && deductFromCredit ? true : undefined,
          cheques:
            paymentMethod === "cheque"
              ? chequeList.map((c) => ({
                  cheque_number: c.cheque_number,
                  bank_name: c.bank_name,
                  branch: c.branch || undefined,
                  is_crossed: c.is_crossed,
                  payee_name: c.payee_name,
                  amount: c.amount,
                  cheque_date: c.cheque_date,
                  received_date: c.received_date,
                }))
              : undefined,
        }
      );

      const remainingBalance = result.customer.balance_due;
      const message = paymentReceiptMessage(payingCustomer.name, amount, remainingBalance, usingCredit);
      setReceiptAfterPayment({ name: payingCustomer.name, phone: payingCustomer.phone, message });

      setPayingCustomer(null);
      setPaymentStep(1);
      setChequeNumber("");
      setChequeBankName("");
      setChequePayeeName("");
      setChequeAmount("");
      setChequeDate("");
      setChequeList([]);
      refresh();
    } catch (err) {
      setPaymentError(err instanceof ApiRequestError ? err.message : "Failed to record this payment");
    } finally {
      setPaymentSubmitting(false);
    }
  }

  function cancelEdit() {
    if (!customer) return;
    setIsEditing(false);
    setEditForm({
      name: customer.name,
      phone: customer.phone ?? "",
      phone2: customer.phone2 ?? "",
      gender: customer.gender,
    });
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
      refresh();
    } catch (err) {
      setSuspendError(err instanceof ApiRequestError ? err.message : "Failed to suspend this customer");
    } finally {
      setSuspendSubmitting(false);
    }
  }

  function openRedeem(c: Customer) {
    setRedeemTarget(c);
    setRedeemPoints(String(c.loyalty_points));
    setRedeemError(null);
  }

  async function handleRedeem() {
    if (!redeemTarget) return;
    setRedeemError(null);
    const points = parseInt(redeemPoints, 10);
    if (!points || points <= 0) {
      setRedeemError("Enter how many points to redeem");
      return;
    }
    if (points > redeemTarget.loyalty_points) {
      setRedeemError(`Only ${redeemTarget.loyalty_points} points are available`);
      return;
    }
    setRedeemSubmitting(true);
    try {
      await api.post(`/customers/${redeemTarget.id}/redeem-loyalty-points`, { points });
      setRedeemTarget(null);
      setRedeemPoints("");
      refresh();
    } catch (err) {
      setRedeemError(err instanceof ApiRequestError ? err.message : "Failed to redeem points");
    } finally {
      setRedeemSubmitting(false);
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
      refresh();
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
      navigate("/customers", { replace: true });
    } catch (err) {
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
    const badPhone = phoneError(editForm.phone) ?? phoneError(editForm.phone2);
    if (badPhone) {
      setEditError(badPhone);
      return;
    }
    try {
      await api.put(`/customers/${id}`, {
        name: editForm.name.trim(),
        phone: normalizePhone(editForm.phone) || undefined,
        phone2: normalizePhone(editForm.phone2) || undefined,
        gender: editForm.gender,
      });
      setEditSuccess("Saved.");
      setIsEditing(false);
      refresh();
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
      refresh();
    } catch (err) {
      setAddrError(err instanceof ApiRequestError ? err.message : "Failed to add address");
    }
  }

  async function makeDefault(customerId: number, address: CustomerAddress) {
    try {
      await api.put(`/customers/${customerId}/addresses/${address.id}`, { is_default: true });
      refresh();
    } catch {}
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
      refresh();
    } catch (err) {
      setEditAddrError(err instanceof ApiRequestError ? err.message : "Failed to update address");
    }
  }

  async function deleteAddress(customerId: number, addressId: number) {
    if (!confirm("Delete this address?")) return;
    try {
      await api.delete(`/customers/${customerId}/addresses/${addressId}`);
      refresh();
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
      refresh();
    } catch (err) {
      setBankAccountError(err instanceof ApiRequestError ? err.message : "Failed to add bank account");
    }
  }

  async function makeBankAccountDefault(customerId: number, account: BankAccount) {
    try {
      await api.put(`/customers/${customerId}/bank-accounts/${account.id}`, { is_default: true });
      refresh();
    } catch {}
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
      refresh();
    } catch (err) {
      setEditBankAccountError(err instanceof ApiRequestError ? err.message : "Failed to update bank account");
    }
  }

  async function deleteBankAccount(customerId: number, accountId: number) {
    if (!confirm("Delete this bank account?")) return;
    try {
      await api.delete(`/customers/${customerId}/bank-accounts/${accountId}`);
      refresh();
    } catch (err) {
      setEditBankAccountError(err instanceof ApiRequestError ? err.message : "Failed to delete bank account");
    }
  }

  const initials = (customer?.name ?? "?")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div>
      <button onClick={() => navigate(-1)} className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-3">
        <ArrowLeft size={14} />
        Back
      </button>

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <PageLoader />
      ) : !customer ? null : (
        <>
          {/* ================= Header: who they are, and what you can do ================= */}
          <Card className="mb-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border border-gray-200 bg-gray-50 text-base font-semibold text-gray-700">
                {initials}
              </div>
              <div className="min-w-0">
                <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight text-gray-900">
                  {customer.name}
                  {customer.is_suspended === 1 && <Badge label="Suspended" tone="danger" />}
                </h1>
                <p className="text-sm text-gray-500">
                  {customer.customer_code}
                  {customer.phone ? ` · ${customer.phone}` : ""}
                  {customer.phone2 ? ` · ${customer.phone2}` : ""}
                </p>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {customer.balance_due > 0 && (
                  <Button variant="primary" onClick={() => openPayment(customer)} className="inline-flex items-center gap-1.5">
                    <Wallet size={14} />
                    Record payment
                  </Button>
                )}
                {customer.phone && (
                  <a
                    href={whatsappLink(customer.phone)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-green-600 transition hover:bg-gray-50"
                  >
                    <MessageCircle size={14} />
                    WhatsApp
                  </a>
                )}
                <ActionMenu
                  items={[
                    { group: "Points", label: "Points history", icon: <Star size={14} />, onClick: () => setTab("points") },
                    ...(customer.loyalty_points >= 500 ? [{ group: "Points", label: "Redeem points", icon: <Star size={14} />, onClick: () => openRedeem(customer) }] : []),
                    ...(customer.phone
                      ? [
                          {
                            group: "Points",
                            label: "Send points on WhatsApp",
                            icon: <MessageCircle size={14} />,
                            // Opens WhatsApp with their points balance typed in, ready to send.
                            onClick: () => window.open(whatsappMessageLink(customer.phone!, loyaltyPointsMessage(customer.name, customer.loyalty_points)), "_blank", "noopener,noreferrer"),
                          },
                        ]
                      : []),
                    ...(isAdmin ? [{ group: "Points", label: "Adjust points", icon: <Pencil size={14} />, onClick: () => setLoyaltyTarget(customer) }] : []),
                    ...(isAdmin ? [{ group: "Store credit", label: "Add store credit", icon: <Plus size={14} />, onClick: () => setAddCreditFor(customer) }] : []),
                    ...(isAdmin && customer.store_credit_balance > 0
                      ? [{ group: "Store credit", label: "Refund store credit", icon: <Wallet size={14} />, onClick: () => setRefundCreditFor(customer) }]
                      : []),
                    {
                      // Quick slip: what they owe right now, with our bank details.
                      group: "Other",
                      label: slippingBalance ? "Preparing..." : "Balance slip",
                      icon: <FileText size={14} />,
                      onClick: async () => {
                        if (slippingBalance) return;
                        setSlippingBalance(true);
                        setError(null);
                        try {
                          await downloadBalanceSlip(customer.id);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Couldn't create the balance slip");
                        } finally {
                          setSlippingBalance(false);
                        }
                      },
                    },
                    ...(isAdmin
                      ? [
                          customer.is_suspended === 1
                            ? {
                                group: "Other",
                                label: "Reactivate customer",
                                icon: <UserCheck size={14} />,
                                onClick: () => {
                                  setReactivateTarget(customer);
                                  setReactivateReason("");
                                  setReactivateError(null);
                                },
                              }
                            : {
                                group: "Other",
                                label: "Suspend customer",
                                icon: <UserX size={14} />,
                                onClick: () => {
                                  setSuspendTarget(customer);
                                  setSuspendReason("");
                                  setSuspendError(null);
                                },
                              },
                          { group: "Other", label: "Delete customer", icon: <Trash2 size={14} />, danger: true, onClick: () => openDelete(customer) },
                        ]
                      : []),
                  ]}
                />
              </div>
            </div>

            {customer.is_suspended === 1 && (
              <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-red-500" />
                <div className="text-xs text-red-700">
                  <p className="font-medium">Suspended</p>
                  {customer.suspended_reason && <p className="mt-0.5">{customer.suspended_reason}</p>}
                  {customer.suspended_at && <p className="mt-0.5 text-red-500">Since {customer.suspended_at.slice(0, 10)}</p>}
                </div>
              </div>
            )}
          </Card>

          {/* ================= The four numbers ================= */}
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-400">Balance due</p>
              <p className={`mt-0.5 text-lg font-semibold tabular-nums ${customer.balance_due > 0 ? "text-red-600" : "text-gray-900"}`}>
                {customer.balance_due > 0 ? `Rs. ${customer.balance_due.toLocaleString()}` : "Settled"}
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-400">Loyalty points</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900">{customer.loyalty_points}</p>
              {customer.loyalty_blocked === 1 && (
                <p className="mt-0.5 text-xs text-gray-500">
                  Doesn't earn points{customer.loyalty_block_reason ? ` — ${customer.loyalty_block_reason}` : ""}
                </p>
              )}
            </div>
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-400">Store credit</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900">
                {customer.store_credit_balance > 0 ? `Rs. ${customer.store_credit_balance.toLocaleString()}` : "—"}
              </p>
              {customer.store_credit_balance > 0 && creditBreakdown.length > 0 && (
                <div className="mt-1 space-y-1">
                  {creditBreakdown.map((g, i) => {
                    const daysLeft = g.expires_at ? Math.ceil((new Date(g.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;
                    const urgent = daysLeft !== null && daysLeft <= 14;
                    return (
                      <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-xs text-gray-500">+ Rs. {g.amount.toLocaleString()}</span>
                        {g.expires_at && (
                          <Badge
                            label={`${new Date(g.expires_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}${daysLeft !== null ? ` · ${daysLeft}d left` : ""}`}
                            tone={urgent ? "danger" : "neutral"}
                          />
                        )}
                        {!g.expires_at && g.reason && <Badge label={g.reason} tone="neutral" />}
                      </div>
                    );
                  })}
                  <p className="text-xs text-gray-400">Applied automatically at checkout</p>
                </div>
              )}
            </div>
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-400">Last order</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900">{customer.last_order_date ? customer.last_order_date.slice(0, 10) : "No orders yet"}</p>
            </div>
          </div>

          {/* ================= Orders / Payments / Points / Details ================= */}
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

          {tab === "orders" && <CustomerOrderHistoryPage key={reloadKey} customerId={customer.id} />}
          {tab === "payments" && <CustomerPaymentHistoryPage key={reloadKey} customerId={customer.id} />}
          {tab === "points" && <CustomerLoyaltyHistoryPage key={reloadKey} customerId={customer.id} />}
          {tab === "details" && (
            <div className="space-y-4">
                            {(
                              <div className="bg-white border border-gray-200 rounded-xl p-4">
                                <div className="flex items-center justify-between mb-3">
                                  <h3 className="text-sm font-semibold text-gray-900">Contact details</h3>
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
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                      <FormGroup>
                                        <Label>Name</Label>
                                        <Input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
                                      </FormGroup>
                                      <FormGroup>
                                        <Label>Phone</Label>
                                        <PhoneInput value={editForm.phone} onChange={(v) => setEditForm((f) => ({ ...f, phone: v }))} />
                                      </FormGroup>
                                      <FormGroup>
                                        <Label>Phone 2</Label>
                                        <PhoneInput value={editForm.phone2} onChange={(v) => setEditForm((f) => ({ ...f, phone2: v }))} />
                                      </FormGroup>
                                      <FormGroup>
                                        <Label>Gender</Label>
                                        <Dropdown
                                          value={editForm.gender}
                                          onChange={(v) => setEditForm((f) => ({ ...f, gender: v as CustomerGender }))}
                                          options={[
                                            { value: "unspecified", label: "Unspecified" },
                                            { value: "male", label: "Male" },
                                            { value: "female", label: "Female" },
                                          ]}
                                        />
                                      </FormGroup>
                                    </div>
                                    {editError && <ErrorText>{editError}</ErrorText>}
                                    {editSuccess && <SuccessText>{editSuccess}</SuccessText>}
                                    <div className="flex justify-end gap-2 mt-3">
                                      <Button size="sm" onClick={cancelEdit}>
                                        Cancel
                                      </Button>
                                      <Button size="sm" variant="primary" onClick={() => saveEdit(customer.id)}>
                                        Save
                                      </Button>
                                    </div>
                                  </>
                                ) : (
                                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                                    <div>
                                      <p className="text-xs text-gray-400">Name</p>
                                      <p className="text-gray-900">{customer.name}</p>
                                    </div>
                                    <div>
                                      <p className="text-xs text-gray-400">Phone</p>
                                      <p className="text-gray-900">{customer.phone ?? "—"}</p>
                                    </div>
                                    <div>
                                      <p className="text-xs text-gray-400">Phone 2</p>
                                      <p className="text-gray-900">{customer.phone2 ?? "—"}</p>
                                    </div>
                                    <div>
                                      <p className="text-xs text-gray-400">Gender</p>
                                      <p className="text-gray-900 capitalize">{customer.gender}</p>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                            {(
                              <div className="bg-white border border-gray-200 rounded-xl p-4">
                                <div className="flex items-center justify-between mb-3">
                                  <h3 className="text-sm font-semibold text-gray-900">Saved addresses</h3>
                                  {!showAddAddress && (
                                    <button
                                      onClick={() => setShowAddAddress(true)}
                                      className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100"
                                    >
                                      <Plus size={12} />
                                      Add address
                                    </button>
                                  )}
                                </div>

                                {(!customer.addresses || customer.addresses.length === 0) && !showAddAddress ? (
                                  <p className="text-xs text-gray-400">No saved addresses.</p>
                                ) : (
                                  <div className="space-y-2">
                                    {customer.addresses?.map((a) =>
                                      editingAddressId === a.id ? (
                                        <div key={a.id} className="bg-gray-50 border border-gray-200 rounded-xl p-3">
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
                                          <div className="flex justify-end gap-2 mt-3">
                                            <Button size="sm" onClick={cancelEditAddress}>
                                              Cancel
                                            </Button>
                                            <Button size="sm" variant="primary" onClick={() => saveEditAddress(customer.id, a.id)}>
                                              Save
                                            </Button>
                                          </div>
                                        </div>
                                      ) : (
                                        <div key={a.id} className="flex items-center justify-between bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 text-sm">
                                          <span className="text-gray-700">
                                            {[a.address_line1, a.address_line2, a.city].filter(Boolean).join(", ") || "—"}
                                          </span>
                                          <div className="flex items-center gap-3 flex-shrink-0">
                                            {a.is_default ? (
                                              <span className="text-xs text-green-600 font-medium">Default</span>
                                            ) : (
                                              <button onClick={() => makeDefault(customer.id, a)} className="text-xs text-gray-400 hover:text-gray-700">
                                                Make default
                                              </button>
                                            )}
                                            <button onClick={() => startEditAddress(a)} className="text-xs text-gray-400 hover:text-gray-700">
                                              Edit
                                            </button>
                                            <button onClick={() => deleteAddress(customer.id, a.id)} className="text-xs text-red-400 hover:text-red-600">
                                              Delete
                                            </button>
                                          </div>
                                        </div>
                                      )
                                    )}
                                  </div>
                                )}

                                {showAddAddress && (
                                  <div className="mt-3 bg-gray-50 border border-gray-200 rounded-xl p-3">
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
                                    <div className="flex justify-end gap-2 mt-3">
                                      <Button size="sm" onClick={() => setShowAddAddress(false)}>
                                        Cancel
                                      </Button>
                                      <Button size="sm" variant="primary" onClick={() => addAddress(customer.id)}>
                                        Save address
                                      </Button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                            {(
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

                                {(!customer.bank_accounts || customer.bank_accounts.length === 0) && !showAddBankAccount ? (
                                  <p className="text-xs text-gray-400">
                                    No bank accounts on file — needed for a bank-transfer refund or payment.
                                  </p>
                                ) : (
                                  <div className="space-y-2">
                                    {customer.bank_accounts?.map((a) =>
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
                                            <Button size="sm" variant="primary" onClick={() => saveEditBankAccount(customer.id, a.id)}>
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
                                                onClick={() => makeBankAccountDefault(customer.id, a)}
                                                className="text-xs text-gray-400 hover:text-gray-700"
                                              >
                                                Make default
                                              </button>
                                            )}
                                            <button onClick={() => startEditBankAccount(a)} className="text-xs text-gray-400 hover:text-gray-700">
                                              Edit
                                            </button>
                                            <button onClick={() => deleteBankAccount(customer.id, a.id)} className="text-xs text-red-400 hover:text-red-600">
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
                                      <Button size="sm" variant="primary" onClick={() => addBankAccount(customer.id)}>
                                        Save account
                                      </Button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
            </div>
          )}

      {/* ================= RECORD PAYMENT WIZARD ================= */}
      {payingCustomer && (
        <Modal
          size="2xl"
          height="h-[min(640px,calc(100dvh-2rem))]"
          flush
          onClose={() => setPayingCustomer(null)}
          title={
            <span className="inline-flex items-center gap-3">
              {paymentStep === 2 && (
                <button
                  type="button"
                  onClick={() => setPaymentStep(1)}
                  className="text-gray-400 hover:text-gray-700 flex-shrink-0"
                  title="Back to method"
                >
                  <ArrowLeft size={18} />
                </button>
              )}
              {paymentStep === 1 ? "Record payment" : "Payment details"}
            </span>
          }
          subtitle={
            <>
              {payingCustomer.name} · owes{" "}
              <span className="text-gray-600 font-medium">Rs. {payingCustomer.balance_due.toLocaleString()}</span>
            </>
          }
          footer={
            <>
              <Button onClick={() => setPayingCustomer(null)}>Cancel</Button>
              {paymentStep === 2 && (
                <Button variant="primary" onClick={handleRecordPayment} disabled={paymentSubmitting}>
                  {paymentSubmitting ? "Recording..." : paymentMethod === "other" && deductFromCredit ? "Deduct from store credit" : "Confirm payment"}
                </Button>
              )}
            </>
          }
        >
<div className="h-full overflow-hidden">
              {paymentStep === 1 ? (
                <div className="h-full flex flex-col items-center justify-center px-6">
                  <p className="text-sm text-gray-700 mb-5">How was this payment made?</p>
                  <div className="grid grid-cols-4 gap-4 w-full max-w-2xl">
                    <button
                      onClick={() => chooseMethod("cash")}
                      className="flex flex-col items-center justify-center gap-2 py-6 rounded-xl border border-gray-200 hover:border-gray-900 hover:bg-gray-50 transition"
                    >
                      <Wallet size={24} className="text-gray-700" />
                      <span className="text-sm font-medium text-gray-900">Cash</span>
                    </button>
                    <button
                      onClick={() => chooseMethod("bank_transfer")}
                      className="flex flex-col items-center justify-center gap-2 py-6 rounded-xl border border-gray-200 hover:border-gray-900 hover:bg-gray-50 transition"
                    >
                      <Building2 size={24} className="text-gray-700" />
                      <span className="text-sm font-medium text-gray-900">Bank transfer</span>
                    </button>
                    <button
                      onClick={() => chooseMethod("cheque")}
                      className="flex flex-col items-center justify-center gap-2 py-6 rounded-xl border border-gray-200 hover:border-gray-900 hover:bg-gray-50 transition"
                    >
                      <FileText size={24} className="text-gray-700" />
                      <span className="text-sm font-medium text-gray-900">Cheque</span>
                    </button>
                    <button
                      onClick={() => chooseMethod("other")}
                      className="flex flex-col items-center justify-center gap-2 py-6 rounded-xl border border-gray-200 hover:border-gray-900 hover:bg-gray-50 transition"
                    >
                      <MoreHorizontal size={24} className="text-gray-700" />
                      <span className="text-sm font-medium text-gray-900">Other</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-5 h-full">
                  <div className="col-span-3 px-6 py-5 space-y-4 border-r border-gray-100 overflow-y-auto">
                    {paymentMethod !== "cheque" ? (
                      <>
                        {paymentMethod === "other" && (
                          <div
                            className={`rounded-lg border px-3.5 py-3 ${
                              "bg-gray-50 border-gray-200"
                            }`}
                          >
                            <label
                              className={`flex items-center gap-2 text-sm ${
                                payingCustomer.store_credit_balance > 0 ? "text-gray-800 cursor-pointer" : "text-gray-400 cursor-not-allowed"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={deductFromCredit}
                                disabled={payingCustomer.store_credit_balance <= 0}
                                onChange={(e) => {
                                  setDeductFromCredit(e.target.checked);
                                  if (e.target.checked) {
                                    // Start at the most this can settle — all the credit, or
                                    // what they owe if that's less.
                                    setPaymentAmount(String(Math.min(payingCustomer.store_credit_balance, payingCustomer.balance_due)));
                                  }
                                }}
                                className="rounded"
                              />
                              Deduct from store credit
                            </label>
                            <p className={`text-xs mt-1 ${payingCustomer.store_credit_balance > 0 ? "text-gray-600" : "text-gray-400"}`}>
                              {payingCustomer.store_credit_balance > 0
                                ? `Rs. ${payingCustomer.store_credit_balance.toLocaleString()} store credit available — no money is taken; the credit is used up against what they owe.`
                                : "This customer has no store credit available."}
                            </p>
                          </div>
                        )}

                        <div>
                          <Label>{paymentMethod === "other" && deductFromCredit ? "Amount to deduct from store credit (Rs.)" : "Amount received (Rs.)"}</Label>
                          <input
                            type="number"
                            min="0"
                            value={paymentAmount}
                            onChange={(e) => setPaymentAmount(e.target.value)}
                            placeholder="0"
                            autoFocus
                            className="w-full mt-1 px-3 py-3 border border-gray-200 rounded-lg text-2xl font-medium tabular-nums focus:outline-none focus:border-gray-400"
                          />
                        </div>

                        <FormGroup>
                          <Label>Notes (optional)</Label>
                          <Input
                            value={paymentNotes}
                            onChange={(e) => setPaymentNotes(e.target.value)}
                          />
                        </FormGroup>
                      </>
                    ) : (
                      <>
                        <div className="flex items-baseline justify-between">
                          <h3 className="text-sm font-semibold text-gray-900">
                            Add cheque
                            <HelpHint text="Add one or more cheques received from this customer, in one combined payment." />
                          </h3>
                          <span className="text-[11px] text-gray-400">Clears later</span>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <Input
                            placeholder="Cheque number"
                            value={chequeNumber}
                            onChange={(e) => setChequeNumber(e.target.value)}
                          />
                          <Input
                            placeholder="Bank name"
                            value={chequeBankName}
                            onChange={(e) => setChequeBankName(e.target.value)}
                          />
                          <Input
                            placeholder="Branch (optional)"
                            value={chequeBranch}
                            onChange={(e) => setChequeBranch(e.target.value)}
                          />
                          <DatePicker
                            value={chequeDate || null}
                            onChange={setChequeDate}
                            placeholder="Cheque date"
                          />
                          <Input
                            type="number"
                            min="0"
                            placeholder="Amount"
                            value={chequeAmount}
                            onChange={(e) => setChequeAmount(e.target.value)}
                          />
                          <label className="flex items-center gap-1.5 text-xs text-gray-600 self-center pl-1">
                            <input
                              type="checkbox"
                              checked={chequeIsCrossed}
                              onChange={(e) => setChequeIsCrossed(e.target.checked)}
                              className="rounded border-gray-300"
                            />
                            Crossed cheque
                          </label>
                          <div className="col-span-2">
                            <Label>Payable to</Label>
                            <TabToggle
                              value={chequePayCash ? "cash" : "name"}
                              onChange={(v) => setChequePayCash(v === "cash")}
                              options={[
                                { value: "cash", label: "Cash" },
                                { value: "name", label: "A specific name" },
                              ]}
                            />
                          </div>
                          <div className="col-span-2">
                            <Input
                              placeholder="Who the cheque is made out to"
                              value={chequePayeeName}
                              onChange={(e) => setChequePayeeName(e.target.value)}
                              disabled={chequePayCash}
                              className={chequePayCash ? "opacity-40 cursor-not-allowed" : ""}
                            />
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={addCheque}
                          className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg border border-dashed border-gray-300 text-sm font-medium text-gray-600 hover:border-gray-900 hover:text-gray-900 hover:bg-gray-50 transition"
                        >
                          <Plus size={14} />
                          Add cheque to list
                        </button>

                        {chequeListError && <ErrorText>{chequeListError}</ErrorText>}

                        <FormGroup>
                          <Label>Notes (optional)</Label>
                          <Input
                            value={paymentNotes}
                            onChange={(e) => setPaymentNotes(e.target.value)}
                          />
                        </FormGroup>
                      </>
                    )}

                    {paymentError && <ErrorText>{paymentError}</ErrorText>}
                  </div>

                  <div className="col-span-2 px-5 py-5 bg-gray-50/50 overflow-y-auto space-y-4">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 mb-3">Will apply to</h3>
                      <PaymentPreviewPane
                        amount={paymentMethod === "cheque" ? chequeListTotal : parseFloat(paymentAmount) || 0}
                        loading={previewLoading}
                        preview={paymentPreview}
                        currentBalance={payingCustomer.balance_due}
                      />
                    </div>

                    {paymentMethod === "cheque" && (
                      <div className="border border-gray-200 rounded-lg bg-white flex flex-col">
                        <div className="flex items-baseline justify-between px-3 py-2 border-b border-gray-200">
                          <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                            Cheques ({chequeList.length})
                          </p>
                          {chequeList.length > 0 && (
                            <p className="text-[11px] text-gray-500">
                              Total <span className="text-gray-900 font-semibold tabular-nums">Rs. {chequeListTotal.toLocaleString()}</span>
                            </p>
                          )}
                        </div>

                        <div className="px-2 py-2 space-y-2 max-h-[240px] overflow-y-auto">
                          {chequeList.length === 0 ? (
                            <p className="text-xs text-gray-400 px-1 py-2 leading-relaxed">
                              No cheques yet. Fill the fields on the left and click "Add cheque to list".
                            </p>
                          ) : (
                            chequeList.map((c, i) => (
                              <div
                                key={i}
                                className="bg-white rounded-lg border border-gray-200 px-3 py-2.5 hover:border-gray-300 transition"
                              >
                                <div className="flex items-baseline justify-between gap-3">
                                  <p className="text-sm font-medium text-gray-900 truncate">
                                    {c.payee_name}
                                  </p>
                                  <p className="text-sm font-semibold text-gray-900 tabular-nums flex-shrink-0">
                                    {c.amount.toLocaleString()}/-
                                  </p>
                                </div>

                                <div className="flex items-center justify-between gap-3 mt-1.5">
                                  <div className="flex items-center gap-2 text-[11px] text-gray-500 truncate min-w-0">
                                    <span className="truncate">#{c.cheque_number}</span>
                                    <span className="text-gray-300">·</span>
                                    <span className="truncate">{c.bank_name}</span>
                                    <span className="text-gray-300">·</span>
                                    <span className="tabular-nums">{c.cheque_date.slice(0, 10)}</span>
                                  </div>
                                  <button
                                    onClick={() => removeCheque(i)}
                                    className="text-[11px] text-gray-400 hover:text-red-500 flex-shrink-0"
                                  >
                                    Remove
                                  </button>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
        </Modal>
      )}

      {receiptAfterPayment && (
        <Modal
          size="md"
          onClose={() => setReceiptAfterPayment(null)}
          title="Payment recorded"
          footer={
            <>
              <Button onClick={() => setReceiptAfterPayment(null)}>Skip</Button>
              {receiptAfterPayment.phone && (
                <a
                  href={whatsappMessageLink(receiptAfterPayment.phone, receiptAfterPayment.message)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setReceiptAfterPayment(null)}
                  className="bg-black text-white rounded-xl px-4 py-2.5 text-sm font-medium hover:bg-gray-800 transition inline-flex items-center justify-center gap-1.5"
                >
                  <MessageCircle size={14} />
                  Open in WhatsApp
                </a>
              )}
            </>
          }
        >
              <p className="text-xs text-gray-400 mb-3">Send a receipt to {receiptAfterPayment.name}? Review it before sending.</p>
              <p className="text-sm text-gray-700 bg-gray-50 rounded-xl p-3 mb-4 whitespace-pre-wrap">{receiptAfterPayment.message}</p>
        </Modal>
      )}

      {refundCreditFor && (
        <StoreCreditRefundModal
          customer={refundCreditFor}
          onClose={() => setRefundCreditFor(null)}
          onDone={async () => {
            await refresh();
          }}
        />
      )}

      {addCreditFor && (
        <StoreCreditGrantModal
          customer={addCreditFor}
          onClose={() => setAddCreditFor(null)}
          onDone={async () => {
            await refresh();
          }}
        />
      )}

      {loyaltyTarget && (
        <LoyaltyAdjustModal
          customer={loyaltyTarget}
          onClose={() => setLoyaltyTarget(null)}
          onChanged={async () => {
            await refresh();
          }}
        />
      )}

      {redeemTarget && (
        <Modal
          size="md"
          onClose={() => setRedeemTarget(null)}
          title={`Redeem points — ${redeemTarget.name}`}
          subtitle="1 point = Rs. 1 of store credit. Redeemable now that this customer has reached the 500-point minimum."
          footer={
            <>
              <Button onClick={() => setRedeemTarget(null)}>Cancel</Button>
              <Button variant="primary" onClick={handleRedeem} disabled={redeemSubmitting}>
                {redeemSubmitting ? "Redeeming..." : "Redeem"}
              </Button>
            </>
          }
        >
              <p className="text-xs text-gray-400 mb-3">
                {redeemTarget.loyalty_points} points available — redeeming converts them to store credit.
              </p>
              <FormGroup>
                <Label>Points to redeem</Label>
                <Input
                  type="number"
                  value={redeemPoints}
                  onChange={(e) => setRedeemPoints(e.target.value)}
                  max={redeemTarget.loyalty_points}
                  min={1}
                />
              </FormGroup>
              {redeemPoints && !isNaN(parseInt(redeemPoints, 10)) && (
                <p className="text-xs text-gray-500 mb-2">
                  = Rs. {parseInt(redeemPoints, 10).toLocaleString()} store credit
                </p>
              )}
              {redeemError && <ErrorText>{redeemError}</ErrorText>}
        </Modal>
      )}

      {suspendTarget && (
        <Modal
          size="md"
          onClose={() => setSuspendTarget(null)}
          title={`Suspend ${suspendTarget.name}`}
          subtitle="They'll stay fully in the system — every sale, loyalty point, and credit is untouched — they just can't be selected for a new sale until reactivated."
          footer={
            <>
              <Button onClick={() => setSuspendTarget(null)}>Cancel</Button>
              <Button variant="primary" onClick={handleSuspend} disabled={suspendSubmitting}>
                {suspendSubmitting ? "Suspending..." : "Suspend"}
              </Button>
            </>
          }
        >
              <FormGroup>
                <Label>Reason</Label>
                <Input value={suspendReason} onChange={(e) => setSuspendReason(e.target.value)} />
              </FormGroup>
              {suspendError && <ErrorText>{suspendError}</ErrorText>}
        </Modal>
      )}

      {reactivateTarget && (
        <Modal
          size="md"
          onClose={() => setReactivateTarget(null)}
          title={`Reactivate ${reactivateTarget.name}`}
          footer={
            <>
              <Button onClick={() => setReactivateTarget(null)}>Cancel</Button>
              <Button variant="primary" onClick={handleReactivate} disabled={reactivateSubmitting}>
                {reactivateSubmitting ? "Reactivating..." : "Reactivate"}
              </Button>
            </>
          }
        >
              <FormGroup>
                <Label>Reason</Label>
                <Input
                  value={reactivateReason}
                  onChange={(e) => setReactivateReason(e.target.value)}
                />
              </FormGroup>
              {reactivateError && <ErrorText>{reactivateError}</ErrorText>}
        </Modal>
      )}

      {deleteTarget && (
        <Modal
          size="md"
          onClose={() => {
            setDeleteTarget(null);
            setDeleteWarning(null);
          }}
          title={`Delete ${deleteTarget.name}?`}
          footer={
            <>
              <Button
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteWarning(null);
                }}
              >
                Cancel
              </Button>
              <Button variant="danger" onClick={() => handleDelete(deleteWarning !== null)} disabled={deleteSubmitting}>
                {deleteSubmitting ? "Deleting..." : deleteWarning ? "Delete permanently anyway" : "Delete"}
              </Button>
            </>
          }
        >
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
        </Modal>
      )}
        </>
      )}
    </div>
  );
}
