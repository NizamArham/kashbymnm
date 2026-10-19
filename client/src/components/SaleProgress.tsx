import { Check, X } from "lucide-react";
import { Sale, SalePaymentEntry } from "../lib/types";
import { courierTrackingUrl } from "../lib/delivery";
import { whenLabel } from "../lib/whenLabel";
import { Card } from "./ui";

// Where an order stands, in one place: its delivery stages and whether it's paid, who has it and what is still to be collected,
// and the payments recorded against it. (The delivery pipeline and the payment live on different screens, so without this
// an order paid by hand could still look like cash to collect.)

type StepState = "done" | "current" | "todo" | "bad";
interface Step {
  key: string;
  label: string;
  note: string | null;
  state: StepState;
}

const money = (n: number) => `Rs. ${Math.round(n).toLocaleString()}`;
const METHOD: Record<string, string> = { cash: "Cash", bank_transfer: "Bank transfer", card: "Card", credit: "On credit" };

// "2026-10-18T18:43:00" / "2026-10-18 18:43:07" -> comparable text
const stamp = (v: string | null | undefined) => (v ? v.replace("T", " ") : null);

function steps(sale: Sale): Step[] | null {
  const status = sale.delivery_status;
  if (sale.sale_type !== "online" || !status) return null;
  const rank = ({ pending: 0, packed: 1, dispatched: 2, delivered: 3 } as Record<string, number>)[status] ?? 0;
  const paid = sale.payment_status === "paid";
  // When it became fully paid: the last payment the cash book has against the bill (a courier's settlement leaves none).
  const paidAt = paid ? stamp([...(sale.payments ?? [])].reverse().find((p) => p.type === "income")?.entry_date) : null;

  // The delivery stages, in the one order they can happen...
  const stages: (Step & { at: string | null })[] = [];
  if (status === "returned" || status === "cancelled") {
    stages.push({ key: status, label: status === "returned" ? "Returned" : "Cancelled", note: null, state: "bad", at: null });
  } else {
    const at = [null, stamp(sale.delivery_packed_at), stamp(sale.delivery_dispatched_at), stamp(sale.delivery_delivered_at)];
    ["Packed", "Dispatched", "Delivered"].forEach((label, i) =>
      stages.push({ key: label.toLowerCase(), label, note: rank >= i + 1 && at[i + 1] ? whenLabel(at[i + 1]!) : null, state: rank >= i + 1 ? "done" : "todo", at: rank >= i + 1 ? at[i + 1] : null })
    );
  }

  const payStep: Step = {
    key: "paid",
    label: "Paid",
    note: paid ? (paidAt ? whenLabel(paidAt) : null) : sale.payment_status === "partial" ? `${money(sale.amount_paid)} of ${money(sale.total)}` : sale.payment_method === "credit" ? "On credit" : null,
    state: paid ? "done" : "todo",
  };

  // ...and Paid goes where it happened. Paid up front it comes right after Ordered, before the parcel is even packed; paid on
  // delivery it comes last. Until it's paid it waits at the end. A payment with no time on it (a courier's settlement) can only
  // have come after the parcel was delivered, so it follows the last stage that has happened.
  let paidIndex = stages.length;
  if (paid) {
    const later = stages.findIndex((st) => st.state !== "todo" && st.at && paidAt && st.at > paidAt);
    if (later >= 0) paidIndex = later;
    else {
      const todoFrom = stages.findIndex((st) => st.state === "todo");
      paidIndex = todoFrom >= 0 ? todoFrom : stages.length;
    }
    if (status === "returned" || status === "cancelled") paidIndex = 0; // paid, then the parcel came back
  }
  const list: Step[] = [{ key: "ordered", label: "Ordered", note: whenLabel(sale.date.replace("T", " ")), state: "done" }, ...stages];
  // A parcel that came back (or was cancelled) with nothing ever paid on it has no payment step to show.
  const nothingToPay = (status === "returned" || status === "cancelled") && !(sale.amount_paid > 0);
  if (!nothingToPay) list.splice(1 + paidIndex, 0, payStep);

  // The first thing not yet done is where it is now (a returned / cancelled parcel has nothing further to do).
  if (status !== "returned" && status !== "cancelled") {
    const next = list.find((st) => st.state === "todo");
    if (next) next.state = "current";
  }
  return list;
}

function entryLabel(p: SalePaymentEntry): string {
  const n = p.notes ?? "";
  if (n.startsWith("COD collected")) return "COD collected";
  if (n.startsWith("Additional payment")) return "Extra payment";
  if (n.startsWith("Payment for invoice")) return "Paid at checkout";
  if (n.startsWith("Reversed payment")) return "Payment undone";
  return n || "Payment";
}

export default function SaleProgress({ sale }: { sale: Sale }) {
  const stages = steps(sale);
  const payments = sale.payments ?? [];
  const net = payments.reduce((sum, p) => sum + (p.type === "income" ? p.amount : -p.amount), 0);
  // Paid, but not through one of those entries: a courier's settlement, a payment on the customer's account — and store credit.
  const elsewhere = Math.round(sale.amount_paid - (sale.store_credit_applied ?? 0) - net);

  const partnerCode = sale.delivery_partner ?? null;
  const partner = sale.delivery_partner_name ?? partnerCode;
  const tracking = sale.delivery_tracking_number && sale.delivery_tracking_number !== sale.invoice ? sale.delivery_tracking_number : null;
  const trackingUrl = courierTrackingUrl(partnerCode, tracking);
  const unpaid = sale.payment_status !== "paid";
  const cod = sale.delivery_cod_amount ?? 0;
  const closed = sale.delivery_status === "returned" || sale.delivery_status === "cancelled";

  if (!stages && payments.length === 0 && elsewhere <= 0) return null;

  return (
    <Card className="mb-4">
      {stages && (
        // A row of stages on a wide screen; a short list down the page on a phone, where five names don't fit side by side.
        <ol className="flex flex-col gap-3 sm:flex-row sm:gap-0">
          {stages.map((s, i) => (
            <li key={s.key} className="relative flex items-start gap-3 sm:flex-1 sm:flex-col sm:items-center sm:gap-0 sm:text-center">
              {i > 0 && (
                <span
                  className={`absolute -top-3 left-[11px] h-3 w-0.5 sm:left-auto sm:right-1/2 sm:top-3 sm:h-0.5 sm:w-full ${s.state === "done" || s.state === "bad" ? "bg-black" : "bg-gray-200"}`}
                />
              )}
              <span
                className={`relative z-10 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full ${
                  s.state === "done" ? "bg-black text-white" : s.state === "bad" ? "bg-red-600 text-white" : s.state === "current" ? "border-2 border-black bg-white" : "border-2 border-gray-200 bg-white"
                }`}
              >
                {s.state === "done" ? <Check size={13} strokeWidth={3} /> : s.state === "bad" ? <X size={13} strokeWidth={3} /> : s.state === "current" ? <span className="h-2 w-2 rounded-full bg-black" /> : null}
              </span>
              <span className="flex min-h-6 flex-wrap items-center gap-x-2 sm:mt-1.5 sm:flex-col sm:gap-x-0">
                <span className={`text-sm ${s.state === "current" ? "font-semibold text-gray-900" : s.state === "todo" ? "text-gray-500" : s.state === "bad" ? "font-medium text-red-600" : "font-medium text-gray-900"}`}>{s.label}</span>
                {s.note && <span className="text-xs text-gray-500">{s.note}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className={`grid grid-cols-1 gap-x-6 gap-y-4 text-sm md:grid-cols-3 ${stages ? "mt-5 border-t border-gray-100 pt-4" : ""}`}>
        {stages && (
          <div>
            <p className="text-xs text-gray-500">Delivery</p>
            <p className="font-medium text-gray-900">{partner ?? "No courier yet"}</p>
            {tracking && (
              <p className="text-xs text-gray-500">
                Tracking{" "}
                {trackingUrl ? (
                  <a href={trackingUrl} target="_blank" rel="noreferrer" className="font-medium text-gray-900 underline decoration-dotted underline-offset-2">
                    {tracking}
                  </a>
                ) : (
                  <span className="font-medium text-gray-900">{tracking}</span>
                )}
              </p>
            )}
            {sale.delivery_waybill_number && <p className="text-xs text-gray-500">Waybill {sale.delivery_waybill_number}</p>}
          </div>
        )}

        {stages && (
          <div>
            <p className="text-xs text-gray-500">To collect on delivery</p>
            {closed ? (
              <p className="font-medium text-gray-900">Nothing — the parcel {sale.delivery_status === "returned" ? "came back" : "was cancelled"}</p>
            ) : cod > 0 && unpaid ? (
              <p className="font-semibold text-gray-900">{money(cod)}</p>
            ) : cod > 0 ? (
              <p className="font-medium text-gray-900">{money(cod)} <span className="text-xs font-normal text-gray-500">(delivery charge)</span></p>
            ) : (
              <p className="font-medium text-gray-900">{unpaid ? "Nothing — prepaid" : "Nothing — paid in full"}</p>
            )}
          </div>
        )}

        <div className={stages ? "" : "md:col-span-3"}>
          <p className="text-xs text-gray-500">
            Payments · {money(sale.amount_paid)} of {money(sale.total)}
          </p>
          {payments.length === 0 && elsewhere <= 0 ? (
            <p className="font-medium text-gray-900">Nothing paid yet</p>
          ) : (
            <ul className="space-y-0.5">
              {payments.map((p) => (
                <li key={p.id} className="flex flex-wrap items-baseline gap-x-2">
                  <span className={`font-medium ${p.type === "expense" ? "text-red-600" : "text-gray-900"}`}>
                    {p.type === "expense" ? "−" : ""}
                    {money(p.amount)}
                  </span>
                  <span className="text-gray-600">
                    {p.payment_method ? (METHOD[p.payment_method] ?? p.payment_method) : "—"} · {entryLabel(p)}
                  </span>
                  <span className="text-xs text-gray-500">{whenLabel(p.entry_date)}</span>
                </li>
              ))}
              {elsewhere > 0 && (
                <li className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-gray-900">{money(elsewhere)}</span>
                  <span className="text-gray-600">Settled another way</span>
                  <span className="text-xs text-gray-500">a courier settlement or a payment on the customer's account</span>
                </li>
              )}
              {(sale.store_credit_applied ?? 0) > 0 && (
                <li className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-gray-900">{money(sale.store_credit_applied!)}</span>
                  <span className="text-gray-600">Store credit</span>
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}
