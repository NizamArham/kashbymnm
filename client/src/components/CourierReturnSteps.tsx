import { ReactNode, useEffect, useMemo, useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { ReturnPickup, ReturnPickupItem } from "../lib/types";
import { useDeliveryPartners } from "../lib/delivery";
import { SHARE_OPTIONS } from "../lib/pickupShare";
import { useAuth } from "../context/AuthContext";
import { useAdminApproval } from "./AdminApproval";
import ArrivalChoice, { PasswordNote, allGood, startGood } from "./ArrivalChoice";
import RefundMethodPicker, { useCustomerBankAccounts } from "./RefundMethodPicker";
import StepModal from "./StepModal";
import CancelReasonModal from "./CancelReasonModal";
import { Button, Dropdown, ErrorText, FormGroup, Input, Label, Modal, MoneyInput } from "./ui";

const money = (n: number) => `Rs. ${Math.round(n).toLocaleString()}`;
const variant = (size: string | null, color: string | null) => [size, color].filter(Boolean).join(" / ");
const itemName = (i: ReturnPickupItem) => `${i.title ?? "Item"}${variant(i.size, i.color) ? ` · ${variant(i.size, i.color)}` : ""}`;

// The steps of a courier return after it has been approved — each a dialog, opened from the row on Returns ▸ On the way back:
//   CourierReceivedModal  the parcel is on hand: service, tracking number (or none, which is noted as accepted risk), what we paid, and
//                         good or bad for each item with an optional reason
//   InspectionReportModal the careful look: condition of each item, who pays the delivery charge, what to pay the customer back
//   RejectReturnModal     the parcel is here and the return is not accepted at all — nothing refunded
//   RefundPaidModal       the refund is paid (with the customer's bank details) and goes into the cash book

const OTHER = "__other__";

// Which delivery service: one of our couriers, or any other by name.
function ServicePicker({
  partnerCode,
  serviceName,
  onChange,
}: {
  partnerCode: string;
  serviceName: string;
  onChange: (next: { partnerCode: string; serviceName: string }) => void;
}) {
  const { activePartners } = useDeliveryPartners();
  const couriers = activePartners.filter((p) => p.kind === "courier");
  return (
    <FormGroup>
      <Label>Which delivery service?</Label>
      <Dropdown
        value={partnerCode}
        onChange={(v) => onChange({ partnerCode: v, serviceName })}
        placeholder="Choose the service"
        options={[...couriers.map((c) => ({ value: c.code, label: c.name })), { value: OTHER, label: "Another service (post, bus, someone else…)" }]}
      />
      {partnerCode === OTHER && <Input className="mt-2" placeholder="Name of the service" value={serviceName} onChange={(e) => onChange({ partnerCode, serviceName: e.target.value })} />}
    </FormGroup>
  );
}

// What the picker has chosen, in the shape the API takes.
const serviceBody = (partnerCode: string, serviceName: string) =>
  partnerCode === OTHER ? (serviceName.trim() ? { service_name: serviceName.trim() } : {}) : partnerCode ? { delivery_partner: partnerCode } : {};

// The picker's starting value from a return that may already know its service.
function initialService(p: ReturnPickup) {
  if (p.delivery_partner) return { partnerCode: p.delivery_partner, serviceName: "" };
  if (p.partner_name) return { partnerCode: OTHER, serviceName: p.partner_name };
  return { partnerCode: "", serviceName: "" };
}

// A tracking number — or the plain statement that there is none.
function TrackingFields({
  tracking,
  onTracking,
  noTracking,
  onNoTracking,
  noTrackingLabel,
}: {
  tracking: string;
  onTracking: (v: string) => void;
  noTracking: boolean;
  onNoTracking: (v: boolean) => void;
  noTrackingLabel: string;
}) {
  return (
    <FormGroup>
      <Label>Tracking number</Label>
      <Input placeholder="Tracking number" value={tracking} onChange={(e) => onTracking(e.target.value)} disabled={noTracking} />
      <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-xs text-gray-600">
        <input type="checkbox" checked={noTracking} onChange={(e) => onNoTracking(e.target.checked)} className="h-3.5 w-3.5 accent-black" />
        {noTrackingLabel}
      </label>
    </FormGroup>
  );
}

function Foot({ onClose, busy, label, onConfirm, disabled, middle }: { onClose: () => void; busy: boolean; label: string; onConfirm: () => void; disabled?: boolean; middle?: ReactNode }) {
  return (
    <>
      <Button onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      {middle}
      <Button variant="primary" onClick={onConfirm} disabled={busy || disabled}>
        {busy ? "Saving…" : label}
      </Button>
    </>
  );
}

// ---------------------------------------------------------------- the parcel is on hand
// One fixed size, two panes: the parcel itself on the left, what came back on the right (which scrolls when there are many items).
export function CourierReceivedModal({ pickup, onClose, onDone }: { pickup: ReturnPickup; onClose: () => void; onDone: () => void }) {
  const { runWithApproval } = useAdminApproval();
  const { user } = useAuth();
  const waiting = pickup.items.filter((i) => i.status === "awaiting");
  const [service, setService] = useState(initialService(pickup));
  const [tracking, setTracking] = useState(pickup.tracking_number ?? "");
  const [noTracking, setNoTracking] = useState(!!pickup.sent_without_tracking);
  const [paid, setPaid] = useState("");
  // Good unless ticked otherwise, each with an optional reason.
  const [arrival, setArrival] = useState(() => startGood(waiting.map((i) => i.sale_item_id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsAdmin = !allGood(arrival) && user?.role !== "admin";

  async function confirm() {
    setError(null);
    if (!service.partnerCode) return setError("Say which service brought it.");
    if (service.partnerCode === OTHER && !service.serviceName.trim()) return setError("Name the delivery service.");
    if (!tracking.trim() && !noTracking) return setError("Enter the tracking number — or tick that it came without one.");
    setBusy(true);
    try {
      await runWithApproval((approval) =>
        api.put(
          `/return-pickups/${pickup.id}/received`,
          {
            ...serviceBody(service.partnerCode, service.serviceName),
            ...(tracking.trim() ? { tracking_number: tracking.trim() } : { no_tracking_ack: true }),
            pickup_charge: Number(paid) || 0,
            items: waiting.map((i) => ({
              sale_item_id: i.sale_item_id,
              condition: arrival.condition[i.sale_item_id] === "bad" ? "damaged" : "ok",
              ...(arrival.reason[i.sale_item_id]?.trim() ? { note: arrival.reason[i.sale_item_id].trim() } : {}),
            })),
          },
          { approval }
        )
      );
      onDone();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "That didn't work — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepModal
      title={`Parcel received — ${pickup.invoice}`}
      subtitle={`${pickup.customer_name ?? "Walk-in"} · it is on hand`}
      onClose={onClose}
      message={error}
      buttons={<Foot onClose={onClose} busy={busy} label="Mark Received" onConfirm={confirm} />}
      left={
        <>
          <ServicePicker partnerCode={service.partnerCode} serviceName={service.serviceName} onChange={setService} />
          <TrackingFields tracking={tracking} onTracking={setTracking} noTracking={noTracking} onNoTracking={setNoTracking} noTrackingLabel="It came without a tracking number" />
          <FormGroup>
            <Label>What we paid for the parcel (Rs.)</Label>
            <MoneyInput placeholder="0 if the customer paid" value={paid} onChange={setPaid} />
            <p className="mt-1 text-xs text-gray-400">Who finally bears it is decided in the inspection report.</p>
          </FormGroup>
        </>
      }
    >
      <ArrivalChoice
        items={waiting.map((i) => ({ id: i.sale_item_id, name: itemName(i), detail: money(i.amount), badNote: "Looked at again in the inspection report before anything is refunded." }))}
        state={arrival}
        onChange={setArrival}
      />
      <PasswordNote show={needsAdmin} />
    </StepModal>
  );
}

// ---------------------------------------------------------------- the inspection report
type Verdict = "clean" | "damaged" | "missing_parts" | "not_per_policy";
const VERDICTS: { key: Verdict; label: string; hint: string }[] = [
  { key: "clean", label: "Sellable", hint: "Clean — back on the shelf." },
  { key: "damaged", label: "Damaged", hint: "Taken back, but to the damaged stock — not resold." },
  { key: "missing_parts", label: "Missing parts", hint: "Taken back, but to the damaged stock — not resold." },
  { key: "not_per_policy", label: "Not per policy", hint: "Can't be taken back — no refund for it." },
];

// Reasons that are our doing (a defect, a wrong description) — the delivery charge starts as ours; anything else starts as the customer's.
const OUR_FAULT = /defect|damag|not as described|wrong item/i;

export function InspectionReportModal({ pickup, onClose, onDone }: { pickup: ReturnPickup; onClose: () => void; onDone: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const items = pickup.items.filter((i) => i.status === "awaiting");
  const arrived = items.filter((i) => i.arrival_condition !== "missing");
  const missing = items.filter((i) => i.arrival_condition === "missing");
  const [verdicts, setVerdicts] = useState<Record<number, Verdict>>(() =>
    Object.fromEntries(arrived.map((i) => [i.sale_item_id, (i.arrival_condition === "damaged" ? "damaged" : "clean") as Verdict]))
  );
  const [resolution, setResolution] = useState<"refund" | "store_credit">(pickup.resolution);
  const [share, setShare] = useState<string>(String(pickup.pickup_charge > 0 ? pickup.customer_share_pct : 0));
  const [proposed, setProposed] = useState<string | null>(null); // null = not changed: pay back everything the items come to
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);

  // The configured starting point for who pays the delivery charge, by the reason for the return.
  useEffect(() => {
    if (pickup.pickup_charge <= 0) return;
    api
      .get<{ our_fault: number; customer_choice: number }>("/app-settings/courier-return-split")
      .then((d) => setShare(String(OUR_FAULT.test(pickup.reason) ? d.our_fault : d.customer_choice)))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const takenBack = arrived.filter((i) => verdicts[i.sale_item_id] !== "not_per_policy");
  const itemsTotal = takenBack.reduce((sum, i) => sum + i.amount, 0);
  const sharePct = Number(share);
  const customerShare = Math.round((pickup.pickup_charge * sharePct) / 100);
  const heldBack = Math.min(customerShare, itemsTotal);
  const estimate = itemsTotal - heldBack;
  const proposedNum = proposed === null ? estimate : Number(proposed) || 0;
  const overMax = proposedNum > estimate + 0.5;
  const lessThanItems = proposed !== null && proposedNum < estimate - 0.5;
  const creditNoun = resolution === "refund" ? "refund" : "store credit";

  async function submit() {
    setError(null);
    if (overMax) return setError(`That's more than the items allow — at most ${money(estimate)}.`);
    setBusy(true);
    try {
      await api.put(`/return-pickups/${pickup.id}/report`, {
        items: arrived.map((i) => ({ sale_item_id: i.sale_item_id, verdict: verdicts[i.sale_item_id] })),
        resolution,
        ...(pickup.pickup_charge > 0 ? { customer_share_pct: sharePct } : {}),
        ...(proposed !== null && takenBack.length > 0 ? { proposed_amount: proposedNum } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "That didn't work — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepModal
      title={`Inspection report — ${pickup.invoice}`}
      subtitle={`${pickup.customer_name ?? "Walk-in"} · ${pickup.partner_name ?? "service not noted"}${pickup.tracking_number ? ` · tracking ${pickup.tracking_number}` : ""}`}
      onClose={onClose}
      message={error}
      buttons={
        <Foot
          onClose={onClose}
          busy={busy}
          label={isAdmin ? "Save and approve" : "Send for approval"}
          onConfirm={submit}
          middle={
            <Button onClick={() => setRejecting(true)} disabled={busy} title="The parcel is here but the return isn't accepted — nothing is refunded">
              Reject return
            </Button>
          }
        />
      }
      left={
        <>
          {pickup.report_status === "sent_back" && (
            <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              An admin sent the last report back{pickup.report_decision_reason ? `: ${pickup.report_decision_reason}` : ""}. Look again and send a new one.
            </p>
          )}

          <FormGroup>
            <Label>The customer is paid back as</Label>
            <div className="flex gap-2">
              {([
                ["refund", "Refund"],
                ["store_credit", "Store credit"],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  disabled={key === "store_credit" && !pickup.customer_id}
                  onClick={() => setResolution(key)}
                  className={`flex-1 rounded-xl border py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    resolution === key ? "border-black bg-black text-white" : "border-gray-200 bg-white text-gray-600 hover:border-gray-400"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </FormGroup>

          <FormGroup>
            <Label>Who pays the delivery charge?</Label>
            {pickup.pickup_charge > 0 ? (
              <>
                {/* The same three choices, worded the same way, as everywhere else the delivery charge is split. */}
                <div className="space-y-1.5">
                  {SHARE_OPTIONS.map((o) => (
                    <button
                      key={o.pct}
                      type="button"
                      onClick={() => setShare(String(o.pct))}
                      className={`flex w-full items-baseline justify-between gap-3 rounded-xl border bg-white px-3 py-1.5 text-left transition ${
                        sharePct === o.pct ? "border-black" : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      <span className="text-sm font-medium text-gray-900">{o.label}</span>
                      <span className="text-right text-[11px] leading-tight text-gray-500">{o.hint}</span>
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-gray-400">
                  We paid {money(pickup.pickup_charge)} for the parcel.{" "}
                  {sharePct === 0 ? "We carry all of it." : sharePct === 100 ? "It comes off what the customer is paid back." : `Half (${money(customerShare)}) comes off what the customer is paid back.`}
                </p>
              </>
            ) : (
              <p className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs text-gray-500">We paid nothing for the parcel, so there is nothing to share.</p>
            )}
          </FormGroup>

          <FormGroup>
            <Label>Proposed {creditNoun} (Rs.)</Label>
            <MoneyInput value={proposed ?? String(estimate)} onChange={setProposed} disabled={takenBack.length === 0} aria-label="Proposed amount" />
            <p className="mt-1 text-xs text-gray-400">
              Items {money(itemsTotal)}
              {heldBack > 0 ? ` less ${money(heldBack)} delivery share` : ""} = {money(estimate)}. Shown for an order paid in full — a refund is never more than was actually paid.
            </p>
            {lessThanItems && <p className="mt-1 text-xs text-gray-600">{money(estimate - proposedNum)} is held back (for damage, say) — say why in the note.</p>}
            {takenBack.length === 0 && <p className="mt-1 text-xs text-gray-400">Nothing is being taken back, so nothing is paid.</p>}
          </FormGroup>

          <FormGroup>
            <Label>Note (optional)</Label>
            <Input placeholder="What you saw — worn, a missing button, a tag gone…" value={note} onChange={(e) => setNote(e.target.value)} />
          </FormGroup>
          {!isAdmin && <p className="text-xs text-gray-500">An admin approves the delivery split and the amount together; nothing moves until then.</p>}
        </>
      }
    >
      <Label>What condition is each item in?</Label>
      <div className="space-y-2">
        {arrived.map((i) => {
          const chosen = verdicts[i.sale_item_id];
          const v = VERDICTS.find((x) => x.key === chosen);
          return (
            <div key={i.id} className="rounded-xl border border-gray-200 px-3.5 py-3">
              <p className="text-sm text-gray-900">
                {itemName(i)} <span className="text-xs text-gray-400">{money(i.amount)}</span>
              </p>
              {i.arrival_condition === "damaged" && (
                <p className="mt-0.5 text-xs text-gray-500">Marked Bad when it arrived{i.arrival_note ? ` — ${i.arrival_note}` : ""}</p>
              )}
              {/* Four ways it can be, as small pills — the filled one is the answer. */}
              <div className="mt-2.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Condition">
                {VERDICTS.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    role="radio"
                    aria-checked={chosen === o.key}
                    onClick={() => setVerdicts((cur) => ({ ...cur, [i.sale_item_id]: o.key }))}
                    className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition ${
                      chosen === o.key ? "border-black bg-black text-white" : "border-gray-200 bg-white text-gray-600 hover:border-gray-400"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              {v && <p className="mt-2 text-xs text-gray-400">{v.hint}</p>}
            </div>
          );
        })}
        {missing.map((i) => (
          <div key={i.id} className="rounded-xl border border-dashed border-gray-300 px-3.5 py-3 text-sm text-gray-500">
            {itemName(i)} <span className="text-xs text-gray-400">{money(i.amount)}</span> — marked missing when the parcel was opened. Nothing to refund for it.
          </div>
        ))}
      </div>
      {rejecting && <RejectReturnModal pickup={pickup} stacked onClose={() => setRejecting(false)} onDone={onDone} />}
    </StepModal>
  );
}

// ---------------------------------------------------------------- the return is not accepted
// The parcel is on hand and it isn't taken back — worn, outside the policy… — so nothing is refunded and no stock moves. It is an admin's
// decision (a cashier is asked for an admin's password); the reason is optional here and kept on the record.
export function RejectReturnModal({ pickup, onClose, onDone, stacked = false }: { pickup: ReturnPickup; onClose: () => void; onDone: () => void; stacked?: boolean }) {
  const { runWithApproval } = useAdminApproval();
  return (
    <CancelReasonModal
      title={`Reject this return — ${pickup.invoice}?`}
      confirmLabel="Yes, reject it"
      keepLabel="No, go back"
      busyLabel="Rejecting…"
      stacked={stacked}
      onClose={onClose}
      onConfirm={async (reason) => {
        await runWithApproval((approval) => api.put(`/return-pickups/${pickup.id}/report/reject`, reason ? { reason } : {}, { approval }));
        onDone();
      }}
    >
      Nothing is refunded and no stock moves — the customer's purchase stands. The parcel is still with you, so send it back to them or keep it as your policy says. A cashier needs an admin's
      password for this.
    </CancelReasonModal>
  );
}

// ---------------------------------------------------------------- the refund is paid
export function RefundPaidModal({ pickup, onClose, onDone }: { pickup: ReturnPickup; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState<"cash" | "bank_transfer">("bank_transfer");
  const [accountId, setAccountId] = useState("");
  const { accounts, defaultId, reload } = useCustomerBankAccounts(pickup.customer_id, method === "bank_transfer");
  useEffect(() => {
    if (method === "bank_transfer") setAccountId((cur) => cur || defaultId);
  }, [method, defaultId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const received = useMemo(() => pickup.items.filter((i) => i.status === "received"), [pickup.items]);

  async function confirm() {
    setError(null);
    if (method === "bank_transfer" && !accountId) return setError("Pick the customer's bank account — or add their bank details first.");
    setBusy(true);
    try {
      await api.put(`/return-pickups/${pickup.id}/refund`, { method, ...(method === "bank_transfer" ? { bank_account_id: parseInt(accountId, 10) } : {}) });
      onDone();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "That didn't work — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      size="md"
      title={`Refund — ${pickup.invoice}`}
      subtitle={`${pickup.customer_name ?? "Walk-in"} · approved ${pickup.report_decided_by_name ? `by ${pickup.report_decided_by_name}` : ""}`}
      onClose={onClose}
      footer={<Foot onClose={onClose} busy={busy} label={`Refund of ${money(pickup.refund_due)} paid`} onConfirm={confirm} />}
    >
      <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50/70 px-4 py-2.5 text-sm">
        {received.map((i) => (
          <div key={i.id} className="flex justify-between py-0.5 text-gray-600">
            <span>{itemName(i)}</span>
            <span className="tabular-nums">{money(i.refund_amount ?? 0)}</span>
          </div>
        ))}
        <div className="mt-1 flex justify-between border-t border-gray-200 pt-1.5 font-semibold text-gray-900">
          <span>To pay the customer</span>
          <span className="tabular-nums">{money(pickup.refund_due)}</span>
        </div>
      </div>
      <RefundMethodPicker
        method={method}
        onMethod={setMethod}
        accounts={accounts}
        accountId={accountId}
        onAccount={setAccountId}
        name={`courier-refund-account-${pickup.id}`}
        customerId={pickup.customer_id}
        onAdded={(a) => {
          reload();
          setAccountId(String(a.id));
        }}
      />
      <p className="text-xs text-gray-500">Make the payment first, then press the button — it records the money in the cash book and completes the return.</p>
      {error && <ErrorText>{error}</ErrorText>}
    </Modal>
  );
}

