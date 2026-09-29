import { useState, useEffect, Fragment } from "react";
import { RotateCcw, AlertTriangle, ChevronDown, ChevronRight, Download } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Sale, ReturnRequest } from "../lib/types";
import { useAuth } from "../context/AuthContext";
import { downloadTabularReport, rangeLabelFor, buildReportFilename, todayLongDate } from "../lib/reportPdf";
import {
  PageHeader,
  Card,
  Input,
  Dropdown,
  Label,
  FormGroup,
  ErrorText,
  SuccessText,
  Button,
  Table,
  Th,
  Td,
  Badge,
  TabToggle,
  DateRangePicker,
  EmptyState,
  ReasonPicker,
  ReasonDropdown,
  RowCard,
  HelpHint,
  RefLink,
} from "../components/ui";

type ReturnsTab = "request" | "all";

const RETURN_REASON_PRESETS = [
  "Wrong size",
  "Wrong color",
  "Changed mind",
  "Defective / damaged",
  "Not as described",
  "Found cheaper elsewhere",
];

const APPROVE_REASON_PRESETS = [
  "Verified — unworn with tags",
  "Valid defect confirmed",
  "Within return policy",
  "Approved as goodwill",
  "Manager override approved",
];

const DECLINE_REASON_PRESETS = [
  "Signs of wear / use",
  "Outside return window",
  "Final Sale — no override",
  "Missing tags / packaging",
  "Suspected misuse",
];

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "9/19" instead of "2026-09-19" — the year is dead weight in a list
// that's already scoped to a date range, and this reads faster in a
// narrow column or on a phone.
function shortDate(dateStr: string): string {
  const [, month, day] = dateStr.slice(0, 10).split("-");
  return `${parseInt(month, 10)}/${parseInt(day, 10)}`;
}

function statusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "approved") return "success";
  if (status === "pending") return "warning";
  return "danger";
}

export default function ReturnsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [activeTab, setActiveTab] = useState<ReturnsTab>("request");

  return (
    <div>
      <PageHeader
        title="Returns"
        subtitle="Requests wait for admin approval before stock or cash move."
        action={
          <TabToggle
            value={activeTab}
            onChange={setActiveTab}
            options={[
              { value: "request", label: "Request a Return" },
              { value: "all", label: "Returns" },
            ]}
          />
        }
      />

      {activeTab === "request" && <RequestReturnTab />}
      {activeTab === "all" && <AllReturnsTab isAdmin={isAdmin} />}
    </div>
  );
}

// One selected item's own return configuration — condition, resolution and
// reason are all independent per item, since an admin approves or declines
// each item's request on its own merits, not the batch as a whole.
interface ReturnLineConfig {
  condition: "clean" | "damaged";
  resolution: "refund" | "store_credit_exchange";
  reason: string;
  exchangeNote: string;
  creditExpiryChoice: "45" | "60" | "90" | "custom";
  customExpiryDays: string;
}

function defaultLineConfig(): ReturnLineConfig {
  return {
    condition: "clean",
    resolution: "refund",
    reason: "",
    exchangeNote: "",
    creditExpiryChoice: "45",
    customExpiryDays: "",
  };
}

function RequestReturnTab() {
  const [invoiceQuery, setInvoiceQuery] = useState("");
  const [sale, setSale] = useState<Sale | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [selectedItemIds, setSelectedItemIds] = useState<Set<number>>(new Set());
  const [lineConfigs, setLineConfigs] = useState<Record<number, ReturnLineConfig>>({});

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleLookup() {
    setLookupError(null);
    setSale(null);
    setSelectedItemIds(new Set());
    setLineConfigs({});
    setSubmitError(null);
    setSubmitSuccess(null);
    const value = invoiceQuery.trim();
    if (!value) return;

    try {
      const all = await api.get<Sale[]>("/sales");
      const match = all.find((s) => s.invoice.toLowerCase() === value.toLowerCase());
      if (!match) {
        setLookupError("No sale found with that invoice number");
        return;
      }
      setSale(await api.get<Sale>(`/sales/${match.id}`));
    } catch (err) {
      setLookupError(err instanceof ApiRequestError ? err.message : "Lookup failed");
    }
  }

  function toggleItem(itemId: number) {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
        setLineConfigs((cfgs) => (cfgs[itemId] ? cfgs : { ...cfgs, [itemId]: defaultLineConfig() }));
      }
      return next;
    });
  }

  function updateLine(itemId: number, patch: Partial<ReturnLineConfig>) {
    setLineConfigs((cfgs) => ({ ...cfgs, [itemId]: { ...cfgs[itemId], ...patch } }));
  }

  function itemLabel(itemId: number): string {
    return sale?.items?.find((i) => i.id === itemId)?.product_title ?? `Item #${itemId}`;
  }

  async function handleSubmitAll() {
    setSubmitError(null);
    setSubmitSuccess(null);

    const ids = Array.from(selectedItemIds);
    if (ids.length === 0) {
      setSubmitError("Select at least one item to return");
      return;
    }

    // Validate every line up front — a mistake on item 2 shouldn't leave
    // item 1 already submitted while the rest of the form errors out.
    for (const id of ids) {
      const cfg = lineConfigs[id];
      if (!cfg?.reason.trim()) {
        setSubmitError(`Enter a reason for ${itemLabel(id)}`);
        return;
      }
      if (cfg.resolution === "store_credit_exchange") {
        if (!sale?.customer_id) {
          setSubmitError(`${itemLabel(id)}: store credit needs a real customer account — this is a walk-in sale. Use a cash refund instead.`);
          return;
        }
        if (cfg.creditExpiryChoice === "custom") {
          const parsed = parseInt(cfg.customExpiryDays, 10);
          if (!parsed || parsed <= 0) {
            setSubmitError(`${itemLabel(id)}: enter a valid number of days for the custom credit expiry`);
            return;
          }
        }
      }
    }

    setSubmitting(true);
    const succeededIds: number[] = [];
    const failed: { id: number; name: string; error: string }[] = [];
    let anyFinalSale = false;

    for (const id of ids) {
      const cfg = lineConfigs[id];
      let credit_expiry_days: number | undefined;
      if (cfg.resolution === "store_credit_exchange") {
        credit_expiry_days = cfg.creditExpiryChoice === "custom" ? parseInt(cfg.customExpiryDays, 10) : parseInt(cfg.creditExpiryChoice, 10);
      }
      try {
        const result = await api.post<ReturnRequest & { is_final_sale: boolean }>("/returns/requests", {
          sale_item_id: id,
          condition: cfg.condition,
          resolution: cfg.resolution,
          reason:
            cfg.resolution === "store_credit_exchange" && cfg.exchangeNote.trim()
              ? `${cfg.reason.trim()} — ${cfg.exchangeNote.trim()}`
              : cfg.reason.trim(),
          credit_expiry_days,
        });
        succeededIds.push(id);
        if (result.is_final_sale) anyFinalSale = true;
      } catch (err) {
        failed.push({ id, name: itemLabel(id), error: err instanceof ApiRequestError ? err.message : "Failed to submit" });
      }
    }

    setSubmitting(false);

    if (failed.length === 0) {
      setSubmitSuccess(
        `${succeededIds.length} return request${succeededIds.length !== 1 ? "s" : ""} submitted — an admin will review ${
          succeededIds.length !== 1 ? "them" : "it"
        }.${anyFinalSale ? " Note: at least one item is Final Sale and will need an admin override to approve." : ""}`
      );
      setSale(null);
      setInvoiceQuery("");
      setSelectedItemIds(new Set());
      setLineConfigs({});
    } else {
      setSubmitError(`${failed.length} of ${ids.length} failed: ${failed.map((f) => `${f.name} — ${f.error}`).join("; ")}`);
      if (succeededIds.length > 0) {
        setSubmitSuccess(`${succeededIds.length} of ${ids.length} submitted successfully.`);
        setSelectedItemIds(new Set(failed.map((f) => f.id)));
      }
    }
  }

  return (
    <>
      <Card className="mb-5">
        <div className="flex gap-2">
          <Input
            placeholder="Invoice number"
            value={invoiceQuery}
            onChange={(e) => setInvoiceQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLookup()}
          />
          <Button variant="primary" onClick={handleLookup}>
            Find
          </Button>
        </div>
        {lookupError && <ErrorText>{lookupError}</ErrorText>}
      </Card>

      {sale && (
        <Card>
          <h2 className="text-base font-semibold text-gray-900 mb-3">
            {sale.invoice} — {sale.customer_name ?? (sale.deleted_customer_snapshot ? `[Deleted: ${sale.deleted_customer_snapshot}]` : "Walk-in")}
          </h2>

          <FormGroup>
            <Label>Which item(s) are being returned? Tick one to configure its return.</Label>
            <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 overflow-hidden">
              {sale.items?.map((item) => {
                const checked = selectedItemIds.has(item.id);
                const alreadyReturned = (item.is_returned ?? 0) > 0;
                const cfg = lineConfigs[item.id] ?? defaultLineConfig();
                const isFinalSale = item.allow_returns === 0;

                return (
                  <div key={item.id}>
                    <label
                      className={`flex items-center gap-2.5 px-3 py-2.5 transition ${
                        alreadyReturned ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
                      } ${checked ? "bg-gray-50" : "hover:bg-gray-50"}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={alreadyReturned}
                        onChange={() => toggleItem(item.id)}
                        className="rounded flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-900 truncate">
                          {item.product_title}
                          {(item.color || item.size) && (
                            <span className="text-gray-400"> · {[item.color, item.size].filter(Boolean).join(" / ")}</span>
                          )}
                        </p>
                        <p className="text-xs text-gray-400">
                          {item.sku} · Rs. {item.unit_price.toLocaleString()}
                        </p>
                      </div>
                      {alreadyReturned && <span className="text-xs text-gray-400 flex-shrink-0">Already returned</span>}
                    </label>

                    {checked && !alreadyReturned && (
                      <div className="px-3.5 pb-4 pt-1 bg-gray-50/60 space-y-3">
                        {isFinalSale && (
                          <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                            <AlertTriangle size={13} className="text-amber-600 flex-shrink-0 mt-0.5" />
                            <p className="text-xs text-amber-800">
                              This product is marked Final Sale — No Returns. You can still submit a request, but it will need an
                              explicit admin override to be approved.
                            </p>
                          </div>
                        )}

                        <div className="grid grid-cols-2 gap-3">
                          <FormGroup>
                            <Label>Condition</Label>
                            <Dropdown
                              value={cfg.condition}
                              onChange={(v) => updateLine(item.id, { condition: v as "clean" | "damaged" })}
                              options={[
                                { value: "clean", label: "Clean — resellable" },
                                { value: "damaged", label: "Damaged — write-off" },
                              ]}
                            />
                          </FormGroup>
                          <FormGroup>
                            <Label>Resolution</Label>
                            <Dropdown
                              value={cfg.resolution}
                              onChange={(v) => updateLine(item.id, { resolution: v as ReturnLineConfig["resolution"] })}
                              options={[
                                { value: "refund", label: "Cash refund" },
                                { value: "store_credit_exchange", label: "Exchange" },
                              ]}
                            />
                          </FormGroup>
                        </div>

                        {cfg.resolution === "store_credit_exchange" && (
                          <>
                            <FormGroup>
                              <Label>What are they exchanging it for? (optional note)</Label>
                              <Input
                                value={cfg.exchangeNote}
                                onChange={(e) => updateLine(item.id, { exchangeNote: e.target.value })}
                              />
                            </FormGroup>
                            {!sale.customer_id ? (
                              <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                                <AlertTriangle size={13} className="text-amber-600 flex-shrink-0 mt-0.5" />
                                <p className="text-xs text-amber-800">
                                  This is a walk-in sale with no customer attached — store credit needs a real customer account. Use a
                                  cash refund instead.
                                </p>
                              </div>
                            ) : (
                              <FormGroup>
                                <Label>
                                  Credit expires in
                                  <HelpHint text="45 days is the standard — only pick something longer for a genuine exception." />
                                </Label>
                                <div className="flex gap-2">
                                  {(["45", "60", "90"] as const).map((d) => (
                                    <button
                                      key={d}
                                      type="button"
                                      onClick={() => updateLine(item.id, { creditExpiryChoice: d })}
                                      className={`flex-1 border rounded-xl py-2 text-sm font-medium transition ${
                                        cfg.creditExpiryChoice === d
                                          ? "border-black bg-black text-white"
                                          : "border-gray-200 text-gray-600 hover:border-gray-400 bg-white"
                                      }`}
                                    >
                                      {d} days
                                    </button>
                                  ))}
                                  <button
                                    type="button"
                                    onClick={() => updateLine(item.id, { creditExpiryChoice: "custom" })}
                                    className={`flex-1 border rounded-xl py-2 text-sm font-medium transition ${
                                      cfg.creditExpiryChoice === "custom"
                                        ? "border-black bg-black text-white"
                                        : "border-gray-200 text-gray-600 hover:border-gray-400 bg-white"
                                    }`}
                                  >
                                    Custom
                                  </button>
                                </div>
                                {cfg.creditExpiryChoice === "custom" && (
                                  <Input
                                    type="number"
                                    min="1"
                                    className="mt-2"
                                    placeholder="Number of days"
                                    value={cfg.customExpiryDays}
                                    onChange={(e) => updateLine(item.id, { customExpiryDays: e.target.value })}
                                  />
                                )}
                              </FormGroup>
                            )}
                          </>
                        )}

                        <FormGroup>
                          <Label>Reason (required)</Label>
                          <ReasonPicker
                            value={cfg.reason}
                            onChange={(v) => updateLine(item.id, { reason: v })}
                            presets={RETURN_REASON_PRESETS}
                          />
                        </FormGroup>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </FormGroup>

          {submitError && <ErrorText>{submitError}</ErrorText>}
          {submitSuccess && <SuccessText>{submitSuccess}</SuccessText>}

          <Button variant="primary" onClick={handleSubmitAll} disabled={submitting || selectedItemIds.size === 0} className="mt-4">
            {submitting
              ? "Submitting..."
              : `Submit ${selectedItemIds.size > 1 ? `${selectedItemIds.size} return requests` : "return request"}`}
          </Button>
        </Card>
      )}
    </>
  );
}

function AllReturnsTab({ isAdmin }: { isAdmin: boolean }) {
  const [requests, setRequests] = useState<ReturnRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "approved" | "declined">("all");
  const [startDate, setStartDate] = useState<string | null>(() => {
    const d = new Date();
    return toISODate(new Date(d.getFullYear(), d.getMonth(), 1));
  });
  const [endDate, setEndDate] = useState<string | null>(() => toISODate(new Date()));

  // Expand a row in place instead of a modal — shows the full detail, and
  // for a pending request (admins only) the approve/decline forms too.
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // Which decision an admin is looking at on the expanded row — a small
  // tab switcher (defaults to Approve), so only one form's worth of
  // fields ever shows at once instead of both stacked together.
  const [decisionMode, setDecisionMode] = useState<"approve" | "decline">("approve");

  const [approveReason, setApproveReason] = useState("");
  const [refundMethod, setRefundMethod] = useState<"cash" | "bank_transfer">("cash");
  const [customerBankAccounts, setCustomerBankAccounts] = useState<any[]>([]);
  const [selectedRefundAccountId, setSelectedRefundAccountId] = useState("");
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approveSubmitting, setApproveSubmitting] = useState(false);

  const [declineReason, setDeclineReason] = useState("");
  const [declineError, setDeclineError] = useState<string | null>(null);
  const [declineSubmitting, setDeclineSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setRequests(await api.get<ReturnRequest[]>("/returns/requests"));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load returns");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function applyQuickFilter(range: "today" | "week" | "month" | "3months") {
    const today = new Date();
    let start: Date;
    if (range === "today") start = today;
    else if (range === "week") {
      start = new Date(today);
      start.setDate(start.getDate() - 6);
    } else if (range === "month") start = new Date(today.getFullYear(), today.getMonth(), 1);
    else start = new Date(today.getFullYear(), today.getMonth() - 3, today.getDate());
    setStartDate(toISODate(start));
    setEndDate(toISODate(today));
  }

  async function toggleExpand(r: ReturnRequest) {
    if (expandedId === r.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(r.id);
    setDecisionMode("approve");
    setApproveReason("");
    setApproveError(null);
    setRefundMethod("cash");
    setSelectedRefundAccountId("");
    setCustomerBankAccounts([]);
    setDeclineReason("");
    setDeclineError(null);
    if (r.status === "pending" && r.resolution === "refund" && r.customer_id) {
      try {
        const full = await api.get<{ bank_accounts?: any[] }>(`/customers/${r.customer_id}`);
        setCustomerBankAccounts(full.bank_accounts ?? []);
      } catch {
        // row stays open fine; bank transfer just shows an empty list
      }
    }
  }

  async function confirmApprove(r: ReturnRequest) {
    setApproveError(null);
    if (r.is_admin_override === 1 && !approveReason.trim()) {
      setApproveError("An override reason is required for a Final Sale item.");
      return;
    }
    if (r.resolution === "refund" && refundMethod === "bank_transfer" && !selectedRefundAccountId) {
      setApproveError("Select which of the customer's bank accounts to refund into");
      return;
    }

    setApproveSubmitting(true);
    try {
      await api.put(`/returns/requests/${r.id}/approve`, {
        decision_reason: approveReason.trim() || undefined,
        payment_method: r.resolution === "refund" ? refundMethod : undefined,
        bank_account_id: r.resolution === "refund" && refundMethod === "bank_transfer" ? parseInt(selectedRefundAccountId, 10) : undefined,
      });
      setExpandedId(null);
      load();
    } catch (err) {
      setApproveError(err instanceof ApiRequestError ? err.message : "Failed to approve request");
    } finally {
      setApproveSubmitting(false);
    }
  }

  async function confirmDecline(r: ReturnRequest) {
    setDeclineError(null);
    if (!declineReason.trim()) {
      setDeclineError("A reason is required to decline a request.");
      return;
    }

    setDeclineSubmitting(true);
    try {
      await api.put(`/returns/requests/${r.id}/decline`, { decision_reason: declineReason.trim() });
      setExpandedId(null);
      load();
    } catch (err) {
      setDeclineError(err instanceof ApiRequestError ? err.message : "Failed to decline request");
    } finally {
      setDeclineSubmitting(false);
    }
  }

  // Shared between the desktop table's expanded row and the mobile card
  // list's expanded section — same content either way, just a different
  // container around it.
  function renderExpandedDetail(r: ReturnRequest) {
    return (
      <div className="space-y-4">
        <div>
          <p className="text-xs text-gray-400 mb-1">Item</p>
          <p className="text-sm font-medium text-gray-900">
            {r.product_id ? <RefLink to={`/products/${r.product_id}`}>{r.product_title}</RefLink> : r.product_title} ({r.sku})
            {(r.color || r.size) && <span className="text-gray-400 font-normal"> · {[r.color, r.size].filter(Boolean).join(" / ")}</span>}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <p className="text-xs text-gray-400">Condition</p>
            <p className="text-gray-900 capitalize">{r.condition}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400">Resolution</p>
            <p className="text-gray-900 capitalize">{r.resolution.replace(/_/g, " ")}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400">Requested by</p>
            <p className="text-gray-900">{r.requested_by_name ?? "—"}</p>
          </div>
        </div>

        <div>
          <p className="text-xs text-gray-400 mb-1">Reason for return</p>
          <p className="text-sm text-gray-900">{r.reason}</p>
        </div>

        {r.is_admin_override === 1 && (
          <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <AlertTriangle size={13} className="text-amber-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800">This item is Final Sale — approving it needs an explicit override.</p>
          </div>
        )}

        {r.status !== "pending" && (
          <div className="grid grid-cols-2 gap-3 text-sm border-t border-gray-200 pt-3">
            <div>
              <p className="text-xs text-gray-400">{r.status === "approved" ? "Approved by" : "Declined by"}</p>
              <p className="text-gray-900">
                {r.decided_by_name ?? "—"}
                {r.decided_at && <span className="text-gray-400"> · {r.decided_at.slice(0, 10)}</span>}
              </p>
            </div>
            {r.decision_reason && (
              <div>
                <p className="text-xs text-gray-400">{r.status === "approved" ? "Approval reason" : "Decline reason"}</p>
                <p className="text-gray-900">{r.decision_reason}</p>
              </div>
            )}
            {r.status === "approved" && r.resolution === "refund" && (
              <div>
                <p className="text-xs text-gray-400">Refund amount</p>
                <p className="text-gray-900 font-semibold">Rs. {(r.refund_amount ?? 0).toLocaleString()}</p>
              </div>
            )}
            {r.status === "approved" && r.resolution === "store_credit_exchange" && (
              <div>
                <p className="text-xs text-gray-400">Store credit granted</p>
                <p className="text-gray-900 font-semibold">
                  Rs. {r.unit_price.toLocaleString()}
                  {r.credit_expiry_days ? ` — expires in ${r.credit_expiry_days} days` : ""}
                </p>
              </div>
            )}
          </div>
        )}

        {r.status === "pending" && isAdmin && (
          <div className="border-t border-gray-200 pt-4">
            <TabToggle
              value={decisionMode}
              onChange={setDecisionMode}
              options={[
                { value: "approve", label: "Approve" },
                { value: "decline", label: "Decline" },
              ]}
            />

            <div className="bg-white border border-gray-200 rounded-xl p-3.5 max-w-md mt-3">
              {decisionMode === "approve" ? (
                <>
                  {r.resolution === "refund" && (
                    <>
                      <FormGroup>
                        <Label>Refund method</Label>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setRefundMethod("cash")}
                            className={`flex-1 border rounded-xl py-2 text-sm font-medium transition ${
                              refundMethod === "cash"
                                ? "border-black bg-black text-white"
                                : "border-gray-200 text-gray-600 hover:border-gray-400 bg-white"
                            }`}
                          >
                            Cash
                          </button>
                          <button
                            type="button"
                            onClick={() => setRefundMethod("bank_transfer")}
                            className={`flex-1 border rounded-xl py-2 text-sm font-medium transition ${
                              refundMethod === "bank_transfer"
                                ? "border-black bg-black text-white"
                                : "border-gray-200 text-gray-600 hover:border-gray-400 bg-white"
                            }`}
                          >
                            Bank transfer
                          </button>
                        </div>
                      </FormGroup>

                      {refundMethod === "bank_transfer" && (
                        <div className="border border-gray-200 rounded-xl p-3 mb-3">
                          {customerBankAccounts.length === 0 ? (
                            <p className="text-xs text-amber-600">
                              No bank account on file for this customer — add one from the Customers page before refunding by bank
                              transfer.
                            </p>
                          ) : (
                            <div className="space-y-2">
                              {customerBankAccounts.map((a) => (
                                <label
                                  key={a.id}
                                  className={`flex items-start gap-2 border rounded-lg px-3 py-2 text-sm cursor-pointer transition ${
                                    String(a.id) === selectedRefundAccountId
                                      ? "border-black bg-gray-50"
                                      : "border-gray-200 hover:border-gray-300"
                                  }`}
                                >
                                  <input
                                    type="radio"
                                    name="refund-bank-account"
                                    checked={String(a.id) === selectedRefundAccountId}
                                    onChange={() => setSelectedRefundAccountId(String(a.id))}
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
                    </>
                  )}

                  <FormGroup>
                    <Label>Reason{r.is_admin_override === 1 ? " (required)" : " (optional)"}</Label>
                    <ReasonDropdown value={approveReason} onChange={setApproveReason} presets={APPROVE_REASON_PRESETS} />
                  </FormGroup>

                  {approveError && <ErrorText>{approveError}</ErrorText>}
                  <Button variant="primary" size="sm" onClick={() => confirmApprove(r)} disabled={approveSubmitting} className="mt-1">
                    {approveSubmitting ? "Approving..." : "Approve"}
                  </Button>
                </>
              ) : (
                <>
                  <FormGroup>
                    <Label>Reason (required)</Label>
                    <ReasonDropdown value={declineReason} onChange={setDeclineReason} presets={DECLINE_REASON_PRESETS} />
                  </FormGroup>
                  {declineError && <ErrorText>{declineError}</ErrorText>}
                  <Button variant="danger" size="sm" onClick={() => confirmDecline(r)} disabled={declineSubmitting} className="mt-1">
                    {declineSubmitting ? "Declining..." : "Decline"}
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  const filtered = requests.filter((r) => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    if (!startDate || !endDate) return true;
    const d = r.requested_at.slice(0, 10);
    return d >= startDate && d <= endDate;
  });

  // Day/month/year in full — e.g. "9/09/2026" — since the short "19 Sep
  // 26" style used on screen reads ambiguous on a printed report.
  function longDate(dateStr: string): string {
    const d = new Date(dateStr.slice(0, 10) + "T00:00:00");
    return `${d.getDate()}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  }

  function downloadReturnsPdf() {
    const rangeLabel = rangeLabelFor(startDate, endDate);
    downloadTabularReport({
      headerLabel: "M&M Clothing — Returns Report",
      headerFields: [
        { label: "Report", value: "Returns" },
        { label: "Period", value: rangeLabel },
        { label: "Generated", value: todayLongDate() },
      ],
      rangeLabel,
      columns: [
        { label: "Date", width: 70 },
        { label: "Customer", width: 105 },
        { label: "Product", width: 185 },
        { label: "Status", width: 60 },
        { label: "Decided by", width: 95 },
      ],
      rows: filtered.map((r) => ({
        cells: [
          longDate(r.requested_at),
          r.customer_name ?? (r.deleted_customer_snapshot ? `[Deleted: ${r.deleted_customer_snapshot}]` : "Walk-in"),
          `${r.product_title} (${r.sku})`,
          r.status,
          r.decided_by_name ?? "—",
        ],
        detail: `Reason: ${r.reason}`,
      })),
      totalSummary: { label: "Requests in this view", amount: `${filtered.length}` },
      filename: buildReportFilename("Returns", `${startDate || "all"}-to-${endDate || "now"}`),
    });
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex gap-2 flex-wrap items-center">
          <div className="w-40">
            <Dropdown
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as typeof statusFilter)}
              options={[
                { value: "all", label: "All statuses" },
                { value: "pending", label: "Pending" },
                { value: "approved", label: "Approved" },
                { value: "declined", label: "Declined" },
              ]}
            />
          </div>
          <button onClick={() => applyQuickFilter("today")} className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg transition">
            Today
          </button>
          <button onClick={() => applyQuickFilter("week")} className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg transition">
            This Week
          </button>
          <button onClick={() => applyQuickFilter("month")} className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg transition">
            This Month
          </button>
          <button onClick={() => applyQuickFilter("3months")} className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg transition">
            Last 3 Months
          </button>
        </div>
        <div className="flex items-center gap-2">
          <DateRangePicker
            startDate={startDate}
            endDate={endDate}
            onChange={(s, e) => {
              setStartDate(s);
              setEndDate(e);
            }}
          />
          <Button onClick={downloadReturnsPdf} disabled={filtered.length === 0} className="inline-flex items-center gap-1.5">
            <Download size={14} />
            Download PDF
          </Button>
        </div>
      </div>

      {error && <ErrorText>{error}</ErrorText>}
      {!loading && <p className="text-xs text-gray-400 mb-3">{filtered.length} request(s) — click a row to see full details</p>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <EmptyState icon={RotateCcw} title="No returns match this view" />
      ) : (
        <>
          {/* Desktop / tablet-landscape: table with an inline-expand row */}
          <Card className="p-0 overflow-hidden hidden lg:block">
            <Table>
              <thead>
                <tr>
                  <Th>ID</Th>
                  <Th>Date</Th>
                  <Th>Customer</Th>
                  <Th>Product</Th>
                  <Th>Reason</Th>
                  <Th>Status</Th>
                  <Th>Decided by</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const isExpanded = expandedId === r.id;
                  return (
                    <Fragment key={r.id}>
                      <tr
                        onClick={() => toggleExpand(r)}
                        className={`cursor-pointer hover:bg-gray-50 ${
                          isExpanded ? "bg-gray-50" : r.is_admin_override && r.status === "pending" ? "bg-amber-50" : ""
                        }`}
                      >
                        <Td>#{r.id}</Td>
                        <Td>{shortDate(r.requested_at)}</Td>
                        <Td>{r.customer_name ?? (r.deleted_customer_snapshot ? `[Deleted: ${r.deleted_customer_snapshot}]` : "Walk-in")}</Td>
                        <Td>
                          <p className="text-gray-900">
                            {r.product_id ? <RefLink to={`/products/${r.product_id}`}>{r.product_title}</RefLink> : r.product_title}
                          </p>
                          <p className="text-xs text-gray-400">{r.sku}</p>
                          {r.is_admin_override === 1 && r.status === "pending" && (
                            <span className="text-xs text-amber-600 font-medium">Final Sale</span>
                          )}
                        </Td>
                        <Td className="max-w-[200px] truncate">{r.reason}</Td>
                        <Td>
                          <Badge label={r.status} tone={statusTone(r.status)} />
                        </Td>
                        <Td>{r.decided_by_name ?? "—"}</Td>
                        <Td className="w-8">
                          {isExpanded ? <ChevronDown size={15} className="text-gray-400" /> : <ChevronRight size={15} className="text-gray-400" />}
                        </Td>
                      </tr>

                      {isExpanded && (
                        <tr>
                          <Td colSpan={8} className="bg-gray-50/70 !py-4 !px-5">
                            <div className="max-w-2xl">{renderExpandedDetail(r)}</div>
                          </Td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          </Card>

          {/* Mobile / tablet-portrait: stacked cards, same tap-to-expand */}
          <div className="lg:hidden space-y-2.5">
            {filtered.map((r) => {
              const isExpanded = expandedId === r.id;
              return (
                <RowCard
                  key={r.id}
                  onClick={() => toggleExpand(r)}
                  className={r.is_admin_override && r.status === "pending" ? "border-amber-300 bg-amber-50/40" : ""}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 leading-snug">
                        {r.product_id ? <RefLink to={`/products/${r.product_id}`}>{r.product_title}</RefLink> : r.product_title}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">{r.sku}</p>
                      <p className="text-xs text-gray-500 mt-1">
                        #{r.id} · {shortDate(r.requested_at)} ·{" "}
                        {r.customer_name ?? (r.deleted_customer_snapshot ? `[Deleted: ${r.deleted_customer_snapshot}]` : "Walk-in")}
                      </p>
                    </div>
                    <div className="flex-shrink-0 flex items-center gap-2">
                      <Badge label={r.status} tone={statusTone(r.status)} />
                      {isExpanded ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="mt-3 pt-3 border-t border-gray-100" onClick={(e) => e.stopPropagation()}>
                      {renderExpandedDetail(r)}
                    </div>
                  )}
                </RowCard>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
