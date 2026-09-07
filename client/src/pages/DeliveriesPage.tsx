import { useEffect, useState, useMemo } from "react";
import { Truck, Package, Send, CheckCircle2, RotateCcw, FileDown, Ban } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Delivery, DeliveryStatus } from "../lib/types";
import { PageHeader, Card, Table, Th, Td, Button, EmptyState, ErrorText, DateRangePicker } from "../components/ui";
import PackWaybillModal from "../components/PackWaybillModal";
import { DELIVERY_PARTNERS } from "../lib/delivery";

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

  async function confirmAddress(id: number) {
    setActionError(null);
    try {
      await api.put(`/deliveries/${id}/confirm-address`, {});
      load();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : "Failed to confirm address");
    }
  }

  async function openPackModal(d: Delivery) {
    // The list view doesn't include line items — fetch the full record so
    // the waybill's description line has real product details.
    const full = await api.get<Delivery>(`/deliveries/${d.id}`);
    setPackingDelivery(full);
  }

  // Called by the modal only after the label has actually been saved or
  // sent to print — packing the order is the consequence of producing
  // the waybill, not a separate step that could get out of sync with it.
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
              onClick={() => setActiveTab(tab.key)}
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
          onClick={() => setActiveTab("returned")}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition ${
            activeTab === "returned" ? "bg-red-600 text-white" : "bg-red-50 text-red-600 hover:bg-red-100"
          }`}
        >
          <RotateCcw size={15} />
          Returned
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${activeTab === "returned" ? "bg-white/20" : "bg-white"}`}>{returnedCount}</span>
        </button>
        <button
          onClick={() => setActiveTab("cancelled")}
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
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th>Invoice</Th>
                <Th>Customer</Th>
                <Th>Address</Th>
                {activeTab !== "pending" && <Th>Waybill</Th>}
                <Th>Partner</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.id} className="hover:bg-gray-50">
                  <Td>{d.invoice}</Td>
                  <Td>{d.customer_name ?? "—"}</Td>
                  <Td>{d.address_line1 ? `${d.address_line1}, ${d.city ?? ""}` : "No address on file"}</Td>
                  {activeTab !== "pending" && (
                    <Td>
                      <div>{d.waybill_number ?? "—"}</div>
                      {d.tracking_number && <div className="text-xs text-gray-400">{d.tracking_number}</div>}
                    </Td>
                  )}
                  <Td>
                    <div>{DELIVERY_PARTNERS.find((p) => p.value === d.delivery_partner)?.label ?? "—"}</div>
                    {d.courier_name && <div className="text-xs text-gray-400">{d.courier_name}</div>}
                  </Td>
                  <Td>
                    {activeTab === "pending" && (
                      <>
                        {!d.address_confirmed ? (
                          <Button size="sm" variant="primary" onClick={() => confirmAddress(d.id)} disabled={!d.address_line1}>
                            Confirm address
                          </Button>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-green-600">✓ Address confirmed</span>
                            <Button size="sm" variant="primary" onClick={() => openPackModal(d)}>
                              Generate waybill
                            </Button>
                          </div>
                        )}
                      </>
                    )}
                    {activeTab === "packed" && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="primary" onClick={() => dispatch(d.id)}>
                          Dispatch
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => markReturned(d.id)}>
                          Returned
                        </Button>
                      </div>
                    )}
                    {activeTab === "dispatched" && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="primary" onClick={() => markDelivered(d.id)}>
                          Mark delivered
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => markReturned(d.id)}>
                          Returned
                        </Button>
                      </div>
                    )}
                    {activeTab === "delivered" && <span className="text-xs text-gray-400">{d.delivery_date?.slice(0, 10)}</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {packingDelivery && <PackWaybillModal delivery={packingDelivery} onClose={() => setPackingDelivery(null)} onPacked={handlePacked} />}
    </div>
  );
}
