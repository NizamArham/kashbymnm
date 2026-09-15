import { useState, useEffect } from "react";
import { RotateCcw, AlertTriangle } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Sale, InventoryUnit, ReturnRequest } from "../lib/types";
import { useAuth } from "../context/AuthContext";
import {
  PageHeader,
  Card,
  Input,
  Select,
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
} from "../components/ui";

type ReturnsTab = "request" | "all";

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
        subtitle="Every return starts as a request — an admin approves or declines it before stock or cash are affected."
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

function RequestReturnTab() {
  const [invoiceQuery, setInvoiceQuery] = useState("");
  const [sale, setSale] = useState<Sale | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [condition, setCondition] = useState<"clean" | "damaged">("clean");
  const [resolution, setResolution] = useState<"refund" | "store_credit_exchange">("refund");
  const [reason, setReason] = useState("");
  const [exchangeNote, setExchangeNote] = useState("");
  // 45 is the real default — anything else is a deliberate exception,
  // not an equally-weighted option.
  const [creditExpiryChoice, setCreditExpiryChoice] = useState<"45" | "60" | "90" | "custom">("45");
  const [customExpiryDays, setCustomExpiryDays] = useState("");

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selectedItem = sale?.items?.find((i) => i.id === selectedItemId);
  const selectedProduct = selectedItem as any;

  async function handleLookup() {
    setLookupError(null);
    setSale(null);
    setSelectedItemId(null);
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

  async function handleSubmitRequest() {
    setSubmitError(null);
    setSubmitSuccess(null);

    if (!selectedItemId) {
      setSubmitError("Select which item is being returned");
      return;
    }
    if (!reason.trim()) {
      setSubmitError("A reason is required to submit a return request");
      return;
    }

    let credit_expiry_days: number | undefined;
    if (resolution === "store_credit_exchange") {
      if (!sale?.customer_id) {
        setSubmitError(
          "Store credit needs a real customer account — this is a walk-in sale. Use a cash refund instead."
        );
        return;
      }
      if (creditExpiryChoice === "custom") {
        const parsed = parseInt(customExpiryDays, 10);
        if (!parsed || parsed <= 0) {
          setSubmitError("Enter a valid number of days for the custom expiry");
          return;
        }
        credit_expiry_days = parsed;
      } else {
        credit_expiry_days = parseInt(creditExpiryChoice, 10);
      }
    }

    setSubmitting(true);
    try {
      const result = await api.post<ReturnRequest & { is_final_sale: boolean }>("/returns/requests", {
        sale_item_id: selectedItemId,
        condition,
        resolution,
        reason:
          resolution === "store_credit_exchange" && exchangeNote.trim()
            ? `${reason.trim()} — ${exchangeNote.trim()}`
            : reason.trim(),
        credit_expiry_days,
      });
      setSubmitSuccess(
        result.is_final_sale
          ? "Request submitted — this item is marked Final Sale, so it will need an admin override to approve."
          : "Return request submitted — an admin will review it."
      );
      setSale(null);
      setInvoiceQuery("");
      setSelectedItemId(null);
      setReason("");
      setExchangeNote("");
      setCreditExpiryChoice("45");
      setCustomExpiryDays("");
    } catch (err) {
      setSubmitError(err instanceof ApiRequestError ? err.message : "Failed to submit return request");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Card className="mb-5">
        <div className="flex gap-2">
          <Input
            placeholder="Invoice number, e.g. STR26090001"
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
            <Label>Which item is being returned?</Label>
            <Select value={selectedItemId ?? ""} onChange={(e) => setSelectedItemId(Number(e.target.value))}>
              <option value="">— Select item —</option>
              {sale.items?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.product_title} ({item.sku}) — Rs. {item.unit_price.toLocaleString()}
                </option>
              ))}
            </Select>
          </FormGroup>

          {selectedProduct && selectedProduct.allow_returns === 0 && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
              <AlertTriangle size={13} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">
                This product is marked Final Sale — No Returns. You can still submit a request, but it will need an explicit admin
                override to be approved.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormGroup>
              <Label>Condition</Label>
              <Select value={condition} onChange={(e) => setCondition(e.target.value as "clean" | "damaged")}>
                <option value="clean">Clean — resellable</option>
                <option value="damaged">Damaged — write-off</option>
              </Select>
            </FormGroup>
            <FormGroup>
              <Label>Resolution</Label>
              <Select value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)}>
                <option value="refund">Cash refund</option>
                <option value="store_credit_exchange">Exchange</option>
              </Select>
            </FormGroup>
          </div>

          {resolution === "store_credit_exchange" && (
            <>
              <FormGroup>
                <Label>What are they exchanging it for? (optional note)</Label>
                <Input
                  placeholder='e.g. "Wants a different size, will pick one up later"'
                  value={exchangeNote}
                  onChange={(e) => setExchangeNote(e.target.value)}
                />
              </FormGroup>
              {!sale.customer_id ? (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
                  <AlertTriangle size={13} className="text-amber-600 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-800">
                    This is a walk-in sale with no customer attached — store credit needs a real customer account. Use a cash refund or
                    a direct exchange instead.
                  </p>
                </div>
              ) : (
                <FormGroup>
                  <Label>Credit expires in</Label>
                  <p className="text-xs text-gray-400 mb-1.5">
                    45 days is the standard — only pick something longer for a genuine exception.
                  </p>
                  <div className="flex gap-2">
                    {(["45", "60", "90"] as const).map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setCreditExpiryChoice(d)}
                        className={`flex-1 border rounded-xl py-2 text-sm font-medium transition ${
                          creditExpiryChoice === d ? "border-black bg-black text-white" : "border-gray-200 text-gray-600 hover:border-gray-400"
                        }`}
                      >
                        {d} days
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setCreditExpiryChoice("custom")}
                      className={`flex-1 border rounded-xl py-2 text-sm font-medium transition ${
                        creditExpiryChoice === "custom" ? "border-black bg-black text-white" : "border-gray-200 text-gray-600 hover:border-gray-400"
                      }`}
                    >
                      Custom
                    </button>
                  </div>
                  {creditExpiryChoice === "custom" && (
                    <Input
                      type="number"
                      min="1"
                      className="mt-2"
                      placeholder="Number of days"
                      value={customExpiryDays}
                      onChange={(e) => setCustomExpiryDays(e.target.value)}
                    />
                  )}
                </FormGroup>
              )}
            </>
          )}

          <FormGroup>
            <Label>Reason (required)</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being returned?" />
          </FormGroup>

          {submitError && <ErrorText>{submitError}</ErrorText>}
          {submitSuccess && <SuccessText>{submitSuccess}</SuccessText>}

          <Button variant="primary" onClick={handleSubmitRequest} disabled={submitting} className="mt-2">
            {submitting ? "Submitting..." : "Submit return request"}
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
  const [decidingId, setDecidingId] = useState<number | null>(null);

  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "approved" | "declined">("all");
  const [startDate, setStartDate] = useState<string | null>(() => {
    const d = new Date();
    return toISODate(new Date(d.getFullYear(), d.getMonth(), 1));
  });
  const [endDate, setEndDate] = useState<string | null>(() => toISODate(new Date()));

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

  async function approve(r: ReturnRequest) {
    setError(null);
    const promptMsg = r.is_admin_override
      ? "This product is Final Sale — No Returns. Enter a reason to override and approve anyway:"
      : "Approve this return? Add an optional note:";
    const reason = prompt(promptMsg);
    if (reason === null) return;
    if (r.is_admin_override && !reason.trim()) {
      setError("An override reason is required for a Final Sale item.");
      return;
    }

    setDecidingId(r.id);
    try {
      await api.put(`/returns/requests/${r.id}/approve`, { decision_reason: reason.trim() || undefined });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to approve request");
    } finally {
      setDecidingId(null);
    }
  }

  async function decline(r: ReturnRequest) {
    setError(null);
    const reason = prompt("Reason for declining this request:");
    if (reason === null) return;
    if (!reason.trim()) {
      setError("A reason is required to decline a request.");
      return;
    }

    setDecidingId(r.id);
    try {
      await api.put(`/returns/requests/${r.id}/decline`, { decision_reason: reason.trim() });
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to decline request");
    } finally {
      setDecidingId(null);
    }
  }

  const filtered = requests.filter((r) => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    if (!startDate || !endDate) return true;
    const d = r.requested_at.slice(0, 10);
    return d >= startDate && d <= endDate;
  });

  return (
    <>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex gap-2 flex-wrap items-center">
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className="w-36">
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="declined">Declined</option>
          </Select>
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
        <DateRangePicker
          startDate={startDate}
          endDate={endDate}
          onChange={(s, e) => {
            setStartDate(s);
            setEndDate(e);
          }}
        />
      </div>

      {error && <ErrorText>{error}</ErrorText>}
      {!loading && <p className="text-xs text-gray-400 mb-3">{filtered.length} request(s)</p>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <EmptyState icon={RotateCcw} title="No returns match this view" />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th>Request ID</Th>
                <Th>Date</Th>
                <Th>Customer</Th>
                <Th>Product</Th>
                <Th>Reason</Th>
                <Th>Status</Th>
                <Th>Decided by</Th>
                {isAdmin && <Th></Th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className={r.is_admin_override && r.status === "pending" ? "bg-amber-50" : ""}>
                  <Td>#{r.id}</Td>
                  <Td>{r.requested_at.slice(0, 10)}</Td>
                  <Td>{r.customer_name ?? (r.deleted_customer_snapshot ? `[Deleted: ${r.deleted_customer_snapshot}]` : "Walk-in")}</Td>
                  <Td>
                    {r.product_title} ({r.sku})
                    {r.is_admin_override && r.status === "pending" ? (
                      <span className="ml-1 text-xs text-amber-600 font-medium">Final Sale</span>
                    ) : (
                      ""
                    )}
                  </Td>
                  <Td>{r.reason}</Td>
                  <Td>
                    <Badge label={r.status} tone={statusTone(r.status)} />
                  </Td>
                  <Td>{r.decided_by_name ?? "—"}</Td>
                  {isAdmin && (
                    <Td>
                      {r.status === "pending" && (
                        <div className="flex gap-2">
                          <Button size="sm" variant="primary" disabled={decidingId === r.id} onClick={() => approve(r)}>
                            Approve
                          </Button>
                          <Button size="sm" variant="danger" disabled={decidingId === r.id} onClick={() => decline(r)}>
                            Decline
                          </Button>
                        </div>
                      )}
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
