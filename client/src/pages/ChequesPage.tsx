import { useEffect, useMemo, useState } from "react";
import { Banknote, Check, Plus, Pencil, Trash2, X, Download } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Supplier } from "../lib/types";
import { downloadTabularReport, buildReportFilename, todayLongDate, rangeLabelFor } from "../lib/reportPdf";
import { PageHeader, Card, Table, Th, Td, SortHeader, Button, EmptyState, ErrorText, Badge, RowActions, TabToggle, Input, Label, FormGroup, Dropdown, DatePicker, DateRangePicker, Modal } from "../components/ui";
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

type StatusFilter = "pending" | "all" | "cleared" | "bounced";

// "Pending" = still waiting to clear. For a cheque we wrote that's simply
// 'pending'; for one we received it's anything not yet cleared or bounced
// (in hand, given to a supplier, or deposited).
function matchesStatusFilter(status: string, filter: StatusFilter, issued: boolean): boolean {
  if (filter === "all") return true;
  if (filter === "cleared" || filter === "bounced") return status === filter;
  return issued ? status === "pending" : status !== "cleared" && status !== "bounced";
}

export default function ChequesPage() {
  const [activeTab, setActiveTab] = useState<Tab>("in_hand");
  const [cheques, setCheques] = useState<ChequeRow[]>([]);
  const [issuedCheques, setIssuedCheques] = useState<IssuedChequeRow[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // What the lists show. Open with only the cheques still waiting to clear
  // (the ones that need action); "All", "Cleared" and "Bounced" are one click
  // away, and the period narrows by the date written on the cheque.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [periodStart, setPeriodStart] = useState<string | null>(null);
  const [periodEnd, setPeriodEnd] = useState<string | null>(null);
  // The "In Hand" tab is already just the cheques being held, so a status
  // filter has nothing to add there.
  const statusApplies = activeTab !== "in_hand";
  const periodActive = !!(periodStart || periodEnd);
  const filtersActive = periodActive || (statusApplies && statusFilter !== "pending");

  function inPeriod(chequeDate: string): boolean {
    const day = chequeDate.slice(0, 10);
    return (!periodStart || day >= periodStart) && (!periodEnd || day <= periodEnd);
  }
  const shownCheques = useMemo(
    () => cheques.filter((c) => inPeriod(c.cheque_date) && (!statusApplies || matchesStatusFilter(c.status, statusFilter, false))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cheques, statusFilter, periodStart, periodEnd, statusApplies]
  );
  const shownIssued = useMemo(
    () => issuedCheques.filter((c) => inPeriod(c.cheque_date) && matchesStatusFilter(c.status, statusFilter, true)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [issuedCheques, statusFilter, periodStart, periodEnd]
  );

  const { sorted: sortedCheques, sortKey: receivedSortKey, sortDir: receivedSortDir, toggleSort: toggleReceivedSort } = useSortableData<ChequeRow, ReceivedChequeSortKey>(
    shownCheques,
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
    // The cheque's own date is what matters (when it can be banked / falls
    // due), so the list opens soonest-first by that — not by when it was received.
    "cheque_date",
    "asc"
  );

  const { sorted: sortedIssuedCheques, sortKey: issuedSortKey, sortDir: issuedSortDir, toggleSort: toggleIssuedSort } = useSortableData<IssuedChequeRow, IssuedChequeSortKey>(
    shownIssued,
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
    "cheque_date",
    "asc"
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

  // Exports exactly what's on screen — the active tab with its status and
  // period filters applied, in the order shown.
  const statusLabel: Record<StatusFilter, string> = { pending: "Pending only", all: "All statuses", cleared: "Cleared only", bounced: "Bounced only" };
  const reportPeriod = rangeLabelFor(periodStart, periodEnd);
  const reportScope = statusApplies ? ` · ${statusLabel[statusFilter]}` : "";
  function downloadChequesPdf() {
    if (activeTab === "issued") {
      const total = sortedIssuedCheques.reduce((sum, c) => sum + c.amount, 0);
      downloadTabularReport({
        headerLabel: "M&M Clothing — Cheque Register",
        headerFields: [
          { label: "Report", value: `Cheques Written by Me${reportScope}` },
          { label: "Cheque date", value: reportPeriod },
          { label: "Generated", value: todayLongDate() },
        ],
        rangeLabel: reportPeriod,
        columns: [
          { label: "Cheque date", width: 75 },
          { label: "Cheque #", width: 90 },
          { label: "Bank", width: 90 },
          { label: "Issued", width: 75 },
          { label: "Amount", width: 80, align: "right" },
          { label: "To supplier", width: 105 },
        ],
        rows: sortedIssuedCheques.map((c) => ({
          cells: [c.cheque_date.slice(0, 10), c.cheque_number, c.bank_name, c.date_issued.slice(0, 10), `Rs. ${c.amount.toLocaleString()}`, c.supplier_name],
        })),
        totalSummary: {
          label: "Total",
          amount: `Rs. ${total.toLocaleString()}`,
          note: `${sortedIssuedCheques.length} cheque${sortedIssuedCheques.length !== 1 ? "s" : ""}`,
        },
        filename: buildReportFilename("Cheques Written By Me", new Date().toISOString().slice(0, 10)),
      });
    } else {
      const total = sortedCheques.reduce((sum, c) => sum + c.amount, 0);
      downloadTabularReport({
        headerLabel: "M&M Clothing — Cheque Register",
        headerFields: [
          { label: "Report", value: `Cheques — ${tabLabel[activeTab]}${reportScope}` },
          { label: "Cheque date", value: reportPeriod },
          { label: "Generated", value: todayLongDate() },
        ],
        rangeLabel: reportPeriod,
        columns: [
          { label: "Cheque date", width: 75 },
          { label: "Cheque #", width: 90 },
          { label: "Bank", width: 90 },
          { label: "Received", width: 75 },
          { label: "Amount", width: 80, align: "right" },
          { label: "From", width: 105 },
        ],
        rows: sortedCheques.map((c) => ({
          cells: [c.cheque_date.slice(0, 10), c.cheque_number, c.bank_name, c.date_received.slice(0, 10), `Rs. ${c.amount.toLocaleString()}`, `${c.customer_name} (${c.customer_code})`],
        })),
        totalSummary: {
          label: "Total",
          amount: `Rs. ${total.toLocaleString()}`,
          note: `${sortedCheques.length} cheque${sortedCheques.length !== 1 ? "s" : ""}`,
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
              disabled={activeTab === "issued" ? sortedIssuedCheques.length === 0 : sortedCheques.length === 0}
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

      <div className="flex items-center gap-3 flex-wrap mb-4">
        {statusApplies && (
          <TabToggle
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: "pending", label: "Pending" },
              { value: "all", label: "All" },
              { value: "cleared", label: "Cleared" },
              { value: "bounced", label: "Bounced" },
            ]}
          />
        )}
        <DateRangePicker
          startDate={periodStart}
          endDate={periodEnd}
          onChange={(s, e) => {
            setPeriodStart(s);
            setPeriodEnd(e);
          }}
        />
        {filtersActive && (
          <button
            type="button"
            onClick={() => {
              setStatusFilter("pending");
              setPeriodStart(null);
              setPeriodEnd(null);
            }}
            className="text-xs text-gray-500 hover:text-gray-800 underline"
          >
            Reset filters
          </button>
        )}
        {!loading && (
          <span className="ml-auto text-xs text-gray-500 tabular-nums">
            {(activeTab === "issued" ? sortedIssuedCheques : sortedCheques).length} cheque
            {(activeTab === "issued" ? sortedIssuedCheques : sortedCheques).length !== 1 ? "s" : ""} · Rs.{" "}
            {(activeTab === "issued" ? sortedIssuedCheques : sortedCheques).reduce((sum, c) => sum + c.amount, 0).toLocaleString()}
            <span className="text-gray-400"> · by cheque date</span>
          </span>
        )}
      </div>

      {error && <ErrorText>{error}</ErrorText>}
      {actionError && <ErrorText>{actionError}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : activeTab === "issued" ? (
        issuedCheques.length === 0 ? (
          <EmptyState icon={Banknote} title="No self-written cheques recorded" subtitle="Cheques you write directly to a supplier will show here." />
        ) : sortedIssuedCheques.length === 0 ? (
          <EmptyState icon={Banknote} title="No cheques match these filters" subtitle="Try “All” under status, or a wider period." />
        ) : (
          <Card className="p-0 overflow-hidden">
            <Table>
              <thead>
                <tr>
                  <SortHeader<IssuedChequeSortKey> label="Cheque date" sortKey="cheque_date" activeKey={issuedSortKey} dir={issuedSortDir} onClick={toggleIssuedSort} />
                  <SortHeader<IssuedChequeSortKey> label="Cheque #" sortKey="number" activeKey={issuedSortKey} dir={issuedSortDir} onClick={toggleIssuedSort} />
                  <SortHeader<IssuedChequeSortKey> label="Bank" sortKey="bank" activeKey={issuedSortKey} dir={issuedSortDir} onClick={toggleIssuedSort} />
                  <SortHeader<IssuedChequeSortKey> label="Issued" sortKey="issued" activeKey={issuedSortKey} dir={issuedSortDir} onClick={toggleIssuedSort} />
                  <SortHeader<IssuedChequeSortKey> label="Amount" sortKey="amount" activeKey={issuedSortKey} dir={issuedSortDir} onClick={toggleIssuedSort} />
                  <SortHeader<IssuedChequeSortKey> label="To supplier" sortKey="to" activeKey={issuedSortKey} dir={issuedSortDir} onClick={toggleIssuedSort} />
                  <SortHeader<IssuedChequeSortKey> label="Status" sortKey="status" activeKey={issuedSortKey} dir={issuedSortDir} onClick={toggleIssuedSort} />
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {sortedIssuedCheques.map((c) => (
                  <tr key={c.id}>
                    <Td className="font-medium">{shortDate(c.cheque_date)}</Td>
                    <Td>{c.cheque_number}</Td>
                    <Td>{c.bank_name}</Td>
                    <Td>{c.date_issued.slice(0, 10)}</Td>
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
      ) : sortedCheques.length === 0 ? (
        <EmptyState icon={Banknote} title="No cheques match these filters" subtitle="Try “All” under status, or a wider period." />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <SortHeader<ReceivedChequeSortKey> label="Cheque date" sortKey="cheque_date" activeKey={receivedSortKey} dir={receivedSortDir} onClick={toggleReceivedSort} />
                <SortHeader<ReceivedChequeSortKey> label="Cheque #" sortKey="number" activeKey={receivedSortKey} dir={receivedSortDir} onClick={toggleReceivedSort} />
                <SortHeader<ReceivedChequeSortKey> label="Bank" sortKey="bank" activeKey={receivedSortKey} dir={receivedSortDir} onClick={toggleReceivedSort} />
                <SortHeader<ReceivedChequeSortKey> label="Received" sortKey="received" activeKey={receivedSortKey} dir={receivedSortDir} onClick={toggleReceivedSort} />
                <SortHeader<ReceivedChequeSortKey> label="Amount" sortKey="amount" activeKey={receivedSortKey} dir={receivedSortDir} onClick={toggleReceivedSort} />
                <SortHeader<ReceivedChequeSortKey> label="From" sortKey="from" activeKey={receivedSortKey} dir={receivedSortDir} onClick={toggleReceivedSort} />
                <SortHeader<ReceivedChequeSortKey> label="Status" sortKey="status" activeKey={receivedSortKey} dir={receivedSortDir} onClick={toggleReceivedSort} />
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {sortedCheques.map((c) => (
                <tr key={c.id}>
                  <Td className="font-medium">{shortDate(c.cheque_date)}</Td>
                  <Td>{c.cheque_number}</Td>
                  <Td>{c.bank_name}</Td>
                  <Td>{c.date_received.slice(0, 10)}</Td>
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
        <Modal
          size="sm"
          onClose={() => setClearingId(null)}
          title="Mark cheque cleared"
          subtitle={(() => {
            const cheque = cheques.find((c) => c.id === clearingId);
            const wasTransferred = clearingIsIssued || !!cheque?.transferred_to_supplier_name;
            return wasTransferred
              ? "This records the cash book expense for paying the supplier with this cheque."
              : "This records the cash book income for this cheque, since the money is now real.";
          })()}
          footer={
            <>
              <Button onClick={() => setClearingId(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => handleClear(clearingId, clearingIsIssued)} disabled={clearSubmitting}>
                {clearSubmitting ? "Saving..." : "Confirm cleared"}
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600 mb-3">Confirm this cheque has cleared.</p>
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
        </Modal>
      )}

      {bouncingId !== null && (
        <Modal
          size="sm"
          onClose={() => setBouncingId(null)}
          title="Mark cheque bounced"
          subtitle="The originating customer's sales revert to unpaid. If this cheque was already given to a supplier, their balance is reinstated too."
          footer={
            <>
              <Button onClick={() => setBouncingId(null)}>Cancel</Button>
              <Button variant="danger" onClick={() => handleBounce(bouncingId, bouncingIsIssued)} disabled={bounceSubmitting}>
                {bounceSubmitting ? "Saving..." : "Confirm bounced"}
              </Button>
            </>
          }
        >
              <FormGroup>
                <Label>Reason</Label>
                <Input value={bounceReason} onChange={(e) => setBounceReason(e.target.value)} />
              </FormGroup>
        </Modal>
      )}

      {showIssueForm && (
        <Modal
          size="xl"
          onClose={() => setShowIssueForm(false)}
          title="Issue a cheque"
          subtitle="A cheque written from your own account, straight to a supplier. Their balance reduces now; the Cash Book updates once it clears."
          footer={
            <>
              <Button onClick={() => setShowIssueForm(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleIssueCheque} disabled={issueSubmitting}>
                {issueSubmitting ? "Saving..." : "Record cheque"}
              </Button>
            </>
          }
        >
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
        </Modal>
      )}

      {editingCheque && (
        <Modal
          size="sm"
          onClose={() => setEditingCheque(null)}
          title="Edit cheque"
          subtitle={
            editingCheque.isIssued
              ? "Changing the amount adjusts the supplier's balance to match."
              : "Changing the amount re-applies it against the customer's outstanding sales."
          }
          footer={
            <>
              <Button onClick={() => setEditingCheque(null)}>Cancel</Button>
              <Button variant="primary" onClick={saveEdit} disabled={editSubmitting}>
                {editSubmitting ? "Saving..." : "Save changes"}
              </Button>
            </>
          }
        >
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
        </Modal>
      )}
    </div>
  );
}
