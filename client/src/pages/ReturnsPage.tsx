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

type ReturnsTab = "request" | "pending" | "history";

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
              ...(isAdmin ? [{ value: "pending" as ReturnsTab, label: "Pending Approvals" }] : []),
              { value: "history", label: "History" },
            ]}
          />
        }
      />

      {activeTab === "request" && <RequestReturnTab />}
      {activeTab === "pending" && isAdmin && <PendingApprovalsTab />}
      {activeTab === "history" && <HistoryTab />}
    </div>
  );
}

function RequestReturnTab() {
  const [invoiceQuery, setInvoiceQuery] = useState("");
  const [sale, setSale] = useState<Sale | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [condition, setCondition] = useState<"clean" | "damaged">("clean");
  const [resolution, setResolution] = useState<"refund" | "exchange">("refund");
  const [reason, setReason] = useState("");
  const [exchangeSku, setExchangeSku] = useState("");

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

    let exchange_inventory_id: number | undefined;
    if (resolution === "exchange") {
      if (!exchangeSku.trim()) {
        setSubmitError("Enter the SKU of the replacement item for an exchange");
        return;
      }
      try {
        const all = await api.get<InventoryUnit[]>("/inventory?status=available");
        const match = all.find((u) => u.sku.toLowerCase() === exchangeSku.trim().toLowerCase());
        if (!match) {
          setSubmitError("No available item found with that SKU for the exchange");
          return;
        }
        exchange_inventory_id = match.id;
      } catch (err) {
        setSubmitError(err instanceof ApiRequestError ? err.message : "Failed to look up exchange item");
        return;
      }
    }

    setSubmitting(true);
    try {
      const result = await api.post<ReturnRequest & { is_final_sale: boolean }>("/returns/requests", {
        sale_item_id: selectedItemId,
        condition,
        resolution,
        reason: reason.trim(),
        exchange_inventory_id,
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
      setExchangeSku("");
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
            Find sale
          </Button>
        </div>
        {lookupError && <ErrorText>{lookupError}</ErrorText>}
      </Card>

      {sale && (
        <Card>
          <h2 className="text-base font-semibold text-gray-900 mb-3">
            {sale.invoice} — {sale.customer_name ?? "Walk-in"}
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
              <Select value={resolution} onChange={(e) => setResolution(e.target.value as "refund" | "exchange")}>
                <option value="refund">Cash refund</option>
                <option value="exchange">Exchange for another item</option>
              </Select>
            </FormGroup>
          </div>

          {resolution === "exchange" && (
            <FormGroup>
              <Label>Replacement item SKU</Label>
              <Input placeholder="SKU of the item going out instead" value={exchangeSku} onChange={(e) => setExchangeSku(e.target.value)} />
            </FormGroup>
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

function PendingApprovalsTab() {
  const [requests, setRequests] = useState<ReturnRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      setRequests(await api.get<ReturnRequest[]>("/returns/requests/pending"));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load pending requests");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

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

  return (
    <>
      {error && <ErrorText>{error}</ErrorText>}
      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : requests.length === 0 ? (
        <EmptyState icon={RotateCcw} title="No pending return requests" />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th>Requested</Th>
                <Th>Invoice</Th>
                <Th>Customer</Th>
                <Th>Product</Th>
                <Th>Condition</Th>
                <Th>Resolution</Th>
                <Th>Reason</Th>
                <Th>Requested by</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} className={r.is_admin_override ? "bg-amber-50" : ""}>
                  <Td>{r.requested_at.slice(0, 16).replace("T", " ")}</Td>
                  <Td>{r.invoice}</Td>
                  <Td>{r.customer_name ?? "Walk-in"}</Td>
                  <Td>
                    {r.product_title} ({r.sku})
                    {r.is_admin_override ? <span className="ml-1 text-xs text-amber-600 font-medium">Final Sale</span> : ""}
                  </Td>
                  <Td className="capitalize">{r.condition}</Td>
                  <Td className="capitalize">{r.resolution}</Td>
                  <Td>{r.reason}</Td>
                  <Td>{r.requested_by_name ?? "—"}</Td>
                  <Td>
                    <div className="flex gap-2">
                      <Button size="sm" variant="primary" disabled={decidingId === r.id} onClick={() => approve(r)}>
                        Approve
                      </Button>
                      <Button size="sm" variant="danger" disabled={decidingId === r.id} onClick={() => decline(r)}>
                        Decline
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}

function HistoryTab() {
  const [requests, setRequests] = useState<ReturnRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      setError(err instanceof ApiRequestError ? err.message : "Failed to load return history");
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

  const filtered = requests.filter((r) => {
    if (!startDate || !endDate) return true;
    const d = r.requested_at.slice(0, 10);
    return d >= startDate && d <= endDate;
  });

  return (
    <>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex gap-2 flex-wrap">
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
      {!loading && <p className="text-xs text-gray-400 mb-3">{filtered.length} request(s) in this range</p>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <EmptyState icon={RotateCcw} title="No return requests in this range" />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th>Request ID</Th>
                <Th>Date</Th>
                <Th>Customer</Th>
                <Th>Product</Th>
                <Th>Qty</Th>
                <Th>Reason</Th>
                <Th>Status</Th>
                <Th>Decided by</Th>
                <Th>Timestamp</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <Td>#{r.id}</Td>
                  <Td>{r.requested_at.slice(0, 10)}</Td>
                  <Td>{r.customer_name ?? "Walk-in"}</Td>
                  <Td>
                    {r.product_title} ({r.sku})
                  </Td>
                  <Td>1</Td>
                  <Td>{r.reason}</Td>
                  <Td>
                    <Badge label={r.status} tone={statusTone(r.status)} />
                  </Td>
                  <Td>{r.decided_by_name ?? "—"}</Td>
                  <Td>{r.decided_at ? r.decided_at.slice(0, 16).replace("T", " ") : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
