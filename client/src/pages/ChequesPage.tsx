import { useEffect, useState } from "react";
import { Banknote, CheckCircle2, XCircle, Plus, Pencil, Trash2, X } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Supplier } from "../lib/types";
import { PageHeader, Card, Table, Th, Td, Button, EmptyState, ErrorText, Badge, TabToggle, Input, Label, FormGroup, Dropdown, DatePicker } from "../components/ui";

interface ChequeRow {
  id: number;
  cheque_number: string;
  bank_name: string;
  amount: number;
  cheque_date: string;
  date_received: string;
  customer_id: number;
  customer_name: string;
  customer_code: string;
  status: "in_hand" | "given_to_supplier" | "deposited" | "cleared" | "bounced";
  cleared_at: string | null;
  bounced_at: string | null;
  bounced_reason: string | null;
  notes: string | null;
  transfer_id: number | null;
  transferred_to_supplier_id: number | null;
  transferred_to_supplier_name: string | null;
  transfer_date: string | null;
}

interface IssuedChequeRow {
  id: number;
  cheque_number: string;
  bank_name: string;
  amount: number;
  cheque_date: string;
  date_issued: string;
  supplier_id: number;
  supplier_name: string;
  status: "pending" | "cleared" | "bounced";
  bounced_reason: string | null;
}

function statusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "cleared") return "success";
  if (status === "bounced") return "danger";
  return "warning";
}

// Short date for the cheque's own date — e.g. "15 Sep 26" — the date
// that actually matters for whether it's bankable, distinct from when
// it was received or issued.
function shortDate(iso: string): string {
  const d = new Date(iso.slice(0, 10) + "T00:00:00");
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" });
}

type Tab = "in_hand" | "all" | "issued";

export default function ChequesPage() {
  const [activeTab, setActiveTab] = useState<Tab>("in_hand");
  const [cheques, setCheques] = useState<ChequeRow[]>([]);
  const [issuedCheques, setIssuedCheques] = useState<IssuedChequeRow[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [clearingId, setClearingId] = useState<number | null>(null);
  const [clearingIsIssued, setClearingIsIssued] = useState(false);
  const [clearMethod, setClearMethod] = useState<"cash" | "bank_transfer">("bank_transfer");
  const [clearSubmitting, setClearSubmitting] = useState(false);

  const [bouncingId, setBouncingId] = useState<number | null>(null);
  const [bouncingIsIssued, setBouncingIsIssued] = useState(false);
  const [bounceReason, setBounceReason] = useState("");
  const [bounceSubmitting, setBounceSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Issuing a self-written cheque directly to a supplier — no customer
  // or transfer involved, since it's already at its final destination
  // the moment it's written.
  const [showIssueForm, setShowIssueForm] = useState(false);
  const [issueSupplierId, setIssueSupplierId] = useState("");
  const [issueChequeNumber, setIssueChequeNumber] = useState("");
  const [issueBankName, setIssueBankName] = useState("");
  const [issueAmount, setIssueAmount] = useState("");
  const [issueChequeDate, setIssueChequeDate] = useState("");
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issueSubmitting, setIssueSubmitting] = useState(false);

  // Editing an existing cheque — only ever offered while it's still
  // editable (in_hand for received, pending for issued), enforced again
  // server-side either way.
  const [editingCheque, setEditingCheque] = useState<{ id: number; isIssued: boolean } | null>(null);
  const [editChequeNumber, setEditChequeNumber] = useState("");
  const [editBankName, setEditBankName] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editChequeDate, setEditChequeDate] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      if (activeTab === "issued") {
        const [rows, supplierList] = await Promise.all([
          api.get<IssuedChequeRow[]>("/cheques/issued"),
          suppliers.length > 0 ? Promise.resolve(suppliers) : api.get<Supplier[]>("/suppliers"),
        ]);
        setIssuedCheques(rows);
        if (suppliers.length === 0) setSuppliers(supplierList);
      } else {
        const query = activeTab === "in_hand" ? "?status=in_hand" : "";
        setCheques(await api.get<ChequeRow[]>(`/cheques${query}`));
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load cheques");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  async function handleClear(id: number, isIssued: boolean) {
    setActionError(null);
    setClearSubmitting(true);
    try {
      const path = isIssued ? `/cheques/issued/${id}/clear` : `/cheques/${id}/clear`;
      await api.put(path, { payment_method: clearMethod });
      setClearingId(null);
      load();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : "Failed to mark this cheque cleared");
    } finally {
      setClearSubmitting(false);
    }
  }

  async function handleBounce(id: number, isIssued: boolean) {
    setActionError(null);
    if (!bounceReason.trim()) {
      setActionError("A reason is required");
      return;
    }
    setBounceSubmitting(true);
    try {
      const path = isIssued ? `/cheques/issued/${id}/bounce` : `/cheques/${id}/bounce`;
      const result = await api.put<{ affected_supplier: boolean }>(path, { reason: bounceReason.trim() });
      setBouncingId(null);
      setBounceReason("");
      load();
      if (!isIssued && result.affected_supplier) {
        alert(
          "This cheque had already been passed to a supplier — their balance has been reinstated as owed, alongside this customer's sales reverting to unpaid."
        );
      }
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : "Failed to mark this cheque bounced");
    } finally {
      setBounceSubmitting(false);
    }
  }

  async function handleIssueCheque() {
    setIssueError(null);
    if (!issueSupplierId) {
      setIssueError("Select a supplier");
      return;
    }
    const amount = parseFloat(issueAmount);
    if (!amount || amount <= 0) {
      setIssueError("Enter a valid amount");
      return;
    }
    if (!issueChequeNumber.trim() || !issueBankName.trim() || !issueChequeDate) {
      setIssueError("Cheque number, bank name, and date are all required");
      return;
    }
    setIssueSubmitting(true);
    try {
      await api.post("/cheques/issued", {
        cheque_number: issueChequeNumber.trim(),
        bank_name: issueBankName.trim(),
        amount,
        cheque_date: issueChequeDate,
        supplier_id: parseInt(issueSupplierId, 10),
      });
      setShowIssueForm(false);
      setIssueSupplierId("");
      setIssueChequeNumber("");
      setIssueBankName("");
      setIssueAmount("");
      setIssueChequeDate("");
      load();
    } catch (err) {
      setIssueError(err instanceof ApiRequestError ? err.message : "Failed to record this cheque");
    } finally {
      setIssueSubmitting(false);
    }
  }

  function openEdit(id: number, isIssued: boolean, current: { cheque_number: string; bank_name: string; amount: number; cheque_date: string }) {
    setEditingCheque({ id, isIssued });
    setEditChequeNumber(current.cheque_number);
    setEditBankName(current.bank_name);
    setEditAmount(String(current.amount));
    setEditChequeDate(current.cheque_date.slice(0, 10));
    setEditError(null);
  }

  async function saveEdit() {
    if (!editingCheque) return;
    setEditError(null);
    const amt = parseFloat(editAmount);
    if (!editChequeNumber.trim() || !editBankName.trim() || !amt || amt <= 0 || !editChequeDate) {
      setEditError("Cheque number, bank name, a valid amount, and date are all required");
      return;
    }
    setEditSubmitting(true);
    try {
      const path = editingCheque.isIssued ? `/cheques/issued/${editingCheque.id}` : `/cheques/${editingCheque.id}`;
      await api.put(path, {
        cheque_number: editChequeNumber.trim(),
        bank_name: editBankName.trim(),
        amount: amt,
        cheque_date: editChequeDate,
      });
      setEditingCheque(null);
      load();
    } catch (err) {
      setEditError(err instanceof ApiRequestError ? err.message : "Failed to update this cheque");
    } finally {
      setEditSubmitting(false);
    }
  }

  async function handleDeleteCheque(id: number, isIssued: boolean) {
    if (!confirm("Delete this cheque? This can't be undone.")) return;
    setActionError(null);
    setDeletingId(id);
    try {
      const path = isIssued ? `/cheques/issued/${id}` : `/cheques/${id}`;
      await api.delete(path);
      load();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : "Failed to delete this cheque");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Cheques"
        subtitle="Track cheques from receipt through to clearing — including ones handed on to a supplier, or written from your own account."
        action={
          <div className="flex items-center gap-3">
            <TabToggle
              value={activeTab}
              onChange={setActiveTab}
              options={[
                { value: "in_hand", label: "In Hand" },
                { value: "all", label: "All Cheques" },
                { value: "issued", label: "Written by Me" },
              ]}
            />
            {activeTab === "issued" && (
              <Button variant="primary" onClick={() => setShowIssueForm(true)} className="inline-flex items-center gap-1.5">
                <Plus size={15} />
                Issue a cheque
              </Button>
            )}
          </div>
        }
      />

      {error && <ErrorText>{error}</ErrorText>}
      {actionError && <ErrorText>{actionError}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : activeTab === "issued" ? (
        issuedCheques.length === 0 ? (
          <EmptyState icon={Banknote} title="No self-written cheques recorded" subtitle="Cheques you write directly to a supplier will show here." />
        ) : (
          <Card className="p-0 overflow-hidden">
            <Table>
              <thead>
                <tr>
                  <Th>Issued</Th>
                  <Th>Cheque #</Th>
                  <Th>Bank</Th>
                  <Th>Cheque date</Th>
                  <Th>Amount</Th>
                  <Th>To supplier</Th>
                  <Th>Status</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {issuedCheques.map((c) => (
                  <tr key={c.id}>
                    <Td>{c.date_issued.slice(0, 10)}</Td>
                    <Td>{c.cheque_number}</Td>
                    <Td>{c.bank_name}</Td>
                    <Td className="font-medium">{shortDate(c.cheque_date)}</Td>
                    <Td>Rs. {c.amount.toLocaleString()}</Td>
                    <Td>{c.supplier_name}</Td>
                    <Td>
                      <Badge label={c.status} tone={statusTone(c.status)} />
                      {c.status === "bounced" && c.bounced_reason && (
                        <div className="text-xs text-gray-400 mt-0.5">{c.bounced_reason}</div>
                      )}
                    </Td>
                    <Td>
                      {c.status === "pending" && (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => openEdit(c.id, true, c)}
                            className="text-gray-400 hover:text-gray-700"
                            title="Edit"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            onClick={() => handleDeleteCheque(c.id, true)}
                            disabled={deletingId === c.id}
                            className="text-gray-400 hover:text-red-600"
                            title="Delete"
                          >
                            <Trash2 size={14} />
                          </button>
                          <button
                            onClick={() => {
                              setClearingId(c.id);
                              setClearingIsIssued(true);
                              setClearMethod("bank_transfer");
                            }}
                            className="text-gray-400 hover:text-green-600"
                            title="Mark cleared"
                          >
                            <CheckCircle2 size={16} />
                          </button>
                          <button
                            onClick={() => {
                              setBouncingId(c.id);
                              setBouncingIsIssued(true);
                              setBounceReason("");
                            }}
                            className="text-gray-400 hover:text-red-500"
                            title="Mark bounced"
                          >
                            <XCircle size={16} />
                          </button>
                        </div>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )
      ) : cheques.length === 0 ? (
        <EmptyState
          icon={Banknote}
          title={activeTab === "in_hand" ? "No cheques currently in hand" : "No cheques recorded"}
          subtitle={
            activeTab === "in_hand" ? "Cheques received from customers, not yet deposited or passed on, will show here." : undefined
          }
        />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th>Received</Th>
                <Th>Cheque #</Th>
                <Th>Bank</Th>
                <Th>Cheque date</Th>
                <Th>Amount</Th>
                <Th>From</Th>
                <Th>Status</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {cheques.map((c) => (
                <tr key={c.id}>
                  <Td>{c.date_received.slice(0, 10)}</Td>
                  <Td>{c.cheque_number}</Td>
                  <Td>{c.bank_name}</Td>
                  <Td className="font-medium">{shortDate(c.cheque_date)}</Td>
                  <Td>Rs. {c.amount.toLocaleString()}</Td>
                  <Td>
                    {c.customer_name} ({c.customer_code})
                    {c.transferred_to_supplier_name && (
                      <div className="text-xs text-gray-400 mt-0.5">→ given to {c.transferred_to_supplier_name}</div>
                    )}
                  </Td>
                  <Td>
                    <Badge label={c.status.replace("_", " ")} tone={statusTone(c.status)} />
                    {c.status === "bounced" && c.bounced_reason && (
                      <div className="text-xs text-gray-400 mt-0.5">{c.bounced_reason}</div>
                    )}
                  </Td>
                  <Td>
                    {(c.status === "in_hand" || c.status === "given_to_supplier" || c.status === "deposited") && (
                      <div className="flex items-center gap-2">
                        {c.status === "in_hand" && (
                          <>
                            <button onClick={() => openEdit(c.id, false, c)} className="text-gray-400 hover:text-gray-700" title="Edit">
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => handleDeleteCheque(c.id, false)}
                              disabled={deletingId === c.id}
                              className="text-gray-400 hover:text-red-600"
                              title="Delete"
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => {
                            setClearingId(c.id);
                            setClearingIsIssued(false);
                            setClearMethod("bank_transfer");
                          }}
                          className="text-gray-400 hover:text-green-600"
                          title="Mark cleared"
                        >
                          <CheckCircle2 size={16} />
                        </button>
                        <button
                          onClick={() => {
                            setBouncingId(c.id);
                            setBouncingIsIssued(false);
                            setBounceReason("");
                          }}
                          className="text-gray-400 hover:text-red-500"
                          title="Mark bounced"
                        >
                          <XCircle size={16} />
                        </button>
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {clearingId !== null && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full shadow-2xl">
            <div className="p-5 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">Mark cheque cleared</h2>
            </div>
            <div className="p-5">
              {(() => {
                const cheque = cheques.find((c) => c.id === clearingId);
                const wasTransferred = clearingIsIssued || !!cheque?.transferred_to_supplier_name;
                return (
                  <>
                    <p className="text-xs text-gray-400 mb-3">
                      {wasTransferred
                        ? "This records the cash book expense for paying the supplier with this cheque."
                        : "This records the cash book income for this cheque, since the money is now real."}
                    </p>
                    {!wasTransferred && (
                      <FormGroup>
                        <Label>Deposited into</Label>
                        <Dropdown
                          value={clearMethod}
                          onChange={(v) => setClearMethod(v as "cash" | "bank_transfer")}
                          options={[
                            { value: "bank_transfer", label: "Bank" },
                            { value: "cash", label: "Cash" },
                          ]}
                        />
                      </FormGroup>
                    )}
                  </>
                );
              })()}
              <div className="flex gap-2 mt-2">
                <Button variant="primary" onClick={() => handleClear(clearingId, clearingIsIssued)} disabled={clearSubmitting}>
                  {clearSubmitting ? "Saving..." : "Confirm cleared"}
                </Button>
                <Button onClick={() => setClearingId(null)}>Cancel</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {bouncingId !== null && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full shadow-2xl">
            <div className="p-5 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">Mark cheque bounced</h2>
            </div>
            <div className="p-5">
              <p className="text-xs text-gray-400 mb-3">
                The originating customer's sales revert to unpaid. If this cheque was already given to a supplier, their balance is
                reinstated too.
              </p>
              <FormGroup>
                <Label>Reason</Label>
                <Input value={bounceReason} onChange={(e) => setBounceReason(e.target.value)} placeholder="e.g. Insufficient funds" />
              </FormGroup>
              <div className="flex gap-2 mt-2">
                <Button variant="danger" onClick={() => handleBounce(bouncingId, bouncingIsIssued)} disabled={bounceSubmitting}>
                  {bounceSubmitting ? "Saving..." : "Confirm bounced"}
                </Button>
                <Button onClick={() => setBouncingId(null)}>Cancel</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showIssueForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full shadow-2xl">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Issue a cheque</h2>
              <button onClick={() => setShowIssueForm(false)} className="text-gray-400 hover:text-gray-600">
                ✕
              </button>
            </div>
            <div className="p-5">
              <p className="text-xs text-gray-400 mb-3">
                A cheque written from your own account, straight to a supplier. Their balance reduces now; the Cash Book updates once
                it clears.
              </p>
              <FormGroup>
                <Label>Supplier</Label>
                <Dropdown
                  value={issueSupplierId}
                  onChange={setIssueSupplierId}
                  searchable
                  placeholder="— Select —"
                  options={suppliers.map((s) => ({ value: String(s.id), label: s.name, sublabel: s.supplier_code }))}
                />
              </FormGroup>
              <FormGroup>
                <Label>Cheque number</Label>
                <Input value={issueChequeNumber} onChange={(e) => setIssueChequeNumber(e.target.value)} />
              </FormGroup>
              <FormGroup>
                <Label>Bank name</Label>
                <Input value={issueBankName} onChange={(e) => setIssueBankName(e.target.value)} />
              </FormGroup>
              <FormGroup>
                <Label>Amount (Rs.)</Label>
                <Input type="number" min="0" value={issueAmount} onChange={(e) => setIssueAmount(e.target.value)} />
              </FormGroup>
              <FormGroup>
                <Label>Cheque date</Label>
                <Input type="date" value={issueChequeDate} onChange={(e) => setIssueChequeDate(e.target.value)} />
              </FormGroup>
              {issueError && <ErrorText>{issueError}</ErrorText>}
              <div className="flex gap-2 mt-2">
                <Button variant="primary" onClick={handleIssueCheque} disabled={issueSubmitting}>
                  {issueSubmitting ? "Saving..." : "Record cheque"}
                </Button>
                <Button onClick={() => setShowIssueForm(false)}>Cancel</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingCheque && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full shadow-2xl">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Edit cheque</h2>
              <button onClick={() => setEditingCheque(null)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5">
              <p className="text-xs text-gray-400 mb-3">
                {editingCheque.isIssued
                  ? "Changing the amount adjusts the supplier's balance to match."
                  : "Changing the amount re-applies it against the customer's outstanding sales."}
              </p>
              <FormGroup>
                <Label>Cheque number</Label>
                <Input value={editChequeNumber} onChange={(e) => setEditChequeNumber(e.target.value)} />
              </FormGroup>
              <FormGroup>
                <Label>Bank name</Label>
                <Input value={editBankName} onChange={(e) => setEditBankName(e.target.value)} />
              </FormGroup>
              <FormGroup>
                <Label>Amount (Rs.)</Label>
                <Input type="number" min="0" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} />
              </FormGroup>
              <FormGroup>
                <Label>Cheque date</Label>
                <DatePicker value={editChequeDate || null} onChange={setEditChequeDate} />
              </FormGroup>
              {editError && <ErrorText>{editError}</ErrorText>}
              <div className="flex gap-2 mt-2">
                <Button variant="primary" onClick={saveEdit} disabled={editSubmitting}>
                  {editSubmitting ? "Saving..." : "Save changes"}
                </Button>
                <Button onClick={() => setEditingCheque(null)}>Cancel</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
