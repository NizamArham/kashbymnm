// The three ways something comes back, and the stage each one is at — one set of names used on every screen, so the same thing is
// never called two different things.
//
//   In-Store Return   Pending → Completed          (approving it is what moves the stock and the money)
//   Courier Return    Pending → Approved → On the way back → Received → Inspection pending → Refund approved → Completed
//   Delivery Exchange Pending → Approved → Stock reserved → Dispatched → On the way back → Completed
//
// Declined and Cancelled end any of them. A request an admin recorded themselves skips Pending and says AUTO_APPROVED where the
// decision is shown.

import type { ApprovalState, ReturnPickup, ReturnRequest, SaleExchange } from "./types";

export const AUTO_APPROVED = "Auto-approved (recorded by admin)";

export type FlowKind = "in_store" | "courier" | "exchange";

export const FLOW_LABEL: Record<FlowKind, string> = {
  in_store: "In-Store Return",
  courier: "Courier Return",
  exchange: "Delivery Exchange",
};

export function inStoreStage(r: Pick<ReturnRequest, "status">): string {
  return r.status === "pending" ? "Pending" : r.status === "approved" ? "Completed" : "Declined";
}

// The chip for a courier return, from its stage. "Received" covers the parcel being on hand while its inspection and refund are still to do —
// courierNote() says which.
export function courierStage(p: Pick<ReturnPickup, "stage">): string {
  switch (p.stage) {
    case "requested":
      return "Pending";
    case "approved":
      return "Approved";
    case "on_the_way":
      return "On the way back";
    case "received":
      return "Received";
    case "report_pending":
      return "Inspection pending";
    case "refund_due":
      return "Refund approved";
    case "completed":
      return "Completed";
    case "declined":
      return "Declined";
    default:
      return "Cancelled";
  }
}

// What is waiting to happen next on a courier return, in a few words — shown under the chip.
export function courierNote(p: Pick<ReturnPickup, "stage" | "refund_due" | "report_status" | "report_decision_reason" | "sent_without_tracking">): string | null {
  switch (p.stage) {
    case "requested":
      return "Waiting for an admin to approve";
    case "approved":
      return "Waiting for the parcel";
    case "on_the_way":
      return p.sent_without_tracking ? "Sent without tracking — the risk is the customer's" : "On its way";
    case "received":
      return p.report_status === "sent_back" ? `Report sent back${p.report_decision_reason ? ` — ${p.report_decision_reason}` : ""}` : "Inspect it and file the report";
    case "report_pending":
      return "Inspection report waiting for an admin";
    case "refund_due":
      return `Refund Rs. ${Math.round(p.refund_due).toLocaleString()} to pay`;
    default:
      return null;
  }
}

// The request for a delivery exchange, before there is an order.
export function exchangeRequestStage(approval: ApprovalState | null | undefined): string {
  return approval === "pending" ? "Pending" : approval === "declined" ? "Declined" : "Approved";
}

// The exchange once its order exists, from the order's delivery and what has come back of the old items.
export function exchangeStage(x: Pick<SaleExchange, "status"> & { delivery_status?: string | null }): string {
  // Nothing came back (the exchange was cancelled, or none of the old items were handed back).
  if (x.status === "cancelled" || x.status === "not_returned") return "Cancelled";
  if (x.status !== "awaiting_pickup") return "Completed";
  switch (x.delivery_status) {
    case "dispatched":
      return "Dispatched";
    case "delivered":
      return "On the way back";
    case "returned":
    case "cancelled":
      return "Cancelled";
    default:
      return "Stock reserved";
  }
}

// "Approved by Name · 12/10" — or, for a request an admin recorded themselves, the auto-approved wording.
export function decidedLine(auto: boolean, status: "approved" | "declined", by: string | null, at: string | null): string {
  const when = at ? ` · ${at.slice(0, 10)}` : "";
  if (auto) return `${AUTO_APPROVED}${by ? ` — ${by}` : ""}${when}`;
  return `${status === "approved" ? "Approved" : "Declined"} by ${by ?? "an admin"}${when}`;
}
