import { useState, useEffect } from "react";
import { PageLoader } from "../components/Loader";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import {
  Landmark,
  ArrowLeft,
  Building2,
  FileText,
  Wallet,
  CreditCard,
  Download,
} from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { SupplierPayment, SupplierBalance, Supplier, Purchase, BankAccount } from "../lib/types";
import { downloadTabularReport, rangeLabelFor, buildReportFilename, todayLongDate } from "../lib/reportPdf";
import { Card, Input, Label, FormGroup, ErrorText, SuccessText, Button, Table, Th, Td, Dropdown, EmptyState, DateRangePicker, DatePicker, HelpHint, TabToggle, Modal, MoneyInput } from "../components/ui";
import { formatDate, formatDateTime } from "../lib/dates";

export default function SupplierPaymentsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [balances, setBalances] = useState<SupplierBalance[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Payment log — paginated, with an optional date range. Without a
  // range: 5 per page, the everyday "just the recent ones" view. With a
  // range picked: 50 per page, since a filtered range is already a
  // deliberate, bounded query rather than "show me everything ever."
  const [payments, setPayments] = useState<SupplierPayment[]>([]);
  const [paymentsTotal, setPaymentsTotal] = useState(0);
  const [paymentsPage, setPaymentsPage] = useState(1);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const paymentsPageSize = dateStart || dateEnd ? 50 : 5;
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const [showRecord, setShowRecord] = useState(false);
  const [paymentStep, setPaymentStep] = useState<1 | 2>(1);
  const [supplierId, setSupplierId] = useState("");
  // The bills this payment is for (none = a general payment). A cheque goes against one bill at most; cash, card and bank transfers
  // can cover several. `purchaseId` / `setPurchaseId` are the single-bill view of it, used by the cheque paths and the resets.
  const [pickedPurchases, setPickedPurchases] = useState<number[]>([]);
  const purchaseId = pickedPurchases.length === 1 ? String(pickedPurchases[0]) : "";
  const setPurchaseId = (v: string) => setPickedPurchases(v ? [Number(v)] : []);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // For a bank transfer, fetched fresh once a supplier is picked —
  // the plain supplier list doesn't carry bank accounts.
  const [supplierBankAccounts, setSupplierBankAccounts] = useState<BankAccount[]>([]);
  const [selectedBankAccountId, setSelectedBankAccountId] = useState("");

  // Pay a supplier by cheque — a LIST of one or more, mixing in-hand
  // (searched by number, same pattern as looking up a purchase/sale by
  // code elsewhere) and freshly-written own cheques freely. Each item
  // added here becomes its own independent record once submitted.
  const [chequeKind, setChequeKind] = useState<"in_hand" | "own">("in_hand");
  const [chequeSearchNumber, setChequeSearchNumber] = useState("");
  const [chequeSearchError, setChequeSearchError] = useState<string | null>(null);
  const [ownChequeNumber, setOwnChequeNumber] = useState("");
  const [ownChequeBankName, setOwnChequeBankName] = useState("");
  const [ownChequeBranch, setOwnChequeBranch] = useState("");
  const [ownChequeIsCrossed, setOwnChequeIsCrossed] = useState(true);
  // Most cheques we write are made out to "Cash", not the supplier by
  // name — defaults to that.
  const [ownChequePayCash, setOwnChequePayCash] = useState(true);
  const [ownChequePayeeName, setOwnChequePayeeName] = useState("");
  const [ownChequeAmount, setOwnChequeAmount] = useState("");
  const [ownChequeDate, setOwnChequeDate] = useState("");
  const [chequeList, setChequeList] = useState<
    (
      | { kind: "in_hand"; receipt: any }
      | {
          kind: "own";
          cheque_number: string;
          bank_name: string;
          branch: string;
          is_crossed: boolean;
          payee_name: string;
          amount: number;
          cheque_date: string;
        }
    )[]
  >([]);

  async function load() {
    setLoading(true);
    try {
      const [b, s, pur] = await Promise.all([
        api.get<SupplierBalance[]>("/supplier-payments/summary"),
        api.get<Supplier[]>("/suppliers"),
        api.get<Purchase[]>("/purchases"),
      ]);
      setBalances(b);
      setSuppliers(s);
      setPurchases(pur);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load supplier payments");
    } finally {
      setLoading(false);
    }
  }

  async function loadPayments() {
    setPaymentsLoading(true);
    try {
      const params = new URLSearchParams({ page: String(paymentsPage), pageSize: String(paymentsPageSize) });
      if (dateStart) params.set("start", dateStart);
      if (dateEnd) params.set("end", dateEnd);
      const result = await api.get<{ rows: SupplierPayment[]; total: number }>(`/supplier-payments?${params.toString()}`);
      setPayments(result.rows);
      setPaymentsTotal(result.total);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load the payment log");
    } finally {
      setPaymentsLoading(false);
    }
  }

  useEffect(() => {
    loadPayments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentsPage, dateStart, dateEnd]);

  const PAYMENTS_REPORT_CAP = 200;

  // Downloads the full filtered range, not just the current page — the
  // server caps a single page at 200 rows; if the range holds more, the
  // report says so rather than silently only covering the first 200.
  async function downloadPaymentsPdf() {
    setDownloadError(null);
    setDownloading(true);
    try {
      const params = new URLSearchParams({ page: "1", pageSize: String(PAYMENTS_REPORT_CAP) });
      if (dateStart) params.set("start", dateStart);
      if (dateEnd) params.set("end", dateEnd);
      const result = await api.get<{ rows: SupplierPayment[]; total: number }>(`/supplier-payments?${params.toString()}`);
      const truncated = result.total > result.rows.length;
      const totalPaid = result.rows.reduce((sum, p) => sum + p.amount, 0);
      const rangeLabel = rangeLabelFor(dateStart || null, dateEnd || null);

      downloadTabularReport({
        headerLabel: "M&M Clothing — Supplier Payments Report",
        headerFields: [
          { label: "Report", value: "Supplier Payments" },
          { label: "Period", value: rangeLabel },
          { label: "Generated", value: todayLongDate() },
        ],
        rangeLabel,
        columns: [
          { label: "Date", width: 90 },
          { label: "Supplier", width: 140 },
          { label: "Amount", width: 90, align: "right" },
          { label: "Method", width: 90 },
          { label: "Notes", width: 105 },
        ],
        rows: result.rows.map((p) => ({
          cells: [
            p.payment_date.slice(0, 16).replace("T", " "),
            p.supplier_name,
            `Rs. ${p.amount.toLocaleString()}`,
            p.method ? p.method.replace("_", " ") : "—",
            p.notes ?? "—",
          ],
        })),
        summaryLines: truncated
          ? [{ text: `Showing the latest ${result.rows.length} of ${result.total} payments — narrow the date range for a complete report.` }]
          : undefined,
        totalSummary: {
          label: "Total paid in this range",
          amount: `Rs. ${totalPaid.toLocaleString()}`,
        },
        filename: buildReportFilename("Supplier Payments", `${dateStart || "all"}-to-${dateEnd || "now"}`),
      });
    } catch (err) {
      setDownloadError(err instanceof ApiRequestError ? err.message : "Failed to generate report");
    } finally {
      setDownloading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // The accounts a bank transfer can go to. Loaded whenever a supplier is chosen — by hand in the dialog or already chosen when
  // coming from their profile page — so the picker never claims "no account on file" for a supplier that has one.
  async function loadSupplierBankAccounts(id: string) {
    setSupplierBankAccounts([]);
    if (!id) return;
    try {
      const full = await api.get<Supplier>(`/suppliers/${id}`);
      setSupplierBankAccounts(full.bank_accounts ?? []);
    } catch {
      // if this fails, the bank-transfer picker just shows empty — the backend still validates for real at submission time either way
    }
  }

  // Coming from "Record payment" on a supplier's profile page: open the payment dialog with that supplier already chosen.
  useEffect(() => {
    const state = location.state as { paySupplierId?: number } | null;
    if (!state?.paySupplierId || suppliers.length === 0) return;
    if (suppliers.some((s) => s.id === state.paySupplierId)) {
      setSupplierId(String(state.paySupplierId));
      void loadSupplierBankAccounts(String(state.paySupplierId));
      setShowRecord(true);
      setPaymentStep(1);
    }
    navigate(location.pathname + location.search, { replace: true, state: {} });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suppliers]);

  // The Suppliers page's "Record payment" button: open the dialog, then drop the flag so a refresh doesn't open it again.
  useEffect(() => {
    if (searchParams.get("record") !== "1") return;
    setShowRecord(true);
    setPaymentStep(1);
    const next = new URLSearchParams(searchParams);
    next.delete("record");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);


  async function handleChequeSearch() {
    setChequeSearchError(null);
    const number = chequeSearchNumber.trim();
    if (!number) return;
    try {
      const matches = await api.get<any[]>(`/cheques/search?number=${encodeURIComponent(number)}`);
      if (matches.length === 0) {
        setChequeSearchError("No in-hand cheque found with that number");
        return;
      }
      if (chequeList.some((c) => c.kind === "in_hand" && c.receipt.id === matches[0].id)) {
        setChequeSearchError("That cheque is already added below");
        return;
      }
      setChequeList((list) => [...list, { kind: "in_hand", receipt: matches[0] }]);
      setChequeSearchNumber("");
    } catch (err) {
      setChequeSearchError(err instanceof ApiRequestError ? err.message : "Lookup failed");
    }
  }

  function addOwnCheque() {
    setChequeSearchError(null);
    const amt = parseFloat(ownChequeAmount);
    if (!ownChequeNumber.trim() || !ownChequeBankName.trim() || !amt || amt <= 0 || !ownChequeDate) {
      setChequeSearchError("Cheque number, bank name, a valid amount, and date are all required");
      return;
    }
    if (!ownChequePayCash && !ownChequePayeeName.trim()) {
      setChequeSearchError("Enter who the cheque is payable to, or switch back to Cash");
      return;
    }
    setChequeList((list) => [
      ...list,
      {
        kind: "own",
        cheque_number: ownChequeNumber.trim(),
        bank_name: ownChequeBankName.trim(),
        branch: ownChequeBranch.trim(),
        is_crossed: ownChequeIsCrossed,
        payee_name: ownChequePayCash ? "" : ownChequePayeeName.trim(),
        amount: amt,
        cheque_date: ownChequeDate,
      },
    ]);
    setOwnChequeNumber("");
    setOwnChequeBankName("");
    setOwnChequeBranch("");
    setOwnChequeIsCrossed(true);
    setOwnChequePayCash(true);
    setOwnChequePayeeName("");
    setOwnChequeAmount("");
    setOwnChequeDate("");
  }

  function removeCheque(index: number) {
    setChequeList((list) => list.filter((_, i) => i !== index));
  }

  const chequeListTotal = chequeList.reduce((sum, c) => sum + (c.kind === "in_hand" ? c.receipt.amount : c.amount), 0);

  async function handleRecordPayment() {
    setFormError(null);
    setFormSuccess(null);

    if (!supplierId) {
      setFormError("Select a supplier");
      return;
    }

    if (method === "cheque") {
      if (chequeList.length === 0) {
        setFormError("Add at least one cheque");
        return;
      }
      setSubmitting(true);
      try {
        await api.post("/cheques/pay-supplier-batch", {
          supplier_id: parseInt(supplierId, 10),
          purchase_id: purchaseId ? parseInt(purchaseId, 10) : undefined,
          notes: notes.trim() || undefined,
          in_hand_cheque_ids: chequeList.filter((c) => c.kind === "in_hand").map((c: any) => c.receipt.id),
          own_cheques: chequeList
            .filter((c) => c.kind === "own")
            .map((c: any) => ({
              cheque_number: c.cheque_number,
              bank_name: c.bank_name,
              branch: c.branch || undefined,
              is_crossed: c.is_crossed,
              payee_name: c.payee_name || undefined,
              amount: c.amount,
              cheque_date: c.cheque_date,
            })),
        });
        setFormSuccess(
          `${chequeList.length} cheque(s) recorded — the supplier's balance is reduced by Rs. ${chequeListTotal.toLocaleString()} now; the Cash Book updates as each one clears.`
        );
        setSupplierId("");
        setPurchaseId("");
        setAmount("");
        setMethod("cash");
        setChequeKind("in_hand");
        setNotes("");
        setChequeSearchNumber("");
        setChequeList([]);
        setShowRecord(false);
        setPaymentStep(1);
        load();
      } catch (err) {
        setFormError(err instanceof ApiRequestError ? err.message : "Failed to record these cheques");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const amt = parseFloat(amount);
    if (!amt || amt <= 0) {
      setFormError("Enter an amount greater than 0");
      return;
    }
    if (method === "bank_transfer" && !selectedBankAccountId) {
      setFormError("Select which bank account this is going to");
      return;
    }
    if (pickedPurchases.length > 0) {
      const stillToPay = purchases
        .filter((p) => pickedPurchases.includes(p.id))
        .reduce((sum, p) => sum + (p.to_pay ?? Math.max(0, p.total_cost - p.amount_paid)), 0);
      if (amt > stillToPay + 0.009) {
        setFormError(`That's more than the Rs. ${stillToPay.toLocaleString()} still to pay on the bills you ticked — lower the amount or tick more bills.`);
        return;
      }
    }

    setSubmitting(true);
    try {
      await api.post("/supplier-payments", {
        supplier_id: parseInt(supplierId, 10),
        purchase_id: purchaseId ? parseInt(purchaseId, 10) : undefined,
        purchase_ids: pickedPurchases.length > 1 ? pickedPurchases : undefined,
        amount: amt,
        method: method || undefined,
        bank_account_id: method === "bank_transfer" ? parseInt(selectedBankAccountId, 10) : undefined,
        notes: notes.trim() || undefined,
      });
      setFormSuccess("Payment recorded.");
      setSupplierId("");
      setPurchaseId("");
      setAmount("");
      setMethod("cash");
      setSelectedBankAccountId("");
      setSupplierBankAccounts([]);
      setNotes("");
      setShowRecord(false);
      setPaymentStep(1);
      load();
      loadPayments();
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? err.message : "Failed to record payment");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      {error && <ErrorText>{error}</ErrorText>}

      {showRecord && (
        <Modal
          size="lg"
          height="h-[min(640px,calc(100dvh-2rem))]"
          flush
          onClose={() => {
            setShowRecord(false);
            setPaymentStep(1);
          }}
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
              {paymentStep === 1 ? "Record a payment" : "Payment details"}
            </span>
          }
          footer={
            <>
              <Button
                onClick={() => {
                  setShowRecord(false);
                  setPaymentStep(1);
                }}
              >
                Cancel
              </Button>
              {paymentStep === 2 && (
                <Button variant="primary" onClick={handleRecordPayment} disabled={submitting}>
                  {submitting ? "Recording..." : "Record payment"}
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
                      onClick={() => {
                        setMethod("cash");
                        setPaymentStep(2);
                      }}
                      className="flex flex-col items-center justify-center gap-2 py-6 rounded-xl border border-gray-200 hover:border-gray-900 hover:bg-gray-50 transition"
                    >
                      <Wallet size={24} className="text-gray-700" />
                      <span className="text-sm font-medium text-gray-900">Cash</span>
                    </button>
                    <button
                      onClick={() => {
                        setMethod("card");
                        setPaymentStep(2);
                      }}
                      className="flex flex-col items-center justify-center gap-2 py-6 rounded-xl border border-gray-200 hover:border-gray-900 hover:bg-gray-50 transition"
                    >
                      <CreditCard size={24} className="text-gray-700" />
                      <span className="text-sm font-medium text-gray-900">Card</span>
                    </button>
                    <button
                      onClick={() => {
                        setMethod("bank_transfer");
                        setPaymentStep(2);
                      }}
                      className="flex flex-col items-center justify-center gap-2 py-6 rounded-xl border border-gray-200 hover:border-gray-900 hover:bg-gray-50 transition"
                    >
                      <Building2 size={24} className="text-gray-700" />
                      <span className="text-sm font-medium text-gray-900">Bank transfer</span>
                    </button>
                    <button
                      onClick={() => {
                        setMethod("cheque");
                        setChequeSearchError(null);
                        setPickedPurchases((picked) => picked.slice(0, 1));
                        setPaymentStep(2);
                      }}
                      className="flex flex-col items-center justify-center gap-2 py-6 rounded-xl border border-gray-200 hover:border-gray-900 hover:bg-gray-50 transition"
                    >
                      <FileText size={24} className="text-gray-700" />
                      <span className="text-sm font-medium text-gray-900">Cheque</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-5 h-full">
                  <div className="col-span-3 px-6 py-5 space-y-4 border-r border-gray-100 overflow-y-auto">
                    <FormGroup>
                      <Label>Supplier</Label>
                      <Dropdown
                        value={supplierId}
                        onChange={async (v) => {
                          setSupplierId(v);
                          setPurchaseId("");
                          setSelectedBankAccountId("");
                          await loadSupplierBankAccounts(v);
                        }}
                        placeholder="— Select —"
                        searchable
                        options={suppliers.map((s) => ({ value: String(s.id), label: s.name, sublabel: s.supplier_code }))}
                      />
                    </FormGroup>

                    {supplierId && (() => {
                      const owedNow = balances.find((b) => String(b.id) === supplierId)?.balance_owed;
                      if (owedNow == null) return null;
                      return (
                        <p className="text-sm text-gray-600 -mt-1">
                          {owedNow > 0 ? (
                            <>You owe {suppliers.find((s) => String(s.id) === supplierId)?.name} <span className="font-semibold text-gray-900">Rs. {owedNow.toLocaleString()}</span> in all.</>
                          ) : owedNow < 0 ? (
                            <>You've paid {suppliers.find((s) => String(s.id) === supplierId)?.name} <span className="font-semibold text-gray-900">Rs. {(-owedNow).toLocaleString()}</span> ahead.</>
                          ) : (
                            <>Nothing owed to {suppliers.find((s) => String(s.id) === supplierId)?.name} right now.</>
                          )}
                        </p>
                      );
                    })()}

                    {(() => {
                      // "Still to pay" is the purchase's own balance less any money already paid past another of this supplier's
                      // purchases — the same figure as the supplier's total, not the bill on its own.
                      const ownLeft = (p: Purchase) => Math.max(0, p.total_cost - p.amount_paid);
                      const leftOn = (p: Purchase) => p.to_pay ?? ownLeft(p);
                      const outstanding = purchases.filter(
                        (p) => String(p.supplier_id) === supplierId && p.payment_status !== "paid" && leftOn(p) > 0
                      );
                      if (!supplierId || outstanding.length === 0) return null;
                      const toggle = (p: Purchase) => {
                        const on = pickedPurchases.includes(p.id);
                        // A cheque is put against one bill; the other methods can cover several.
                        const next = on ? pickedPurchases.filter((id) => id !== p.id) : method === "cheque" ? [p.id] : [...pickedPurchases, p.id];
                        setPickedPurchases(next);
                        if (method !== "cheque") {
                          const sum = outstanding.filter((x) => next.includes(x.id)).reduce((t, x) => t + leftOn(x), 0);
                          setAmount(next.length > 0 ? String(Math.round(sum * 100) / 100) : "");
                        } else if (!on) {
                          setAmount(String(leftOn(p)));
                        }
                      };
                      return (
                        <FormGroup>
                          <Label>{method === "cheque" ? "Which bill is this for? (optional)" : "Which bills is this for? (optional)"}</Label>
                          <p className="text-xs text-gray-500 -mt-0.5 mb-1.5">
                            {method === "cheque"
                              ? "Tick the bill this cheque pays, or leave it for a general payment."
                              : "Tick the bills this payment is for — the others stay as they are. Leave none ticked for a general payment."}
                          </p>
                          <div className="border border-gray-200 rounded-lg overflow-hidden bg-white divide-y divide-gray-100 max-h-60 overflow-y-auto">
                            {outstanding.map((p) => {
                              const on = pickedPurchases.includes(p.id);
                              return (
                                <label key={p.id} className={`flex items-start gap-2.5 px-3 py-2 cursor-pointer ${on ? "bg-gray-50" : "hover:bg-gray-50/60"}`}>
                                  <input
                                    type="checkbox"
                                    checked={on}
                                    onChange={() => toggle(p)}
                                    className="mt-0.5 h-4 w-4 accent-black flex-shrink-0"
                                  />
                                  <span className="min-w-0 flex-1">
                                    <span className="block text-sm font-medium text-gray-900">
                                      {p.purchase_code} <span className="font-normal text-gray-500">· {formatDate(p.purchase_date)}</span>
                                    </span>
                                    <span className="block text-xs text-gray-500">
                                      {p.amount_paid > 0
                                        ? `Part paid · Rs. ${p.amount_paid.toLocaleString()} of Rs. ${p.total_cost.toLocaleString()} paid`
                                        : `Unpaid · Rs. ${p.total_cost.toLocaleString()}`}
                                      {leftOn(p) < ownLeft(p) && ` · Rs. ${(ownLeft(p) - leftOn(p)).toLocaleString()} already covered by payments on other bills`}
                                    </span>
                                  </span>
                                  <span className="text-sm font-medium text-gray-900 tabular-nums flex-shrink-0">Rs. {leftOn(p).toLocaleString()}</span>
                                </label>
                              );
                            })}
                          </div>
                        </FormGroup>
                      );
                    })()}

                    {method !== "cheque" ? (
                      <div>
                        <Label>Amount (Rs.)</Label>
                        <MoneyInput
                          bare
                          value={amount}
                          onChange={setAmount}
                          placeholder="0"
                          autoFocus
                          className="w-full mt-1 px-3 py-3 border border-gray-200 rounded-lg text-2xl font-medium focus:outline-none focus:border-gray-400"
                        />
                      </div>
                    ) : (
                      <>
                        <div className="flex items-baseline justify-between">
                          <h3 className="text-sm font-semibold text-gray-900">
                            Add cheque
                            <HelpHint
                              text={
                                chequeKind === "in_hand"
                                  ? "Add one or more cheques already received from customers, currently in hand."
                                  : "Write one or more new cheques from your own account."
                              }
                            />
                          </h3>
                          <span className="text-xs text-gray-500">Clears later</span>
                        </div>

                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setChequeKind("in_hand")}
                            className={`flex-1 border rounded-xl py-2 text-xs font-medium transition ${
                              chequeKind === "in_hand" ? "border-black bg-black text-white" : "border-gray-200 text-gray-600 hover:border-gray-400"
                            }`}
                          >
                            Cheque in hand
                          </button>
                          <button
                            type="button"
                            onClick={() => setChequeKind("own")}
                            className={`flex-1 border rounded-xl py-2 text-xs font-medium transition ${
                              chequeKind === "own" ? "border-black bg-black text-white" : "border-gray-200 text-gray-600 hover:border-gray-400"
                            }`}
                          >
                            My own cheque
                          </button>
                        </div>

                        {chequeKind === "in_hand" ? (
                          <>
                            <div className="flex gap-2">
                              <Input
                                placeholder="Cheque number"
                                value={chequeSearchNumber}
                                onChange={(e) => setChequeSearchNumber(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && handleChequeSearch()}
                              />
                              <Button onClick={handleChequeSearch}>Add</Button>
                            </div>
                            {chequeSearchError && <ErrorText>{chequeSearchError}</ErrorText>}
                          </>
                        ) : (
                          <>
                            <div className="grid grid-cols-2 gap-2">
                              <Input placeholder="Cheque number" value={ownChequeNumber} onChange={(e) => setOwnChequeNumber(e.target.value)} />
                              <Input placeholder="Bank name" value={ownChequeBankName} onChange={(e) => setOwnChequeBankName(e.target.value)} />
                              <Input placeholder="Branch (optional)" value={ownChequeBranch} onChange={(e) => setOwnChequeBranch(e.target.value)} />
                              <DatePicker value={ownChequeDate || null} onChange={setOwnChequeDate} placeholder="Cheque date" />
                              <MoneyInput placeholder="Amount" value={ownChequeAmount} onChange={setOwnChequeAmount} />
                              <label className="flex items-center gap-1.5 text-xs text-gray-600 self-center pl-1">
                                <input
                                  type="checkbox"
                                  checked={ownChequeIsCrossed}
                                  onChange={(e) => setOwnChequeIsCrossed(e.target.checked)}
                                  className="rounded border-gray-300"
                                />
                                Crossed cheque
                              </label>
                              <div className="col-span-2">
                                <Label>Payable to</Label>
                                <TabToggle
                                  value={ownChequePayCash ? "cash" : "name"}
                                  onChange={(v) => setOwnChequePayCash(v === "cash")}
                                  options={[
                                    { value: "cash", label: "Cash" },
                                    { value: "name", label: "A specific name" },
                                  ]}
                                />
                              </div>
                              <div className="col-span-2">
                                <Input
                                  placeholder="Who the cheque is made out to"
                                  value={ownChequePayeeName}
                                  onChange={(e) => setOwnChequePayeeName(e.target.value)}
                                  disabled={ownChequePayCash}
                                  className={ownChequePayCash ? "opacity-40 cursor-not-allowed" : ""}
                                />
                              </div>
                            </div>
                            {chequeSearchError && <ErrorText>{chequeSearchError}</ErrorText>}
                            <button
                              type="button"
                              onClick={addOwnCheque}
                              className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg border border-dashed border-gray-300 text-sm font-medium text-gray-600 hover:border-gray-900 hover:text-gray-900 hover:bg-gray-50 transition"
                            >
                              <Plus size={14} />
                              Add cheque to list
                            </button>
                          </>
                        )}
                      </>
                    )}

                    {method === "bank_transfer" && (
                      <div className="border border-gray-200 rounded-xl p-3">
                        <p className="text-xs text-gray-500 mb-2">Pick which of this supplier's accounts the money is going to.</p>
                        {!supplierId ? (
                          <p className="text-xs text-gray-500">Select a supplier first.</p>
                        ) : supplierBankAccounts.length === 0 ? (
                          <p className="text-xs text-amber-600">
                            No bank account on file for this supplier — add one from the Suppliers page before paying by bank transfer.
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {supplierBankAccounts.map((a) => (
                              <label
                                key={a.id}
                                className={`flex items-start gap-2 border rounded-lg px-3 py-2 text-sm cursor-pointer transition ${
                                  String(a.id) === selectedBankAccountId ? "border-black bg-gray-50" : "border-gray-200 hover:border-gray-300"
                                }`}
                              >
                                <input
                                  type="radio"
                                  name="supplier-bank-account"
                                  checked={String(a.id) === selectedBankAccountId}
                                  onChange={() => setSelectedBankAccountId(String(a.id))}
                                  className="mt-0.5"
                                />
                                <div>
                                  <p className="font-medium text-gray-900">
                                    {a.bank_name} {a.is_default === 1 && <span className="text-xs text-green-600 font-normal">(default)</span>}
                                  </p>
                                  <p className="text-xs text-gray-500">
                                    {a.account_name} — {a.account_number}
                                    {a.branch ? ` — ${a.branch}` : ""}
                                  </p>
                                </div>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <FormGroup>
                      <Label>Notes (optional)</Label>
                      <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
                    </FormGroup>

                    {formError && <ErrorText>{formError}</ErrorText>}
                    {formSuccess && <SuccessText>{formSuccess}</SuccessText>}
                  </div>

                  <div className="col-span-2 px-5 py-5 bg-gray-50/50 overflow-y-auto space-y-4">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 mb-3">Summary</h3>
                      {supplierId ? (
                        (() => {
                          const sel = suppliers.find((s) => String(s.id) === supplierId);
                          const displayAmount = method === "cheque" ? chequeListTotal : parseFloat(amount) || 0;
                          const owedNow = balances.find((b) => String(b.id) === supplierId)?.balance_owed;
                          const after = owedNow == null ? null : owedNow - displayAmount;
                          return (
                            <div className="bg-white rounded-lg border border-gray-200 px-3 py-2.5">
                              <p className="text-sm font-medium text-gray-900">{sel?.name}</p>
                              {owedNow != null && (
                                <p className="text-xs text-gray-500 mt-1">
                                  Owed now <span className="font-medium text-gray-700">Rs. {Math.max(0, owedNow).toLocaleString()}</span>
                                </p>
                              )}
                              <p className="text-xs text-gray-500 mt-1">
                                Paying <span className="font-medium text-gray-700">Rs. {displayAmount.toLocaleString()}</span>
                              </p>
                              {after != null && displayAmount > 0 && (
                                <p className="text-xs text-gray-500 mt-1">
                                  {after > 0 ? (
                                    <>Still owed after <span className="font-medium text-gray-700">Rs. {after.toLocaleString()}</span></>
                                  ) : after === 0 ? (
                                    <span className="font-medium text-gray-700">Settled after this payment</span>
                                  ) : (
                                    <>Paid ahead by <span className="font-medium text-gray-700">Rs. {(-after).toLocaleString()}</span></>
                                  )}
                                </p>
                              )}
                            </div>
                          );
                        })()
                      ) : (
                        <p className="text-xs text-gray-500">Select a supplier to see a summary.</p>
                      )}
                    </div>

                    {method === "cheque" && chequeList.length > 0 && (
                      <div>
                        <h3 className="text-sm font-semibold text-gray-900 mb-3">Cheques added</h3>
                        <div className="space-y-1.5">
                          {chequeList.map((c, i) => (
                            <div
                              key={i}
                              className="bg-white rounded-lg border border-gray-200 px-3 py-2.5 hover:border-gray-300 transition"
                            >
                              <div className="flex items-baseline justify-between gap-3">
                                <p className="text-sm font-medium text-gray-900 truncate">
                                  #{c.kind === "in_hand" ? c.receipt.cheque_number : c.cheque_number}
                                </p>
                                <p className="text-sm font-semibold text-gray-900 tabular-nums flex-shrink-0">
                                  {(c.kind === "in_hand" ? c.receipt.amount : c.amount).toLocaleString()}/-
                                </p>
                              </div>
                              <div className="flex items-center justify-between gap-3 mt-1.5">
                                <div className="flex items-center gap-2 text-xs text-gray-500 truncate min-w-0">
                                  <span className="truncate">
                                    {c.kind === "in_hand" ? c.receipt.bank_name : c.bank_name}
                                    {c.kind === "in_hand" ? ` — from ${c.receipt.customer_name}` : " — own cheque"}
                                  </span>
                                </div>
                                <button onClick={() => removeCheque(i)} className="text-xs text-gray-500 hover:text-red-500 flex-shrink-0">
                                  Remove
                                </button>
                              </div>
                            </div>
                          ))}
                          <div className="flex justify-between text-sm font-medium px-1 pt-1">
                            <span>Total</span>
                            <span>Rs. {chequeListTotal.toLocaleString()}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
        </Modal>
      )}

      {loading ? (
        <PageLoader />
      ) : (
        <>
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <h2 className="text-base font-semibold text-gray-900">Payment log</h2>
            <div className="flex items-center gap-2">
              <DateRangePicker
                startDate={dateStart || null}
                endDate={dateEnd || null}
                onChange={(s, e) => {
                  setDateStart(s ?? "");
                  setDateEnd(e ?? "");
                  setPaymentsPage(1);
                }}
              />
              <Button onClick={downloadPaymentsPdf} disabled={downloading || payments.length === 0} className="inline-flex items-center gap-1.5">
                <Download size={14} />
                {downloading ? "Preparing..." : "Download PDF"}
              </Button>
            </div>
          </div>
          {downloadError && <ErrorText>{downloadError}</ErrorText>}

          {paymentsLoading ? (
            <PageLoader />
          ) : payments.length === 0 ? (
            <EmptyState
              icon={Landmark}
              title={dateStart && dateEnd ? "No payments recorded in this range" : "No payments recorded yet"}
              actions={[
                dateStart && dateEnd
                  ? {
                      label: "Show all dates",
                      onClick: () => {
                        setDateStart("");
                        setDateEnd("");
                        setPaymentsPage(1);
                      },
                    }
                  : null,
              ]}
            />
          ) : (
            <>
              <Card className="p-0 overflow-clip">
                <Table>
                  <thead>
                    <tr>
                      <Th>Date</Th>
                      <Th>Supplier</Th>
                      <Th align="right">Amount</Th>
                      <Th>Method</Th>
                      <Th>Notes</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.id}>
                        <Td>{formatDateTime(p.payment_date)}</Td>
                        <Td>{p.supplier_name}</Td>
                        <Td align="right">Rs. {p.amount.toLocaleString()}</Td>
                        <Td className="capitalize">{p.method?.replace("_", " ") ?? "—"}</Td>
                        <Td>{p.notes ?? "—"}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>

              <div className="flex items-center justify-between mt-3">
                <p className="text-xs text-gray-500">
                  Showing {(paymentsPage - 1) * paymentsPageSize + 1}–{Math.min(paymentsPage * paymentsPageSize, paymentsTotal)} of{" "}
                  {paymentsTotal}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPaymentsPage((p) => Math.max(1, p - 1))}
                    disabled={paymentsPage === 1}
                    className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setPaymentsPage((p) => p + 1)}
                    disabled={paymentsPage * paymentsPageSize >= paymentsTotal}
                    className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
