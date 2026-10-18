import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { api } from "../lib/api";
import { ReturnRequest } from "../lib/types";
import { decidedLine } from "../lib/returnFlow";
import { useAdminApproval } from "./AdminApproval";
import DecisionBox from "./DecisionBox";
import RefundMethodPicker, { useCustomerBankAccounts } from "./RefundMethodPicker";
import { RefLink } from "./ui";

// One in-store return request in full: what it is, who asked and why, how it was decided — and, while it is still pending, the form to
// approve or decline it. Shared by the Returns list (click a row) and the To approve list.
export default function ReturnRequestPanel({ r, onChanged }: { r: ReturnRequest; onChanged: () => void }) {
  // A cashier can fill in the decision too; confirming it asks for an admin's password, and the return is recorded as decided by that admin.
  const { runWithApproval } = useAdminApproval();
  const pending = r.status === "pending";
  const [method, setMethod] = useState<"cash" | "bank_transfer">("cash");
  const [accountId, setAccountId] = useState("");
  const { accounts, defaultId } = useCustomerBankAccounts(r.customer_id, pending && r.resolution === "refund" && method === "bank_transfer");
  useEffect(() => {
    if (method === "bank_transfer") setAccountId((cur) => cur || defaultId);
  }, [method, defaultId]);

  async function approve(reason: string) {
    if (r.resolution === "refund" && method === "bank_transfer" && !accountId) {
      throw new Error("Select which of the customer's bank accounts to refund into");
    }
    const decision = {
      decision_reason: reason || undefined,
      payment_method: r.resolution === "refund" ? method : undefined,
      bank_account_id: r.resolution === "refund" && method === "bank_transfer" ? parseInt(accountId, 10) : undefined,
    };
    await runWithApproval((approval) => api.put(`/returns/requests/${r.id}/approve`, decision, { approval }));
    onChanged();
  }

  async function decline(reason: string) {
    await runWithApproval((approval) => api.put(`/returns/requests/${r.id}/decline`, { decision_reason: reason }, { approval }));
    onChanged();
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1 text-xs text-gray-400">Item</p>
        <p className="text-sm font-medium text-gray-900">
          {r.product_id ? <RefLink to={`/products/${r.product_id}`}>{r.product_title}</RefLink> : r.product_title} ({r.sku})
          {(r.color || r.size) && <span className="font-normal text-gray-400"> · {[r.color, r.size].filter(Boolean).join(" / ")}</span>}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <p className="text-xs text-gray-400">Condition</p>
          <p className="capitalize text-gray-900">{r.condition}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Resolution</p>
          <p className="capitalize text-gray-900">{r.resolution.replace(/_/g, " ")}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Requested by</p>
          <p className="text-gray-900">{r.requested_by_name ?? "—"}</p>
        </div>
      </div>

      <div>
        <p className="mb-1 text-xs text-gray-400">Reason for return</p>
        <p className="text-sm text-gray-900">{r.reason}</p>
      </div>

      {r.is_admin_override === 1 && pending && <NoReturnsWarning />}

      {!pending && (
        <div className="grid grid-cols-2 gap-3 border-t border-gray-200 pt-3 text-sm">
          <div>
            <p className="text-xs text-gray-400">Decision</p>
            <p className="text-gray-900">{decidedLine(r.auto_approved === 1, r.status as "approved" | "declined", r.decided_by_name, r.decided_at)}</p>
          </div>
          {r.decision_reason && (
            <div>
              <p className="text-xs text-gray-400">{r.status === "approved" ? "Approval reason" : "Decline reason"}</p>
              <p className="text-gray-900">{r.decision_reason}</p>
            </div>
          )}
          {r.status === "approved" && r.resolution === "refund" && (
            <div>
              <p className="text-xs text-gray-400">Refund amount</p>
              <p className="font-semibold text-gray-900">Rs. {(r.refund_amount ?? 0).toLocaleString()}</p>
            </div>
          )}
          {r.status === "approved" && r.resolution === "store_credit_exchange" && (
            <div>
              <p className="text-xs text-gray-400">Store credit granted</p>
              <p className="font-semibold text-gray-900">
                Rs. {r.unit_price.toLocaleString()}
                {r.credit_expiry_days ? ` — expires in ${r.credit_expiry_days} days` : ""}
              </p>
            </div>
          )}
        </div>
      )}

      {pending && (
        <div className="border-t border-gray-200 pt-4">
          <DecisionBox
            reasonRequired={r.is_admin_override === 1}
            approveExtras={
              r.resolution === "refund" ? (
                <RefundMethodPicker method={method} onMethod={setMethod} accounts={accounts} accountId={accountId} onAccount={setAccountId} name={`refund-account-${r.id}`} />
              ) : undefined
            }
            onApprove={approve}
            onDecline={decline}
          />
        </div>
      )}
    </div>
  );
}

// A product marked "no returns": taking it back is allowed only on purpose, with the reason written down.
export function NoReturnsWarning({ children }: { children?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
      <AlertTriangle size={12} className="mt-0.5 flex-shrink-0 text-amber-600" />
      <p className="text-xs text-amber-800">{children ?? "This item is Final Sale — approving it needs an explicit override."}</p>
    </div>
  );
}
