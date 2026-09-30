import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Receipt, Printer, FileText, MessageCircle } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Sale } from "../lib/types";
import { downloadA4Pdf, downloadThermalPdf, sendWhatsAppBill, groupSaleItemsForDisplay } from "../lib/receipts";
import { PageHeader, Card, Table, Th, Td, ErrorText, Badge, RefLink, Button } from "../components/ui";
import ReceiptOptionsModal, { ModalOption } from "../components/ReceiptOptionsModal";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";

export default function SaleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [sale, setSale] = useState<Sale | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showReceiptOptions, setShowReceiptOptions] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);

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
        icon: <Receipt size={17} className="text-gray-700" />,
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
          if (!sale.customer_phone) {
            setReceiptError("This customer has no saved phone number — add one on the Customers page first.");
            return;
          }
          setReceiptError(null);
          sendWhatsAppBill(sale, sale.customer_phone);
        },
      },
    ];
  }

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api
      .get<Sale>(`/sales/${id}`)
      .then((s) => {
        if (!cancelled) setSale(s);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiRequestError ? err.message : "Failed to load this invoice");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  function openReceiptOptions() {
    setReceiptError(null);
    setShowReceiptOptions(true);
  }

  useKeyboardShortcut("d", openReceiptOptions, { ctrlOrCmd: true, shift: true, enabled: !!sale });

  return (
    <div>
      <button
        onClick={() => navigate(-1)}
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-3"
      >
        <ArrowLeft size={15} />
        Back
      </button>

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : sale ? (
        <>
          <PageHeader
            title={sale.invoice}
            subtitle={`${sale.date.slice(0, 16).replace("T", " ")} · ${sale.sale_type === "online" ? "Online" : "In-Store"}${
              sale.is_voided ? " · Voided" : ""
            }`}
            action={
              <Button
                variant="primary"
                onClick={openReceiptOptions}
                className="inline-flex items-center gap-1.5"
                title="Get receipt (Ctrl/Cmd+Shift+D)"
              >
                <Printer size={14} />
                Get Receipt
              </Button>
            }
          />

          {showReceiptOptions && (
            <ReceiptOptionsModal
              heading="Get receipt"
              subtitle={sale.invoice}
              options={receiptOptionsFor(sale)}
              error={receiptError}
              onClose={() => setShowReceiptOptions(false)}
            />
          )}

          <Card className="mb-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-xs text-gray-400">Status</p>
                <p className="text-gray-900 font-medium capitalize">{sale.payment_status}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Payment</p>
                <p className="text-gray-900 font-medium capitalize">{sale.payment_method?.replace("_", " ") ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Bill to</p>
                <p className="text-gray-900 font-medium">
                  {sale.customer_name ?? sale.deleted_customer_snapshot ?? "Walk-in"}
                  {sale.customer_phone ? <span className="text-gray-400"> · {sale.customer_phone}</span> : null}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Total</p>
                <p className="text-gray-900 font-medium">Rs. {sale.total.toLocaleString()}</p>
              </div>
            </div>
            {sale.is_voided && (
              <p className="text-xs text-red-500 mt-3">
                Voided {sale.voided_at?.slice(0, 16).replace("T", " ")}
                {sale.void_reason ? ` — ${sale.void_reason}` : ""}
              </p>
            )}
          </Card>

          <Card className="p-0 overflow-hidden">
            <Table>
              <thead>
                <tr>
                  <Th>SKU</Th>
                  <Th>Product</Th>
                  <Th>Size/Color</Th>
                  <Th>Qty</Th>
                  <Th>Price</Th>
                  <Th>Total</Th>
                </tr>
              </thead>
              <tbody>
                {groupSaleItemsForDisplay(sale.items ?? []).map((item) => (
                  <tr key={item.ids.join(",")} className={item.is_returned ? "opacity-60" : ""}>
                    <Td className={item.is_returned ? "line-through" : ""}>{item.sku}</Td>
                    <Td className={item.is_returned ? "line-through" : ""}>
                      {item.product_id ? (
                        <RefLink to={`/products/${item.product_id}`}>{item.product_title}</RefLink>
                      ) : (
                        item.product_title
                      )}
                      {item.is_returned ? (
                        <span className="ml-2 not-italic no-underline">
                          <Badge label="RTN" tone="danger" />
                        </span>
                      ) : null}
                    </Td>
                    <Td className={item.is_returned ? "line-through" : ""}>
                      {item.size ?? "—"} / {item.color ?? "—"}
                    </Td>
                    <Td className={item.is_returned ? "line-through" : ""}>{item.quantity}</Td>
                    <Td className={item.is_returned ? "line-through" : ""}>Rs. {item.unit_price.toLocaleString()}</Td>
                    <Td className={item.is_returned ? "line-through" : ""}>Rs. {item.line_total.toLocaleString()}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <div className="flex justify-end mt-3 text-sm text-gray-600 gap-6">
            <span>Subtotal: Rs. {sale.subtotal.toLocaleString()}</span>
            {sale.discount > 0 && <span>Discount: -Rs. {sale.discount.toLocaleString()}</span>}
            <span className="font-semibold text-gray-900">Total: Rs. {sale.total.toLocaleString()}</span>
          </div>
        </>
      ) : (
        !error && <p className="text-sm text-gray-400 flex items-center gap-2"><Receipt size={14} /> Invoice not found.</p>
      )}
    </div>
  );
}
