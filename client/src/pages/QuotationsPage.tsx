import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, Printer, ShoppingCart, XCircle, MessageCircle, Receipt } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Sale } from "../lib/types";
import { downloadA4Pdf, downloadThermalPdf, sendWhatsAppBill } from "../lib/receipts";
import { PageHeader, Card, Table, Th, Td, Badge, EmptyState, ErrorText, Button, RowCard, RowCardStats, RowCardStat } from "../components/ui";
import ReceiptOptionsModal, { ModalOption } from "../components/ReceiptOptionsModal";
import { hasDraftInProgress } from "../lib/posDraft";

function isExpired(sale: Sale): boolean {
  return !!sale.quotation_valid_until && new Date(sale.quotation_valid_until) < new Date();
}

export default function QuotationsPage() {
  const navigate = useNavigate();

  const [quotations, setQuotations] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [receiptSale, setReceiptSale] = useState<Sale | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  function load() {
    setLoading(true);
    api
      .get<Sale[]>("/sales?status=quotation")
      .then(setQuotations)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Failed to load quotations"))
      .finally(() => setLoading(false));
  }

  // Reopens the quotation in POS with everything filled in, ready to
  // adjust and then re-save or check out as the real sale.
  function openInPos(sale: Sale) {
    if (hasDraftInProgress() && !confirm("POS has a sale in progress. Replace it with this quotation?")) return;
    navigate(`/pos?quotation=${sale.id}`);
  }

  async function openReceipt(sale: Sale) {
    setReceiptError(null);
    const full = await api.get<Sale>(`/sales/${sale.id}`);
    setReceiptSale(full);
  }

  function receiptOptionsFor(sale: Sale): ModalOption[] {
    return [
      {
        key: "a4",
        icon: <FileText size={16} className="text-gray-700" />,
        title: "A4 Quotation (PDF)",
        subtitle: "Full-page printable quote",
        onClick: () => downloadA4Pdf(sale),
      },
      {
        key: "thermal",
        icon: <Receipt size={16} className="text-gray-700" />,
        title: "80mm Receipt (PDF)",
        subtitle: "For thermal till printers",
        onClick: () => downloadThermalPdf(sale),
      },
      {
        key: "whatsapp",
        icon: <MessageCircle size={16} className="text-green-600" />,
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

  async function handleCancel(sale: Sale) {
    if (!confirm(`Cancel quotation ${sale.invoice}? This can't be undone.`)) return;
    setCancellingId(sale.id);
    try {
      await api.delete(`/sales/${sale.id}/quotation`);
      setQuotations((prev) => prev.filter((q) => q.id !== sale.id));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to cancel this quotation");
    } finally {
      setCancellingId(null);
    }
  }

  function statusBadge(sale: Sale) {
    return isExpired(sale) ? <Badge label="expired" tone="warning" /> : <Badge label="open" tone="neutral" />;
  }

  return (
    <div>
      <PageHeader title="Quotations" subtitle="Price-confirmation bills saved from POS — nothing here has been charged yet." />

      {error && <ErrorText>{error}</ErrorText>}

      {!loading && (
        <p className="text-xs text-gray-400 mb-3">
          {quotations.length} quotation{quotations.length !== 1 ? "s" : ""}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : quotations.length === 0 ? (
        <EmptyState icon={FileText} title="No quotations saved yet" subtitle={'Save a cart as a quotation from the POS page using the "Quotation" button.'} />
      ) : (
        <>
          {/* Desktop / tablet-landscape */}
          <Card className="p-0 overflow-hidden hidden lg:block">
            <Table>
              <thead>
                <tr>
                  <Th>Quote #</Th>
                  <Th>Date</Th>
                  <Th>Customer</Th>
                  <Th>Type</Th>
                  <Th>Total</Th>
                  <Th>Valid until</Th>
                  <Th>Status</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {quotations.map((q) => (
                  <tr key={q.id} onClick={() => navigate(`/sales/${q.id}`)} className="cursor-pointer hover:bg-gray-50">
                    <Td>{q.invoice}</Td>
                    <Td>{q.date.slice(0, 16).replace("T", " ")}</Td>
                    <Td>{q.customer_name ?? "Walk-in"}</Td>
                    <Td>{q.sale_type === "online" ? "Online" : "In-Store"}</Td>
                    <Td>Rs. {q.total.toLocaleString()}</Td>
                    <Td>{q.quotation_valid_until ? q.quotation_valid_until.slice(0, 16).replace("T", " ") : "—"}</Td>
                    <Td>{statusBadge(q)}</Td>
                    <Td>
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => openReceipt(q)}
                          title="Get quotation"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
                        >
                          <Printer size={14} />
                        </button>
                        <button
                          onClick={() => openInPos(q)}
                          title="Edit / convert to sale in POS"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
                        >
                          <ShoppingCart size={14} />
                        </button>
                        <button
                          onClick={() => handleCancel(q)}
                          disabled={cancellingId === q.id}
                          title="Cancel quotation"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition disabled:opacity-50"
                        >
                          <XCircle size={14} />
                        </button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>

          {/* Mobile / tablet-portrait */}
          <div className="lg:hidden space-y-2.5">
            {quotations.map((q) => (
              <RowCard key={q.id} onClick={() => navigate(`/sales/${q.id}`)}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 leading-snug">{q.invoice}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{q.date.slice(0, 16).replace("T", " ")}</p>
                    <p className="text-xs text-gray-500 mt-1">
                      {q.customer_name ?? "Walk-in"} · {q.sale_type === "online" ? "Online" : "In-Store"}
                    </p>
                  </div>
                  <div className="flex-shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    {statusBadge(q)}
                    <button
                      onClick={() => openReceipt(q)}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
                    >
                      <Printer size={14} />
                    </button>
                    <button
                      onClick={() => openInPos(q)}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
                    >
                      <ShoppingCart size={14} />
                    </button>
                    <button
                      onClick={() => handleCancel(q)}
                      disabled={cancellingId === q.id}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition disabled:opacity-50"
                    >
                      <XCircle size={14} />
                    </button>
                  </div>
                </div>
                <RowCardStats>
                  <RowCardStat label="Total" value={`Rs. ${q.total.toLocaleString()}`} />
                  <RowCardStat label="Valid until" value={q.quotation_valid_until ? q.quotation_valid_until.slice(0, 10) : "—"} />
                </RowCardStats>
              </RowCard>
            ))}
          </div>
        </>
      )}

      {receiptSale && (
        <ReceiptOptionsModal
          heading="Get quotation"
          subtitle={receiptSale.invoice}
          options={receiptOptionsFor(receiptSale)}
          error={receiptError}
          onClose={() => setReceiptSale(null)}
        />
      )}
    </div>
  );
}
