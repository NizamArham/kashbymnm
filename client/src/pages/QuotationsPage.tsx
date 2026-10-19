import { useEffect, useState } from "react";
import { PageLoader } from "../components/Loader";
import { useNavigate } from "react-router-dom";
import { FileText, Printer, ShoppingCart, XCircle, MessageCircle, Receipt } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Sale } from "../lib/types";
import { downloadA4Pdf, downloadThermalPdf, sendWhatsAppBill } from "../lib/receipts";
import { PageHeader, Card, Table, Th, Td, Badge, EmptyState, ErrorText, Button, RowCard, RowCardStats, RowCardStat, ActionMenu } from "../components/ui";
import ReceiptOptionsModal, { ModalOption } from "../components/ReceiptOptionsModal";
import { hasDraftInProgress } from "../lib/posDraft";
import { useConfirm } from "../components/Feedback";
import { formatDate, formatDateTime } from "../lib/dates";

function isExpired(sale: Sale): boolean {
  return !!sale.quotation_valid_until && new Date(sale.quotation_valid_until) < new Date();
}

export default function QuotationsPage() {
  const { confirm: confirmDialog } = useConfirm();
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
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Failed to load payment requests"))
      .finally(() => setLoading(false));
  }

  // Reopens the quotation in POS with everything filled in, ready to
  // adjust and then re-save or check out as the real sale.
  async function openInPos(sale: Sale) {
    // A quoted exchange is confirmed on its own page (it can't be rung up in POS — the old items have to come back).
    if (sale.exchange_draft) {
      navigate(`/sales/${sale.id}`);
      return;
    }
    if (hasDraftInProgress() && !(await confirmDialog({ title: "Replace the sale in progress?", message: "POS has a sale in progress. Opening this payment request there replaces it.", confirmLabel: "Replace it" }))) return;
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
        title: "A4 Payment request (PDF)",
        subtitle: "Full-page printable payment request",
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
    if (!(await confirmDialog({ title: `Cancel payment request ${sale.invoice}?`, message: "This can't be undone.", confirmLabel: "Cancel request", cancelLabel: "Keep it", danger: true }))) return;
    setCancellingId(sale.id);
    try {
      await api.delete(`/sales/${sale.id}/quotation`);
      setQuotations((prev) => prev.filter((q) => q.id !== sale.id));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to cancel this payment request");
    } finally {
      setCancellingId(null);
    }
  }

  // The one thing you do with a payment request is turn it into the sale (an exchange request is opened on its own page instead, where the
  // order is made once it's approved). Printing and cancelling are tucked into the menu beside it.
  function rowActions(q: Sale) {
    // An exchange request's button says where it stands (so it never repeats the "open" status badge beside it): waiting for an
    // admin's yes, declined, or approved and ready to be made into the order.
    const exchangeStep = q.exchange_draft ? (q.approval_status === "pending" ? "Review" : q.approval_status === "declined" ? "View" : "Create order") : null;
    return (
      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <Button
          variant="primary"
          size="sm"
          onClick={() => openInPos(q)}
          title={exchangeStep ? "Opens the exchange request on its own page" : "Edit it, or turn it into the sale, in POS"}
          className="inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          {!q.exchange_draft && <ShoppingCart size={13} />}
          {exchangeStep ?? "Make sale"}
        </Button>
        <ActionMenu
          items={[
            { label: "Get payment request", icon: <Printer size={14} />, onClick: () => openReceipt(q) },
            { label: "Cancel request", icon: <XCircle size={14} />, danger: true, onClick: () => (cancellingId === q.id ? undefined : handleCancel(q)) },
          ]}
        />
      </div>
    );
  }

  // The Status column only flags what needs a look — one badge at most, the most important: an exchange waiting for approval, a declined
  // one, or a request past its pay-by time. A normal open request has nothing to flag, so its cell is empty. (Whether it's an exchange is in
  // the Type column, and whether its pieces are held is under Pay by.)
  function statusBadge(sale: Sale) {
    if (sale.exchange_draft && sale.approval_status === "declined") return <Badge label="declined" tone="danger" />;
    if (sale.exchange_draft && sale.approval_status === "pending") return <Badge label="needs approval" tone="warning" />;
    if (isExpired(sale)) return <Badge label="expired" tone="warning" />;
    return null;
  }
  // The column itself only exists while some request has something to flag.
  const anyStatus = quotations.some((q) => statusBadge(q) !== null);
  const typeLabel = (sale: Sale) => (sale.exchange_draft ? "Exchange" : sale.sale_type === "online" ? "Online" : "In-Store");

  return (
    <div>
      <PageHeader title="Payment requests" subtitle="Bills waiting to be paid — saved from POS or an exchange. Nothing here has been charged yet." />

      {error && <ErrorText>{error}</ErrorText>}

      {!loading && (
        <p className="text-xs text-gray-400 mb-3">
          {quotations.length} payment request{quotations.length !== 1 ? "s" : ""}
        </p>
      )}

      {loading ? (
        <PageLoader />
      ) : quotations.length === 0 ? (
        <EmptyState icon={FileText} title="No payment requests saved yet" subtitle={'Save a cart as a payment request from the POS page using the "Payment request" button.'} actions={[{ label: "Open the till", onClick: () => navigate("/pos") }]} />
      ) : (
        <>
          {/* Desktop / tablet-landscape */}
          <Card className="p-0 overflow-clip hidden lg:block">
            <Table>
              <thead>
                <tr>
                  <Th>Request #</Th>
                  <Th>Date</Th>
                  <Th>Customer</Th>
                  <Th>Type</Th>
                  <Th align="right">Total</Th>
                  <Th>Pay by</Th>
                  {anyStatus && <Th>Status</Th>}
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {quotations.map((q) => (
                  <tr key={q.id} onClick={() => navigate(`/sales/${q.id}`)} className="cursor-pointer hover:bg-gray-50">
                    <Td>{q.invoice}</Td>
                    <Td>{formatDateTime(q.date)}</Td>
                    <Td>{q.customer_name ?? "Walk-in"}</Td>
                    <Td>{typeLabel(q)}</Td>
                    <Td align="right">Rs. {q.total.toLocaleString()}</Td>
                    <Td>
                      {q.quotation_valid_until ? formatDateTime(q.quotation_valid_until) : "—"}
                      {q.hold_until && <span className="block text-xs text-gray-400">pieces held</span>}
                    </Td>
                    {anyStatus && <Td>{statusBadge(q)}</Td>}
                    <Td>{rowActions(q)}</Td>
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
                    <p className="text-xs text-gray-400 mt-0.5">{formatDateTime(q.date)}</p>
                    <p className="text-xs text-gray-500 mt-1">
                      {q.customer_name ?? "Walk-in"} · {typeLabel(q)}
                    </p>
                  </div>
                  <div className="flex-shrink-0">{statusBadge(q)}</div>
                </div>
                <RowCardStats>
                  <RowCardStat label="Total" value={`Rs. ${q.total.toLocaleString()}`} />
                  <RowCardStat label="Pay by" value={`${q.quotation_valid_until ? formatDate(q.quotation_valid_until) : "—"}${q.hold_until ? " · pieces held" : ""}`} />
                </RowCardStats>
                <div className="mt-3 flex justify-end border-t border-gray-100 pt-3">{rowActions(q)}</div>
              </RowCard>
            ))}
          </div>
        </>
      )}

      {receiptSale && (
        <ReceiptOptionsModal
          heading="Get payment request"
          subtitle={receiptSale.invoice}
          options={receiptOptionsFor(receiptSale)}
          error={receiptError}
          onClose={() => setReceiptSale(null)}
        />
      )}
    </div>
  );
}
