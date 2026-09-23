import { useEffect, useState, Fragment, useMemo, MouseEvent, useRef, ReactNode } from "react";
import { ChevronDown, ChevronRight, Receipt, Printer, MoreVertical, Wallet, Download } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Sale } from "../lib/types";
import { downloadTabularReport, rangeLabelFor } from "../lib/reportPdf";
import { PageHeader, Card, Table, Th, Td, Badge, paymentStatusTone, EmptyState, ErrorText, DateRangePicker, Button, HelpHint, RowCard, RowCardStats, RowCardStat } from "../components/ui";
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
  // Two separate refs, not one shared between the desktop row and the
  // mobile card: both markups exist in the DOM at once (CSS just hides
  // whichever doesn't match the viewport), so a single ref's `current`
  // would get overwritten by whichever renders second — silently
  // pointing "outside click" detection at the wrong (invisible) element
  // and closing the menu on every click inside it, before the click
  // itself could ever reach a menu item's onClick.
  const desktopMenuRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  // "Mark as paid / COD collected" — self-delivered orders only, since
  // courier-collected COD is settled separately in bulk elsewhere.
  const [codConfirmSale, setCodConfirmSale] = useState<Sale | null>(null);
  const [codConfirming, setCodConfirming] = useState(false);
  const [codError, setCodError] = useState<string | null>(null);
  const [codPaymentMethod, setCodPaymentMethod] = useState<"cash" | "bank_transfer" | "card">("cash");
  const [undoingId, setUndoingId] = useState<number | null>(null);

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
      const target = e.target as Node;
      const insideDesktop = desktopMenuRef.current?.contains(target) ?? false;
      const insideMobile = mobileMenuRef.current?.contains(target) ?? false;
      if (!insideDesktop && !insideMobile) setOpenMenuId(null);
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

  // Downloads exactly what's currently on screen (the active tab or date
  // range) — the same "what you see is what you export" rule used
  // elsewhere, since `sales` already holds everything and filtering is
  // done client-side.
  function downloadSalesPdf() {
    const activeTabLabel = TABS.find((t) => t.value === activeTab)?.label ?? "Sales";
    const rangeLabel = startDate && endDate ? rangeLabelFor(startDate, endDate) : activeTabLabel;

    downloadTabularReport({
      headerLabel: "M&M Clothing — Sale History Report",
      title: "Sale History",
      rangeLabel,
      orientation: "landscape",
      columns: [
        { label: "Invoice", width: 80 },
        { label: "Date", width: 90 },
        { label: "Customer", width: 130 },
        { label: "Type", width: 60 },
        { label: "Total", width: 80, align: "right" },
        { label: "Paid", width: 80, align: "right" },
        { label: "Payment", width: 100 },
        { label: "Status", width: 90 },
      ],
      rows: filteredSales.map((sale) => ({
        cells: [
          sale.invoice + (sale.is_voided ? " (Voided)" : ""),
          sale.date.slice(0, 16).replace("T", " "),
          sale.customer_name ?? (sale.deleted_customer_snapshot ? `[Deleted: ${sale.deleted_customer_snapshot}]` : "Walk-in"),
          sale.sale_type === "online" ? "Online" : "In-Store",
          `Rs. ${sale.total.toLocaleString()}`,
          `Rs. ${sale.amount_paid.toLocaleString()}`,
          sale.payment_method ? sale.payment_method.replace("_", " ") : "—",
          sale.is_voided ? "Voided" : sale.payment_status,
        ],
        styles: sale.is_voided ? [{ color: 150 }, { color: 150 }, { color: 150 }, { color: 150 }, { color: 150 }, { color: 150 }, { color: 150 }, { color: 150 }] : undefined,
      })),
      summaryLines: [{ text: `Total for this view: Rs. ${periodTotal.toLocaleString()} (${filteredSales.length} sale${filteredSales.length !== 1 ? "s" : ""})`, bold: true }],
      filename: `sale-history-${rangeLabel.replace(/[^\w-]+/g, "-").toLowerCase()}.pdf`,
    });
  }

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

  async function handleConfirmCod() {
    if (!codConfirmSale) return;
    setCodError(null);
    setCodConfirming(true);
    try {
      await api.put(`/sales/${codConfirmSale.id}/confirm-cod`, { payment_method: codPaymentMethod });
      const refreshed = await api.get<Sale[]>("/sales");
      setSales(refreshed);
      setCodConfirmSale(null);
    } catch (err) {
      setCodError(err instanceof ApiRequestError ? err.message : "Failed to confirm this payment");
    } finally {
      setCodConfirming(false);
    }
  }

  async function handleUndoCod(sale: Sale) {
    setOpenMenuId(null);
    setError(null);
    if (!confirm(`Undo the COD confirmation for invoice ${sale.invoice}? This reverts it to unpaid and removes the matching cash book entry. Only possible within 24 hours of confirming.`)) return;

    setUndoingId(sale.id);
    try {
      await api.put(`/sales/${sale.id}/undo-cod`, {});
      const refreshed = await api.get<Sale[]>("/sales");
      setSales(refreshed);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to undo this confirmation");
    } finally {
      setUndoingId(null);
    }
  }

  // Shared between the desktop row's expanded panel and the mobile
  // card's expanded section, so the two views never drift apart.
  function renderExpandedItems(sale: Sale): ReactNode {
    return (
      <>
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
            {sale.items?.map((item) => (
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
        {sale.discount > 0 && (
          <p className="text-xs text-gray-400 mt-2">
            Discounts & Coupons: Rs. {sale.discount.toLocaleString()}
            {sale.manual_discount > 0 && ` (manual: Rs. ${sale.manual_discount.toLocaleString()})`}
            {sale.coupon_discount > 0 && ` (coupon ${sale.coupon_code}: Rs. ${sale.coupon_discount.toLocaleString()})`}
          </p>
        )}
        {!sale.is_voided && <p className="text-xs text-gray-400 mt-1">Loyalty points earned: {sale.loyalty_points_earned}</p>}
        {sale.is_voided && (
          <p className="text-xs text-red-500 mt-2">
            Voided {sale.voided_at?.slice(0, 16).replace("T", " ")}
            {sale.void_reason ? ` — ${sale.void_reason}` : ""}
            {sale.loyalty_points_earned > 0 && ` · ${sale.loyalty_points_earned} loyalty points reversed`}
          </p>
        )}
      </>
    );
  }

  // Same menu content for the desktop row's "..." button and the mobile
  // card's — only the trigger/positioning differs between the two.
  function renderActionsMenuItems(sale: Sale): ReactNode {
    return (
      <>
        <button onClick={() => openReceipt(sale)} className="w-full flex items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition">
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
        {sale.invoice.startsWith("OCD") &&
          !sale.is_voided &&
          sale.payment_status !== "paid" &&
          (!sale.delivery_partner || sale.delivery_partner === "D2D") && (
            <button
              onClick={() => {
                setOpenMenuId(null);
                setCodError(null);
                setCodPaymentMethod("cash");
                setCodConfirmSale(sale);
              }}
              className="w-full flex items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition"
            >
              <Wallet size={14} />
              Mark as paid / COD collected
            </button>
          )}
        {sale.invoice.startsWith("OCD") &&
          !sale.is_voided &&
          sale.payment_status === "paid" &&
          (!sale.delivery_partner || sale.delivery_partner === "D2D") && (
            <button
              onClick={() => handleUndoCod(sale)}
              disabled={undoingId === sale.id}
              className="w-full flex items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition disabled:opacity-50"
            >
              <Wallet size={14} />
              {undoingId === sale.id ? "Undoing..." : "Undo COD confirmation"}
            </button>
          )}
        {isAdmin && !sale.is_voided && (
          <button
            onClick={() => handleVoid(sale)}
            disabled={voidingId === sale.id}
            className="w-full flex items-center gap-2 px-3.5 py-2 text-left text-sm text-red-600 hover:bg-red-50 transition disabled:opacity-50 border-t border-gray-100 mt-1 pt-2"
          >
            Void sale
          </button>
        )}
      </>
    );
  }

  return (
    <div>
      <PageHeader
        title="Sale history"
        subtitle="Click a row to see the items included."
        action={
          <div className="flex items-center gap-2">
            <DateRangePicker
              startDate={startDate}
              endDate={endDate}
              onChange={(s, e) => {
                setStartDate(s);
                setEndDate(e);
              }}
            />
            <Button onClick={downloadSalesPdf} disabled={filteredSales.length === 0} className="inline-flex items-center gap-1.5">
              <Download size={14} />
              Download PDF
            </Button>
          </div>
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
        <>
          {/* Desktop / tablet-landscape */}
          <Card className="p-0 overflow-hidden hidden lg:block">
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
                      <Td>
                        {sale.customer_name ?? (sale.deleted_customer_snapshot ? `[Deleted: ${sale.deleted_customer_snapshot}]` : "Walk-in")}
                      </Td>
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
                        <div className="relative" ref={openMenuId === sale.id ? desktopMenuRef : undefined}>
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
                              {renderActionsMenuItems(sale)}
                            </div>
                          )}
                        </div>
                      </Td>
                    </tr>
                    {expanded?.id === sale.id && (
                      <tr>
                        <Td colSpan={9} className="bg-gray-50">
                          <div className="py-2">{renderExpandedItems(expanded)}</div>
                        </Td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </Table>
          </Card>

          {/* Mobile / tablet-portrait: stacked cards, same tap-to-expand */}
          <div className="lg:hidden space-y-2.5">
            {filteredSales.map((sale) => {
              const isExpanded = expanded?.id === sale.id;
              return (
                <RowCard key={sale.id} onClick={() => toggleExpand(sale)} className={sale.is_voided ? "opacity-50" : ""}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 leading-snug">
                        {sale.invoice}
                        {sale.is_voided ? " (Voided)" : ""}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">{sale.date.slice(0, 16).replace("T", " ")}</p>
                      <p className="text-xs text-gray-500 mt-1">
                        {sale.customer_name ?? (sale.deleted_customer_snapshot ? `[Deleted: ${sale.deleted_customer_snapshot}]` : "Walk-in")} ·{" "}
                        {sale.sale_type === "online" ? "Online" : "In-Store"}
                      </p>
                    </div>
                    <div className="flex-shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      {sale.is_voided ? <Badge label="voided" tone="danger" /> : <Badge label={sale.payment_status} tone={paymentStatusTone(sale.payment_status)} />}
                      <div className="relative" ref={openMenuId === sale.id ? mobileMenuRef : undefined}>
                        <button
                          onClick={() => setOpenMenuId(openMenuId === sale.id ? null : sale.id)}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
                          title="Actions"
                        >
                          <MoreVertical size={16} />
                        </button>
                        {openMenuId === sale.id && (
                          <div className="absolute right-0 z-20 mt-1 w-52 bg-white border border-gray-200 rounded-xl shadow-lg py-1">
                            {renderActionsMenuItems(sale)}
                          </div>
                        )}
                      </div>
                      {isExpanded ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
                    </div>
                  </div>

                  <RowCardStats>
                    <RowCardStat label="Total" value={`Rs. ${sale.total.toLocaleString()}`} />
                    <RowCardStat label="Paid" value={`Rs. ${sale.amount_paid.toLocaleString()}`} />
                    <RowCardStat label="Payment" value={<span className="capitalize">{sale.payment_method?.replace("_", " ") ?? "—"}</span>} />
                  </RowCardStats>
                  {(sale.change_due > 0 || sale.overpaid_amount > 0) && (
                    <p className="text-xs mt-1.5">
                      {sale.change_due > 0 && <span className="text-gray-400">Change: Rs. {sale.change_due.toLocaleString()}</span>}
                      {sale.overpaid_amount > 0 && <span className="text-amber-600">Overpaid: Rs. {sale.overpaid_amount.toLocaleString()}</span>}
                    </p>
                  )}

                  {isExpanded && (
                    <div className="mt-3 pt-3 border-t border-gray-100" onClick={(e) => e.stopPropagation()}>
                      {renderExpandedItems(expanded)}
                    </div>
                  )}
                </RowCard>
              );
            })}
          </div>
        </>
      )}

      {receiptSale && <ReceiptOptionsModal sale={receiptSale} onClose={() => setReceiptSale(null)} />}

      {codConfirmSale && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full shadow-2xl">
            <div className="p-5 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">
                Confirm COD collected
                <HelpHint text="This marks the order as fully paid and records the amount in the cash book, together, in one step." />
              </h2>
            </div>
            <div className="p-5">
              <p className="text-sm text-gray-600 mb-1">Invoice {codConfirmSale.invoice}</p>
              <p className="text-2xl font-semibold text-gray-900 mb-3">
                Rs. {(codConfirmSale.total - codConfirmSale.amount_paid).toLocaleString()}
              </p>
              <div className="mb-4">
                <p className="text-xs font-medium text-gray-500 mb-1.5">How was it collected?</p>
                <div className="flex gap-2">
                  {(["cash", "bank_transfer", "card"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setCodPaymentMethod(m)}
                      className={`flex-1 border rounded-xl py-2 text-xs font-medium capitalize transition ${
                        codPaymentMethod === m ? "border-black bg-black text-white" : "border-gray-200 text-gray-600 hover:border-gray-400"
                      }`}
                    >
                      {m.replace("_", " ")}
                    </button>
                  ))}
                </div>
              </div>
              {codError && <ErrorText>{codError}</ErrorText>}
              <div className="flex gap-2">
                <button
                  onClick={handleConfirmCod}
                  disabled={codConfirming}
                  className="flex-1 bg-black text-white rounded-xl py-2.5 text-sm font-medium hover:bg-gray-800 transition disabled:opacity-50"
                >
                  {codConfirming ? "Confirming..." : "Confirm, collected"}
                </button>
                <button
                  onClick={() => setCodConfirmSale(null)}
                  className="flex-1 border border-gray-200 rounded-xl py-2.5 text-sm font-medium hover:bg-gray-50 transition"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
