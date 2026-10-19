import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { api } from "../lib/api";
import { ReturnApprovals, ReturnPickup, ReturnRequest } from "../lib/types";
import { FLOW_LABEL, courierStage } from "../lib/returnFlow";
import { useAdminApproval } from "./AdminApproval";
import DecisionBox from "./DecisionBox";
import ReturnRequestPanel, { NoReturnsWarning } from "./ReturnRequestPanel";
import { shareSummary } from "./ReturnsOnTheWay";
import { Badge, Card, EmptyState, EmptyActions, RefLink } from "./ui";
import { formatDate, formatDateTime } from "../lib/dates";

const money = (n: number) => `Rs. ${Math.round(n).toLocaleString()}`;
const variant = (size: string | null, color: string | null) => [size, color].filter(Boolean).join(" / ");
const nameOf = (i: { title: string | null; size: string | null; color: string | null }) =>
  `${i.title ?? "Item"}${variant(i.size, i.color) ? ` · ${variant(i.size, i.color)}` : ""}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Exchange = ReturnApprovals["exchanges"][number];

type Entry =
  | { kind: "in_store"; key: string; at: string; r: ReturnRequest }
  | { kind: "courier"; key: string; at: string; p: ReturnPickup }
  // The inspection report of a courier return whose parcel has arrived — approved or sent back by an admin.
  | { kind: "courier_report"; key: string; at: string; p: ReturnPickup }
  | { kind: "exchange"; key: string; at: string; s: Exchange };

// Everything waiting for an admin's yes, in the order it was asked — an in-store return, a courier return and a delivery exchange side by
// side, each tagged with what it is. Click a row to see it in full and to approve or decline; nothing moves (no stock, no money) until then.
export default function ReturnApprovalList({ approvals, onChanged, emptyActions }: { approvals: ReturnApprovals; onChanged: () => void; emptyActions?: EmptyActions }) {
  const [open, setOpen] = useState<string | null>(null);

  const entries: Entry[] = [
    ...approvals.in_store.map((r) => ({ kind: "in_store" as const, key: `r${r.id}`, at: r.requested_at, r })),
    ...approvals.courier.map((p) => ({ kind: "courier" as const, key: `c${p.id}`, at: p.created_at, p })),
    ...(approvals.courier_reports ?? []).map((p) => ({ kind: "courier_report" as const, key: `cr${p.id}`, at: p.report_at ?? p.created_at, p })),
    ...approvals.exchanges.map((s) => ({ kind: "exchange" as const, key: `x${s.id}`, at: s.date, s })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title="Nothing waiting for approval"
        subtitle="Returns and exchanges that staff ask for show up here until an admin decides."
        actions={emptyActions}
      />
    );
  }

  const done = () => {
    setOpen(null);
    onChanged();
  };

  return (
    <Card className="overflow-clip p-0">
      <div className="hidden grid-cols-[9.5rem_minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,1fr)_6rem_auto] gap-x-3 border-b border-gray-100 bg-gray-50/70 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-gray-400 lg:grid">
        <span>Type</span>
        <span>Invoice</span>
        <span>Customer</span>
        <span>Asked by</span>
        <span>Date</span>
        <span className="justify-self-end">Status</span>
      </div>
      <div className="divide-y divide-gray-100">
        {entries.map((e) => {
          const view = describe(e);
          const isOpen = open === e.key;
          return (
            <div key={e.key}>
              <div
                onClick={() => setOpen(isOpen ? null : e.key)}
                className={`grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 text-sm hover:bg-gray-50 lg:grid-cols-[9.5rem_minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,1fr)_6rem_auto] ${isOpen ? "bg-gray-50" : ""}`}
              >
                <span className="col-span-2 lg:col-span-1">
                  <Badge label={FLOW_LABEL[e.kind === "courier_report" ? "courier" : e.kind]} />
                </span>
                <div className="min-w-0">
                  <RefLink
                    to={`/sales/${view.saleId}`}
                    className="font-medium text-gray-900 underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500"
                  >
                    {view.invoice}
                  </RefLink>
                  <p className="truncate text-xs text-gray-400">
                    {view.note}
                    {view.noReturns && <span className="font-medium text-amber-600"> · Final Sale</span>}
                  </p>
                </div>
                <span className="hidden truncate text-gray-700 lg:block">{view.customer}</span>
                <span className="hidden truncate text-gray-500 lg:block">{view.askedBy ?? "—"}</span>
                <span className="hidden text-xs text-gray-400 lg:block">{formatDate(e.at)}</span>
                <span className="flex items-center justify-end gap-2">
                  <span className="text-xs text-gray-500">{e.kind === "courier_report" ? courierStage(e.p) : "Pending"}</span>
                  {isOpen ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
                </span>
              </div>
              {isOpen && (
                <div className="border-t border-gray-100 bg-gray-50/70 px-5 py-4">
                  <div className="max-w-2xl">
                    {e.kind === "in_store" && <ReturnRequestPanel r={e.r} onChanged={done} />}
                    {e.kind === "courier" && <CourierReturnPanel p={e.p} onChanged={done} />}
                    {e.kind === "courier_report" && <CourierReportPanel p={e.p} onChanged={done} />}
                    {e.kind === "exchange" && <ExchangeRequestPanel s={e.s} onChanged={done} />}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// The one-line version of a request, whatever kind it is.
function describe(e: Entry) {
  if (e.kind === "in_store") {
    const r = e.r;
    return {
      saleId: r.sale_id,
      invoice: r.invoice,
      note: r.product_title,
      customer: r.customer_name ?? (r.deleted_customer_snapshot ? `[Deleted: ${r.deleted_customer_snapshot}]` : "Walk-in"),
      askedBy: r.requested_by_name,
      noReturns: r.is_admin_override === 1,
    };
  }
  if (e.kind === "courier" || e.kind === "courier_report") {
    const p = e.p;
    const report = e.kind === "courier_report";
    return {
      saleId: p.sale_id,
      invoice: p.invoice,
      note: report
        ? `Inspection report · ${plural(p.items.length, "item")} · ${p.partner_name ?? "service not noted"}`
        : `${plural(p.items.length, "item")} · ${p.resolution === "refund" ? "refund" : "store credit"}`,
      customer: p.customer_name ?? "Walk-in",
      askedBy: report ? p.report_by_name : p.requested_by_name,
      noReturns: p.items.some((i) => i.allow_returns === 0),
    };
  }
  const s = e.s;
  const q = s.exchange_quote;
  return {
    saleId: s.id,
    invoice: s.invoice,
    note: `${plural(q?.old_items.length ?? 0, "old item")} back · ${plural(s.new_items.length, "new piece")} out`,
    customer: s.customer_name ?? "Customer",
    askedBy: s.salesperson ?? null,
    noReturns: !!q?.old_items.some((i) => i.allow_returns === 0),
  };
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-gray-400">{label}</p>
      <p className="text-sm text-gray-900">{children}</p>
    </div>
  );
}

function CourierReturnPanel({ p, onChanged }: { p: ReturnPickup; onChanged: () => void }) {
  const { runWithApproval } = useAdminApproval();
  const noReturns = p.items.filter((i) => i.allow_returns === 0);

  async function approve(reason: string) {
    await runWithApproval((approval) => api.put(`/return-pickups/${p.id}/approve`, { override_reason: reason || undefined }, { approval }));
    onChanged();
  }
  async function decline(reason: string) {
    await runWithApproval((approval) => api.put(`/return-pickups/${p.id}/decline`, { reason }, { approval }));
    onChanged();
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1 text-xs text-gray-400">Being sent back</p>
        <ul className="space-y-0.5 text-sm">
          {p.items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-gray-900">{nameOf(i)}</span>
              <span className="text-xs text-gray-400">{money(i.amount)}</span>
              {i.allow_returns === 0 && <span className="text-xs font-medium text-amber-600">Final Sale</span>}
            </li>
          ))}
        </ul>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Fact label="Customer would like">{p.resolution === "refund" ? "A refund" : "Store credit"}</Fact>
        <Fact label="Asked by">{p.requested_by_name ?? "—"}</Fact>
      </div>
      <p className="text-xs text-gray-400">Approving only means "yes, send it back" — its condition isn't known yet. It gets inspected when it arrives.</p>
      <div>
        <p className="mb-1 text-xs text-gray-400">Reason for return</p>
        <p className="text-sm text-gray-900">{p.reason}</p>
      </div>
      {noReturns.length > 0 && <NoReturnsWarning>{`${noReturns.map((i) => i.title ?? "An item").join(", ")} — Final Sale. Approving needs an explicit override reason.`}</NoReturnsWarning>}
      <div className="border-t border-gray-200 pt-4">
        <DecisionBox reasonRequired={noReturns.length > 0} onApprove={approve} onDecline={decline} />
      </div>
    </div>
  );
}

const VERDICT_TEXT: Record<string, string> = {
  clean: "Sellable",
  damaged: "Damaged",
  missing_parts: "Missing parts",
  not_per_policy: "Not per policy",
  not_received: "Missing from the parcel",
};

// The inspection report of a courier return that has arrived: what each item turned out to be, who pays the delivery, and what is to be paid
// back — approved (stock goes back, a refund becomes due) or sent back for another look. The split and the amount are decided together.
function CourierReportPanel({ p, onChanged }: { p: ReturnPickup; onChanged: () => void }) {
  const { runWithApproval } = useAdminApproval();
  const arrived = p.items.filter((i) => i.status === "awaiting");
  const taken = arrived.filter((i) => i.verdict === "clean" || i.verdict === "damaged" || i.verdict === "missing_parts");
  const itemsTotal = taken.reduce((sum, i) => sum + i.amount, 0);
  const share = Math.round((p.pickup_charge * p.customer_share_pct) / 100);
  const heldBack = Math.min(share, itemsTotal);
  const estimate = itemsTotal - heldBack;
  const payBack = p.report_proposed ?? estimate;

  async function approve(reason: string) {
    await runWithApproval((approval) => api.put(`/return-pickups/${p.id}/report/approve`, { reason: reason || undefined }, { approval }));
    onChanged();
  }
  async function sendBack(reason: string) {
    await runWithApproval((approval) => api.put(`/return-pickups/${p.id}/report/send-back`, { reason }, { approval }));
    onChanged();
  }
  async function reject(reason: string) {
    await runWithApproval((approval) => api.put(`/return-pickups/${p.id}/report/reject`, { reason }, { approval }));
    onChanged();
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1 text-xs text-gray-400">What the inspection found</p>
        <ul className="space-y-0.5 text-sm">
          {arrived.map((i) => (
            <li key={i.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-gray-900">{nameOf(i)}</span>
              <span className="text-xs text-gray-400">{money(i.amount)}</span>
              <span className="text-xs font-medium text-gray-700">{VERDICT_TEXT[i.verdict ?? (i.arrival_condition === "missing" ? "not_received" : "clean")]}</span>
              {i.arrival_condition === "damaged" && <span className="text-xs text-amber-700">marked Bad when it arrived{i.arrival_note ? ` — ${i.arrival_note}` : ""}</span>}
              {i.allow_returns === 0 && <span className="text-xs font-medium text-amber-600">Final Sale</span>}
            </li>
          ))}
        </ul>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Fact label="Came with">
          {p.partner_name ?? "—"}
          {p.tracking_number ? ` · ${p.tracking_number}` : p.sent_without_tracking ? " · no tracking (risk accepted)" : ""}
        </Fact>
        <Fact label="We paid for the parcel">{p.pickup_charge > 0 ? money(p.pickup_charge) : "Nothing"}</Fact>
        <Fact label="Who pays the delivery">
          {p.pickup_charge <= 0 ? "Nothing to share" : p.customer_share_pct === 0 ? "We pay" : p.customer_share_pct === 100 ? `Customer pays (${money(share)} comes off)` : `Half and half (${money(share)} comes off)`}
        </Fact>
        <Fact label={p.resolution === "refund" ? "Proposed refund" : "Proposed store credit"}>
          <span className="font-semibold">{money(payBack)}</span>
          {p.report_proposed !== null && p.report_proposed < estimate - 0.5 && <span className="text-xs text-gray-400"> (items {money(estimate)} — {money(estimate - p.report_proposed)} held back)</span>}
        </Fact>
        <Fact label="Report by">
          {p.report_by_name ?? "—"}
          {p.report_at ? ` · ${formatDate(p.report_at)}` : ""}
        </Fact>
        <Fact label="Received by">
          {p.received_by_name ?? "—"}
          {p.received_at ? ` · ${formatDate(p.received_at)}` : ""}
        </Fact>
      </div>
      {p.report_note && (
        <div>
          <p className="mb-1 text-xs text-gray-400">Note</p>
          <p className="text-sm text-gray-900">{p.report_note}</p>
        </div>
      )}
      <div>
        <p className="mb-1 text-xs text-gray-400">Reason for return</p>
        <p className="text-sm text-gray-900">{p.reason}</p>
      </div>
      <div className="border-t border-gray-200 pt-4">
        <DecisionBox
          approveLabel="Approve report"
          declineLabel="Send back"
          rejectLabel="Reject return"
          rejectNote="The parcel is here but the return isn't accepted. Nothing is refunded and no stock moves; the parcel is still with the shop."
          onApprove={approve}
          onDecline={sendBack}
          onReject={reject}
        />
      </div>
    </div>
  );
}

// Approve or decline a delivery exchange request (the payment request it is saved as). Also used on the request's own page.
export function ExchangeApprovalBox({ saleId, noReturns, onChanged }: { saleId: number; noReturns: boolean; onChanged: () => void }) {
  const { runWithApproval } = useAdminApproval();
  async function decide(decision: "approve" | "decline", reason: string) {
    await runWithApproval((approval) => api.put(`/sales/${saleId}/approval`, { decision, reason: reason || undefined }, { approval }));
    onChanged();
  }
  return <DecisionBox reasonRequired={noReturns} onApprove={(reason) => decide("approve", reason)} onDecline={(reason) => decide("decline", reason)} />;
}

function ExchangeRequestPanel({ s, onChanged }: { s: Exchange; onChanged: () => void }) {
  const q = s.exchange_quote;
  const noReturns = (q?.old_items ?? []).filter((i) => i.allow_returns === 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-xs text-gray-400">Old items coming back</p>
          <ul className="space-y-0.5 text-sm">
            {(q?.old_items ?? []).map((i) => (
              <li key={i.sale_item_id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-gray-900">{nameOf(i)}</span>
                <span className="text-xs text-gray-400">
                  {i.old_invoice} · {money(i.unit_price)}
                </span>
                {i.allow_returns === 0 && <span className="text-xs font-medium text-amber-600">Final Sale</span>}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mb-1 text-xs text-gray-400">New items going out</p>
          <ul className="space-y-0.5 text-sm">
            {s.new_items.map((i, idx) => (
              <li key={idx} className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-gray-900">{nameOf(i)}</span>
                <span className="text-xs text-gray-400">{money(i.unit_price)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {q && (
        <div className="grid grid-cols-2 gap-3">
          <Fact label="Delivered by">
            {q.partner_name}
            {q.package_weight_kg ? ` · ${q.package_weight_kg} kg` : ""}
          </Fact>
          <Fact label="Old items come back">{q.return_service ? `separately, with ${q.return_service}` : "with the delivery"}</Fact>
          <Fact label="Return charge">
            {shareSummary({ pickup_charge: q.pickup_charge, customer_share_pct: q.customer_share_pct, customer_share: q.pickup_collected })}
          </Fact>
          <Fact label="Customer pays">
            {money(q.amount_to_pay)} <span className="text-xs text-gray-400">(after {money(q.applied_amount)} for the old items)</span>
          </Fact>
          <Fact label="Asked by">{s.salesperson ?? "—"}</Fact>
          <Fact label="Pieces held">{s.hold_until ? `until ${formatDateTime(s.hold_until)}` : "not held"}</Fact>
        </div>
      )}
      {noReturns.length > 0 && <NoReturnsWarning>{`${noReturns.map((i) => i.title ?? "An item").join(", ")} — Final Sale. Approving needs an explicit override reason.`}</NoReturnsWarning>}
      <div className="border-t border-gray-200 pt-4">
        <ExchangeApprovalBox saleId={s.id} noReturns={noReturns.length > 0} onChanged={onChanged} />
      </div>
    </div>
  );
}
