import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageLoader } from "../components/Loader";
import { RotateCcw, AlertTriangle, ChevronDown, ChevronRight, Download, Search } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Sale, ReturnRequest, ReturnApprovals, Customer } from "../lib/types";
import { findCustomers, CASHIER_SEARCH_MIN_CHARS } from "../lib/customerSearch";
import { countOpenPickups } from "../lib/returnsCounts";
import { useAuth } from "../context/AuthContext";
import ReturnByDeliveryForm from "../components/ReturnByDeliveryForm";
import OnlineExchangeModal from "../components/OnlineExchangeModal";
import ReturnPickupList from "../components/ReturnsOnTheWay";
import ReturnApprovalList from "../components/ReturnApprovals";
import ReturnRequestPanel from "../components/ReturnRequestPanel";
import { RefundSlipMenu } from "../components/RefundSlipButton";
import RefundMethodPicker, { useCustomerBankAccounts } from "../components/RefundMethodPicker";
import { AUTO_APPROVED, FLOW_LABEL, inStoreStage } from "../lib/returnFlow";
import { downloadTabularReport, rangeLabelFor, buildReportFilename, todayLongDate } from "../lib/reportPdf";
import { useSortableData } from "../lib/useSortableData";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";
import { useCopyToClipboard } from "../lib/useCopyToClipboard";
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
  SortHeader,
  Badge,
  TabToggle,
  DateRangePicker,
  EmptyState,
  ReasonPicker,
  RowCard,
  HelpHint,
  RefLink,
} from "../components/ui";
import { formatDate } from "../lib/dates";

type ReturnsTab = "request" | "approve" | "all" | "pickups";
type ReturnSortKey = "id" | "date" | "customer" | "product" | "status";

const RETURN_REASON_PRESETS = [
  "Wrong size",
  "Wrong color",
  "Changed mind",
  "Defective / damaged",
  "Not as described",
  "Found cheaper elsewhere",
];

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const shortDate = (dateStr: string) => formatDate(dateStr);

function statusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "approved") return "success";
  if (status === "pending") return "warning";
  return "danger";
}

export default function ReturnsPage() {
  // The dashboard's "waiting for your approval" row lands straight on that tab (/returns?tab=approve).
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<ReturnsTab>(() => (searchParams.get("tab") === "approve" ? "approve" : "request"));
  useEffect(() => {
    if (searchParams.get("tab")) setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Everything waiting for an admin's yes — read here so the tab can show how many there are, and refreshed after anything is asked or decided.
  const [approvals, setApprovals] = useState<ReturnApprovals | null>(null);
  const [approvalsError, setApprovalsError] = useState<string | null>(null);
  const loadApprovals = useCallback(() => {
    api
      .get<ReturnApprovals>("/returns/approvals")
      .then((a) => {
        setApprovals(a);
        setApprovalsError(null);
        window.dispatchEvent(new Event("mm-approvals-changed")); // the badge on the Returns menu item re-reads
      })
      .catch((err) => setApprovalsError(err instanceof ApiRequestError ? err.message : "Couldn't load what is waiting for approval"));
  }, []);
  useEffect(() => {
    loadApprovals();
  }, [loadApprovals, activeTab]);
  const waiting = approvals ? approvals.in_store.length + approvals.courier.length + (approvals.courier_reports?.length ?? 0) + approvals.exchanges.length : 0;

  return (
    <div>
      <PageHeader
        title="Returns"
        subtitle="Returns and exchanges wait for an admin's approval before any stock or cash moves."
        action={
          <TabToggle
            value={activeTab}
            onChange={setActiveTab}
            options={[
              { value: "request", label: "Request a Return" },
              { value: "approve", label: waiting > 0 ? `To approve (${waiting})` : "To approve" },
              { value: "all", label: "In-store returns" },
              { value: "pickups", label: "On the way back" },
            ]}
          />
        }
      />

      {activeTab === "request" && <RequestReturnTab onRequested={loadApprovals} waiting={waiting} onGoTo={setActiveTab} />}
      {activeTab === "approve" &&
        (approvals ? (
          <ReturnApprovalList approvals={approvals} onChanged={loadApprovals} />
        ) : approvalsError ? (
          <ErrorText>{approvalsError}</ErrorText>
        ) : (
          <PageLoader />
        ))}
      {activeTab === "all" && <AllReturnsTab onDecided={loadApprovals} />}
      {activeTab === "pickups" && <ReturnPickupList status="all" />}
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

function RequestReturnTab({ onRequested, waiting, onGoTo }: { onRequested: () => void; waiting: number; onGoTo: (tab: ReturnsTab) => void }) {
  // An admin's own return is approved in the same step ("Auto-approved (recorded by admin)"), so how a refund is paid is chosen here;
  // anyone else's waits in To approve, where the admin chooses it.
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [refundMethod, setRefundMethod] = useState<"cash" | "bank_transfer">("cash");
  const [refundAccountId, setRefundAccountId] = useState("");
  const [invoiceQuery, setInvoiceQuery] = useState("");
  const [sale, setSale] = useState<Sale | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const invoiceInput = useRef<HTMLInputElement>(null);
  // Typed only the last few digits and more than one bill ends that way: pick the right one.
  const [matches, setMatches] = useState<Sale[] | null>(null);
  // "No receipt?": find the customer, then choose from their recent bills.
  const [findingCustomer, setFindingCustomer] = useState(false);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [allCustomers, setAllCustomers] = useState<Customer[] | null>(null);
  const [pickedCustomer, setPickedCustomer] = useState<Customer | null>(null);
  const [customerBills, setCustomerBills] = useState<Sale[] | null>(null);
  const customerSearchSeq = useRef(0);
  // How many parcels are on their way back, for the quiet line under the box.
  const [onTheWay, setOnTheWay] = useState(0);
  useEffect(() => {
    countOpenPickups().then(setOnTheWay).catch(() => {});
  }, []);

  const [selectedItemIds, setSelectedItemIds] = useState<Set<number>>(new Set());
  const [lineConfigs, setLineConfigs] = useState<Record<number, ReturnLineConfig>>({});
  const hasRefundLine = Array.from(selectedItemIds).some((id) => lineConfigs[id]?.resolution === "refund");
  const { accounts: refundAccounts, defaultId: defaultRefundAccount } = useCustomerBankAccounts(
    sale?.customer_id,
    isAdmin && hasRefundLine && refundMethod === "bank_transfer"
  );
  useEffect(() => {
    if (refundMethod === "bank_transfer") setRefundAccountId((cur) => cur || defaultRefundAccount);
  }, [refundMethod, defaultRefundAccount]);

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // For a delivered online order there are three ways it can come back: to the shop (the form below), collected by a courier
  // (recorded here), or swapped for new items by delivery (the exchange popup).
  const navigate = useNavigate();
  const [how, setHow] = useState<"shop" | "courier">("shop");
  const [showExchange, setShowExchange] = useState(false);

  // "Return or exchange items" on an invoice's own page lands here with the bill already found.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const invoice = searchParams.get("invoice");
    // Otherwise the box is ready for a scanner (or typing) the moment the page opens.
    if (!invoice) {
      invoiceInput.current?.focus();
      return;
    }
    setInvoiceQuery(invoice);
    setSearchParams({}, { replace: true });
    handleLookup(invoice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLookup(invoiceOverride?: string) {
    setLookupError(null);
    setMatches(null);
    setHow("shop");
    setSale(null);
    setSelectedItemIds(new Set());
    setLineConfigs({});
    setSubmitError(null);
    setSubmitSuccess(null);
    setRefundMethod("cash");
    setRefundAccountId("");
    const value = (invoiceOverride ?? invoiceQuery).trim();
    if (!value) return;

    try {
      // The one bill, however old — a cashier's plain sales list only reaches back a week.
      const found = await api.get<Sale[]>(`/sales?invoice=${encodeURIComponent(value)}`);
      const match = found[0];
      if (!match) {
        // Not a whole invoice number — maybe just its last digits, as read off a receipt.
        if (/^[A-Za-z0-9]{3,12}$/.test(value)) {
          const ends = await api.get<Sale[]>(`/sales?invoice_ends=${encodeURIComponent(value)}`);
          if (ends.length === 1) {
            setInvoiceQuery(ends[0].invoice);
            setSale(await api.get<Sale>(`/sales/${ends[0].id}`));
            return;
          }
          if (ends.length > 1) {
            setMatches(ends);
            return;
          }
        }
        setLookupError(
          isAdmin
            ? "No sale found with that invoice number"
            : "No sale found. Check the number — the last digits find sales from the past week; an older one needs the whole invoice number."
        );
        return;
      }
      setSale(await api.get<Sale>(`/sales/${match.id}`));
    } catch (err) {
      setLookupError(err instanceof ApiRequestError ? err.message : "Lookup failed");
    }
  }

  // ---- "No receipt?" — find the customer, then one of their recent bills
  async function openFinder() {
    setFindingCustomer(true);
    // An admin searches the whole list; a cashier's search is answered by the server (3+ letters, a few people at most).
    if (isAdmin && !allCustomers) api.get<Customer[]>("/customers").then(setAllCustomers).catch(() => {});
  }
  function searchCustomers(text: string) {
    setCustomerQuery(text);
    setPickedCustomer(null);
    setCustomerBills(null);
    const q = text.trim();
    const seq = ++customerSearchSeq.current;
    if (q.length < (isAdmin ? 2 : CASHIER_SEARCH_MIN_CHARS)) {
      setCustomerResults([]);
      return;
    }
    if (isAdmin) {
      const lower = q.toLowerCase();
      setCustomerResults(
        (allCustomers ?? []).filter((c) => c.name.toLowerCase().includes(lower) || (c.phone ?? "").includes(q) || c.customer_code.toLowerCase().includes(lower)).slice(0, 6)
      );
      return;
    }
    findCustomers(q)
      .then((found) => {
        if (seq === customerSearchSeq.current) setCustomerResults(found.slice(0, 6));
      })
      .catch(() => {
        if (seq === customerSearchSeq.current) setCustomerResults([]);
      });
  }
  async function pickCustomer(c: Customer) {
    setPickedCustomer(c);
    setCustomerResults([]);
    setCustomerBills(null);
    try {
      setCustomerBills((await api.get<Sale[]>(`/sales?customer_id=${c.id}`)).slice(0, 10));
    } catch (err) {
      setLookupError(err instanceof ApiRequestError ? err.message : "Couldn't load their bills");
    }
  }
  function openBill(invoice: string) {
    setInvoiceQuery(invoice);
    setFindingCustomer(false);
    setCustomerQuery("");
    setPickedCustomer(null);
    setCustomerBills(null);
    handleLookup(invoice);
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

    if (isAdmin && hasRefundLine && refundMethod === "bank_transfer") {
      if (!sale?.customer_id) {
        setSubmitError("A bank transfer refund needs a real customer account — this is a walk-in sale. Refund in cash instead.");
        return;
      }
      if (!refundAccountId) {
        setSubmitError("Select which of the customer's bank accounts to refund into");
        return;
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
          ...(isAdmin && cfg.resolution === "refund"
            ? { payment_method: refundMethod, ...(refundMethod === "bank_transfer" ? { bank_account_id: parseInt(refundAccountId, 10) } : {}) }
            : {}),
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
        isAdmin
          ? `${succeededIds.length} return${succeededIds.length !== 1 ? "s" : ""} recorded — ${AUTO_APPROVED.toLowerCase()}.`
          : `${succeededIds.length} return request${succeededIds.length !== 1 ? "s" : ""} sent for approval — an admin will decide ${
              succeededIds.length !== 1 ? "them" : "it"
            }.${anyFinalSale ? " Note: at least one item is Final Sale and will need an admin override to approve." : ""}`
      );
      onRequested();
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
            ref={invoiceInput}
            placeholder="Scan the receipt, or type the invoice number (or just its last digits)"
            value={invoiceQuery}
            onChange={(e) => setInvoiceQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLookup()}
          />
          <Button variant="primary" onClick={() => handleLookup()}>
            Find
          </Button>
        </div>
        {lookupError && <ErrorText>{lookupError}</ErrorText>}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-gray-500">
          <button type="button" onClick={() => (findingCustomer ? setFindingCustomer(false) : openFinder())} className="underline hover:text-gray-900">
            {findingCustomer ? "Close the customer search" : "No receipt? Find the customer"}
          </button>
          {(waiting > 0 || onTheWay > 0) && (
            <span>
              Also waiting:{" "}
              {waiting > 0 && (
                <button type="button" onClick={() => onGoTo("approve")} className="font-medium text-gray-700 underline hover:text-gray-900">
                  {waiting} to approve
                </button>
              )}
              {waiting > 0 && onTheWay > 0 && " · "}
              {onTheWay > 0 && (
                <button type="button" onClick={() => onGoTo("pickups")} className="font-medium text-gray-700 underline hover:text-gray-900">
                  {onTheWay} on the way back
                </button>
              )}
            </span>
          )}
        </div>

        {findingCustomer && (
          <div className="mt-3 border-t border-gray-100 pt-3">
            <Input
              autoFocus
              placeholder={isAdmin ? "Customer name or phone" : `Part of the name, or the phone number (at least ${CASHIER_SEARCH_MIN_CHARS} characters)`}
              value={customerQuery}
              onChange={(e) => searchCustomers(e.target.value)}
            />
            {customerResults.length > 0 && (
              <div className="mt-2 divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200">
                {customerResults.map((c) => (
                  <button key={c.id} type="button" onClick={() => pickCustomer(c)} className="flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left text-sm hover:bg-gray-50">
                    <span className="min-w-0 truncate font-medium text-gray-900">{c.name}</span>
                    <span className="flex-shrink-0 text-xs text-gray-400">{c.phone ?? c.customer_code}</span>
                  </button>
                ))}
              </div>
            )}
            {pickedCustomer && (
              <div className="mt-3">
                <p className="mb-1.5 text-xs text-gray-500">
                  {pickedCustomer.name}'s recent bills — pick the one they're returning from
                </p>
                {customerBills === null ? (
                  <p className="text-xs text-gray-400">Loading…</p>
                ) : customerBills.length === 0 ? (
                  <p className="text-xs text-gray-400">No bills on record for this customer.</p>
                ) : (
                  <div className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200">
                    {customerBills.map((b) => (
                      <button key={b.id} type="button" onClick={() => openBill(b.invoice)} className="flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left text-sm hover:bg-gray-50">
                        <span className="font-medium text-gray-900">{b.invoice}</span>
                        <span className="text-xs text-gray-400">{formatDate(b.date)}</span>
                        <span className="tabular-nums text-gray-700">Rs. {b.total.toLocaleString()}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Card>

      {matches && (
        <Card className="mb-5">
          <p className="mb-2 text-sm font-medium text-gray-900">More than one bill ends that way — which one?</p>
          <div className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200">
            {matches.map((m) => (
              <button key={m.id} type="button" onClick={() => openBill(m.invoice)} className="flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left text-sm hover:bg-gray-50">
                <span className="font-medium text-gray-900">{m.invoice}</span>
                <span className="text-xs text-gray-400">{formatDate(m.date)}</span>
                <span className="min-w-0 flex-1 truncate text-right text-gray-600">{m.customer_name ?? "Walk-in"}</span>
                <span className="tabular-nums text-gray-700">Rs. {m.total.toLocaleString()}</span>
              </button>
            ))}
          </div>
        </Card>
      )}

      {sale && (
        <Card>
          <h2 className="text-base font-semibold text-gray-900 mb-3">
            {sale.invoice} — {sale.customer_name ?? (sale.deleted_customer_snapshot ? `[Deleted: ${sale.deleted_customer_snapshot}]` : "Walk-in")}
          </h2>

          {sale.sale_type === "online" && sale.delivery_status === "delivered" && (
            <FormGroup>
              <Label>How is it coming back?</Label>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["shop", FLOW_LABEL.in_store],
                    ["courier", FLOW_LABEL.courier],
                    ["exchange", FLOW_LABEL.exchange],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => (key === "exchange" ? setShowExchange(true) : setHow(key))}
                    className={`rounded-xl border px-3 py-2 text-left text-sm font-medium transition ${
                      key !== "exchange" && how === key ? "border-black bg-black text-white" : "border-gray-200 bg-white text-gray-700 hover:border-gray-400"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {how === "courier" && (
                <p className="mt-1.5 text-xs text-gray-500">
                  Any delivery service will do — post, a bus, a courier. The delivery charge is split as you choose, and the customer's share is held back from what they're paid back.
                </p>
              )}
            </FormGroup>
          )}

          {how === "courier" ? (
            <ReturnByDeliveryForm
              sale={sale}
              onBooked={async () => {
                // The items are now on their way back — reload the invoice so they show as such.
                try {
                  setSale(await api.get<Sale>(`/sales/${sale.id}`));
                } catch {
                  // the booking itself went through; the list will refresh on the next lookup
                }
              }}
            />
          ) : (
          <>
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
                            <AlertTriangle size={12} className="text-amber-600 flex-shrink-0 mt-0.5" />
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
                                <AlertTriangle size={12} className="text-amber-600 flex-shrink-0 mt-0.5" />
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

          {isAdmin && hasRefundLine && (
            <div className="mt-4 max-w-md">
              <RefundMethodPicker
                method={refundMethod}
                onMethod={setRefundMethod}
                accounts={refundAccounts}
                accountId={refundAccountId}
                onAccount={setRefundAccountId}
                name="request-refund-account"
              />
            </div>
          )}

          {submitError && <ErrorText>{submitError}</ErrorText>}
          {submitSuccess && <SuccessText>{submitSuccess}</SuccessText>}

          <Button variant="primary" onClick={handleSubmitAll} disabled={submitting || selectedItemIds.size === 0} className="mt-4">
            {submitting
              ? isAdmin
                ? "Recording..."
                : "Sending..."
              : isAdmin
              ? `Record ${selectedItemIds.size > 1 ? `${selectedItemIds.size} returns` : "return"}`
              : `Send ${selectedItemIds.size > 1 ? `${selectedItemIds.size} return requests` : "return request"} for approval`}
          </Button>
          {isAdmin && selectedItemIds.size > 0 && <p className="mt-1.5 text-xs text-gray-400">{AUTO_APPROVED} — stock and money move straight away.</p>}
          </>
          )}
        </Card>
      )}

      {showExchange && sale && (
        <OnlineExchangeModal
          sale={sale}
          onClose={() => setShowExchange(false)}
          onCreated={(created) => {
            setShowExchange(false);
            navigate(`/sales/${created.id}`);
          }}
          onQuoted={(created) => {
            setShowExchange(false);
            navigate(`/sales/${created.id}`);
          }}
        />
      )}
    </>
  );
}

function AllReturnsTab({ onDecided }: { onDecided: () => void }) {
  const [requests, setRequests] = useState<ReturnRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "approved" | "declined">("all");
  const [startDate, setStartDate] = useState<string | null>(() => {
    const d = new Date();
    return toISODate(new Date(d.getFullYear(), d.getMonth(), 1));
  });
  const [endDate, setEndDate] = useState<string | null>(() => toISODate(new Date()));

  // Expand a row in place instead of a modal — shows the full detail, and for a pending request the approve / decline form too.
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // Jump straight to one: a search over every return, whatever its date or status ("/" focuses it).
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useKeyboardShortcut("/", () => searchRef.current?.focus());

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

  function toggleExpand(r: ReturnRequest) {
    setExpandedId(expandedId === r.id ? null : r.id);
  }

  // Shared between the desktop table's expanded row and the mobile card list's expanded section.
  function renderExpandedDetail(r: ReturnRequest) {
    return (
      <ReturnRequestPanel
        r={r}
        onChanged={() => {
          setExpandedId(null);
          load();
          onDecided();
        }}
      />
    );
  }

  const q = query.trim().toLowerCase();
  const filtered = requests.filter((r) => {
    if (q) {
      // A search ignores the date range and status chips: it looks through everything.
      return [r.invoice, r.customer_name, r.deleted_customer_snapshot, r.product_title, r.sku, r.reason, r.requested_by_name, r.decided_by_name, inStoreStage(r), `#${r.id}`]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    }
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    if (!startDate || !endDate) return true;
    const d = r.requested_at.slice(0, 10);
    return d >= startDate && d <= endDate;
  });

  const { sorted: sortedRequests, sortKey, sortDir, toggleSort } = useSortableData<ReturnRequest, ReturnSortKey>(
    filtered,
    (r, key) => {
      switch (key) {
        case "id":
          return r.id;
        case "date":
          return r.requested_at;
        case "customer":
          return (r.customer_name ?? r.deleted_customer_snapshot ?? "Walk-in").toLowerCase();
        case "product":
          return (r.product_title ?? "").toLowerCase();
        case "status":
          return r.status;
      }
    },
    "date",
    "desc"
  );

  const { copy: copySku, tooltip: skuCopyTooltip } = useCopyToClipboard();

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
          inStoreStage(r),
          r.auto_approved === 1 ? `${r.decided_by_name ?? "Admin"} (auto-approved)` : r.decided_by_name ?? "—",
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
          <div className="relative w-full sm:w-64">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (setQuery(""), searchRef.current?.blur())}
              placeholder="Search invoice or customer  ( / )"
              aria-label="Search returns"
              className="pl-9"
            />
          </div>
          <div className="w-40">
            <Dropdown
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as typeof statusFilter)}
              options={[
                { value: "all", label: "All statuses" },
                { value: "pending", label: "Pending" },
                { value: "approved", label: "Completed" },
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
      {!loading && (
        <p className="text-xs text-gray-400 mb-3">
          {filtered.length} request(s){q ? ` matching "${query.trim()}" — all dates` : ""} — click a row to see full details
        </p>
      )}

      {loading ? (
        <PageLoader />
      ) : filtered.length === 0 ? (
        <EmptyState icon={RotateCcw} title="No returns match this view" />
      ) : (
        <>
          {/* Desktop / tablet-landscape: table with an inline-expand row */}
          <Card className="p-0 overflow-hidden hidden lg:block">
            <Table>
              <thead>
                <tr>
                  <SortHeader<ReturnSortKey> label="ID" sortKey="id" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                  <SortHeader<ReturnSortKey> label="Date" sortKey="date" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                  <SortHeader<ReturnSortKey> label="Customer" sortKey="customer" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                  <SortHeader<ReturnSortKey> label="Product" sortKey="product" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                  <Th>Reason</Th>
                  <SortHeader<ReturnSortKey> label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                  <Th>Decided by</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {sortedRequests.map((r) => {
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
                          <p
                            onClick={(e) => {
                              e.stopPropagation();
                              copySku(`sku-${r.id}`, r.sku, e);
                            }}
                            className="text-xs text-gray-400 inline-block cursor-pointer hover:bg-gray-100 rounded transition-colors select-none"
                            title="Click to copy SKU"
                          >
                            {r.sku}
                          </p>
                          {r.is_admin_override === 1 && r.status === "pending" && (
                            <span className="text-xs text-amber-600 font-medium">Final Sale</span>
                          )}
                        </Td>
                        <Td className="max-w-[200px] truncate">{r.reason}</Td>
                        <Td>
                          <span className="inline-flex items-center gap-2">
                            <Badge label={inStoreStage(r)} tone={statusTone(r.status)} />
                            {r.status === "approved" && r.resolution === "refund" && r.refund_paid === 1 && r.return_id ? <RefundSlipMenu slipKey={`return-${r.return_id}`} /> : null}
                          </span>
                        </Td>
                        <Td>
                          {r.decided_by_name ?? "—"}
                          {r.auto_approved === 1 && (
                            <span className="block text-xs text-gray-400" title={AUTO_APPROVED}>
                              Auto-approved
                            </span>
                          )}
                        </Td>
                        <Td className="w-8">
                          {isExpanded ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
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
            {sortedRequests.map((r) => {
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
                      <Badge label={inStoreStage(r)} tone={statusTone(r.status)} />
                      {r.status === "approved" && r.resolution === "refund" && r.refund_paid === 1 && r.return_id ? <RefundSlipMenu slipKey={`return-${r.return_id}`} /> : null}
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

      {skuCopyTooltip}
    </>
  );
}
