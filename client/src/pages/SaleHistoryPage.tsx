import { useEffect, useState, Fragment, useMemo, MouseEvent } from "react";
import { Receipt, Printer, Ban } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Sale } from "../lib/types";
import { PageHeader, Card, Table, Th, Td, Badge, paymentStatusTone, EmptyState, ErrorText, DateRangePicker } from "../components/ui";
import ReceiptOptionsModal from "../components/ReceiptOptionsModal";
import { useAuth } from "../context/AuthContext";

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function SaleHistoryPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [sales, setSales] = useState<Sale[]>([]);
  const [expanded, setExpanded] = useState<Sale | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [receiptSale, setReceiptSale] = useState<Sale | null>(null);
  const [voidingId, setVoidingId] = useState<number | null>(null);

  // Defaults to the past month, per the usual "recent activity" view —
  // the date picker lets the person widen or narrow this at will.
  const [startDate, setStartDate] = useState<string | null>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return toISODate(d);
  });
  const [endDate, setEndDate] = useState<string | null>(() => toISODate(new Date()));

  useEffect(() => {
    api
      .get<Sale[]>("/sales")
      .then(setSales)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Failed to load sales"))
      .finally(() => setLoading(false));
  }, []);

  const filteredSales = useMemo(() => {
    if (!startDate || !endDate) return sales;
    // sale.date is a full datetime string; compare just the date portion
    // so the end date is inclusive of the whole day.
    return sales.filter((s) => {
      const saleDate = s.date.slice(0, 10);
      return saleDate >= startDate && saleDate <= endDate;
    });
  }, [sales, startDate, endDate]);

  const periodTotal = filteredSales.reduce((sum, s) => sum + s.total, 0);

  async function toggleExpand(sale: Sale) {
    if (expanded?.id === sale.id) {
      setExpanded(null);
      return;
    }
    setExpanded(await api.get<Sale>(`/sales/${sale.id}`));
  }

  async function openReceipt(sale: Sale, e: MouseEvent) {
    e.stopPropagation();
    // Receipts need the itemized breakdown, so fetch the full sale even
    // if this row hasn't been expanded yet.
    const full = expanded?.id === sale.id ? expanded : await api.get<Sale>(`/sales/${sale.id}`);
    setReceiptSale(full);
  }

  async function handleVoid(sale: Sale, e: MouseEvent) {
    e.stopPropagation();
    setError(null);

    const saleDay = sale.date.slice(0, 10);
    const today = toISODate(new Date());
    // Not hard-blocked past the same day — a genuine dispute or mistake
    // found later shouldn't be impossible to fix — but flagged clearly,
    // since same-day is when this is meant to catch billing mistakes.
    const sameDayWarning = saleDay !== today ? "\n\nNote: this sale was NOT made today — voiding an older sale should be rare." : "";
    const reason = prompt(`Void invoice ${sale.invoice}? Stock will be returned and any payment reversed in the cash book.${sameDayWarning}\n\nReason (optional):`);
    if (reason === null) return; // cancelled

    setVoidingId(sale.id);
    try {
      await api.put(`/sales/${sale.id}/void`, { reason: reason.trim() || undefined });
      const refreshed = await api.get<Sale[]>("/sales");
      setSales(refreshed);
      setExpanded(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to void this sale");
    } finally {
      setVoidingId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Sale history"
        subtitle="Click a row to see the items included."
        action={<DateRangePicker startDate={startDate} endDate={endDate} onChange={(s, e) => { setStartDate(s); setEndDate(e); }} />}
      />

      {error && <ErrorText>{error}</ErrorText>}

      {!loading && (
        <p className="text-xs text-gray-400 mb-3">
          {filteredSales.length} sale{filteredSales.length !== 1 ? "s" : ""} in this range · Rs. {periodTotal.toLocaleString()} total
        </p>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : filteredSales.length === 0 ? (
        <EmptyState icon={Receipt} title="No sales in this date range" />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th>Invoice</Th>
                <Th>Date</Th>
                <Th>Customer</Th>
                <Th>Type</Th>
                <Th>Total</Th>
                <Th>Paid</Th>
                <Th>Status</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {filteredSales.map((sale) => (
                <Fragment key={sale.id}>
                  <tr
                    onClick={() => toggleExpand(sale)}
                    className={`cursor-pointer hover:bg-gray-50 ${sale.is_voided ? "opacity-50" : ""}`}
                  >
                    <Td>
                      {sale.invoice}
                      {sale.is_voided ? " (Voided)" : ""}
                    </Td>
                    <Td>{sale.date.slice(0, 16).replace("T", " ")}</Td>
                    <Td>{sale.customer_name ?? "Walk-in"}</Td>
                    <Td>{sale.sale_type === "online" ? "Online" : "In-Store"}</Td>
                    <Td>Rs. {sale.total.toLocaleString()}</Td>
                    <Td>Rs. {sale.amount_paid.toLocaleString()}</Td>
                    <Td>
                      {sale.is_voided ? <Badge label="voided" tone="danger" /> : <Badge label={sale.payment_status} tone={paymentStatusTone(sale.payment_status)} />}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={(e) => openReceipt(sale, e)}
                          className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-900 transition"
                          title="Get receipt"
                        >
                          <Printer size={14} />
                        </button>
                        {isAdmin && !sale.is_voided && (
                          <button
                            onClick={(e) => handleVoid(sale, e)}
                            disabled={voidingId === sale.id}
                            className="inline-flex items-center gap-1.5 text-xs text-red-400 hover:text-red-600 transition disabled:opacity-50"
                            title="Void this sale"
                          >
                            <Ban size={14} />
                          </button>
                        )}
                      </div>
                    </Td>
                  </tr>
                  {expanded?.id === sale.id && (
                    <tr>
                      <Td colSpan={8} className="bg-gray-50">
                        <div className="py-2">
                          <strong className="text-xs text-gray-700">Items</strong>
                          <table className="w-full text-sm mt-2">
                            <thead>
                              <tr>
                                <Th>SKU</Th>
                                <Th>Product</Th>
                                <Th>Size/Color</Th>
                                <Th>Price</Th>
                              </tr>
                            </thead>
                            <tbody>
                              {expanded.items?.map((item) => (
                                <tr key={item.id}>
                                  <Td>{item.sku}</Td>
                                  <Td>{item.product_title}</Td>
                                  <Td>
                                    {item.size ?? "—"} / {item.color ?? "—"}
                                  </Td>
                                  <Td>Rs. {item.unit_price.toLocaleString()}</Td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <p className="text-xs text-gray-400 mt-2">
                            Loyalty points earned: {expanded.is_voided ? 0 : expanded.loyalty_points_earned}
                            {expanded.is_voided && <span className="text-gray-300"> (was {expanded.loyalty_points_earned}, reversed)</span>}
                          </p>
                          {expanded.is_voided && (
                            <p className="text-xs text-red-500 mt-1">
                              Voided {expanded.voided_at?.slice(0, 16).replace("T", " ")}
                              {expanded.void_reason ? ` — ${expanded.void_reason}` : ""}
                            </p>
                          )}
                        </div>
                      </Td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {receiptSale && <ReceiptOptionsModal sale={receiptSale} onClose={() => setReceiptSale(null)} />}
    </div>
  );
}
