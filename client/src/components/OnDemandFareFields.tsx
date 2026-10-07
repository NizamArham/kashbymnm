import { DELIVERY_PAID_BY_OPTIONS, OnDemandFare } from "../lib/delivery";
import { FormGroup, Label, Input, HelpHint } from "./ui";

// The fare half of an on-demand order (Uber, PickMe Flash…): a fare box
// that can be left for later, and who pays. Two separate pieces so POS can
// put the fare box beside the partner picker and the options underneath,
// while the modals just stack them.
type Change = (patch: Partial<OnDemandFare>) => void;

export function OnDemandFareInput({
  value,
  onChange,
  partnerName,
  allowLater = true,
}: {
  value: OnDemandFare;
  onChange: Change;
  partnerName: string;
  // Off where the fare is being entered right now ("Add fare") — waiting makes no sense there.
  allowLater?: boolean;
}) {
  const riderDirect = value.paidBy === "rider_direct";
  const canWait = allowLater && !riderDirect;
  const waiting = canWait && value.fareLater;
  return (
    <FormGroup>
      <Label>
        Delivery fare (Rs.)
        <HelpHint text={`${partnerName} has no tariff — enter what the ride actually costs, or leave it until the rider is booked.`} />
      </Label>
      <Input
        type="number"
        min="0"
        value={riderDirect || waiting ? "" : value.fare}
        onChange={(e) => onChange({ fare: e.target.value })}
        disabled={riderDirect || waiting}
        placeholder={riderDirect ? "Not needed" : waiting ? "Add later" : "0"}
      />
      {canWait && (
        <label className="flex items-center gap-1.5 text-xs text-gray-600 mt-1.5 cursor-pointer">
          <input type="checkbox" checked={value.fareLater} onChange={(e) => onChange({ fareLater: e.target.checked })} className="rounded" />
          Not known yet — add it when booked
        </label>
      )}
    </FormGroup>
  );
}

export function OnDemandPaidByPicker({ value, onChange }: { value: OnDemandFare; onChange: Change }) {
  const selected = DELIVERY_PAID_BY_OPTIONS.find((o) => o.value === value.paidBy);
  const waiting = value.fareLater && value.paidBy !== "rider_direct";
  return (
    <FormGroup>
      <Label>Who pays for the delivery?</Label>
      <div className="grid grid-cols-3 gap-1.5">
        {DELIVERY_PAID_BY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange({ paidBy: opt.value })}
            className={`rounded-lg border px-2.5 py-2 text-xs font-medium text-left transition ${
              value.paidBy === opt.value ? "border-black bg-black text-white" : "border-gray-300 text-gray-700 hover:border-gray-400"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-gray-500 mt-1.5">
        {waiting
          ? "On hold: nothing is charged for delivery yet, and the order can't be packed until you add the fare (Deliveries → Add fare)."
          : selected?.hint}
      </p>
    </FormGroup>
  );
}
