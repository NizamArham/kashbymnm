import { useEffect, useState, Fragment, useMemo, MouseEvent, useRef } from "react";
import { Receipt, Printer, MoreVertical } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Sale } from "../lib/types";
import { PageHeader, Card, Table, Th, Td, Badge, paymentStatusTone, EmptyState, ErrorText, DateRangePicker } from "../components/ui";
import ReceiptOptionsModal from "../components/ReceiptOptionsModal";
import { useAuth } from "../context/AuthContext";

type HistoryTab = "today" | "week" | "month" | "cash" | "credit_cod" | "voided";

const TABS: { value: HistoryTab; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "cash", label: "Cash Sales" },
  { value: "credit_cod", label: "Credit / COD" },
  { value: "voided", label: "Voided" },
];

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
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const [activeTab, setActiveTab] = useState<HistoryTab>("month");

  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Sale[]>("/sales")
      .then(setSales)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Failed to load sales"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    function handleClickOutside(e: globalThis.MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpenMenuId(null);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filteredSales = useMemo(() => {
    let result = sales;

    if (startDate && endDate) {
      result = result.filter((s) => {
        const d = s.date.slice(0, 10);
        return d >= startDate && d <= endDate;
      });
    } else {
      const today = toISODate(new Date());
      if (activeTab === "today") {
        result = result.filter((s) => s.date.slice(0, 10) === today);
      } else if (activeTab === "week") {
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 6);
        const start = toISODate(weekAgo);
        result = result.filter((s) => s.date.slice(0, 10) >= start);
      } else if (activeTab === "month") {
        const now = new Date();
        const monthStart = toISODate(new Date(now.getFullYear(), now.getMonth(), 1));
        result = result.filter((s) => s.date.slice(0, 10) >= monthStart);
      }
    }

    if (activeTab === "cash") {
      result = result.filter((s) => s.payment_method === "cash" && !s.is_voided);
    } else if (activeTab === "credit_cod") {
      result = result.filter((s) => (s.payment_method === "credit" || s.sale_type === "online") && !s.is_voided);
    } else if (activeTab === "voided") {
      result = result.filter((s) => s.is_voided);
    } else {
      result = result.filter((s) => !s.is_voided);
    }

    return result;
  }, [sales, activeTab, startDate, endDate]);

  const periodTotal = filteredSales.reduce((sum, s) => sum + s.total, 0);

  async function toggleExpand(sale: Sale) {
    if (expanded?.id === sale.id) {
      setExpanded(null);
      return;
    }
    setExpanded(await api.get<Sale>(`/sales/${sale.id}`));
  }

  async function openReceipt(sale: Sale) {
    setOpenMenuId(null);
    const full = expanded?.id === sale.id ? expanded : await api.get<Sale>(`/sales/${sale.id}`);
    setReceiptSale(full);
  }

  async function handleVoid(sale: Sale) {
    setOpenMenuId(null);
    setError(null);

    const saleDay = sale.date.slice(0, 10);
    const today = toISODate(new Date());
    const sameDayWarning = saleDay !== today ? "\n\nNote: this sale was NOT made today — voiding an older sale should be rare." : "";
    const reason = prompt(`Void invoice ${sale.invoice}? Stock will be returned and any payment reversed in the cash book.${sameDayWarning}\n\nReason (optional):`);
    if (reason === null) return;

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
        action={
          <DateRangePicker
            startDate={startDate}
            endDate={endDate}
            onChange={(s, e) => {
              setStartDate(s);
              setEndDate(e);
            }}
          />
        }
      />

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => {
              setActiveTab(tab.value);
              setStartDate(null);
              setEndDate(null);
            }}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition ${
              activeTab === tab.value && !startDate
                ? tab.value === "voided"
                  ? "bg-red-600 text-white"
                  : "bg-black text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      {!loading && (
        <p className="text-xs text-gray-400 mb-3">
          {filteredSales.length} sale{filteredSales.length !== 1 ? "s" : ""} · Rs. {periodTotal.toLocaleString()} total
        </p>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : filteredSales.length === 0 ? (
        <EmptyState icon={Receipt} title="No sales match this view" />
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
                <Th>Payment</Th>
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
                      <div className="capitalize">{sale.payment_method?.replace("_", " ") ?? "—"}</div>
                      {sale.change_due > 0 && <div className="text-xs text-gray-400">Change: Rs. {sale.change_due.toLocaleString()}</div>}
                      {sale.overpaid_amount > 0 && (
                        <div className="text-xs text-amber-600">Overpaid: Rs. {sale.overpaid_amount.toLocaleString()}</div>
                      )}
                    </Td>
                    <Td>
                      {sale.is_voided ? <Badge label="voided" tone="danger" /> : <Badge label={sale.payment_status} tone={paymentStatusTone(sale.payment_status)} />}
                    </Td>
                    <Td>
                      <div className="relative" ref={openMenuId === sale.id ? menuRef : undefined}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenMenuId(openMenuId === sale.id ? null : sale.id);
                          }}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
                          title="Actions"
                        >
                          <MoreVertical size={16} />
                        </button>
                        {openMenuId === sale.id && (
                          <div
                            onClick={(e: MouseEvent) => e.stopPropagation()}
                            className="absolute right-0 z-20 mt-1 w-44 bg-white border border-gray-200 rounded-xl shadow-lg py-1"
                          >
                            <button
                              onClick={() => openReceipt(sale)}
                              className="w-full flex items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition"
                            >
                              <Printer size={14} />
                              Get receipt
                            </button>
                            <button
                              onClick={() => {
                                setOpenMenuId(null);
                                toggleExpand(sale);
                              }}
                              className="w-full flex items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition"
                            >
                              <Receipt size={14} />
                              View details
                            </button>
                            {isAdmin && !sale.is_voided && (
                              <button
                                onClick={() => handleVoid(sale)}
                                disabled={voidingId === sale.id}
                                className="w-full flex items-center gap-2 px-3.5 py-2 text-left text-sm text-red-600 hover:bg-red-50 transition disabled:opacity-50 border-t border-gray-100 mt-1 pt-2"
                              >
                                Void sale
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </Td>
                  </tr>
                  {expanded?.id === sale.id && (
                    <tr>
                      <Td colSpan={9} className="bg-gray-50">
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
                                <tr key={item.id} className={item.is_returned ? "opacity-60" : ""}>
                                  <Td className={item.is_returned ? "line-through" : ""}>{item.sku}</Td>
                                  <Td className={item.is_returned ? "line-through" : ""}>
                                    {item.product_title}
                                    {item.is_returned ? (
                                      <span className="ml-2 not-italic no-underline">
                                        <Badge label="RTN" tone="danger" />
                                      </span>
                                    ) : null}
                                  </Td>
                                  <Td className={item.is_returned ? "line-through" : ""}>
                                    {item.size ?? "—"} / {item.color ?? "—"}
                                  </Td>
                                  <Td className={item.is_returned ? "line-through" : ""}>Rs. {item.unit_price.toLocaleString()}</Td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {expanded.discount > 0 && (
                            <p className="text-xs text-gray-400 mt-2">
                              Discounts & Coupons: Rs. {expanded.discount.toLocaleString()}
                              {expanded.manual_discount > 0 && ` (manual: Rs. ${expanded.manual_discount.toLocaleString()})`}
                              {expanded.coupon_discount > 0 &&
                                ` (coupon ${expanded.coupon_code}: Rs. ${expanded.coupon_discount.toLocaleString()})`}
                            </p>
                          )}
                          {!expanded.is_voided && (
                            <p className="text-xs text-gray-400 mt-1">Loyalty points earned: {expanded.loyalty_points_earned}</p>
                          )}
                          {expanded.is_voided && (
                            <p className="text-xs text-red-500 mt-2">
                              Voided {expanded.voided_at?.slice(0, 16).replace("T", " ")}
                              {expanded.void_reason ? ` — ${expanded.void_reason}` : ""}
                              {expanded.loyalty_points_earned > 0 && ` · ${expanded.loyalty_points_earned} loyalty points reversed`}
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
