import { useEffect, useState } from "react";
import { Banknote, Check, Plus, Pencil, Trash2, X, Download } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Supplier } from "../lib/types";
import { downloadTabularReport, buildReportFilename, todayLongDate } from "../lib/reportPdf";
import { PageHeader, Card, Table, Th, Td, SortHeader, Button, EmptyState, ErrorText, Badge, RowActions, TabToggle, Input, Label, FormGroup, Dropdown, DatePicker, HelpHint } from "../components/ui";
import { useSortableData } from "../lib/useSortableData";

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
  branch: string | null;
  is_crossed: number;
  payee_name: string | null;
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
  branch: string | null;
  is_crossed: number;
  payee_name: string | null;
}

type ReceivedChequeSortKey = "received" | "number" | "bank" | "cheque_date" | "amount" | "from" | "status";
type IssuedChequeSortKey = "issued" | "number" | "bank" | "cheque_date" | "amount" | "to" | "status";

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

  const { sorted: sortedCheques, sortKey: receivedSortKey, sortDir: receivedSortDir, toggleSort: toggleReceivedSort } = useSortableData<ChequeRow, ReceivedChequeSortKey>(
    cheques,
    (c, key) => {
      switch (key) {
        case "received":
          return c.date_received;
        case "number":
          return c.cheque_number.toLowerCase();
        case "bank":
          return c.bank_name.toLowerCase();
        case "cheque_date":
          return c.cheque_date;
        case "amount":
          return c.amount;
        case "from":
          return c.customer_name.toLowerCase();
        case "status":
          return c.status;
      }
    },
    "received",
    "desc"
  );

  const { sorted: sortedIssuedCheques, sortKey: issuedSortKey, sortDir: issuedSortDir, toggleSort: toggleIssuedSort } = useSortableData<IssuedChequeRow, IssuedChequeSortKey>(
    issuedCheques,
    (c, key) => {
      switch (key) {
        case "issued":
          return c.date_issued;
        case "number":
          return c.cheque_number.toLowerCase();
        case "bank":
          return c.bank_name.toLowerCase();
        case "cheque_date":
          return c.cheque_date;
        case "amount":
          return c.amount;
        case "to":
          return c.supplier_name.toLowerCase();
        case "status":
          return c.status;
      }
    },
    "issued",
    "desc"
  );

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
  const [issueBranch, setIssueBranch] = useState("");
  const [issueIsCrossed, setIssueIsCrossed] = useState(true);
  // Most cheques we write are made out to "Cash", not to the supplier
  // by name — this defaults to that, and only asks for a name when the
  // person explicitly says it's payable to someone specific.
  const [issuePayCash, setIssuePayCash] = useState(true);
  const [issuePayeeName, setIssuePayeeName] = useState("");
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
    if (!issuePayCash && !issuePayeeName.trim()) {
      setIssueError("Enter who the cheque is payable to, or switch back to Cash");
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
        branch: issueBranch.trim() || undefined,
        is_crossed: issueIsCrossed,
        payee_name: issuePayCash ? undefined : issuePayeeName.trim(),
      });
      setShowIssueForm(false);
      setIssueSupplierId("");
      setIssueChequeNumber("");
      setIssueBankName("");
      setIssueBranch("");
      setIssueIsCrossed(true);
      setIssuePayCash(true);
      setIssuePayeeName("");
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

  const tabLabel: Record<Tab, string> = { in_hand: "In Hand", all: "All Cheques", issued: "Written by Me" };

  // Exports exactly the active tab's currently-loaded rows — there's no
  // date filter on this page (cheque volumes here are small enough that
  // one hasn't been needed), so this is "what's on screen", same rule
  // as everywhere else this report pattern is used.
  function downloadChequesPdf() {
    if (activeTab === "issued") {
      const total = issuedCheques.reduce((sum, c) => sum + c.amount, 0);
      downloadTabularReport({
        headerLabel: "M&M Clothing — Cheque Register",
        headerFields: [
          { label: "Report", value: "Cheques Written by Me" },
          { label: "Period", value: "All records" },
          { label: "Generated", value: todayLongDate() },
        ],
        rangeLabel: "All records",
        columns: [
          { label: "Issued", width: 75 },
          { label: "Cheque #", width: 90 },
          { label: "Bank", width: 90 },
          { label: "Cheque date", width: 75 },
          { label: "Amount", width: 80, align: "right" },
          { label: "To supplier", width: 105 },
        ],
        rows: issuedCheques.map((c) => ({
          cells: [c.date_issued.slice(0, 10), c.cheque_number, c.bank_name, c.cheque_date.slice(0, 10), `Rs. ${c.amount.toLocaleString()}`, c.supplier_name],
        })),
        totalSummary: {
          label: "Total",
          amount: `Rs. ${total.toLocaleString()}`,
          note: `${issuedCheques.length} cheque${issuedCheques.length !== 1 ? "s" : ""}`,
        },
        filename: buildReportFilename("Cheques Written By Me", new Date().toISOString().slice(0, 10)),
      });
    } else {
      const total = cheques.reduce((sum, c) => sum + c.amount, 0);
      downloadTabularReport({
        headerLabel: "M&M Clothing — Cheque Register",
        headerFields: [
          { label: "Report", value: `Cheques — ${tabLabel[activeTab]}` },
          { label: "Period", value: "All records" },
          { label: "Generated", value: todayLongDate() },
        ],
        rangeLabel: "All records",
        columns: [
          { label: "Received", width: 75 },
          { label: "Cheque #", width: 90 },
          { label: "Bank", width: 90 },
          { label: "Cheque date", width: 75 },
          { label: "Amount", width: 80, align: "right" },
          { label: "From", width: 105 },
        ],
        rows: cheques.map((c) => ({
          cells: [c.date_received.slice(0, 10), c.cheque_number, c.bank_name, c.cheque_date.slice(0, 10), `Rs. ${c.amount.toLocaleString()}`, `${c.customer_name} (${c.customer_code})`],
        })),
        totalSummary: {
          label: "Total",
          amount: `Rs. ${total.toLocaleString()}`,
          note: `${cheques.length} cheque${cheques.length !== 1 ? "s" : ""}`,
        },
        filename: buildReportFilename(`Cheques ${tabLabel[activeTab]}`, new Date().toISOString().slice(0, 10)),
      });
    }
  }

  return (
    <div>
      <PageHeader
        title="Cheques"
        subtitle="Track every cheque from receipt to clearing."
        action={
          <div className="flex items-center gap-3 flex-wrap">
            <TabToggle
              value={activeTab}
              onChange={setActiveTab}
              options={[
                { value: "in_hand", label: "In Hand" },
                { value: "all", label: "All Cheques" },
                { value: "issued", label: "Written by Me" },
              ]}
            />
            <Button
              onClick={downloadChequesPdf}
              disabled={activeTab === "issued" ? issuedCheques.length === 0 : cheques.length === 0}
              className="inline-flex items-center gap-1.5"
            >
              <Download size={14} />
              Download PDF
            </Button>
            {activeTab === "issued" && (
              <Button variant="primary" onClick={() => setShowIssueForm(true)} className="inline-flex items-center gap-1.5">
                <Plus size={14} />
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
                  <SortHeader<IssuedChequeSortKey> label="Issued" sortKey="issued" activeKey={issuedSortKey} dir={issuedSortDir} onClick={toggleIssuedSort} />
                  <SortHeader<IssuedChequeSortKey> label="Cheque #" sortKey="number" activeKey={issuedSortKey} dir={issuedSortDir} onClick={toggleIssuedSort} />
                  <SortHeader<IssuedChequeSortKey> label="Bank" sortKey="bank" activeKey={issuedSortKey} dir={issuedSortDir} onClick={toggleIssuedSort} />
                  <SortHeader<IssuedChequeSortKey> label="Cheque date" sortKey="cheque_date" activeKey={issuedSortKey} dir={issuedSortDir} onClick={toggleIssuedSort} />
                  <SortHeader<IssuedChequeSortKey> label="Amount" sortKey="amount" activeKey={issuedSortKey} dir={issuedSortDir} onClick={toggleIssuedSort} />
                  <SortHeader<IssuedChequeSortKey> label="To supplier" sortKey="to" activeKey={issuedSortKey} dir={issuedSortDir} onClick={toggleIssuedSort} />
                  <SortHeader<IssuedChequeSortKey> label="Status" sortKey="status" activeKey={issuedSortKey} dir={issuedSortDir} onClick={toggleIssuedSort} />
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {sortedIssuedCheques.map((c) => (
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
                    <Td className="text-right">
                      {c.status === "pending" && (
                        <RowActions
                          actions={[
                            { label: "Edit", icon: <Pencil size={14} />, onClick: () => openEdit(c.id, true, c) },
                            { label: "Delete", icon: <Trash2 size={14} />, tone: "bad", disabled: deletingId === c.id, onClick: () => handleDeleteCheque(c.id, true) },
                            {
                              label: "Mark cleared",
                              icon: <Check size={14} />,
                              tone: "good",
                              onClick: () => {
                                setClearingId(c.id);
                                setClearingIsIssued(true);
                                setClearMethod("bank_transfer");
                              },
                            },
                            {
                              label: "Mark bounced",
                              icon: <X size={14} />,
                              tone: "bad",
                              onClick: () => {
                                setBouncingId(c.id);
                                setBouncingIsIssued(true);
                                setBounceReason("");
                              },
                            },
                          ]}
                        />
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
                <SortHeader<ReceivedChequeSortKey> label="Received" sortKey="received" activeKey={receivedSortKey} dir={receivedSortDir} onClick={toggleReceivedSort} />
                <SortHeader<ReceivedChequeSortKey> label="Cheque #" sortKey="number" activeKey={receivedSortKey} dir={receivedSortDir} onClick={toggleReceivedSort} />
                <SortHeader<ReceivedChequeSortKey> label="Bank" sortKey="bank" activeKey={receivedSortKey} dir={receivedSortDir} onClick={toggleReceivedSort} />
                <SortHeader<ReceivedChequeSortKey> label="Cheque date" sortKey="cheque_date" activeKey={receivedSortKey} dir={receivedSortDir} onClick={toggleReceivedSort} />
                <SortHeader<ReceivedChequeSortKey> label="Amount" sortKey="amount" activeKey={receivedSortKey} dir={receivedSortDir} onClick={toggleReceivedSort} />
                <SortHeader<ReceivedChequeSortKey> label="From" sortKey="from" activeKey={receivedSortKey} dir={receivedSortDir} onClick={toggleReceivedSort} />
                <SortHeader<ReceivedChequeSortKey> label="Status" sortKey="status" activeKey={receivedSortKey} dir={receivedSortDir} onClick={toggleReceivedSort} />
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {sortedCheques.map((c) => (
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
                    <Badge label={c.status.replace(/_/g, " ")} tone={statusTone(c.status)} />
                    {c.status === "bounced" && c.bounced_reason && (
                      <div className="text-xs text-gray-400 mt-0.5">{c.bounced_reason}</div>
                    )}
                  </Td>
                  <Td className="text-right">
                    {(c.status === "in_hand" || c.status === "given_to_supplier" || c.status === "deposited") && (
                      <RowActions
                        actions={[
                          ...(c.status === "in_hand"
                            ? [
                                { label: "Edit", icon: <Pencil size={14} />, onClick: () => openEdit(c.id, false, c) },
                                { label: "Delete", icon: <Trash2 size={14} />, tone: "bad" as const, disabled: deletingId === c.id, onClick: () => handleDeleteCheque(c.id, false) },
                              ]
                            : []),
                          {
                            label: "Mark cleared",
                            icon: <Check size={14} />,
                            tone: "good" as const,
                            onClick: () => {
                              setClearingId(c.id);
                              setClearingIsIssued(false);
                              setClearMethod("bank_transfer");
                            },
                          },
                          {
                            label: "Mark bounced",
                            icon: <X size={14} />,
                            tone: "bad" as const,
                            onClick: () => {
                              setBouncingId(c.id);
                              setBouncingIsIssued(false);
                              setBounceReason("");
                            },
                          },
                        ]}
                      />
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
              <h2 className="text-base font-semibold text-gray-900">
                Mark cheque cleared
                {(() => {
                  const cheque = cheques.find((c) => c.id === clearingId);
                  const wasTransferred = clearingIsIssued || !!cheque?.transferred_to_supplier_name;
                  return (
                    <HelpHint
                      text={
                        wasTransferred
                          ? "This records the cash book expense for paying the supplier with this cheque."
                          : "This records the cash book income for this cheque, since the money is now real."
                      }
                    />
                  );
                })()}
              </h2>
            </div>
            <div className="p-5">
              {(() => {
                const cheque = cheques.find((c) => c.id === clearingId);
                const wasTransferred = clearingIsIssued || !!cheque?.transferred_to_supplier_name;
                return (
                  <>
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
              <h2 className="text-base font-semibold text-gray-900">
                Mark cheque bounced
                <HelpHint text="The originating customer's sales revert to unpaid. If this cheque was already given to a supplier, their balance is reinstated too." />
              </h2>
            </div>
            <div className="p-5">
              <FormGroup>
                <Label>Reason</Label>
                <Input value={bounceReason} onChange={(e) => setBounceReason(e.target.value)} />
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
          <div className="bg-white rounded-2xl max-w-xl w-full shadow-2xl">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">
                Issue a cheque
                <HelpHint text="A cheque written from your own account, straight to a supplier. Their balance reduces now; the Cash Book updates once it clears." />
              </h2>
              <button onClick={() => setShowIssueForm(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            {/* Laid out like the cheque itself reads — bank details up
                top, payee and amount in the middle, terms last — instead
                of one long stacked column. */}
            <div className="p-5">
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
              <div className="grid grid-cols-2 gap-x-3">
                <FormGroup>
                  <Label>Bank name</Label>
                  <Input value={issueBankName} onChange={(e) => setIssueBankName(e.target.value)} />
                </FormGroup>
                <FormGroup>
                  <Label>Branch (optional)</Label>
                  <Input value={issueBranch} onChange={(e) => setIssueBranch(e.target.value)} />
                </FormGroup>
                <FormGroup>
                  <Label>Cheque number</Label>
                  <Input value={issueChequeNumber} onChange={(e) => setIssueChequeNumber(e.target.value)} />
                </FormGroup>
                <FormGroup>
                  <Label>Cheque date</Label>
                  <Input type="date" value={issueChequeDate} onChange={(e) => setIssueChequeDate(e.target.value)} />
                </FormGroup>
              </div>
              <div className="grid grid-cols-2 gap-x-3">
                <FormGroup>
                  <Label>Amount (Rs.)</Label>
                  <Input type="number" min="0" value={issueAmount} onChange={(e) => setIssueAmount(e.target.value)} />
                </FormGroup>
                <FormGroup>
                  <Label>Payable to</Label>
                  <TabToggle
                    value={issuePayCash ? "cash" : "name"}
                    onChange={(v) => setIssuePayCash(v === "cash")}
                    options={[
                      { value: "cash", label: "Cash" },
                      { value: "name", label: "A name" },
                    ]}
                  />
                </FormGroup>
              </div>
              <FormGroup>
                <Label>Who the cheque is made out to</Label>
                <Input
                  value={issuePayeeName}
                  onChange={(e) => setIssuePayeeName(e.target.value)}
                  disabled={issuePayCash}
                  className={issuePayCash ? "opacity-40 cursor-not-allowed" : ""}
                />
              </FormGroup>
              <label className="flex items-center gap-1.5 text-xs text-gray-600 mb-3">
                <input
                  type="checkbox"
                  checked={issueIsCrossed}
                  onChange={(e) => setIssueIsCrossed(e.target.checked)}
                  className="rounded border-gray-300"
                />
                Crossed cheque
              </label>
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
              <h2 className="text-base font-semibold text-gray-900">
                Edit cheque
                <HelpHint
                  text={
                    editingCheque.isIssued
                      ? "Changing the amount adjusts the supplier's balance to match."
                      : "Changing the amount re-applies it against the customer's outstanding sales."
                  }
                />
              </h2>
              <button onClick={() => setEditingCheque(null)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5">
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
