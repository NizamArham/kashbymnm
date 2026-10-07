import { useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { Delivery } from "../lib/types";
import { DeliveryPaidBy, EMPTY_ON_DEMAND_FARE, OnDemandFare, onDemandFareError, paidByOf, partnerLabel } from "../lib/delivery";
import { Button, ErrorText, Modal } from "./ui";
import { OnDemandFareInput, OnDemandPaidByPicker } from "./OnDemandFareFields";

// Enter the fare of an Uber / PickMe Flash order once the ride is booked —
// the order was billed (or put on credit) first, so it's been on hold with
// nothing charged for delivery. Saving re-prices it like checkout would
// have, and releases the hold so it can be packed. Also the place to say
// "the customer pays the rider" when there turns out to be no fare for us.
export default function DeliveryFareModal({
  delivery,
  onClose,
  onSaved,
}: {
  delivery: Delivery;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const current = paidByOf(delivery);
  // A fare already on the order is being corrected; otherwise it's being added.
  const editing = delivery.actual_fare != null;
  const [value, setValue] = useState<OnDemandFare>({
    ...EMPTY_ON_DEMAND_FARE,
    fare: editing ? String(delivery.actual_fare) : "",
    paidBy: (current ?? "customer") as DeliveryPaidBy,
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const name = partnerLabel(delivery.delivery_partner);

  async function handleSave() {
    // "Not known yet" makes no sense here — this is where it gets known.
    const problem = onDemandFareError({ ...value, fareLater: false }, name);
    if (problem) {
      setError(problem.replace(' — or tick "Not known yet" to add it later.', "."));
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await api.put(`/deliveries/${delivery.id}/fare`, {
        delivery_paid_by: value.paidBy,
        ...(value.paidBy !== "rider_direct" ? { delivery_fare: parseFloat(value.fare) } : {}),
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to save the fare");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      size="md"
      stacked
      onClose={onClose}
      title={editing ? "Change delivery fare" : "Add delivery fare"}
      subtitle={`${delivery.invoice} · ${name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save fare"}
          </Button>
        </>
      }
    >
        <OnDemandFareInput value={{ ...value, fareLater: false }} onChange={(patch) => setValue({ ...value, ...patch, fareLater: false })} partnerName={name} allowLater={false} />
        <OnDemandPaidByPicker value={{ ...value, fareLater: false }} onChange={(patch) => setValue({ ...value, ...patch, fareLater: false })} />
        <p className="text-xs text-gray-400 -mt-2 mb-3">
          The customer's charge and the amount to collect on delivery are recalculated from the fare
          {delivery.delivery_fee > 0 ? ` (currently Rs. ${delivery.delivery_fee.toLocaleString()})` : ""}.
        </p>

        {error && <ErrorText>{error}</ErrorText>}
    </Modal>
  );
}
