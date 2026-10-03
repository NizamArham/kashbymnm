import { useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Delivery } from "../lib/types";
import { DELIVERY_PAID_BY_OPTIONS, DeliveryPaidBy, COURIER_API, partnerLabel, useDeliveryPartners } from "../lib/delivery";
import { FormGroup, Label, Input, ErrorText } from "./ui";

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
  const [fare, setFare] = useState("");
  const [paidBy, setPaidBy] = useState<DeliveryPaidBy>("customer");
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
    if (isOnDemand && !(parseFloat(fare) > 0)) {
      setError(`Enter the delivery fare for ${target.name}.`);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await api.put(`/deliveries/${delivery.id}/partner`, {
        delivery_partner: target.code,
        ...(isOnDemand ? { delivery_fare: parseFloat(fare), delivery_paid_by: paidBy } : {}),
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
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-gray-900">Change courier</h2>
        <p className="text-xs text-gray-400 mt-0.5 mb-4">
          {delivery.invoice} · currently {partnerLabel(delivery.delivery_partner)}
        </p>

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
                    {p.kind === "on_demand" ? "On-demand — fare typed in" : "Courier"}
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
            <FormGroup>
              <Label>Delivery fare (Rs.)</Label>
              <Input type="number" min="0" value={fare} onChange={(e) => setFare(e.target.value)} placeholder="0" />
            </FormGroup>
            <FormGroup>
              <Label>Who pays for the delivery?</Label>
              <div className="grid grid-cols-1 gap-1.5">
                {DELIVERY_PAID_BY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setPaidBy(opt.value)}
                    className={`text-left rounded-lg border px-3 py-2 transition ${
                      paidBy === opt.value ? "border-black bg-black text-white" : "border-gray-300 hover:border-gray-400"
                    }`}
                  >
                    <span className="text-xs font-medium block">{opt.label}</span>
                    <span className={`text-[11px] ${paidBy === opt.value ? "text-gray-300" : "text-gray-500"}`}>{opt.hint}</span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-1.5">This re-prices the delivery: the customer's charge and COD are recalculated from the fare.</p>
            </FormGroup>
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

        <div className="flex gap-2 mt-2">
          <button onClick={onClose} className="flex-1 border border-gray-200 rounded-xl py-2.5 text-sm font-medium hover:bg-gray-50 transition">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !target}
            className="flex-1 bg-black text-white rounded-xl py-2.5 text-sm font-medium hover:bg-gray-800 transition disabled:opacity-50"
          >
            {saving ? "Changing..." : "Change courier"}
          </button>
        </div>
      </div>
    </div>
  );
}
