import { useCallback, useEffect, useState } from "react";
import { Truck } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { ExchangeOnTheWay, ParcelComingBack, ReturnPickup } from "../lib/types";
import { ExchangeReceiveModal } from "./ExchangeNotice";
import { CourierReceivedModal, InspectionReportModal, RefundPaidModal, RejectReturnModal } from "./CourierReturnSteps";
import CancelReasonModal from "./CancelReasonModal";
import { RefundSlipMenu } from "./RefundSlipButton";
import { useAuth } from "../context/AuthContext";
import { FLOW_LABEL, courierNote, courierStage, exchangeStage } from "../lib/returnFlow";
import { useAdminApproval } from "./AdminApproval";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";
import { Button, Card, EmptyState, ErrorText, Input, RefLink, TabToggle } from "./ui";
import { PageLoader } from "./Loader";

const money = (n: number) => `Rs. ${Math.round(n).toLocaleString()}`;

type ListFilter = "recent" | "open" | "completed" | "cancelled" | "all";
type RowGroup = "open" | "completed" | "cancelled";
// How many finished (completed / cancelled) rows the default view keeps under the ones that still need doing.
const RECENT_FINISHED = 4;

// Who pays the delivery charge, in a few words.
export function shareSummary(p: Pick<ReturnPickup, "pickup_charge" | "customer_share_pct" | "customer_share">): string {
  if (p.pickup_charge <= 0) return "No delivery charge";
  if (p.customer_share_pct === 0) return `Delivery charge ${money(p.pickup_charge)} — we pay it`;
  if (p.customer_share_pct === 100) return `Delivery charge ${money(p.pickup_charge)} — the customer pays it (held back from what they're paid back)`;
  return `Delivery charge ${money(p.pickup_charge)} — customer pays ${p.customer_share_pct}% (${money(p.customer_share)}), we carry ${money(p.pickup_charge - p.customer_share)}`;
}

// What is on its way back to the shop, one compact row each — courier returns (with the button for whatever step they are at: Mark Received,
// inspection report or Reject, refund paid), the old items of delivery exchanges, and parcels the courier couldn't deliver. A return or exchange that is
// still to arrive has two buttons: Mark Received, and Cancel (which asks again, with an optional reason). Used on the Returns page and on Shipping.
export default function ReturnPickupList({ status = "open", onChanged }: { status?: "open" | "closed" | "all"; onChanged?: () => void }) {
  const { runWithApproval } = useAdminApproval();
  const { user } = useAuth();
  const [rows, setRows] = useState<ReturnPickup[] | null>(null);
  // The old items of exchanges by delivery are on their way back too — listed here beside the returns.
  const [exchanges, setExchanges] = useState<ExchangeOnTheWay[]>([]);
  // …and so are parcels the courier couldn't deliver: dispatched, then "on the way back" until they reach the shop.
  const [parcels, setParcels] = useState<ParcelComingBack[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The step dialog open for a courier return: parcel received / inspection report / refund paid.
  const [step, setStep] = useState<{ kind: "received" | "report" | "refund" | "reject"; pickup: ReturnPickup } | null>(null);
  const [receivingExchange, setReceivingExchange] = useState<ExchangeOnTheWay | null>(null);
  // Being cancelled: the second look, with an optional reason.
  const [cancelling, setCancelling] = useState<{ kind: "pickup"; p: ReturnPickup } | { kind: "exchange"; x: ExchangeOnTheWay } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(() => {
    Promise.all([
      api.get<ReturnPickup[]>(`/return-pickups?status=${status}`),
      api.get<ExchangeOnTheWay[]>(`/exchanges?status=${status}`),
      status === "closed" ? Promise.resolve([] as ParcelComingBack[]) : api.get<ParcelComingBack[]>("/deliveries/coming-back"),
    ])
      .then(([pickups, xs, ps]) => {
        setRows(pickups);
        // An exchange's old items are on their way back once its replacement has been delivered (the customer has it).
        setExchanges(status === "open" ? xs.filter((x) => x.delivery_status === "delivered") : xs);
        setParcels(ps);
      })
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Couldn't load the returns on the way"));
  }, [status]);
  useEffect(load, [load]);

  // Returns and exchanges together, newest first.
  const entries = [
    ...(rows ?? []).map((p) => ({ kind: "pickup" as const, at: p.created_at, p })),
    ...exchanges.map((x) => ({ kind: "exchange" as const, at: x.created_at, x })),
    ...parcels.map((d) => ({ kind: "parcel" as const, at: d.coming_back_at, d })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  // The parcel is on my hand: put it to Returned. For an exchange's replacement parcel that cancels the exchange and puts the new pieces
  // back in stock; the courier's return trip is charged as for any returned parcel.
  async function parcelReturned(d: ParcelComingBack) {
    const message = d.exchange
      ? `Is the parcel for ${d.invoice} on your hand? It's put to Returned: the exchange is cancelled (the customer keeps their old items) and the replacement pieces go back into stock.`
      : `Is the parcel for ${d.invoice} on your hand? It's put to Returned and leaves the normal pipeline.`;
    if (!confirm(message)) return;
    setBusyId(-d.id);
    setError(null);
    try {
      await runWithApproval((approval) => api.put(`/deliveries/${d.id}/return`, {}, { approval }));
      load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't put it to Returned");
    } finally {
      setBusyId(null);
    }
  }

  async function parcelRetry(d: ParcelComingBack) {
    setBusyId(-d.id);
    setError(null);
    try {
      await api.put(`/deliveries/${d.id}/coming-back/undo`, {});
      load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't undo it");
    } finally {
      setBusyId(null);
    }
  }

  // Calling off a courier return that hasn't arrived: nothing has moved, so nothing needs undoing and the items can be returned another way.
  async function cancelPickup(p: ReturnPickup, reason: string) {
    await runWithApproval((approval) => api.put(`/return-pickups/${p.id}/cancel`, reason ? { reason } : {}, { approval }));
    setCancelling(null);
    load();
    onChanged?.();
  }

  // Calling off an exchange whose replacement has been delivered: the old items aren't coming back, so the customer keeps them and the part
  // of the new order they were to cover stays unpaid. (It is the same as "nothing came back" — an admin's password for a cashier.)
  async function cancelExchange(x: ExchangeOnTheWay, reason: string) {
    const waiting = x.items.filter((i) => i.status === "awaiting");
    await runWithApproval((approval) =>
      api.put(
        `/exchanges/${x.id}/receive`,
        { items: waiting.map((i) => ({ sale_item_id: i.old_sale_item_id, outcome: "not_returned" })), note: `Cancelled — the old items aren't coming back${reason ? `: ${reason}` : ""}` },
        { approval }
      )
    );
    setCancelling(null);
    load();
    onChanged?.();
  }

  // One compact row per thing on its way back, like the rows of the shipping pipeline — what it is, who, how it's travelling and what
  // to do. The detail (items, charges, who pays) is on the invoice: click it.
  const tableRows = entries.map((entry) => {
    if (entry.kind === "parcel") {
      const d = entry.d;
      return {
        key: `d${d.id}`,
        saleId: d.sale_id,
        invoice: d.invoice,
        type: "Couldn't deliver",
        note: `${d.items.length} item${d.items.length === 1 ? "" : "s"}${d.exchange ? " · exchange parcel" : ""}`,
        customer: d.customer_name ?? "Walk-in",
        via: d.partner_name ?? "Courier",
        at: d.coming_back_at,
        statusLabel: "On the way back",
        statusExtra: null,
        actions: (
          <>
            <Button size="sm" variant="primary" onClick={() => parcelReturned(d)} disabled={busyId === -d.id}>
              Mark Received
            </Button>
            <Button size="sm" onClick={() => parcelRetry(d)} disabled={busyId === -d.id}>
              Courier will retry
            </Button>
          </>
        ),
      };
    }
    if (entry.kind === "exchange") {
      const x = entry.x;
      const open = x.status === "awaiting_pickup";
      return {
        key: `x${x.id}`,
        saleId: x.new_sale_id,
        invoice: x.new_invoice,
        type: FLOW_LABEL.exchange,
        note: `${x.items.length} old item${x.items.length === 1 ? "" : "s"}${x.return_service ? ` · via ${x.return_service}` : ""}`,
        customer: x.customer_name ?? "Walk-in",
        via: x.return_service ?? x.partner_name ?? "—",
        at: x.created_at,
        statusLabel: exchangeStage(x),
        statusExtra: null,
        actions: open ? (
          <>
            <Button size="sm" variant="primary" onClick={() => setReceivingExchange(x)}>
              Mark Received
            </Button>
            <Button size="sm" onClick={() => setCancelling({ kind: "exchange", x })}>
              Cancel
            </Button>
          </>
        ) : null,
      };
    }
    const p = entry.p;
    // Still to arrive: Mark Received, and Cancel.
    const toArrive = p.stage === "approved" || p.stage === "on_the_way";
    return {
      key: `p${p.id}`,
      saleId: p.sale_id,
      invoice: p.invoice,
      type: FLOW_LABEL.courier,
      note: courierNote(p) ?? `${p.items.length} item${p.items.length === 1 ? "" : "s"} · ${p.resolution === "refund" ? "refund" : "store credit"}`,
      customer: p.customer_name ?? "Walk-in",
      via: p.partner_name ?? "—",
      at: p.created_at,
      statusLabel: courierStage(p),
      // A completed return whose refund was paid: the "Refund payment done" slip, to print.
      statusExtra: p.stage === "completed" && p.refunded_at ? <RefundSlipMenu slipKey={`pickup-${p.id}`} /> : null,
      actions: (
        <>
          {toArrive && (
            <>
              <Button size="sm" variant="primary" onClick={() => setStep({ kind: "received", pickup: p })}>
                Mark Received
              </Button>
              <Button size="sm" onClick={() => setCancelling({ kind: "pickup", p })}>
                Cancel
              </Button>
            </>
          )}
          {p.stage === "received" && (
            <>
              <Button size="sm" variant="primary" onClick={() => setStep({ kind: "report", pickup: p })}>
                Inspection report
              </Button>
              <Button size="sm" onClick={() => setStep({ kind: "reject", pickup: p })}>
                Reject
              </Button>
            </>
          )}
          {p.stage === "refund_due" && (
            <Button size="sm" variant="primary" onClick={() => setStep({ kind: "refund", pickup: p })}>
              Refund paid
            </Button>
          )}
          {p.stage === "report_pending" && <span className="text-xs text-gray-400">{user?.role === "admin" ? "Approve it in Returns ▸ To approve" : "An admin approves it"}</span>}
        </>
      ),
    };
  });

  if (!rows && !error) return <PageLoader />;
  return (
    <div>
      {error && <ErrorText>{error}</ErrorText>}
      {rows && tableRows.length === 0 && (
        <EmptyState
          icon={Truck}
          title={status === "open" ? "Nothing on its way back" : "No courier returns or delivery exchanges yet"}
          subtitle="Parcels the courier couldn't deliver, customers' returns and exchange old items show here until they reach you."
        />
      )}
      {tableRows.length > 0 && (
        <Card className="overflow-hidden p-0">
          <div className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)_6.5rem_minmax(0,1.6fr)] gap-3 border-b border-gray-100 bg-gray-50/70 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-gray-400 lg:grid">
            <span>Invoice</span>
            <span>What</span>
            <span>Customer</span>
            <span>Coming back with</span>
            <span>Since</span>
            <span>Status</span>
          </div>
          <div className="divide-y divide-gray-100">
            {tableRows.map((r) => (
              <div
                key={r.key}
                className="grid grid-cols-2 items-center gap-x-3 gap-y-1.5 px-4 py-3 text-sm lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)_6.5rem_minmax(0,1.6fr)]"
              >
                <div className="min-w-0">
                  <RefLink to={`/sales/${r.saleId}`} className="font-medium text-gray-900 underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500">
                    {r.invoice}
                  </RefLink>
                  <p className="truncate text-xs text-gray-400">{r.note}</p>
                </div>
                <span className="text-gray-700">{r.type}</span>
                <span className="truncate text-gray-700">{r.customer}</span>
                <span className="truncate text-gray-600">{r.via}</span>
                <span className="text-xs text-gray-400">{r.at.slice(0, 10)}</span>
                {/* The status on its own line, the buttons together on the next. */}
                <div className="col-span-2 lg:col-span-1">
                  <p className="flex items-center justify-between gap-2 text-xs text-gray-500">
                    {r.statusLabel}
                    {/* The row's three-dot menu, at its far end. */}
                    {r.statusExtra}
                  </p>
                  {r.actions && <div className="mt-1.5 flex flex-wrap items-center gap-2">{r.actions}</div>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
      {step &&
        (() => {
          const done = () => {
            setStep(null);
            load();
            onChanged?.();
          };
          const close = () => setStep(null);
          if (step.kind === "received") return <CourierReceivedModal pickup={step.pickup} onClose={close} onDone={done} />;
          if (step.kind === "report") return <InspectionReportModal pickup={step.pickup} onClose={close} onDone={done} />;
          if (step.kind === "reject") return <RejectReturnModal pickup={step.pickup} onClose={close} onDone={done} />;
          return <RefundPaidModal pickup={step.pickup} onClose={close} onDone={done} />;
        })()}
      {receivingExchange && (
        <ExchangeReceiveModal
          exchange={receivingExchange}
          invoice={receivingExchange.new_invoice}
          customer={receivingExchange.customer_name}
          onClose={() => setReceivingExchange(null)}
          onDone={() => {
            setReceivingExchange(null);
            load();
            onChanged?.();
          }}
        />
      )}
      {cancelling?.kind === "pickup" && (
        <CancelReasonModal
          title={`Cancel the courier return — ${cancelling.p.invoice}?`}
          onClose={() => setCancelling(null)}
          onConfirm={(reason) => cancelPickup(cancelling.p, reason)}
        >
          Nothing has moved, so nothing needs undoing — the items can be returned another way. If the parcel never arrives, that is the customer's end.
        </CancelReasonModal>
      )}
      {cancelling?.kind === "exchange" && (
        <CancelReasonModal
          title={`Cancel the exchange — ${cancelling.x.new_invoice}?`}
          confirmLabel="Yes, cancel the exchange"
          onClose={() => setCancelling(null)}
          onConfirm={(reason) => cancelExchange(cancelling.x, reason)}
        >
          The old items aren't coming back, so the customer keeps them as well as the new ones. The {money(cancelling.x.items.filter((i) => i.status === "awaiting").reduce((sum, i) => sum + i.applied_share, 0))} of
          the new order they were meant to cover stays unpaid on {cancelling.x.new_invoice}. A cashier needs an admin's password for this.
        </CancelReasonModal>
      )}
    </div>
  );
}
