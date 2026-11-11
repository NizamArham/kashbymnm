import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { api } from "../lib/api";
import { ReturnRequest } from "../lib/types";
import { decidedLine, onlyCancelsDebt, partlyOwed } from "../lib/returnFlow";
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
  // An item that was never paid for (a credit order) only cancels what is owed: nothing is paid back, so there is no refund method to choose.
  const debtOnly = pending && onlyCancelsDebt(r);
  const { accounts, defaultId } = useCustomerBankAccounts(r.customer_id, pending && r.resolution === "refund" && !debtOnly && method === "bank_transfer");
  useEffect(() => {
    if (method === "bank_transfer") setAccountId((cur) => cur || defaultId);
  }, [method, defaultId]);

  async function approve(reason: string) {
    if (r.resolution === "refund" && !debtOnly && method === "bank_transfer" && !accountId) {
      throw new Error("Select which of the customer's bank accounts to refund into");
    }
    const decision = {
      decision_reason: reason || undefined,
      payment_method: r.resolution === "refund" && !debtOnly ? method : undefined,
      bank_account_id: r.resolution === "refund" && !debtOnly && method === "bank_transfer" ? parseInt(accountId, 10) : undefined,
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
        <p className="mb-1 text-xs text-gray-500">Item</p>
        <p className="text-sm font-medium text-gray-900">
          {r.product_id ? <RefLink to={`/products/${r.product_id}`}>{r.product_title}</RefLink> : r.product_title} ({r.sku})
          {(r.color || r.size) && <span className="font-normal text-gray-400"> · {[r.color, r.size].filter(Boolean).join(" / ")}</span>}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <p className="text-xs text-gray-500">Condition</p>
          <p className="capitalize text-gray-900">{r.condition}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Resolution</p>
          <p className={`${debtOnly ? "" : "capitalize "}text-gray-900`}>{debtOnly ? "Reduce what they owe" : r.resolution.replace(/_/g, " ")}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Requested by</p>
          <p className="text-gray-900">{r.requested_by_name ?? "—"}</p>
        </div>
      </div>

      <div>
        <p className="mb-1 text-xs text-gray-500">Reason for return</p>
        <p className="text-sm text-gray-900">{r.reason}</p>
      </div>

      {pending && (onlyCancelsDebt(r) || partlyOwed(r)) && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
          {onlyCancelsDebt(r) ? (
            <>
              <p className="font-medium text-gray-900">Rs. {(r.owed_cleared ?? 0).toLocaleString()} comes off what the customer owes on {r.invoice}.</p>
              <p className="mt-0.5 text-gray-500">Nothing was paid for it, so nothing is paid back and no store credit is given.</p>
            </>
          ) : (
            <>
              <p className="font-medium text-gray-900">Rs. {(r.owed_cleared ?? 0).toLocaleString()} comes off what the customer still owes; Rs. {(r.paid_part ?? 0).toLocaleString()} was paid for.</p>
              <p className="mt-0.5 text-gray-500">
                Only the paid part goes back, as {r.resolution === "refund" ? "a refund" : "store credit"}.
              </p>
            </>
          )}
        </div>
      )}

      {r.is_admin_override === 1 && pending && <NoReturnsWarning />}

      {!pending && (
        <div className="grid grid-cols-2 gap-3 border-t border-gray-200 pt-3 text-sm">
          <div>
            <p className="text-xs text-gray-500">Decision</p>
            <p className="text-gray-900">{decidedLine(r.auto_approved === 1, r.status as "approved" | "declined", r.decided_by_name, r.decided_at)}</p>
          </div>
          {r.decision_reason && (
            <div>
              <p className="text-xs text-gray-500">{r.status === "approved" ? "Approval reason" : "Decline reason"}</p>
              <p className="text-gray-900">{r.decision_reason}</p>
            </div>
          )}
          {r.status === "approved" && r.resolution === "refund" && (
            <div>
              <p className="text-xs text-gray-500">Refund amount</p>
              <p className="font-semibold text-gray-900">{(r.refund_amount ?? 0) > 0 ? `Rs. ${(r.refund_amount ?? 0).toLocaleString()}` : "Nothing paid back"}</p>
            </div>
          )}
          {r.status === "approved" && r.resolution === "store_credit_exchange" && (
            <div>
              <p className="text-xs text-gray-500">Store credit granted</p>
              <p className="font-semibold text-gray-900">
                {(r.credit_granted ?? r.unit_price) > 0 ? `Rs. ${(r.credit_granted ?? r.unit_price).toLocaleString()}` : "None — nothing was paid for it"}
                {(r.credit_granted ?? r.unit_price) > 0 && r.credit_expiry_days ? ` — expires in ${r.credit_expiry_days} days` : ""}
              </p>
            </div>
          )}
          {r.status === "approved" && (r.written_off ?? 0) > 0 && (
            <div>
              <p className="text-xs text-gray-500">Came off what they owe</p>
              <p className="font-semibold text-gray-900">Rs. {(r.written_off ?? 0).toLocaleString()}</p>
            </div>
          )}
        </div>
      )}

      {pending && (
        <div className="border-t border-gray-200 pt-4">
          <DecisionBox
            reasonRequired={r.is_admin_override === 1}
            approveExtras={
              r.resolution === "refund" && !debtOnly ? (
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
