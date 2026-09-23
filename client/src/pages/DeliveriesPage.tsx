import { useEffect, useState, useMemo, Fragment, ReactNode } from "react";
import { Truck, Package, Send, CheckCircle2, RotateCcw, FileDown, Ban, ExternalLink, ChevronDown, ChevronRight } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Delivery, DeliveryStatus } from "../lib/types";
import { PageHeader, Card, Table, Th, Td, Button, EmptyState, ErrorText, DateRangePicker, Badge, RowCard, RowCardStats, RowCardStat } from "../components/ui";
import PackWaybillModal from "../components/PackWaybillModal";
import { DELIVERY_PARTNERS, courierTrackingUrl } from "../lib/delivery";

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function money(n: number | null | undefined): string {
  return `Rs. ${(n ?? 0).toLocaleString()}`;
}

function partnerLabel(partner: string | null | undefined): string {
  return DELIVERY_PARTNERS.find((p) => p.value === partner)?.label ?? "—";
}

function CodCell({ delivery }: { delivery: Delivery }) {
  if (delivery.cod_amount > 0) {
    return <span className="font-semibold text-gray-900">{money(delivery.cod_amount)}</span>;
  }
  return <Badge label="Prepaid" tone="neutral" />;
}

function TrackingLink({ delivery }: { delivery: Delivery }) {
  if (!delivery.tracking_number) return null;
  const url = courierTrackingUrl(delivery.delivery_partner, delivery.tracking_number);
  if (!url) return <span className="block text-sm font-semibold text-gray-900">{delivery.tracking_number}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-sm font-semibold text-gray-900 hover:text-black underline decoration-dotted"
    >
      {delivery.tracking_number}
      <ExternalLink size={12} className="flex-shrink-0" />
    </a>
  );
}

function TimelineStep({ label, date, reached, isLast }: { label: string; date: string | null; reached: boolean; isLast: boolean }) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div
          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
            reached ? "bg-black" : "bg-white border-2 border-gray-300"
          }`}
        />
        {!isLast && <div className={`w-px flex-1 min-h-[28px] ${reached ? "bg-black" : "bg-gray-200"}`} />}
      </div>
      <div className={isLast ? "" : "pb-5"}>
        <p className={`text-sm font-medium ${reached ? "text-gray-900" : "text-gray-400"}`}>{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">{date ? date.slice(0, 10) : "Not yet"}</p>
      </div>
    </div>
  );
}

function ExpandedDetail({ d }: { d: Delivery }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_240px] gap-6 lg:gap-8 items-start">
      {/* Items */}
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2.5">Items</p>
        {d.items && d.items.length > 0 ? (
          <div className="divide-y divide-gray-100 text-sm">
            {d.items.map((it) => (
              <div key={it.id} className="flex items-baseline gap-3 py-2 first:pt-0">
                <span className="text-gray-700">
                  {it.quantity}× {it.product_title}
                  {(it.size || it.color) && (
                    <span className="text-gray-500"> ({[it.size, it.color].filter(Boolean).join(", ")})</span>
                  )}
                </span>
                <span className="text-gray-900 font-medium flex-shrink-0 ml-auto">{money(it.line_total)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">Loading items...</p>
        )}
      </div>

      {/* Contact — only what isn't already visible in the row itself
          (customer name and address are already the Customer/Location
          columns, so repeating them here would just be noise) */}
      {d.customer_phone && (
        <div className="text-sm">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2.5">Contact</p>
          <div className="flex items-baseline gap-3">
            <span className="text-gray-500 w-14 flex-shrink-0">Phone</span>
            <span className="text-gray-900 font-medium">{d.customer_phone}</span>
          </div>
        </div>
      )}

      {/* Timeline */}
      <div className="lg:border-l lg:border-gray-200 lg:pl-8">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Timeline</p>
        <TimelineStep label="Packed" date={d.packed_at} reached={!!d.packed_at} isLast={false} />
        <TimelineStep label="Dispatched" date={d.dispatched_at} reached={!!d.dispatched_at} isLast={false} />
        <TimelineStep label="Delivered" date={d.delivery_date} reached={!!d.delivery_date} isLast={true} />

        {d.notes && (
          <div className="mt-5 pt-5 border-t border-gray-200">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Notes</p>
            <p className="text-sm text-gray-800 leading-relaxed">{d.notes}</p>
          </div>
        )}
      </div>
    </div>
  );
}

const TABS: { key: DeliveryStatus; label: string; icon: any }[] = [
  { key: "pending", label: "Pending", icon: Package },
  { key: "packed", label: "Packed", icon: FileDown },
  { key: "dispatched", label: "Dispatched", icon: Send },
  { key: "delivered", label: "Delivered", icon: CheckCircle2 },
];

export default function DeliveriesPage() {
  const [activeTab, setActiveTab] = useState<DeliveryStatus>("pending");
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [packingDelivery, setPackingDelivery] = useState<Delivery | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [startDate, setStartDate] = useState<string | null>(() => {
    const d = new Date();
    return toISODate(new Date(d.getFullYear(), d.getMonth(), 1));
  });
  const [endDate, setEndDate] = useState<string | null>(() => toISODate(new Date()));

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setDeliveries(await api.get<Delivery[]>("/deliveries"));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load deliveries");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    return deliveries.filter((d) => {
      if (d.delivery_status !== activeTab) return false;
      if (!startDate || !endDate || !d.sale_date) return true;
      const saleDate = d.sale_date.slice(0, 10);
      return saleDate >= startDate && saleDate <= endDate;
    });
  }, [deliveries, activeTab, startDate, endDate]);

  const returnedCount = deliveries.filter((d) => d.delivery_status === "returned").length;
  const cancelledCount = deliveries.filter((d) => d.delivery_status === "cancelled").length;

  const showWaybill = activeTab !== "pending";

  async function toggleExpand(d: Delivery) {
    if (expandedId === d.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(d.id);
    if (!d.items) {
      try {
        const full = await api.get<Delivery>(`/deliveries/${d.id}`);
        setDeliveries((prev) => prev.map((x) => (x.id === d.id ? { ...x, ...full } : x)));
      } catch {
        // detail fetch failing shouldn't block the row from expanding
      }
    }
  }

  async function openPackModal(d: Delivery) {
    const full = await api.get<Delivery>(`/deliveries/${d.id}`);
    setPackingDelivery(full);
  }

  async function handlePacked(trackingNumber: string) {
    if (!packingDelivery) return;
    try {
      await api.put(`/deliveries/${packingDelivery.id}/pack`, { tracking_number: trackingNumber });
      setPackingDelivery(null);
      load();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : "Waybill was saved, but the order status couldn't be updated — check its status.");
    }
  }

  async function dispatch(id: number) {
    setActionError(null);
    try {
      await api.put(`/deliveries/${id}/dispatch`, {});
      load();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : "Failed to dispatch");
    }
  }

  async function markDelivered(id: number) {
    setActionError(null);
    try {
      await api.put(`/deliveries/${id}/deliver`, {});
      load();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : "Failed to mark delivered");
    }
  }

  async function markReturned(id: number) {
    if (!confirm("Mark this order as returned? This removes it from the normal pipeline.")) return;
    setActionError(null);
    try {
      await api.put(`/deliveries/${id}/return`, {});
      load();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : "Failed to mark returned");
    }
  }

  function PrimaryAction({ d }: { d: Delivery }) {
    let content: ReactNode;
    if (d.delivery_status === "pending") {
      content = (
        <Button size="sm" variant="primary" onClick={() => openPackModal(d)}>
          Generate waybill
        </Button>
      );
    } else if (d.delivery_status === "packed") {
      content = (
        <div className="flex gap-2">
          <Button size="sm" variant="primary" onClick={() => dispatch(d.id)}>
            Dispatch
          </Button>
          <Button size="sm" variant="danger" onClick={() => markReturned(d.id)}>
            Returned
          </Button>
        </div>
      );
    } else if (d.delivery_status === "dispatched") {
      content = (
        <div className="flex gap-2">
          <Button size="sm" variant="primary" onClick={() => markDelivered(d.id)}>
            Mark delivered
          </Button>
          <Button size="sm" variant="danger" onClick={() => markReturned(d.id)}>
            Returned
          </Button>
        </div>
      );
    } else if (d.delivery_status === "delivered") {
      content = <span className="text-xs text-gray-400">{d.delivery_date?.slice(0, 10)}</span>;
    } else {
      content = null;
    }
    return <div onClick={(e) => e.stopPropagation()}>{content}</div>;
  }

  return (
    <div>
      <PageHeader
        title="Shipping"
        subtitle="Online orders move through this pipeline automatically once placed."
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

      <div className="flex items-center gap-2 mb-5 flex-wrap">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const count = deliveries.filter((d) => d.delivery_status === tab.key).length;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => {
                setActiveTab(tab.key);
                setExpandedId(null);
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition ${
                isActive ? "bg-black text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
            >
              <Icon size={15} />
              {tab.label}
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${isActive ? "bg-white/20" : "bg-white text-gray-500"}`}>{count}</span>
            </button>
          );
        })}
        <div className="w-px h-6 bg-gray-200 mx-1" />
        <button
          onClick={() => {
            setActiveTab("returned");
            setExpandedId(null);
          }}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition ${
            activeTab === "returned" ? "bg-red-600 text-white" : "bg-red-50 text-red-600 hover:bg-red-100"
          }`}
        >
          <RotateCcw size={15} />
          Returned
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${activeTab === "returned" ? "bg-white/20" : "bg-white"}`}>{returnedCount}</span>
        </button>
        <button
          onClick={() => {
            setActiveTab("cancelled");
            setExpandedId(null);
          }}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition ${
            activeTab === "cancelled" ? "bg-gray-700 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          <Ban size={15} />
          Cancelled
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${activeTab === "cancelled" ? "bg-white/20" : "bg-white"}`}>{cancelledCount}</span>
        </button>
      </div>

      {error && <ErrorText>{error}</ErrorText>}
      {actionError && <ErrorText>{actionError}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <EmptyState icon={Truck} title={`No ${activeTab} orders in this date range`} />
      ) : (
        <>
          {/* Desktop table — detail lives INSIDE the row */}
          <Card className="p-0 overflow-hidden hidden lg:block">
            <Table>
              <thead>
                <tr>
                  <Th>{showWaybill ? "Waybill" : "Order"}</Th>
                  <Th>COD</Th>
                  <Th>Location</Th>
                  <Th>Customer</Th>
                  <Th>Courier</Th>
                  <Th></Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => {
                  const isExpanded = expandedId === d.id;
                  return (
                    <Fragment key={d.id}>
                      <tr
                        onClick={() => toggleExpand(d)}
                        className={`cursor-pointer transition-colors ${
                          isExpanded ? "bg-gray-50" : "hover:bg-gray-50"
                        }`}
                      >
                        <Td>
                          {showWaybill ? (
                            <>
                              <div className="font-semibold text-gray-900">{d.waybill_number ?? "Not packed yet"}</div>
                              <div className="text-xs text-gray-500 mt-0.5">{d.invoice}</div>
                            </>
                          ) : (
                            <div className="font-semibold text-gray-900">{d.invoice}</div>
                          )}
                        </Td>
                        <Td>
                          <CodCell delivery={d} />
                        </Td>
                        <Td className="max-w-[220px]">
                          {d.address_line1 ? (
                            <>
                              <div className="truncate text-gray-900">{d.address_line1}</div>
                              {d.city && <div className="text-xs text-gray-500 truncate mt-0.5">{d.city}</div>}
                            </>
                          ) : d.city ? (
                            <div className="text-gray-900">
                              {d.city} <span className="text-xs text-gray-500">— no street address</span>
                            </div>
                          ) : (
                            <span className="text-gray-400">No address on file</span>
                          )}
                        </Td>
                        <Td className="text-gray-900">{d.customer_name ?? "Walk-in"}</Td>
                        <Td>
                          <TrackingLink delivery={d} />
                          <div className="text-xs text-gray-500 mt-0.5">{partnerLabel(d.delivery_partner)}</div>
                        </Td>
                        <Td>
                          <PrimaryAction d={d} />
                        </Td>
                        <Td className="w-8">
                          {isExpanded ? <ChevronDown size={15} className="text-gray-400" /> : <ChevronRight size={15} className="text-gray-400" />}
                        </Td>
                      </tr>

                      {isExpanded && (
                        <tr className="bg-gray-50">
                          <Td colSpan={7} className="!py-0 !px-0">
                            <div className="px-5 pb-4 pt-3 border-t border-gray-100">
                              <ExpandedDetail d={d} />
                            </div>
                          </Td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          </Card>

          {/* Mobile cards — detail lives INSIDE the card */}
          <div className="lg:hidden space-y-3">
            {filtered.map((d) => {
              const isExpanded = expandedId === d.id;
              return (
                <RowCard key={d.id} onClick={() => toggleExpand(d)}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900">{showWaybill ? d.waybill_number ?? "Not packed yet" : d.invoice}</p>
                      {showWaybill && <p className="text-xs text-gray-500 mt-0.5">{d.invoice}</p>}
                      <p className="text-sm text-gray-700 mt-1.5">{d.customer_name ?? "Walk-in"}</p>
                      <p className="text-xs text-gray-500 truncate mt-0.5">
                        {d.address_line1 ? `${d.address_line1}, ${d.city ?? ""}` : d.city ?? "No address on file"}
                      </p>
                    </div>
                    {isExpanded ? (
                      <ChevronDown size={16} className="text-gray-400 flex-shrink-0 mt-1" />
                    ) : (
                      <ChevronRight size={16} className="text-gray-400 flex-shrink-0 mt-1" />
                    )}
                  </div>

                  <RowCardStats>
                    <RowCardStat label="COD" value={<CodCell delivery={d} />} />
                    <RowCardStat label="Courier" value={partnerLabel(d.delivery_partner)} />
                    {d.tracking_number && <RowCardStat label="Tracking" value={<TrackingLink delivery={d} />} />}
                  </RowCardStats>

                  <div className="mt-3 pt-3 border-t border-gray-100">
                    <PrimaryAction d={d} />
                  </div>

                  {isExpanded && (
                    <div
                      className="mt-2 pt-2 border-t border-gray-100 -mx-4 px-4"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExpandedDetail d={d} />
                    </div>
                  )}
                </RowCard>
              );
            })}
          </div>
        </>
      )}

      {packingDelivery && <PackWaybillModal delivery={packingDelivery} onClose={() => setPackingDelivery(null)} onPacked={handlePacked} />}
    </div>
  );
}