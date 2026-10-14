import { Fragment, useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Receipt, Printer, FileText, MessageCircle, ShoppingCart, XCircle, Repeat, TrendingUp, ChevronDown, ChevronRight } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Sale } from "../lib/types";
import { downloadA4Pdf, downloadThermalPdf, sendWhatsAppBill, groupSaleItemsForDisplay } from "../lib/receipts";
import { PageHeader, Card, Table, Th, Td, ErrorText, Badge, RefLink, Button, ActionMenu } from "../components/ui";
import SaleProfitModal from "../components/SaleProfitModal";
import ReceiptOptionsModal, { ModalOption } from "../components/ReceiptOptionsModal";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";
import { hasDraftInProgress } from "../lib/posDraft";
import { salePaymentLabel, saleStatusLabel } from "../lib/salePayment";
import DeliveryChargeSummary from "../components/DeliveryChargeSummary";
import OnlineExchangeModal from "../components/OnlineExchangeModal";
import ExchangeNotice, { ExchangedOutNotice } from "../components/ExchangeNotice";
import { useAuth } from "../context/AuthContext";

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
        title: sale.status === "quotation" ? "A4 Quotation (PDF)" : "A4 Invoice (PDF)",
        subtitle: sale.status === "quotation" ? "Full-page printable quote" : "Full-page printable invoice",
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
    if (hasDraftInProgress() && !confirm("POS has a sale in progress. Replace it with this quotation?")) return;
    navigate(`/pos?quotation=${sale.id}`);
  }

  async function handleCancelQuotation() {
    if (!sale) return;
    if (!confirm(`Cancel quotation ${sale.invoice}? This can't be undone.`)) return;
    setCancellingQuotation(true);
    try {
      await api.delete(`/sales/${sale.id}/quotation`);
      navigate("/quotations");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to cancel this quotation");
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

  // "Exchange by delivery" from Sale History lands here with the popup already open.
  useEffect(() => {
    if (searchParams.get("exchange") === "1" && canExchange) {
      setShowExchange(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, canExchange, setSearchParams]);

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
        <p className="text-sm text-gray-400">Loading...</p>
      ) : sale ? (
        <>
          <PageHeader
            title={sale.invoice}
            subtitle={`${sale.date.slice(0, 16).replace("T", " ")} · ${sale.sale_type === "online" ? "Online" : "In-Store"}${
              sale.is_wholesale ? " · Wholesale" : ""
            }${isQuotation ? " · Quotation" : ""}${sale.is_voided ? " · Voided" : ""}`}
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
                {isQuotation && (
                  <Button variant="primary" onClick={openInPos} className="inline-flex items-center gap-1.5">
                    <ShoppingCart size={14} />
                    Edit / Convert to Sale
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
                  {isQuotation ? "Get Quotation" : "Get Receipt"}
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
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 text-sm text-amber-800">
              This is a quotation, not a sale yet — nothing has been charged and no stock has been reserved.
              {sale.quotation_valid_until && (
                <> Valid until {sale.quotation_valid_until.slice(0, 16).replace("T", " ")}.</>
              )}{" "}
              Need changes, or the customer confirmed? Use <strong>Edit / Convert to Sale</strong> — it reopens in POS with everything filled in.
            </div>
          )}

          {showExchange && sale && (
            <OnlineExchangeModal
              sale={sale}
              onClose={() => setShowExchange(false)}
              onCreated={(created) => {
                setShowExchange(false);
                navigate(`/sales/${created.id}`);
              }}
            />
          )}

          {sale.exchanged_out && sale.exchanged_out.length > 0 && <ExchangedOutNotice exchanges={sale.exchanged_out} className="mb-4" />}

          {sale.exchange && (
            <ExchangeNotice
              exchange={sale.exchange}
              delivered={sale.delivery_status === "delivered"}
              canAct={user?.role === "admin"}
              onChanged={() => setReloadKey((k) => k + 1)}
              className="mb-4"
            />
          )}

          {showReceiptOptions && (
            <ReceiptOptionsModal
              heading={isQuotation ? "Get quotation" : "Get receipt"}
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
                <p className="text-gray-900 font-medium capitalize">{isQuotation ? "Quotation" : saleStatusLabel({ payment_status: sale.payment_status, is_voided: sale.is_voided, exchange_in_status: sale.exchange?.status ?? null })}</p>
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
