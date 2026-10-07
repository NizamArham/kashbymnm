import { useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Delivery } from "../lib/types";
import {
  COURIER_API,
  EMPTY_ON_DEMAND_FARE,
  OnDemandFare,
  onDemandFareError,
  onDemandPayload,
  partnerLabel,
  useDeliveryPartners,
} from "../lib/delivery";
import { Button, ErrorText, Modal } from "./ui";
import { OnDemandFareInput, OnDemandPaidByPicker } from "./OnDemandFareFields";

// Switch which delivery partner an order ships with, any time before the
// courier actually has it. Shared by the Deliveries list (inline) and the
// waybill modal, so it behaves identically from either.
export default function ChangePartnerModal({
  delivery,
  onClose,
  onChanged,
}: {
  delivery: Delivery;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const { activePartners } = useDeliveryPartners();
  const [selected, setSelected] = useState<string | null>(null);
  const [fare, setFare] = useState<OnDemandFare>(EMPTY_ON_DEMAND_FARE);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const target = activePartners.find((p) => p.code === selected);
  const isOnDemand = target?.kind === "on_demand";
  const warnings: string[] = [];
  if (delivery.delivery_status === "packed") {
    warnings.push("A waybill was already generated for this order — it goes back to Pending so you can generate a new one for the new courier.");
  }
  // A shipment booked through a courier's API exists on THEIR side —
  // this system has no way to cancel it there.
  const bookedWith = delivery.delivery_partner ? COURIER_API[delivery.delivery_partner] : undefined;
  if (bookedWith && (delivery.citypak_order_id || (delivery.delivery_partner !== "CPAK" && delivery.tracking_number))) {
    warnings.push(
      `A ${bookedWith.name} shipment was already created for this order. This system can't cancel it — cancel it with ${bookedWith.name}, or they'll still come to collect it.`
    );
  }

  async function handleSave() {
    if (!target) {
      setError("Pick the new delivery partner.");
      return;
    }
    const fareError = isOnDemand ? onDemandFareError(fare, target.name) : null;
    if (fareError) {
      setError(fareError);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await api.put(`/deliveries/${delivery.id}/partner`, {
        delivery_partner: target.code,
        ...(isOnDemand ? onDemandPayload(fare) : {}),
      });
      await onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to change the delivery partner");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      size="lg"
      stacked
      onClose={onClose}
      title="Change courier"
      subtitle={`${delivery.invoice} · currently ${partnerLabel(delivery.delivery_partner)}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving || !target}>
            {saving ? "Changing..." : "Change courier"}
          </Button>
        </>
      }
    >
        <div className="grid grid-cols-1 gap-1.5 mb-4">
          {activePartners.map((p) => {
            const isCurrent = p.code === delivery.delivery_partner;
            const isSelected = p.code === selected;
            return (
              <button
                key={p.code}
                type="button"
                disabled={isCurrent}
                onClick={() => setSelected(p.code)}
                className={`flex items-center justify-between rounded-lg border px-3 py-2.5 text-left transition ${
                  isSelected ? "border-black bg-black text-white" : isCurrent ? "border-gray-200 bg-gray-50 text-gray-400" : "border-gray-300 hover:border-gray-400"
                }`}
              >
                <span>
                  <span className="text-sm font-medium block">{p.name}</span>
                  <span className={`text-xs ${isSelected ? "text-gray-300" : "text-gray-400"}`}>
                    {p.kind === "on_demand" ? "On-demand — fare typed in, or added later" : "Courier"}
                    {isCurrent ? " · current" : ""}
                  </span>
                </span>
                {isSelected && <Check size={16} />}
              </button>
            );
          })}
        </div>

        {target && !isOnDemand && (
          <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2 mb-4">
            The delivery charge the customer was quoted (Rs. {delivery.delivery_fee.toLocaleString()}
            {delivery.is_free_delivery ? ", free" : ""}) and the COD amount stay exactly as they are.
          </p>
        )}

        {isOnDemand && (
          <>
            <OnDemandFareInput value={fare} onChange={(patch) => setFare({ ...fare, ...patch })} partnerName={target.name} />
            <OnDemandPaidByPicker value={fare} onChange={(patch) => setFare({ ...fare, ...patch })} />
            <p className="text-xs text-gray-400 -mt-2 mb-3">This re-prices the delivery: the customer's charge and COD are recalculated from the fare.</p>
          </>
        )}

        {target &&
          warnings.map((w) => (
            <div key={w} className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
              <AlertTriangle size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">{w}</p>
            </div>
          ))}

        {error && <ErrorText>{error}</ErrorText>}
    </Modal>
  );
}
