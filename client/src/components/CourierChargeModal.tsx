import { FormEvent, useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { CourierReconciliationOrder } from "../lib/types";
import { calculateDeliveryFee, partnerLabel, useDeliveryPartners } from "../lib/delivery";
import { cleanDecimal } from "../lib/numberInput";
import { Badge, Button, ErrorText, FormGroup, Input, Label, Modal } from "./ui";

const money = (n: number) => `Rs. ${n.toLocaleString()}`;

// Put the courier's REAL figures on one order. A charge starts as the tariff's
// estimate for the weight entered at dispatch; the courier's own bill can come
// out higher or lower with the actual parcel. Saving marks the charge confirmed.
export default function CourierChargeModal({
  order,
  onClose,
  onSaved,
}: {
  order: CourierReconciliationOrder;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { partners } = useDeliveryPartners();
  const partner = partners.find((p) => p.code === order.courier_partner);
  const [charge, setCharge] = useState(String(order.courier_charge));
  const [weight, setWeight] = useState(order.actual_weight_kg ? String(order.actual_weight_kg) : "");
  const [returnCharge, setReturnCharge] = useState(String(order.return_charge));
  const [note, setNote] = useState(order.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showReturn = order.delivery_status === "returned" || order.return_charge > 0;
  const weightNum = parseFloat(weight) || 0;
  const tariffForWeight = weightNum > 0 ? calculateDeliveryFee(weightNum, false, partner) : null;
  const chargeNum = parseFloat(charge);
  const returnNum = showReturn ? parseFloat(returnCharge) || 0 : order.return_charge;
  const counts = order.delivery_status === "delivered" || order.delivery_status === "returned";
  const collected = order.delivery_status === "delivered" ? order.cod_amount : 0;
  const netBefore = collected - order.courier_charge - order.return_charge;
  const netAfter = Number.isFinite(chargeNum) ? collected - chargeNum - returnNum : netBefore;

  async function save(values: { charge: number; returnCharge: number; weight: number | null; note: string }) {
    setSaving(true);
    setError(null);
    try {
      await api.post(`/courier-reconciliation/orders/${order.id}`, {
        courier_charge: values.charge,
        ...(showReturn ? { return_charge: values.returnCharge } : {}),
        actual_weight_kg: values.weight,
        notes: values.note,
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't save — try again");
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!Number.isFinite(chargeNum) || chargeNum < 0) {
      setError("Enter the charge the courier really billed.");
      return;
    }
    if (weight.trim() && !(weightNum > 0)) {
      setError("The weight must be more than 0, or leave it empty.");
      return;
    }
    save({ charge: chargeNum, returnCharge: returnNum, weight: weight.trim() ? weightNum : null, note });
  }

  return (
    <form onSubmit={handleSubmit}>
      <Modal
        size="lg"
        stacked
        onClose={onClose}
        title={
          <span className="inline-flex items-center gap-2">
            Real courier values
            <Badge label={order.charge_confirmed ? "Confirmed" : "Estimate"} tone="neutral" />
          </span>
        }
        subtitle={`${order.invoice} · ${order.customer_name ?? "Walk-in"} · ${partnerLabel(order.courier_partner)}`}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            {!order.charge_confirmed && (
              <Button
                onClick={() => save({ charge: order.courier_charge, returnCharge: order.return_charge, weight: order.actual_weight_kg, note: order.notes ?? "" })}
                disabled={saving}
                title="Keep the estimate as it is and mark it checked"
              >
                Estimate is right
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </>
        }
      >
        <div className="rounded-xl bg-gray-50 px-3.5 py-3 text-xs text-gray-600 space-y-1 mb-4">
          <div className="flex justify-between">
            <span>Weight entered at dispatch</span>
            <span className="text-gray-900">{order.package_weight_kg ? `${order.package_weight_kg} kg` : "not entered"}</span>
          </div>
          <div className="flex justify-between">
            <span>The system's estimate</span>
            <span className="text-gray-900">{money(order.estimated_charge ?? order.tariff_charge)}</span>
          </div>
        </div>

        <FormGroup>
          <Label>What the courier really charged (Rs.)</Label>
          <Input
            type="text"
            inputMode="decimal"
            autoFocus
            value={charge}
            onChange={(e) => setCharge(cleanDecimal(e.target.value))}
            className="text-right tabular-nums"
          />
        </FormGroup>

        <FormGroup>
          <Label>Actual weight, if it was different (kg)</Label>
          <Input type="text" inputMode="decimal" value={weight} onChange={(e) => setWeight(cleanDecimal(e.target.value))} placeholder={order.package_weight_kg ? String(order.package_weight_kg) : "optional"} className="text-right tabular-nums" />
          {tariffForWeight !== null && (
            <p className="text-xs text-gray-500 mt-1.5">
              The tariff for {weightNum} kg is {money(tariffForWeight)}.{" "}
              {String(tariffForWeight) !== charge && (
                <button type="button" onClick={() => setCharge(String(tariffForWeight))} className="underline text-gray-900 hover:no-underline">
                  Use that
                </button>
              )}
            </p>
          )}
        </FormGroup>

        {showReturn && (
          <FormGroup>
            <Label>Return-trip charge (Rs.)</Label>
            <Input type="text" inputMode="decimal" value={returnCharge} onChange={(e) => setReturnCharge(cleanDecimal(e.target.value))} className="text-right tabular-nums" />
          </FormGroup>
        )}

        <FormGroup>
          <Label>Note (optional)</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. courier invoice shows a heavier parcel" />
        </FormGroup>

        {counts && Number.isFinite(chargeNum) && netAfter !== netBefore && (
          <p className="text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2 mb-3">
            This order's net: {money(netBefore)} → <span className="font-medium text-gray-900">{money(netAfter)}</span>, so the courier's balance moves by {netAfter - netBefore > 0 ? "+" : "−"}
            {money(Math.abs(netAfter - netBefore))}.
          </p>
        )}

        {error && <ErrorText>{error}</ErrorText>}
      </Modal>
    </form>
  );
}
