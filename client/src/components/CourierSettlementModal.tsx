import { FormEvent, useEffect, useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { CourierReconciliationData } from "../lib/types";
import { useDeliveryPartners, partnerLabel } from "../lib/delivery";
import { addDaysIso, todayIso } from "../lib/dates";
import { Button, DatePicker, Dropdown, ErrorText, FormGroup, HelpHint, Input, Label, Modal, TabToggle, MoneyInput } from "./ui";
import { useToast } from "./Feedback";

const money = (n: number) => `Rs. ${n.toLocaleString()}`;

type ReceivedAs = "" | "cash" | "bank_transfer";

// CityPak and Fardar pay into the bank; our own rider hands the cash over. Any other
// courier has no habit to assume, so it starts empty and has to be chosen.
function defaultReceivedAs(partnerCode: string): ReceivedAs {
  if (partnerCode === "CPAK" || partnerCode === "FDR") return "bank_transfer";
  if (partnerCode === "D2D") return "cash";
  return "";
}

// Recording what a courier has paid over. The period starts the day after their last recorded settlement and runs to today, so the
// common case is just typing the amount — the dates are kept so they can be checked against the courier's own weekly report later.
export default function CourierSettlementModal({
  data,
  initialPartner,
  onClose,
  onSaved,
}: {
  data: CourierReconciliationData;
  initialPartner?: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const toast = useToast();
  const { partners } = useDeliveryPartners();
  const couriers = partners.filter((p) => p.kind === "courier");
  const [partner, setPartner] = useState(initialPartner ?? data.summary[0]?.courier_partner ?? "CPAK");
  const [weekStart, setWeekStart] = useState("");
  const [weekEnd, setWeekEnd] = useState("");
  const [amount, setAmount] = useState("");
  const [receivedAs, setReceivedAs] = useState<ReceivedAs>(defaultReceivedAs(partner));
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Changing the courier restarts the period and how it's usually paid — nothing else, so a choice made by hand stays.
  useEffect(() => {
    const priorEnds = data.settlements.filter((s) => s.courier_partner === partner).map((s) => s.week_end);
    const lastEnd = priorEnds.length > 0 ? priorEnds.reduce((latest, end) => (end > latest ? end : latest)) : null;
    setWeekStart(lastEnd ? addDaysIso(lastEnd, 1) : "");
    setWeekEnd(todayIso());
    setReceivedAs(defaultReceivedAs(partner));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partner]);

  const owed = data.summary.find((c) => c.courier_partner === partner)?.balance ?? 0;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!weekStart || !weekEnd || !amount) {
      setError("Week dates and amount received are required.");
      return;
    }
    if (!receivedAs) {
      setError("Choose how it was received — bank transfer or cash.");
      return;
    }
    setSaving(true);
    try {
      await api.post("/courier-reconciliation/settlements", {
        courier_partner: partner,
        week_start: weekStart,
        week_end: weekEnd,
        amount_received: Number(amount),
        payment_method: receivedAs,
        notes: notes.trim() || undefined,
      });
      toast.success(`Recorded ${money(Number(amount))} from ${partnerLabel(partner)}`);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to record settlement");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <Modal
        size="md"
        onClose={onClose}
        title="Record settlement"
        subtitle="What a courier has paid over to you."
        footer={
          <>
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving} className="whitespace-nowrap">
              {saving ? "Saving..." : "Record settlement"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormGroup>
            <Label>Courier partner</Label>
            <Dropdown value={partner} onChange={setPartner} options={couriers.map((p) => ({ value: p.code, label: p.name }))} />
            {owed !== 0 && (
              <p className="mt-1.5 text-xs text-gray-500">
                {owed > 0 ? `${partnerLabel(partner)} owes you ${money(owed)} right now.` : `You owe ${partnerLabel(partner)} ${money(-owed)} right now.`}
                {owed > 0 && (
                  <>
                    {" "}
                    <button type="button" onClick={() => setAmount(String(owed))} className="font-medium text-gray-900 underline decoration-dotted underline-offset-2">
                      Fill in {money(owed)}
                    </button>
                  </>
                )}
              </p>
            )}
          </FormGroup>
          <div className="grid grid-cols-2 gap-3">
            <FormGroup>
              <Label>
                Week starts
                <HelpHint text="Defaults to the day after your last recorded settlement for this courier, up to today — adjust it only if it needs to match their report exactly." />
              </Label>
              <DatePicker value={weekStart} onChange={setWeekStart} />
            </FormGroup>
            <FormGroup>
              <Label>Week ends</Label>
              <DatePicker value={weekEnd} onChange={setWeekEnd} />
            </FormGroup>
          </div>
          <FormGroup>
            <Label>Amount received (Rs.)</Label>
            <MoneyInput autoFocus value={amount} onChange={setAmount} placeholder="0" className="text-right" />
          </FormGroup>
          <FormGroup>
            <Label>
              Received as
              <HelpHint text="Where the money landed. The Cash Book uses it to tell the bank balance from cash in hand, so it has to be set." />
            </Label>
            <TabToggle<ReceivedAs>
              value={receivedAs}
              onChange={setReceivedAs}
              options={[
                { value: "bank_transfer", label: "Bank transfer" },
                { value: "cash", label: "Cash" },
              ]}
            />
          </FormGroup>
          <FormGroup>
            <Label>Notes</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormGroup>
          {error && <ErrorText>{error}</ErrorText>}
        </div>
      </Modal>
    </form>
  );
}
