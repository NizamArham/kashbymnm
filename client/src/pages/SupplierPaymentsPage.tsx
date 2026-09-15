import { useState, useEffect, Fragment } from "react";
import { Landmark, X } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { SupplierPayment, SupplierBalance, Supplier, Purchase } from "../lib/types";
import { PageHeader, Card, Input, Label, FormGroup, ErrorText, SuccessText, Button, Table, Th, Td, Dropdown, EmptyState, DateRangePicker } from "../components/ui";

export default function SupplierPaymentsPage() {
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
  const [ledgerEntries, setLedgerEntries] = useState<any[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

  const [showRecord, setShowRecord] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [purchaseId, setPurchaseId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  async function toggleSupplierExpand(supplierId: number) {
    if (expandedSupplierId === supplierId) {
      setExpandedSupplierId(null);
      return;
    }
    setExpandedSupplierId(supplierId);
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

  async function handleRecordPayment() {
    setFormError(null);
    setFormSuccess(null);

    if (!supplierId) {
      setFormError("Select a supplier");
      return;
    }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) {
      setFormError("Enter an amount greater than 0");
      return;
    }

    setSubmitting(true);
    try {
      await api.post("/supplier-payments", {
        supplier_id: parseInt(supplierId, 10),
        purchase_id: purchaseId ? parseInt(purchaseId, 10) : undefined,
        amount: amt,
        method: method || undefined,
        notes: notes.trim() || undefined,
      });
      setFormSuccess("Payment recorded.");
      setSupplierId("");
      setPurchaseId("");
      setAmount("");
      setMethod("cash");
      setNotes("");
      setShowRecord(false);
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
            <Button variant="primary" onClick={() => setShowRecord(true)}>
              Record payment
            </Button>
          )
        }
      />

      {error && <ErrorText>{error}</ErrorText>}

      {showRecord && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-2xl">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Record a payment</h2>
              <button onClick={() => setShowRecord(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5">
              <FormGroup>
                <Label>Supplier</Label>
                <Dropdown
                  value={supplierId}
                  onChange={(v) => {
                    setSupplierId(v);
                    setPurchaseId("");
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
              <div className="grid grid-cols-2 gap-3">
                <FormGroup>
                  <Label>Amount (Rs.)</Label>
                  <Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </FormGroup>
                <FormGroup>
                  <Label>Method</Label>
                  <Dropdown
                    value={method}
                    onChange={setMethod}
                    options={[
                      { value: "cash", label: "Cash" },
                      { value: "card", label: "Card" },
                      { value: "bank_transfer", label: "Bank transfer" },
                    ]}
                  />
                </FormGroup>
              </div>
              <FormGroup>
                <Label>Notes</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
              </FormGroup>
              {formError && <ErrorText>{formError}</ErrorText>}
              {formSuccess && <SuccessText>{formSuccess}</SuccessText>}
              <div className="flex gap-2 mt-2">
                <Button variant="primary" onClick={handleRecordPayment} disabled={submitting}>
                  {submitting ? "Recording..." : "Record payment"}
                </Button>
                <Button onClick={() => setShowRecord(false)}>Cancel</Button>
              </div>
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
                  <Th></Th>
                  <Th>Code</Th>
                  <Th>Supplier</Th>
                  <Th>Balance owed</Th>
                </tr>
              </thead>
              <tbody>
                {balances.map((b) => {
                  const isExpanded = expandedSupplierId === b.id;
                  return (
                    <Fragment key={b.id}>
                      <tr onClick={() => toggleSupplierExpand(b.id)} className="cursor-pointer hover:bg-gray-50">
                        <Td className="w-6">{isExpanded ? "▾" : "▸"}</Td>
                        <Td>{b.supplier_code}</Td>
                        <Td className="font-medium">{b.name}</Td>
                        <Td className={b.balance_owed > 0 ? "font-medium" : ""}>Rs. {b.balance_owed.toLocaleString()}</Td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <Td colSpan={4} className="bg-gray-50">
                            <div className="py-3">
                              {ledgerLoading ? (
                                <p className="text-sm text-gray-400">Loading...</p>
                              ) : ledgerError ? (
                                <ErrorText>{ledgerError}</ErrorText>
                              ) : ledgerEntries.length === 0 ? (
                                <p className="text-sm text-gray-400">No activity recorded for this supplier yet.</p>
                              ) : (
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr>
                                      <Th>Date</Th>
                                      <Th>Event</Th>
                                      <Th>Amount</Th>
                                      <Th>Running balance</Th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {ledgerEntries.map((entry, i) => (
                                      <tr key={i}>
                                        <Td>{entry.date?.slice(0, 10)}</Td>
                                        <Td>{entry.label}</Td>
                                        <Td className={entry.type === "purchase" ? "" : "text-gray-500"}>
                                          {entry.type === "purchase" ? "+" : "-"} Rs. {entry.amount.toLocaleString()}
                                        </Td>
                                        <Td className="font-medium">Rs. {entry.running_balance.toLocaleString()}</Td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
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
