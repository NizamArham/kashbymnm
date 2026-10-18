import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { PageLoader } from "../components/Loader";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Receipt, Printer, FileText, MessageCircle, ShoppingCart, XCircle, Repeat, TrendingUp, ChevronDown, ChevronRight, PackageCheck } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Sale } from "../lib/types";
import { downloadA4Pdf, downloadThermalPdf, sendWhatsAppBill, groupSaleItemsForDisplay } from "../lib/receipts";
import { PageHeader, Card, Table, Th, Td, ErrorText, Badge, RefLink, Button, ActionMenu, HelpHint } from "../components/ui";
import SaleProfitModal from "../components/SaleProfitModal";
import ReceiptOptionsModal, { ModalOption } from "../components/ReceiptOptionsModal";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";
import { hasDraftInProgress } from "../lib/posDraft";
import { salePaymentLabel, saleStatusLabel } from "../lib/salePayment";
import DeliveryChargeSummary from "../components/DeliveryChargeSummary";
import OnlineExchangeModal from "../components/OnlineExchangeModal";
import ExchangeNotice, { ExchangedOutNotice } from "../components/ExchangeNotice";
import { shareSummary } from "../components/ReturnsOnTheWay";
import { ExchangeApprovalBox } from "../components/ReturnApprovals";
import { AUTO_APPROVED, FLOW_LABEL, courierNote, courierStage, decidedLine, exchangeRequestStage } from "../lib/returnFlow";
import { useAuth } from "../context/AuthContext";
import { clearExchangeDraft, exchangeDraftFor } from "../lib/exchangeDraft";

// "2026-10-17 23:59:59" -> "17 Oct, 11:59 pm"
function whenLabel(stamp: string): string {
  const d = new Date(stamp.replace(" ", "T"));
  return Number.isNaN(d.getTime())
    ? stamp.slice(0, 16)
    : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
}

export default function SaleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [sale, setSale] = useState<Sale | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showReceiptOptions, setShowReceiptOptions] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const { user } = useAuth();
  const [showExchange, setShowExchange] = useState(false);
  const [showProfit, setShowProfit] = useState(false);
  // Products folded into one row on a big (wholesale) bill, and which of them are opened up.
  const [openProducts, setOpenProducts] = useState<Set<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);

  const isQuotation = sale?.status === "quotation";
  // An online order that has been delivered can be exchanged: the replacement goes out
  // by courier and the courier brings the old item back.
  const canExchange =
    !!sale && !isQuotation && !sale.is_voided && sale.sale_type === "online" && sale.delivery_status === "delivered" && !!sale.customer_id;
  const [cancellingQuotation, setCancellingQuotation] = useState(false);

  function receiptOptionsFor(sale: Sale): ModalOption[] {
    return [
      {
        key: "a4",
        icon: <FileText size={16} className="text-gray-700" />,
        title: sale.status === "quotation" ? "A4 Payment request (PDF)" : "A4 Invoice (PDF)",
        subtitle: sale.status === "quotation" ? "Full-page printable payment request" : "Full-page printable invoice",
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

  // Reopens the quotation in POS with everything filled in — adjust it
  // there, then re-save it or check out to make it the real sale.
  function openInPos() {
    if (!sale) return;
    if (hasDraftInProgress() && !confirm("POS has a sale in progress. Replace it with this payment request?")) return;
    navigate(`/pos?quotation=${sale.id}`);
  }

  // Keep (or let go of) the pieces of this payment request — free, and it ends by itself.
  const [holdBusy, setHoldBusy] = useState(false);
  async function changeHold(mode: "today" | "tomorrow" | "release") {
    if (!sale) return;
    setHoldBusy(true);
    setError(null);
    try {
      await api.put(`/sales/${sale.id}/hold`, { mode });
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't change the hold");
    } finally {
      setHoldBusy(false);
    }
  }

  async function handleCancelQuotation() {
    if (!sale) return;
    if (!confirm(`Cancel payment request ${sale.invoice}? This can't be undone.`)) return;
    setCancellingQuotation(true);
    try {
      await api.delete(`/sales/${sale.id}/quotation`);
      navigate("/quotations");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to cancel this payment request");
      setCancellingQuotation(false);
    }
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
  }, [id, reloadKey]);

  // "Exchange by delivery" from Sale History lands here with the popup already open — and so does the "exchange in
  // progress" reminder, for a popup that was put aside (a quotation being confirmed counts too).
  const quotedExchange = isQuotation && !!sale?.exchange_quote;
  useEffect(() => {
    if (searchParams.get("exchange") === "1" && (canExchange || quotedExchange)) {
      setShowExchange(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, canExchange, quotedExchange, setSearchParams]);

  // An exchange popup that was open when this page was left (or reloaded) comes back open, like the POS cart does.
  const heldChecked = useRef<number | null>(null);
  useEffect(() => {
    if (!sale || heldChecked.current === sale.id) return;
    heldChecked.current = sale.id;
    if (!exchangeDraftFor(sale.id, isQuotation, user?.id)) return;
    if (isQuotation ? !!sale.exchange_quote : canExchange) setShowExchange(true);
    else clearExchangeDraft(); // the invoice can't be exchanged any more — nothing to come back to
  }, [sale, isQuotation, canExchange, user?.id]);

  // One row per product once it has a long run of sizes/colours (a wholesale bill); smaller
  // bills are drawn exactly as before.
  const FOLD_AT = sale?.is_wholesale ? 2 : 3;
  const productRows = useMemo(() => {
    const lines = groupSaleItemsForDisplay(sale?.items ?? []);
    const byProduct = new Map<string, typeof lines>();
    for (const l of lines) {
      const key = String(l.product_id ?? l.product_title ?? "");
      byProduct.set(key, [...(byProduct.get(key) ?? []), l]);
    }
    const rows: (
      | { kind: "line"; item: (typeof lines)[number] }
      | { kind: "product"; key: string; title: string | undefined; product_id: number | null | undefined; items: typeof lines; quantity: number; total: number }
    )[] = [];
    const done = new Set<string>();
    for (const l of lines) {
      const key = String(l.product_id ?? l.product_title ?? "");
      const group = byProduct.get(key)!;
      if (group.length < FOLD_AT) {
        rows.push({ kind: "line", item: l });
      } else if (!done.has(key)) {
        done.add(key);
        rows.push({
          kind: "product",
          key,
          title: l.product_title,
          product_id: l.product_id,
          items: group,
          quantity: group.reduce((n, i) => n + i.quantity, 0),
          total: group.reduce((n, i) => n + i.line_total, 0),
        });
      }
    }
    return rows;
  }, [sale, FOLD_AT]);
  function toggleProduct(key: string) {
    setOpenProducts((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function renderLine(item: ReturnType<typeof groupSaleItemsForDisplay>[number], nested: boolean) {
    return (
      <tr key={item.ids.join(",")} className={`${item.is_returned ? "opacity-60" : ""} ${nested ? "bg-gray-50/70" : ""}`}>
        <Td className={item.is_returned ? "line-through" : ""}>{item.sku}</Td>
        <Td className={`min-w-[16rem] ${nested ? "pl-8" : ""} ${item.is_returned ? "line-through" : ""}`}>
          {nested ? (
            <span className="text-gray-500">{item.product_title}</span>
          ) : item.product_id ? (
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
    );
  }

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
        <ArrowLeft size={14} />
        Back
      </button>

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <PageLoader />
      ) : sale ? (
        <>
          <PageHeader
            title={sale.invoice}
            subtitle={`${sale.date.slice(0, 16).replace("T", " ")} · ${sale.sale_type === "online" ? "Online" : "In-Store"}${
              sale.is_wholesale ? " · Wholesale" : ""
            }${isQuotation ? " · Payment request" : ""}${sale.is_voided ? " · Voided" : ""}`}
            action={
              <div className="flex items-center gap-2">
                {isQuotation && (
                  <Button
                    variant="danger"
                    onClick={handleCancelQuotation}
                    disabled={cancellingQuotation}
                    className="inline-flex items-center gap-1.5"
                  >
                    <XCircle size={14} />
                    {cancellingQuotation ? "Cancelling..." : "Cancel"}
                  </Button>
                )}
                {isQuotation && !sale.exchange_quote && (
                  <Button variant="primary" onClick={openInPos} className="inline-flex items-center gap-1.5">
                    <ShoppingCart size={14} />
                    Edit / Convert to Sale
                  </Button>
                )}
                {isQuotation && sale.exchange_quote && sale.approval_status !== "pending" && sale.approval_status !== "declined" && (
                  <Button variant="primary" onClick={() => setShowExchange(true)} className="inline-flex items-center gap-1.5" title="The customer has confirmed — make it the real exchange order">
                    <Repeat size={14} />
                    Create exchange order
                  </Button>
                )}
                {canExchange && (
                  <Button onClick={() => setShowExchange(true)} className="inline-flex items-center gap-1.5" title="Exchange an item by delivery">
                    <Repeat size={14} />
                    Exchange
                  </Button>
                )}
                <Button
                  variant={isQuotation ? "default" : "primary"}
                  onClick={openReceiptOptions}
                  className="inline-flex items-center gap-1.5"
                  title="Get receipt (Ctrl/Cmd+Shift+D)"
                >
                  <Printer size={14} />
                  {isQuotation ? "Get Payment Request" : "Get Receipt"}
                </Button>
                {/* Admin only, and tucked away: what this bill earned. */}
                {user?.role === "admin" && !isQuotation && (
                  <ActionMenu items={[{ label: "Profit on this bill", icon: <TrendingUp size={14} />, onClick: () => setShowProfit(true) }]} />
                )}
              </div>
            }
          />

          {showProfit && sale && <SaleProfitModal saleId={sale.id} invoice={sale.invoice} onClose={() => setShowProfit(false)} />}

          {isQuotation && (
            // One quiet line: when it must be paid by and whether its pieces are held — the long explanation is behind the ?.
            <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-2 text-sm text-gray-600">
              {sale.quotation_valid_until && (
                <span>
                  Pay by <span className="font-medium text-gray-900">{whenLabel(sale.quotation_valid_until)}</span>
                </span>
              )}
              <span className="text-gray-300">·</span>
              {sale.hold_until ? (
                <span>
                  Pieces held until <span className="font-medium text-gray-900">{whenLabel(sale.hold_until)}</span>
                </span>
              ) : (
                <span className="text-gray-400">Pieces not held</span>
              )}
              <HelpHint
                text={`A payment request isn't a sale — nothing is charged yet. Held pieces are kept for this customer only until the time shown; nobody else can sell them. ${
                  sale.exchange_quote
                    ? "When the customer has paid or confirmed, press Create exchange order and pick how they paid. To change what's in it, cancel it and make a new one."
                    : "When the customer has paid or confirmed, use Edit / Convert to Sale — it reopens in POS with everything filled in."
                }`}
              />
              <span className="ml-auto flex flex-wrap items-center gap-2">
                {!sale.hold_until && (
                  <Button onClick={() => changeHold("today")} disabled={holdBusy} title="Free — keeps the pieces for this customer until closing today">
                    Hold until tonight
                  </Button>
                )}
                <Button onClick={() => changeHold("tomorrow")} disabled={holdBusy} title="Free — keeps the pieces until closing tomorrow, for a customer who will pay tomorrow">
                  Hold until tomorrow
                </Button>
                {sale.hold_until && (
                  <Button onClick={() => changeHold("release")} disabled={holdBusy} title="Let the pieces be sold to anyone again">
                    Release
                  </Button>
                )}
              </span>
            </div>
          )}

          {isQuotation && sale.exchange_quote && (
            <Card className="mb-4">
              <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
                  <Repeat size={14} className="text-gray-500" />
                  {FLOW_LABEL.exchange} — old items coming back with the delivery
                </p>
                <Badge label={exchangeRequestStage(sale.approval_status)} />
              </div>
              {sale.approval_status === "pending" && (
                <p className="mb-2 text-xs text-gray-500">Waiting for an admin to approve it. The order can't be made until then; the pieces are kept for today.</p>
              )}
              {sale.approval_status === "declined" && (
                <p className="mb-2 text-xs text-red-600">Declined{sale.decision_reason ? ` — ${sale.decision_reason}` : ""}. It can't be made into an order; cancel it and make a new one if needed.</p>
              )}
              {sale.approval_status === "approved" && sale.auto_approved === 1 && <p className="mb-2 text-xs text-gray-500">{AUTO_APPROVED}</p>}
              {sale.approval_status === "approved" && sale.auto_approved !== 1 && sale.approved_at && (
                <p className="mb-2 text-xs text-gray-500">{decidedLine(false, "approved", null, sale.approved_at)}</p>
              )}
              <ul className="space-y-0.5 text-sm text-gray-600">
                {sale.exchange_quote.old_items.map((i) => (
                  <li key={i.sale_item_id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-gray-900">
                      {i.title ?? "Item"}
                      {[i.size, i.color].filter(Boolean).length > 0 && <span className="text-gray-500"> · {[i.size, i.color].filter(Boolean).join(" / ")}</span>}
                    </span>
                    <span className="text-xs text-gray-400">
                      {i.old_invoice} · worth Rs. {Math.round(i.unit_price).toLocaleString()}
                    </span>
                    {i.allow_returns === 0 && <span className="text-xs font-medium text-amber-600">Final Sale</span>}
                  </li>
                ))}
              </ul>
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-gray-100 pt-3 text-sm md:grid-cols-4">
                <div>
                  <p className="text-xs text-gray-400">Old items come off</p>
                  <p className="font-medium text-gray-900">− Rs. {Math.round(sale.exchange_quote.applied_amount).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Delivery ({sale.exchange_quote.partner_name})</p>
                  <p className="font-medium text-gray-900">{sale.exchange_quote.is_free_delivery ? "Free" : `+ Rs. ${Math.round(sale.exchange_quote.delivery_fee).toLocaleString()}`}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Customer's return share</p>
                  <p className="font-medium text-gray-900">
                    {sale.exchange_quote.pickup_collected > 0 ? `+ Rs. ${Math.round(sale.exchange_quote.pickup_collected).toLocaleString()}` : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Customer pays</p>
                  <p className="font-semibold text-gray-900">Rs. {Math.round(sale.exchange_quote.amount_to_pay).toLocaleString()}</p>
                </div>
              </div>
              {sale.approval_status === "pending" && (
                <div className="mt-4 border-t border-gray-100 pt-4">
                  <ExchangeApprovalBox
                    saleId={sale.id}
                    noReturns={sale.exchange_quote.old_items.some((i) => i.allow_returns === 0)}
                    onChanged={() => setReloadKey((k) => k + 1)}
                  />
                </div>
              )}
            </Card>
          )}

          {showExchange && sale && (
            <OnlineExchangeModal
              sale={sale}
              quote={isQuotation}
              onClose={() => setShowExchange(false)}
              onCreated={(created) => {
                setShowExchange(false);
                navigate(`/sales/${created.id}`);
              }}
              onQuoted={(created) => {
                setShowExchange(false);
                navigate(`/sales/${created.id}`);
              }}
            />
          )}

          {sale.exchanged_out && sale.exchanged_out.length > 0 && <ExchangedOutNotice exchanges={sale.exchanged_out} className="mb-4" />}

          {(sale.return_pickups ?? [])
            .filter((p) => p.status !== "cancelled" || p.approval_status === "declined")
            .map((p) => (
              <div key={p.id} className="mb-4 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="inline-flex items-center gap-1.5 font-medium text-gray-900">
                    <PackageCheck size={14} className="text-gray-500" />
                    {FLOW_LABEL.courier}
                  </span>
                  <Badge label={courierStage(p)} />
                  <span className="ml-auto text-xs">
                    <RefLink to="/returns">Open in Returns</RefLink>
                  </span>
                </div>
                <ul className="mt-1.5 space-y-0.5 text-gray-600">
                  {p.items.map((i) => (
                    <li key={i.id}>
                      <span className="text-gray-900">{i.title ?? "Item"}</span>
                      <span className="text-gray-500">{[i.size, i.color].filter(Boolean).length ? ` · ${[i.size, i.color].filter(Boolean).join(" / ")}` : ""}</span>
                      <span className="text-xs text-gray-400"> · Rs. {Math.round(i.amount).toLocaleString()}</span>
                      {i.status === "received" && <span className="text-xs text-emerald-700"> · taken back{i.item_condition === "damaged" ? " (damaged stock)" : ""}</span>}
                      {i.status === "not_returned" && <span className="text-xs text-red-600"> · not taken back{i.verdict === "not_received" ? " — missing from the parcel" : i.verdict === "not_per_policy" ? " — not per policy" : ""}</span>}
                    </li>
                  ))}
                </ul>
                {courierNote(p) && <p className="mt-1.5 text-xs text-gray-500">{courierNote(p)}</p>}
                {p.partner_name && (
                  <p className="mt-0.5 text-xs text-gray-500">
                    Came with {p.partner_name}
                    {p.tracking_number ? ` · tracking ${p.tracking_number}` : ""}
                    {p.pickup_charge > 0 ? ` · we paid Rs. ${Math.round(p.pickup_charge).toLocaleString()} for the parcel` : ""}
                  </p>
                )}
                {p.approval_status === "declined" && (
                  <p className="mt-0.5 text-xs text-red-600">
                    Declined{p.decision_reason ? ` — ${p.decision_reason}` : ""}. The items can be returned another way.
                  </p>
                )}
                {p.approval_status === "approved" && (
                  <p className="mt-0.5 text-xs text-gray-400">{decidedLine(p.auto_approved === 1, "approved", p.approved_by_name, p.approved_at)}</p>
                )}
                {p.report_status === "approved" && p.pickup_charge > 0 && <p className="mt-0.5 text-xs text-gray-500">{shareSummary(p)}</p>}
                {p.stage === "rejected" && (
                  <p className="mt-0.5 text-xs text-red-600">
                    Rejected after inspection{p.report_decision_reason ? ` — ${p.report_decision_reason}` : ""}. Nothing was refunded.
                  </p>
                )}
                {p.report_status === "approved" && (
                  <p className="mt-0.5 text-xs text-gray-400">
                    {p.report_auto_approved === 1 ? `Inspection report — ${AUTO_APPROVED}` : `Inspection report approved by ${p.report_decided_by_name ?? "an admin"}`}
                  </p>
                )}
                {p.stage === "completed" && p.refunded_at && (
                  <p className="mt-0.5 text-xs text-gray-400">
                    Refund of Rs. {Math.round(p.refund_due).toLocaleString()} paid by {p.refund_method === "bank_transfer" ? `bank transfer${p.refund_account_label ? ` (${p.refund_account_label})` : ""}` : "cash"} on{" "}
                    {p.refunded_at.slice(0, 10)}
                  </p>
                )}
              </div>
            ))}

          {sale.exchange && (
            <ExchangeNotice
              exchange={sale.exchange}
              delivered={sale.delivery_status === "delivered"}
              deliveryStatus={sale.delivery_status}
              canAct
              onChanged={() => setReloadKey((k) => k + 1)}
              className="mb-4"
            />
          )}

          {showReceiptOptions && (
            <ReceiptOptionsModal
              heading={isQuotation ? "Get payment request" : "Get receipt"}
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
                <p className="text-gray-900 font-medium capitalize">{isQuotation ? "Payment request" : saleStatusLabel({ payment_status: sale.payment_status, is_voided: sale.is_voided, exchange_in_status: sale.exchange?.status ?? null })}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Payment</p>
                <p className="text-gray-900 font-medium capitalize">{isQuotation ? "Not yet paid" : salePaymentLabel(sale)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Bill to</p>
                <p className="text-gray-900 font-medium">
                  {sale.customer_id && sale.customer_name ? (
                    <RefLink to={`/customers?open=${sale.customer_id}`}>{sale.customer_name}</RefLink>
                  ) : (
                    sale.customer_name ?? sale.deleted_customer_snapshot ?? "Walk-in"
                  )}
                  {sale.customer_phone ? <span className="text-gray-400"> · {sale.customer_phone}</span> : null}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Total</p>
                <p className="text-gray-900 font-medium">Rs. {sale.total.toLocaleString()}</p>
              </div>
            </div>
            {sale.is_voided ? (
              <p className="text-xs text-red-500 mt-3">
                Voided {sale.voided_at?.slice(0, 16).replace("T", " ")}
                {sale.void_reason ? ` — ${sale.void_reason}` : ""}
              </p>
            ) : null}
          </Card>

          <Card className="p-0 overflow-hidden">
            <Table>
              <thead>
                <tr>
                  <Th>SKU</Th>
                  <Th className="min-w-[16rem]">Product</Th>
                  <Th>Size/Color</Th>
                  <Th>Qty</Th>
                  <Th>Price</Th>
                  <Th>Total</Th>
                </tr>
              </thead>
              <tbody>
                {productRows.map((row) => {
                  if (row.kind === "line") return renderLine(row.item, false);
                  const isOpen = openProducts.has(row.key);
                  const allBack = row.items.every((i) => i.is_returned);
                  const prices = Array.from(new Set(row.items.map((i) => i.unit_price)));
                  return (
                    <Fragment key={row.key}>
                      <tr
                        onClick={() => toggleProduct(row.key)}
                        className={`cursor-pointer hover:bg-gray-50 ${allBack ? "opacity-60" : ""}`}
                      >
                        <Td className="text-gray-400">
                          <span className="inline-flex items-center gap-1">
                            {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            <span className="text-xs">{row.items.length} lines</span>
                          </span>
                        </Td>
                        <Td className={`min-w-[16rem] font-medium ${allBack ? "line-through" : ""}`}>
                          {row.product_id ? <RefLink to={`/products/${row.product_id}`}>{row.title}</RefLink> : row.title}
                        </Td>
                        <Td className="text-gray-500">{row.items.length} sizes / colours</Td>
                        <Td>{row.quantity}</Td>
                        <Td>{prices.length === 1 ? `Rs. ${prices[0].toLocaleString()}` : "varies"}</Td>
                        <Td className="font-medium">Rs. {row.total.toLocaleString()}</Td>
                      </tr>
                      {isOpen && row.items.map((item) => renderLine(item, true))}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          </Card>

          <div className="flex justify-end mt-3 text-sm text-gray-600 gap-6">
            <span>Subtotal: Rs. {sale.subtotal.toLocaleString()}</span>
            {sale.discount > 0 && <span>Discount: -Rs. {sale.discount.toLocaleString()}</span>}
            <span className="font-semibold text-gray-900">Total: Rs. {sale.total.toLocaleString()}</span>
          </div>
          <DeliveryChargeSummary sale={sale} className="justify-end mt-2" />
        </>
      ) : (
        !error && <p className="text-sm text-gray-400 flex items-center gap-2"><Receipt size={14} /> Invoice not found.</p>
      )}
    </div>
  );
}
