import { useEffect, useState, Fragment } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, ChevronDown, ChevronRight, ShoppingBag, MoreVertical, Download } from "lucide-react";
import jsPDF from "jspdf";
import { api, ApiRequestError } from "../lib/api";
import { Sale, SaleItem, Customer } from "../lib/types";
import { PageHeader, Card, Table, Th, Td, Badge, paymentStatusTone, EmptyState, ErrorText } from "../components/ui";

interface BusinessInfo {
  business_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
}

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function CustomerOrderHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [sales, setSales] = useState<Sale[]>([]);
  const [businessInfo, setBusinessInfo] = useState<BusinessInfo | null>(null);
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

  // The 3-dot menu open for a given sale row, and per-invoice
  // downloading state (so a slow items fetch shows real feedback on
  // the specific row being downloaded, not a blanket page spinner).
  const [menuOpenFor, setMenuOpenFor] = useState<number | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [customerResult, salesResult, businessResult] = await Promise.all([
          api.get<Customer>(`/customers/${id}`),
          api.get<Sale[]>(`/sales?customer_id=${id}`),
          api.get<BusinessInfo>(`/business-info`).catch(() => null),
        ]);
        if (cancelled) return;
        setCustomer(customerResult);
        setSales(salesResult);
        setBusinessInfo(businessResult);
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

  useEffect(() => {
    function handleClickOutside() {
      setMenuOpenFor(null);
    }
    if (menuOpenFor !== null) {
      document.addEventListener("click", handleClickOutside);
      return () => document.removeEventListener("click", handleClickOutside);
    }
  }, [menuOpenFor]);

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

  // A one-page A4 invoice for a single sale — genuinely different from
  // the multi-page payment-history statement (a receipt-style document
  // for one transaction, not a running ledger), so it gets its own,
  // simpler layout: business details up top, customer + invoice meta,
  // the line items, totals, and a small footer.
  async function downloadInvoice(sale: Sale) {
    setDownloadError(null);
    setMenuOpenFor(null);
    setDownloadingId(sale.id);
    try {
      let items = itemsBySale[sale.id];
      if (!items) {
        const detail = await api.get<{ items: SaleItem[] }>(`/sales/${sale.id}`);
        items = detail.items;
        setItemsBySale((prev) => ({ ...prev, [sale.id]: items }));
      }

      const doc = new jsPDF({ unit: "pt", format: "a4" });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const marginX = 40;
      let y = 50;

      // Business header
      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(20);
      doc.text(businessInfo?.business_name || "M&M Clothing", marginX, y);
      y += 18;
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100);
      const addressLine = [businessInfo?.address_line1, businessInfo?.address_line2, businessInfo?.city].filter(Boolean).join(", ");
      if (addressLine) {
        doc.text(addressLine, marginX, y);
        y += 13;
      }
      const contactLine = [businessInfo?.phone, businessInfo?.email].filter(Boolean).join(" · ");
      if (contactLine) {
        doc.text(contactLine, marginX, y);
        y += 13;
      }

      // Invoice title + meta, top right
      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(20);
      doc.text("INVOICE", pageWidth - marginX, 50, { align: "right" });
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100);
      doc.text(sale.invoice, pageWidth - marginX, 68, { align: "right" });
      doc.text(sale.date.slice(0, 10), pageWidth - marginX, 81, { align: "right" });
      if (sale.is_voided) {
        doc.setTextColor(200, 0, 0);
        doc.text("VOIDED", pageWidth - marginX, 94, { align: "right" });
      }

      y = Math.max(y, 94) + 20;
      doc.setDrawColor(220);
      doc.line(marginX, y, pageWidth - marginX, y);
      y += 20;

      // Bill-to block
      doc.setFontSize(9);
      doc.setTextColor(120);
      doc.text("BILL TO", marginX, y);
      y += 14;
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(20);
      doc.text(customer?.name || sale.customer_name || "Walk-in customer", marginX, y);
      y += 15;
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(100);
      if (customer?.customer_code) {
        doc.text(customer.customer_code, marginX, y);
        y += 13;
      }
      if (sale.customer_phone) {
        doc.text(sale.customer_phone, marginX, y);
        y += 13;
      }
      y += 15;

      // Line items table
      const columns = [
        { label: "Item", width: 220 },
        { label: "Size/Color", width: 90 },
        { label: "Qty", width: 40 },
        { label: "Unit price", width: 85 },
        { label: "Total", width: 85 },
      ];
      const tableWidth = columns.reduce((sum, c) => sum + c.width, 0);
      const rowHeight = 20;

      doc.setFillColor(245, 245, 245);
      doc.rect(marginX, y, tableWidth, rowHeight, "F");
      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(80);
      let x = marginX + 6;
      for (const col of columns) {
        doc.text(col.label, x, y + 14);
        x += col.width;
      }
      y += rowHeight;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      for (const item of items) {
        x = marginX + 6;
        doc.setTextColor(30);
        const title = (item.product_title ?? "—").length > 30 ? (item.product_title ?? "—").slice(0, 27) + "..." : item.product_title ?? "—";
        doc.text(title, x, y + 14);
        x += columns[0].width;
        doc.text([item.size, item.color].filter(Boolean).join(" / ") || "—", x, y + 14);
        x += columns[1].width;
        doc.text(String(item.quantity), x, y + 14);
        x += columns[2].width;
        doc.text(item.unit_price.toLocaleString(), x, y + 14);
        x += columns[3].width;
        doc.text(item.line_total.toLocaleString(), x, y + 14);
        doc.setDrawColor(235);
        doc.line(marginX, y + rowHeight, marginX + tableWidth, y + rowHeight);
        y += rowHeight;
      }

      // Totals block, right-aligned
      y += 16;
      const totalsX = marginX + tableWidth;
      function totalsLine(label: string, value: string, bold = false) {
        doc.setFont("helvetica", bold ? "bold" : "normal");
        doc.setFontSize(bold ? 11 : 9);
        doc.setTextColor(bold ? 20 : 90);
        doc.text(label, totalsX - 160, y);
        doc.text(value, totalsX, y, { align: "right" });
        y += bold ? 18 : 15;
      }
      totalsLine("Subtotal", `Rs. ${sale.subtotal.toLocaleString()}`);
      if (sale.discount > 0) totalsLine("Discount", `- Rs. ${sale.discount.toLocaleString()}`);
      if (sale.coupon_discount > 0) totalsLine(`Coupon${sale.coupon_code ? ` (${sale.coupon_code})` : ""}`, `- Rs. ${sale.coupon_discount.toLocaleString()}`);
      doc.setDrawColor(200);
      doc.line(totalsX - 160, y - 4, totalsX, y - 4);
      totalsLine("Total", `Rs. ${sale.total.toLocaleString()}`, true);
      totalsLine("Paid", `Rs. ${sale.amount_paid.toLocaleString()}`);
      if (sale.total - sale.amount_paid > 0) {
        totalsLine("Balance due", `Rs. ${(sale.total - sale.amount_paid).toLocaleString()}`, true);
      }

      // Footer
      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text(`Generated ${toISODate(new Date())} · Thank you for shopping with ${businessInfo?.business_name || "M&M Clothing"}`, marginX, pageHeight - 24);
      doc.text(sale.invoice, pageWidth - marginX, pageHeight - 24, { align: "right" });

      doc.save(`invoice-${sale.invoice}.pdf`);
    } catch (err) {
      setDownloadError(err instanceof ApiRequestError ? err.message : "Failed to generate invoice");
    } finally {
      setDownloadingId(null);
    }
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
      {downloadError && <ErrorText>{downloadError}</ErrorText>}

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
                <Th>Invoice</Th>
                <Th>Date</Th>
                <Th>Type</Th>
                <Th>Total</Th>
                <Th>Status</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {sales.map((sale, index) => {
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
                      <Td className="w-8 relative">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpenFor(menuOpenFor === sale.id ? null : sale.id);
                          }}
                          className="text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100"
                        >
                          <MoreVertical size={15} />
                        </button>
                        {menuOpenFor === sale.id && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className="absolute right-0 top-full mt-1 z-20 bg-white border border-gray-200 rounded-xl shadow-lg py-1 w-48"
                          >
                            <button
                              onClick={() => downloadInvoice(sale)}
                              disabled={downloadingId === sale.id}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 text-left"
                            >
                              <Download size={14} />
                              {downloadingId === sale.id ? "Generating..." : "Download invoice (A4)"}
                            </button>
                          </div>
                        )}
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
                                  {items.map((item, i) => (
                                    <tr key={item.id} className={i % 2 === 1 ? "bg-gray-50/50" : ""}>
                                      <td className="px-4 py-2 font-medium text-gray-900">{item.product_title ?? "—"}</td>
                                      <td className="px-4 py-2 text-gray-600">
                                        {[item.size, item.color].filter(Boolean).join(" / ") || "—"}
                                      </td>
                                      <td className="px-4 py-2 text-gray-500">{item.sku ?? "—"}</td>
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
    </div>
  );
}
