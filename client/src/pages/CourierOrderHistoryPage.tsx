import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Check, CheckCircle2, Download } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { CourierReconciliationData, CourierReconciliationOrder } from "../lib/types";
import CourierChargeModal from "../components/CourierChargeModal";
import { useDeliveryPartners, partnerLabel as labelFor } from "../lib/delivery";
import { downloadTabularReport, rangeLabelFor, buildReportFilename, todayLongDate } from "../lib/reportPdf";
import { Card, Button, DateRangePicker, ErrorText, HelpHint, PageHeader, Table, Td, Th, RefLink } from "../components/ui";

const money = (value: number) => `Rs. ${value.toLocaleString()}`;

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function CourierOrderHistoryPage() {
  const { partners } = useDeliveryPartners();
  const navigate = useNavigate();
  const [data, setData] = useState<CourierReconciliationData>({ summary: [], settlements: [], adjustments: [], orders: [] });
  const [editingOrder, setEditingOrder] = useState<CourierReconciliationOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const downloadMenuRef = useRef<HTMLDivElement>(null);

  // The orders list keeps growing forever (nothing prunes it), so it
  // defaults to just the last 7 days — both on screen and in the
  // downloaded report — with the date range there specifically to reach
  // back into history for an older period.
  const [orderDateStart, setOrderDateStart] = useState<string | null>(() => addDaysIso(todayIso(), -6));
  const [orderDateEnd, setOrderDateEnd] = useState<string | null>(() => todayIso());

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (downloadMenuRef.current && !downloadMenuRef.current.contains(e.target as Node)) setDownloadMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function load() {
    try {
      setData(await api.get<CourierReconciliationData>("/courier-reconciliation"));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load reconciliation");
    }
  }
  useEffect(() => {
    load();
  }, []);

  // The server works out every courier's balance (expected net, less what they've
  // paid, plus any corrections) so this report and the Couriers page always agree.
  const balances = data.summary;

  const filteredOrders = useMemo(
    () =>
      data.orders.filter((order) => {
        if (!orderDateStart || !orderDateEnd) return true;
        const d = order.sale_date.slice(0, 10);
        return d >= orderDateStart && d <= orderDateEnd;
      }),
    [data.orders, orderDateStart, orderDateEnd]
  );

  // Day/month/year in full — e.g. "9/09/2026" — reads unambiguously on
  // a printed report, unlike a locale-dependent short format.
  function longDate(dateStr: string): string {
    const d = new Date(dateStr.slice(0, 10) + "T00:00:00");
    return `${d.getDate()}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  }

  // One report per courier partner — since a courier only ever sees
  // and settles their own orders, a combined report would just be
  // noise they'd have to filter through themselves.
  function downloadReconciliationPdf(courierPartner: string) {
    setDownloadMenuOpen(false);
    const partnerLabel = labelFor(courierPartner);
    const ordersForPartner = filteredOrders.filter((order) => order.courier_partner === courierPartner);
    const balance = balances.find((item) => item.courier_partner === courierPartner);

    const rangeLabel = rangeLabelFor(orderDateStart, orderDateEnd);
    downloadTabularReport({
      headerLabel: `M&M Clothing — ${partnerLabel} Settlement Report`,
      headerFields: [
        { label: "Report", value: `Courier Settlement — ${partnerLabel}` },
        { label: "Courier", value: partnerLabel },
        { label: "Period", value: rangeLabel },
        { label: "Generated", value: todayLongDate() },
      ],
      rangeLabel,
      columns: [
        { label: "Date", width: 65 },
        { label: "Order", width: 150 },
        { label: "Status", width: 55 },
        { label: "COD", width: 80, align: "right" },
        { label: "Charge", width: 70, align: "right" },
        { label: "Net", width: 95, align: "right" },
      ],
      rows: ordersForPartner.map((order) => {
        const totalCharge = order.courier_charge + order.return_charge;
        const net = (order.delivery_status === "delivered" ? order.cod_amount : 0) - totalCharge;
        const notDelivered = order.delivery_status !== "delivered";
        return {
          cells: [
            longDate(order.sale_date),
            `${order.invoice} · ${order.customer_name ?? "Walk-in"}`,
            order.delivery_status,
            money(order.cod_amount),
            money(totalCharge),
            money(net),
          ],
          styles: notDelivered ? [undefined, undefined, undefined, { color: 150, strikethrough: true }, undefined, undefined] : undefined,
        };
      }),
      totalSummary: balance
        ? {
            label: balance.balance >= 0 ? "Balance due" : "Credit",
            amount: money(Math.abs(balance.balance)),
            note: `expected net owed: ${money(balance.expected_net)}${
              balance.adjustments_total !== 0 ? `, incl. corrections ${balance.adjustments_total > 0 ? "+" : "-"}${money(Math.abs(balance.adjustments_total))}` : ""
            }`,
          }
        : undefined,
      filename: buildReportFilename(`${partnerLabel} Settlement`, `${orderDateStart || "all"}-to-${orderDateEnd || "now"}`),
    });
  }

  return (
    <div>
      <button onClick={() => navigate(-1)} className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-3">
        <ArrowLeft size={14} />
        Back
      </button>

      <PageHeader title="Courier order history" subtitle="Every dispatched order's COD, charges, and net — filter by date and download a report per courier." />

      {error && <ErrorText>{error}</ErrorText>}

      <Card className="p-0 overflow-hidden">
        <div className="p-4 border-b border-gray-100">
          <div className="flex flex-col items-start sm:flex-row sm:items-center sm:justify-between gap-3">
            <h2 className="font-semibold text-gray-900">
              Courier orders
              <HelpHint text="Delivered COD orders become collectible; charges — including a return-trip fee if the order came back — are deducted before settlement. Defaults to the last 7 days — widen the range to reach further back." />
            </h2>
            <div className="flex flex-col items-start sm:flex-row sm:items-center gap-2 sm:flex-wrap">
              <button
                onClick={() => {
                  setOrderDateStart(addDaysIso(todayIso(), -6));
                  setOrderDateEnd(todayIso());
                }}
                className="text-xs text-gray-400 hover:text-gray-700 underline"
              >
                Reset to last 7 days
              </button>
              <button
                onClick={() => {
                  setOrderDateStart(null);
                  setOrderDateEnd(null);
                }}
                className="text-xs text-gray-400 hover:text-gray-700 underline"
              >
                Show everything
              </button>
              <DateRangePicker
                startDate={orderDateStart}
                endDate={orderDateEnd}
                onChange={(s, e) => {
                  setOrderDateStart(s);
                  setOrderDateEnd(e);
                }}
              />
              <div className="relative" ref={downloadMenuRef}>
                <Button onClick={() => setDownloadMenuOpen((o) => !o)} disabled={filteredOrders.length === 0} className="inline-flex items-center gap-1.5">
                  <Download size={14} />
                  Download PDF
                </Button>
                {downloadMenuOpen && (
                  <div className="absolute right-0 z-20 mt-1 w-40 bg-white border border-gray-200 rounded-xl shadow-lg py-1">
                    {partners.filter((p) => p.kind === "courier").map((p) => ({ value: p.code, label: p.name })).map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => downloadReconciliationPdf(opt.value)}
                        className="w-full px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition"
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        {filteredOrders.length === 0 ? (
          <p className="p-5 text-sm text-gray-400">{data.orders.length === 0 ? "Dispatch an online order to start reconciliation." : "No orders in this date range."}</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Order</Th>
                <Th>Courier</Th>
                <Th>Status</Th>
                <Th>COD</Th>
                <Th>Charge</Th>
                <Th>Net</Th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map((order) => (
                <tr key={order.id}>
                  <Td>
                    <span className="font-medium">
                      <RefLink to={`/sales/${order.sale_id}`}>{order.invoice}</RefLink>
                    </span>
                    <span className="block text-xs text-gray-400">{order.customer_name ?? "Walk-in"}</span>
                  </Td>
                  <Td>{labelFor(order.courier_partner)}</Td>
                  <Td>
                    <span className="inline-flex items-center gap-1 text-xs capitalize">
                      <CheckCircle2 size={12} className={order.delivery_status === "delivered" ? "text-green-600" : "text-gray-400"} />
                      {order.delivery_status}
                    </span>
                  </Td>
                  <Td>
                    {order.delivery_status === "delivered" ? (
                      money(order.cod_amount)
                    ) : (
                      <span className="line-through text-gray-400">{money(order.cod_amount)}</span>
                    )}
                  </Td>
                  <Td>
                    <button
                      onClick={() => setEditingOrder(order)}
                      className="text-gray-900 hover:text-black underline decoration-dotted tabular-nums"
                      title="Enter what the courier really charged"
                    >
                      {money(order.courier_charge)}
                    </button>
                    {order.return_charge > 0 && (
                      <button onClick={() => setEditingOrder(order)} className="block text-xs text-gray-500 hover:text-gray-900 underline decoration-dotted mt-0.5">
                        +{money(order.return_charge)} return
                      </button>
                    )}
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-400">
                      {order.charge_confirmed ? (
                        <span className="inline-flex items-center gap-0.5 text-gray-500">
                          <Check size={12} />
                          confirmed
                        </span>
                      ) : null}
                      {(order.actual_weight_kg ?? order.package_weight_kg) ? <span>{order.actual_weight_kg ?? order.package_weight_kg} kg</span> : null}
                    </div>
                  </Td>
                  <Td className="font-semibold">
                    {money((order.delivery_status === "delivered" ? order.cod_amount : 0) - order.courier_charge - order.return_charge)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {editingOrder && <CourierChargeModal order={editingOrder} onClose={() => setEditingOrder(null)} onSaved={load} />}
    </div>
  );
}
