import { useState, useEffect, useMemo, Fragment } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Landmark,
  X,
  ArrowLeft,
  Building2,
  FileText,
  Wallet,
  CreditCard,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { SupplierPayment, SupplierBalance, Supplier, Purchase, BankAccount } from "../lib/types";
import { PageHeader, Card, Input, Label, FormGroup, ErrorText, SuccessText, Button, Table, Th, Td, Dropdown, EmptyState, DateRangePicker, DatePicker } from "../components/ui";

type ExpandedTab = "activity";

export default function SupplierPaymentsPage() {
  const navigate = useNavigate();
  const location = useLocation();
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

  // Which supplier's row is expanded to show their full running ledger.
  const [expandedSupplierId, setExpandedSupplierId] = useState<number | null>(null);
  const [expandedTab, setExpandedTab] = useState<ExpandedTab>("activity");
  const [ledgerEntries, setLedgerEntries] = useState<any[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

  const [showRecord, setShowRecord] = useState(false);
  const [paymentStep, setPaymentStep] = useState<1 | 2>(1);
  const [supplierId, setSupplierId] = useState("");
  const [purchaseId, setPurchaseId] = useState("");
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
  const [ownChequeAmount, setOwnChequeAmount] = useState("");
  const [ownChequeDate, setOwnChequeDate] = useState("");
  const [chequeList, setChequeList] = useState<
    ({ kind: "in_hand"; receipt: any } | { kind: "own"; cheque_number: string; bank_name: string; amount: number; cheque_date: string })[]
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

  useEffect(() => {
    load();
  }, []);

  // Arriving back from the full Payment History page (via its Back
  // button) re-expands the same supplier's row, so it genuinely feels
  // like returning to where you were.
  useEffect(() => {
    const state = location.state as { expandSupplierId?: number } | null;
    if (!state?.expandSupplierId || balances.length === 0) return;
    const target = balances.find((b) => b.id === state.expandSupplierId);
    if (target) {
      toggleSupplierExpand(target.id);
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balances]);

  // Two-tier ordering, most actionable first:
  //   1. Owing  — you still owe this supplier money (balance_owed > 0)
  //   2. Settled — nothing outstanding
  // Stable within each tier, preserving the API's original order.
  const sortedBalances = useMemo(() => {
    function tier(b: SupplierBalance): number {
      return (b.balance_owed ?? 0) > 0 ? 0 : 1;
    }
    return [...balances].sort((a, b) => tier(a) - tier(b));
  }, [balances]);

  async function toggleSupplierExpand(supplierId: number) {
    if (expandedSupplierId === supplierId) {
      setExpandedSupplierId(null);
      return;
    }
    setExpandedSupplierId(supplierId);
    setExpandedTab("activity");
    setLedgerLoading(true);
    setLedgerError(null);
    try {
      const result = await api.get<{ entries: any[] }>(`/supplier-payments/ledger/${supplierId}`);
      setLedgerEntries(result.entries);
    } catch (err) {
      setLedgerError(err instanceof ApiRequestError ? err.message : "Failed to load this supplier's ledger");
    } finally {
      setLedgerLoading(false);
    }
  }

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
    setChequeList((list) => [
      ...list,
      { kind: "own", cheque_number: ownChequeNumber.trim(), bank_name: ownChequeBankName.trim(), amount: amt, cheque_date: ownChequeDate },
    ]);
    setOwnChequeNumber("");
    setOwnChequeBankName("");
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
            .map((c: any) => ({ cheque_number: c.cheque_number, bank_name: c.bank_name, amount: c.amount, cheque_date: c.cheque_date })),
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

    setSubmitting(true);
    try {
      await api.post("/supplier-payments", {
        supplier_id: parseInt(supplierId, 10),
        purchase_id: purchaseId ? parseInt(purchaseId, 10) : undefined,
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

  const totalOwed = balances.reduce((sum, b) => sum + b.balance_owed, 0);

  return (
    <div>
      <PageHeader
        title="Supplier payments"
        subtitle="Balance owed is calculated live from purchases minus payments made."
        action={
          !showRecord && (
            <Button
              variant="primary"
              onClick={() => {
                setShowRecord(true);
                setPaymentStep(1);
              }}
            >
              Record payment
            </Button>
          )
        }
      />

      {error && <ErrorText>{error}</ErrorText>}

      {showRecord && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-[880px] h-[640px] shadow-2xl flex flex-col overflow-hidden">
            <div className="px-6 py-3.5 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                {paymentStep === 2 && (
                  <button
                    onClick={() => setPaymentStep(1)}
                    className="text-gray-400 hover:text-gray-700 flex-shrink-0"
                    title="Back to method"
                  >
                    <ArrowLeft size={18} />
                  </button>
                )}
                <h2 className="text-base font-semibold text-gray-900 flex-shrink-0">
                  {paymentStep === 1 ? "Record a payment" : "Payment details"}
                </h2>
              </div>
              <button
                onClick={() => {
                  setShowRecord(false);
                  setPaymentStep(1);
                }}
                className="text-gray-400 hover:text-gray-600 flex-shrink-0 ml-3"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-hidden">
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
                          setSupplierBankAccounts([]);
                          if (v) {
                            try {
                              const full = await api.get<Supplier>(`/suppliers/${v}`);
                              setSupplierBankAccounts(full.bank_accounts ?? []);
                            } catch {
                              // if this fails, the bank-transfer picker just shows empty — the
                              // backend still validates for real at submission time either way
                            }
                          }
                        }}
                        placeholder="— Select —"
                        searchable
                        options={suppliers.map((s) => ({ value: String(s.id), label: s.name, sublabel: s.supplier_code }))}
                      />
                    </FormGroup>

                    {(() => {
                      const outstanding = purchases.filter(
                        (p) => String(p.supplier_id) === supplierId && p.payment_status !== "paid"
                      );
                      if (!supplierId || outstanding.length === 0) return null;
                      return (
                        <FormGroup>
                          <Label>Which purchase is this for? (optional)</Label>
                          <Dropdown
                            value={purchaseId}
                            onChange={(v) => {
                              setPurchaseId(v);
                              const match = outstanding.find((p) => String(p.id) === v);
                              if (match) setAmount(String(match.total_cost - match.amount_paid));
                            }}
                            placeholder="— General payment, not tied to one purchase —"
                            options={outstanding.map((p) => ({
                              value: String(p.id),
                              label: `${p.purchase_code} — owes Rs. ${(p.total_cost - p.amount_paid).toLocaleString()}`,
                            }))}
                          />
                        </FormGroup>
                      );
                    })()}

                    {method !== "cheque" ? (
                      <div>
                        <Label>Amount (Rs.)</Label>
                        <input
                          type="number"
                          min="0"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          placeholder="0"
                          autoFocus
                          className="w-full mt-1 px-3 py-3 border border-gray-200 rounded-lg text-2xl font-medium tabular-nums focus:outline-none focus:border-gray-400"
                        />
                      </div>
                    ) : (
                      <>
                        <div className="flex items-baseline justify-between">
                          <h3 className="text-sm font-semibold text-gray-900">Add cheque</h3>
                          <span className="text-[11px] text-gray-400">Clears later</span>
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
                            <p className="text-xs text-gray-400">Add one or more cheques already received from customers, currently in hand.</p>
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
                            <p className="text-xs text-gray-400">Write one or more new cheques from your own account.</p>
                            <div className="grid grid-cols-2 gap-2">
                              <Input placeholder="Cheque number" value={ownChequeNumber} onChange={(e) => setOwnChequeNumber(e.target.value)} />
                              <Input placeholder="Bank name" value={ownChequeBankName} onChange={(e) => setOwnChequeBankName(e.target.value)} />
                              <Input
                                type="number"
                                min="0"
                                placeholder="Amount"
                                value={ownChequeAmount}
                                onChange={(e) => setOwnChequeAmount(e.target.value)}
                              />
                              <DatePicker value={ownChequeDate || null} onChange={setOwnChequeDate} placeholder="Cheque date" />
                            </div>
                            {chequeSearchError && <ErrorText>{chequeSearchError}</ErrorText>}
                            <Button onClick={addOwnCheque}>Add this cheque</Button>
                          </>
                        )}
                      </>
                    )}

                    {method === "bank_transfer" && (
                      <div className="border border-gray-200 rounded-xl p-3">
                        <p className="text-xs text-gray-400 mb-2">Pick which of this supplier's accounts the money is going to.</p>
                        {!supplierId ? (
                          <p className="text-xs text-gray-400">Select a supplier first.</p>
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
                      <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Reference, remarks, etc." />
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
                          return (
                            <div className="bg-white rounded-lg border border-gray-200 px-3 py-2.5">
                              <p className="text-sm font-medium text-gray-900">{sel?.name}</p>
                              <p className="text-xs text-gray-500 mt-1">
                                Paying <span className="font-medium text-gray-700">Rs. {displayAmount.toLocaleString()}</span>
                              </p>
                            </div>
                          );
                        })()
                      ) : (
                        <p className="text-xs text-gray-400">Select a supplier to see a summary.</p>
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
                                <div className="flex items-center gap-2 text-[11px] text-gray-500 truncate min-w-0">
                                  <span className="truncate">
                                    {c.kind === "in_hand" ? c.receipt.bank_name : c.bank_name}
                                    {c.kind === "in_hand" ? ` — from ${c.receipt.customer_name}` : " — own cheque"}
                                  </span>
                                </div>
                                <button onClick={() => removeCheque(i)} className="text-[11px] text-gray-400 hover:text-red-500 flex-shrink-0">
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

            <div className="px-6 py-3 border-t border-gray-100 flex justify-end gap-2 flex-shrink-0 bg-white">
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
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : (
        <>
          <p className="text-xs text-gray-400 mb-3">Total owed across all suppliers: Rs. {totalOwed.toLocaleString()}</p>

          <Card className="p-0 overflow-hidden mb-5">
            <Table>
              <thead>
                <tr>
                  <Th className="w-8"></Th>
                  <Th>Code</Th>
                  <Th>Supplier</Th>
                  <Th>Balance owed</Th>
                </tr>
              </thead>
              <tbody>
                {sortedBalances.map((b) => {
                  const isExpanded = expandedSupplierId === b.id;
                  return (
                    <Fragment key={b.id}>
                      <tr onClick={() => toggleSupplierExpand(b.id)} className="cursor-pointer hover:bg-gray-50">
                        <Td className="w-8">
                          {isExpanded ? <ChevronDown size={15} className="text-gray-400" /> : <ChevronRight size={15} className="text-gray-400" />}
                        </Td>
                        <Td>{b.supplier_code}</Td>
                        <Td className="font-medium">{b.name}</Td>
                        <Td className={b.balance_owed > 0 ? "font-medium" : ""}>Rs. {b.balance_owed.toLocaleString()}</Td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <Td colSpan={4} className="bg-gray-50">
                            <div className="py-3 px-1">
                              <div className="flex items-center justify-between mb-4">
                                <div>
                                  <h2 className="text-base font-semibold text-gray-900">{b.name}</h2>
                                  <p className="text-xs text-gray-400">{b.supplier_code}</p>
                                </div>
                                <button onClick={() => setExpandedSupplierId(null)} className="text-gray-400 hover:text-gray-600">
                                  <X size={18} />
                                </button>
                              </div>

                              <div className="flex items-center gap-1 border-b border-gray-200 mb-4">
                                <button
                                  onClick={() => setExpandedTab("activity")}
                                  className={`px-3 py-1.5 text-xs font-medium rounded-t-lg transition ${
                                    expandedTab === "activity"
                                      ? "bg-white border border-b-white border-gray-200 text-gray-900 -mb-px"
                                      : "text-gray-500 hover:text-gray-800"
                                  }`}
                                >
                                  Recent Activity
                                </button>
                              </div>

                              {expandedTab === "activity" && (
                                <div className="bg-white border border-gray-200 rounded-xl p-4">
                                  <div className="flex items-center justify-between mb-3">
                                    <h3 className="text-sm font-semibold text-gray-900">Recent activity</h3>
                                    {ledgerEntries.length > 0 && (
                                      <button
                                        onClick={() =>
                                          navigate(`/suppliers/${b.id}/payment-history`, {
                                            state: { from: "supplier-payments", supplierId: b.id },
                                          })
                                        }
                                        className="text-xs text-gray-500 hover:text-gray-800 underline"
                                      >
                                        View all ({ledgerEntries.length})
                                      </button>
                                    )}
                                  </div>

                                  {ledgerLoading ? (
                                    <p className="text-sm text-gray-400">Loading...</p>
                                  ) : ledgerError ? (
                                    <ErrorText>{ledgerError}</ErrorText>
                                  ) : ledgerEntries.length === 0 ? (
                                    <p className="text-sm text-gray-400">No activity recorded for this supplier yet.</p>
                                  ) : (
                                    <div className="border border-gray-200 rounded-xl overflow-hidden">
                                      <table className="w-full text-sm">
                                        <thead>
                                          <tr className="bg-gray-50">
                                            <th className="text-left px-3 py-2 text-xs font-medium text-gray-400">Date</th>
                                            <th className="text-left px-3 py-2 text-xs font-medium text-gray-400">Event</th>
                                            <th className="text-left px-3 py-2 text-xs font-medium text-gray-400">Amount</th>
                                            <th className="text-left px-3 py-2 text-xs font-medium text-gray-400">Running balance</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {[...ledgerEntries]
                                            .reverse()
                                            .slice(0, 3)
                                            .map((entry, i) => (
                                              <tr key={i} className={i % 2 === 1 ? "bg-gray-50/50" : ""}>
                                                <td className="px-3 py-2 border-t border-gray-50 text-gray-500">{entry.date?.slice(0, 10)}</td>
                                                <td className="px-3 py-2 border-t border-gray-50 text-gray-900">{entry.label}</td>
                                                <td
                                                  className={`px-3 py-2 border-t border-gray-50 font-medium ${
                                                    entry.type === "purchase" ? "text-gray-900" : "text-green-600"
                                                  }`}
                                                >
                                                  {entry.type === "purchase" ? "+" : "-"} Rs. {entry.amount.toLocaleString()}
                                                </td>
                                                <td className="px-3 py-2 border-t border-gray-50 text-gray-500">
                                                  Rs. {entry.running_balance.toLocaleString()}
                                                </td>
                                              </tr>
                                            ))}
                                        </tbody>
                                      </table>
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

          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-gray-900">Payment log</h2>
            <DateRangePicker
              startDate={dateStart || null}
              endDate={dateEnd || null}
              onChange={(s, e) => {
                setDateStart(s ?? "");
                setDateEnd(e ?? "");
                setPaymentsPage(1);
              }}
            />
          </div>

          {paymentsLoading ? (
            <p className="text-sm text-gray-400">Loading...</p>
          ) : payments.length === 0 ? (
            <EmptyState icon={Landmark} title="No payments recorded in this range" />
          ) : (
            <>
              <Card className="p-0 overflow-hidden">
                <Table>
                  <thead>
                    <tr>
                      <Th>Date</Th>
                      <Th>Supplier</Th>
                      <Th>Amount</Th>
                      <Th>Method</Th>
                      <Th>Notes</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.id}>
                        <Td>{p.payment_date.slice(0, 16).replace("T", " ")}</Td>
                        <Td>{p.supplier_name}</Td>
                        <Td>Rs. {p.amount.toLocaleString()}</Td>
                        <Td className="capitalize">{p.method?.replace("_", " ") ?? "—"}</Td>
                        <Td>{p.notes ?? "—"}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>

              <div className="flex items-center justify-between mt-3">
                <p className="text-xs text-gray-400">
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
