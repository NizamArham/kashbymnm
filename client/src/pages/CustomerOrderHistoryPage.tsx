import { useEffect, useState, Fragment } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, ChevronDown, ChevronRight, ShoppingBag, MoreVertical, FileText, Receipt as ReceiptIcon, MessageCircle } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Sale, SaleItem, Customer } from "../lib/types";
import { downloadA4Pdf, downloadThermalPdf, sendWhatsAppBill, groupSaleItemsForDisplay } from "../lib/receipts";
import { PageHeader, Card, Table, Th, Td, Badge, SortHeader, paymentStatusTone, EmptyState, ErrorText } from "../components/ui";
import ReceiptOptionsModal, { ModalOption } from "../components/ReceiptOptionsModal";
import { useCopyToClipboard } from "../lib/useCopyToClipboard";
import { useSortableData } from "../lib/useSortableData";

type OrderSortKey = "invoice" | "date" | "total";

export default function CustomerOrderHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [expandedSaleId, setExpandedSaleId] = useState<number | null>(null);
  // Fetched lazily, one sale's line items at a time, only when that
  // row is actually expanded — mirrors the same on-demand pattern used
  // for a product's inventory on Manage Products, rather than fetching
  // every order's line items up front for a customer who may have a
  // long history.
  const [itemsBySale, setItemsBySale] = useState<Record<number, SaleItem[]>>({});
  const [itemsLoading, setItemsLoading] = useState<number | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);

  const { copy: copySku, tooltip: skuCopyTooltip } = useCopyToClipboard();

  const { sorted: sortedSales, sortKey, sortDir, toggleSort } = useSortableData<Sale, OrderSortKey>(
    sales,
    (s, key) => {
      switch (key) {
        case "invoice":
          return s.invoice.toLowerCase();
        case "date":
          return s.date;
        case "total":
          return s.total;
      }
    },
    "date",
    "desc"
  );

  // "Get receipt" modal for a row — same A4/thermal/WhatsApp options as
  // Sale History and the sale detail page, so a customer's own order
  // history offers the exact same downloads rather than a one-off PDF.
  const [receiptSale, setReceiptSale] = useState<Sale | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [receiptLoadingId, setReceiptLoadingId] = useState<number | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [customerResult, salesResult] = await Promise.all([
          api.get<Customer>(`/customers/${id}`),
          api.get<Sale[]>(`/sales?customer_id=${id}`),
        ]);
        if (cancelled) return;
        setCustomer(customerResult);
        setSales(salesResult);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiRequestError ? err.message : "Failed to load order history");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function toggleExpand(saleId: number) {
    if (expandedSaleId === saleId) {
      setExpandedSaleId(null);
      return;
    }
    setExpandedSaleId(saleId);
    if (itemsBySale[saleId]) return;

    setItemsLoading(saleId);
    setItemsError(null);
    try {
      const detail = await api.get<{ items: SaleItem[] }>(`/sales/${saleId}`);
      setItemsBySale((prev) => ({ ...prev, [saleId]: detail.items }));
    } catch (err) {
      setItemsError(err instanceof ApiRequestError ? err.message : "Failed to load this order's items");
    } finally {
      setItemsLoading(null);
    }
  }

  // Same "Get receipt" options as Sale History / the sale detail page —
  // fetches the full sale (line items aren't in the list response) the
  // first time, then reuses it if the row is reopened.
  async function openReceipt(sale: Sale) {
    setReceiptError(null);
    setReceiptLoadingId(sale.id);
    try {
      const full = itemsBySale[sale.id] ? { ...sale, items: itemsBySale[sale.id] } : await api.get<Sale>(`/sales/${sale.id}`);
      setReceiptSale(full);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load this order's receipt");
    } finally {
      setReceiptLoadingId(null);
    }
  }

  function receiptOptionsFor(sale: Sale): ModalOption[] {
    return [
      {
        key: "a4",
        icon: <FileText size={17} className="text-gray-700" />,
        title: "A4 Invoice (PDF)",
        subtitle: "Full-page printable invoice",
        onClick: () => downloadA4Pdf(sale),
      },
      {
        key: "thermal",
        icon: <ReceiptIcon size={17} className="text-gray-700" />,
        title: "80mm Receipt (PDF)",
        subtitle: "For thermal till printers",
        onClick: () => downloadThermalPdf(sale),
      },
      {
        key: "whatsapp",
        icon: <MessageCircle size={17} className="text-green-600" />,
        iconBgClass: "bg-green-50",
        title: "Send via WhatsApp",
        subtitle: "Text summary to customer's phone",
        onClick: () => {
          const phone = sale.customer_phone ?? customer?.phone;
          if (!phone) {
            setReceiptError("This customer has no saved phone number — add one on the Customers page first.");
            return;
          }
          setReceiptError(null);
          sendWhatsAppBill(sale, phone);
        },
      },
    ];
  }

  const totalSpent = sales.reduce((sum, s) => sum + s.total, 0);

  return (
    <div>
      <button
        onClick={() => navigate(-1)}
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-3"
      >
        <ArrowLeft size={15} />
        Back
      </button>

      <PageHeader
        title={customer ? `${customer.name}'s orders` : "Order history"}
        subtitle={
          customer
            ? `${sales.length} order${sales.length === 1 ? "" : "s"} · Rs. ${totalSpent.toLocaleString()} total`
            : undefined
        }
      />

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : sales.length === 0 ? (
        <EmptyState icon={ShoppingBag} title="No orders yet" subtitle="This customer hasn't placed an order." />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th></Th>
                <SortHeader<OrderSortKey> label="Invoice" sortKey="invoice" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortHeader<OrderSortKey> label="Date" sortKey="date" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <Th>Type</Th>
                <SortHeader<OrderSortKey> label="Total" sortKey="total" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <Th>Status</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {sortedSales.map((sale, index) => {
                const isExpanded = expandedSaleId === sale.id;
                const items = itemsBySale[sale.id];
                return (
                  <Fragment key={sale.id}>
                    <tr
                      onClick={() => toggleExpand(sale.id)}
                      className={`cursor-pointer ${index % 2 === 1 ? "bg-gray-50/60 hover:bg-gray-100" : "hover:bg-gray-100"}`}
                    >
                      <Td className="w-8">
                        {isExpanded ? <ChevronDown size={15} className="text-gray-400" /> : <ChevronRight size={15} className="text-gray-400" />}
                      </Td>
                      <Td className="font-medium">{sale.invoice}</Td>
                      <Td>{sale.date.slice(0, 10)}</Td>
                      <Td className="capitalize">{sale.sale_type === "online" ? "Online" : "In-store"}</Td>
                      <Td>Rs. {sale.total.toLocaleString()}</Td>
                      <Td>
                        {sale.is_voided ? (
                          <Badge label="voided" tone="danger" />
                        ) : (
                          <Badge label={sale.payment_status} tone={paymentStatusTone(sale.payment_status)} />
                        )}
                      </Td>
                      <Td className="w-8">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openReceipt(sale);
                          }}
                          disabled={receiptLoadingId === sale.id}
                          className="text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100 disabled:opacity-50"
                          title="Get receipt"
                        >
                          <MoreVertical size={15} />
                        </button>
                      </Td>
                    </tr>

                    {isExpanded && (
                      <tr>
                        <Td colSpan={7} className="bg-gray-50/70 !py-3 !px-4">
                          {itemsLoading === sale.id ? (
                            <p className="text-xs text-gray-400 px-1">Loading items...</p>
                          ) : itemsError ? (
                            <ErrorText>{itemsError}</ErrorText>
                          ) : !items || items.length === 0 ? (
                            <p className="text-xs text-gray-400 px-1">No line items on record for this order.</p>
                          ) : (
                            <div className="bg-white rounded-xl overflow-hidden shadow-sm">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="bg-gray-50">
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Product</th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Size / Color</th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">SKU</th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Qty</th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Unit price</th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Line total</th>
                                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide"></th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                  {groupSaleItemsForDisplay(items).map((item, i) => (
                                    <tr key={item.ids.join(",")} className={i % 2 === 1 ? "bg-gray-50/50" : ""}>
                                      <td className="px-4 py-2 font-medium text-gray-900">{item.product_title ?? "—"}</td>
                                      <td className="px-4 py-2 text-gray-600">
                                        {[item.size, item.color].filter(Boolean).join(" / ") || "—"}
                                      </td>
                                      <td
                                        onClick={(e) => item.sku && copySku(`sku-${item.ids.join(",")}`, item.sku, e)}
                                        className={`px-4 py-2 text-gray-500 ${item.sku ? "cursor-pointer hover:bg-gray-100 rounded transition-colors select-none" : ""}`}
                                        title={item.sku ? "Click to copy SKU" : undefined}
                                      >
                                        {item.sku ?? "—"}
                                      </td>
                                      <td className="px-4 py-2 text-gray-600">{item.quantity}</td>
                                      <td className="px-4 py-2 text-gray-600">Rs. {item.unit_price.toLocaleString()}</td>
                                      <td className="px-4 py-2 font-medium text-gray-900">Rs. {item.line_total.toLocaleString()}</td>
                                      <td className="px-4 py-2">
                                        {item.is_returned ? <Badge label="Returned" tone="danger" /> : null}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </Td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}

      {receiptSale && (
        <ReceiptOptionsModal
          heading="Get receipt"
          subtitle={receiptSale.invoice}
          options={receiptOptionsFor(receiptSale)}
          error={receiptError}
          onClose={() => setReceiptSale(null)}
        />
      )}

      {skuCopyTooltip}
    </div>
  );
}
