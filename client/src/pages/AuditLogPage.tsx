import { useEffect, useRef, useState } from "react";
import { PageLoader } from "../components/Loader";
import { ClipboardList, Search, AlertTriangle, XCircle, Trash2, UserCog, Ban, PackageMinus, Ticket, Gift, Pencil } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { AuditLogEntry } from "../lib/types";
import { PageHeader, Card, Table, Th, Td, SortHeader, Badge, Dropdown, EmptyState, ErrorText } from "../components/ui";
import { useSortableData } from "../lib/useSortableData";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";
import { formatDateTime } from "../lib/dates";

type AuditSortKey = "date" | "staff" | "action";

// Icon + badge tone per action — lets the table read at a glance instead
// of everything looking the same regardless of severity.
const ACTION_META: Record<string, { label: string; icon: typeof AlertTriangle; tone: "danger" | "warning" | "neutral" }> = {
  product_delete: { label: "Deleted product", icon: Trash2, tone: "danger" },
  customer_delete: { label: "Deleted customer", icon: Trash2, tone: "danger" },
  customer_suspend: { label: "Suspended customer", icon: Ban, tone: "warning" },
  customer_reactivate: { label: "Reactivated customer", icon: UserCog, tone: "neutral" },
  supplier_delete: { label: "Deleted supplier", icon: Trash2, tone: "danger" },
  staff_edit: { label: "Edited staff", icon: UserCog, tone: "neutral" },
  staff_role_change: { label: "Changed staff role", icon: UserCog, tone: "warning" },
  staff_password_reset: { label: "Reset staff password", icon: UserCog, tone: "warning" },
  staff_delete: { label: "Removed staff login", icon: Trash2, tone: "danger" },
  sale_void: { label: "Voided sale", icon: XCircle, tone: "danger" },
  return_approve: { label: "Approved return", icon: AlertTriangle, tone: "neutral" },
  return_decline: { label: "Declined return", icon: XCircle, tone: "neutral" },
  purchase_delete: { label: "Deleted purchase", icon: Trash2, tone: "danger" },
  cash_book_delete: { label: "Deleted cash book entry", icon: Trash2, tone: "danger" },
  cash_book_correction: { label: "Corrected cash book entry", icon: AlertTriangle, tone: "warning" },
  cheque_bounce: { label: "Cheque bounced", icon: AlertTriangle, tone: "danger" },
  cheque_delete: { label: "Deleted cheque", icon: Trash2, tone: "danger" },
  inventory_remove: { label: "Removed stock unit", icon: PackageMinus, tone: "warning" },
  product_price_change: { label: "Changed a product's selling price", icon: Pencil, tone: "neutral" },
  inventory_restore: { label: "Put a unit back in stock", icon: PackageMinus, tone: "neutral" },
  coupon_create: { label: "Created coupon", icon: Ticket, tone: "neutral" },
  coupon_edit: { label: "Edited coupon", icon: Pencil, tone: "neutral" },
  coupon_delete: { label: "Deleted coupon", icon: Trash2, tone: "danger" },
  gift_voucher_create: { label: "Issued gift voucher", icon: Gift, tone: "neutral" },
  gift_voucher_edit: { label: "Edited gift voucher", icon: Pencil, tone: "neutral" },
  gift_voucher_delete: { label: "Deleted gift voucher", icon: Trash2, tone: "danger" },
  delivery_partner_create: { label: "Added delivery partner", icon: Pencil, tone: "neutral" },
  delivery_partner_edit: { label: "Edited delivery partner", icon: Pencil, tone: "neutral" },
  delivery_partner_change: { label: "Changed order's courier", icon: Pencil, tone: "neutral" },
  delivery_fare_set: { label: "Set delivery fare", icon: Pencil, tone: "neutral" },
  delivery_fee_change: { label: "Changed delivery fee", icon: Pencil, tone: "neutral" },
  exchange_received: { label: "Received exchange item", icon: Pencil, tone: "neutral" },
  exchange_not_returned: { label: "Exchange item not returned", icon: Pencil, tone: "warning" },
  exchange_cancelled: { label: "Exchange cancelled", icon: Pencil, tone: "warning" },
  return_pickup_booked: { label: "Recorded a courier return", icon: Pencil, tone: "neutral" },
  return_pickup_requested: { label: "Requested a courier return", icon: Pencil, tone: "neutral" },
  return_pickup_approved: { label: "Approved a courier return", icon: Pencil, tone: "neutral" },
  return_pickup_declined: { label: "Declined a courier return", icon: Pencil, tone: "warning" },
  return_pickup_sent: { label: "Courier return sent by the customer", icon: Pencil, tone: "neutral" },
  return_pickup_parcel_received: { label: "Courier return parcel received", icon: Pencil, tone: "neutral" },
  return_pickup_item_checked: { label: "Courier return item checked", icon: Pencil, tone: "neutral" },
  return_pickup_reported: { label: "Courier return inspection report", icon: Pencil, tone: "neutral" },
  return_pickup_report_approved: { label: "Courier return report approved", icon: Pencil, tone: "neutral" },
  return_pickup_report_sent_back: { label: "Courier return report sent back", icon: Pencil, tone: "warning" },
  return_pickup_rejected: { label: "Courier return rejected after inspection", icon: Pencil, tone: "warning" },
  return_pickup_refunded: { label: "Courier return refund paid", icon: Pencil, tone: "neutral" },
  exchange_requested: { label: "Requested a delivery exchange", icon: Pencil, tone: "neutral" },
  exchange_request_approved: { label: "Approved a delivery exchange", icon: Pencil, tone: "neutral" },
  exchange_request_declined: { label: "Declined a delivery exchange", icon: Pencil, tone: "warning" },
  return_pickup_received: { label: "Received a returned item", icon: Pencil, tone: "neutral" },
  return_pickup_not_returned: { label: "Courier return — nothing handed back", icon: Pencil, tone: "warning" },
  return_pickup_cancelled: { label: "Courier return cancelled", icon: Pencil, tone: "warning" },
  sale_removed: { label: "Sale removed entirely", icon: Trash2, tone: "danger" },
  store_credit_refund: { label: "Refunded store credit", icon: Pencil, tone: "neutral" },
  store_credit_grant: { label: "Added store credit", icon: Pencil, tone: "neutral" },
  delivery_status_sync: { label: "Courier updated delivery", icon: Pencil, tone: "neutral" },
  delivery_undelivered: { label: "Put back to dispatched", icon: Pencil, tone: "warning" },
  delivery_coming_back: { label: "Parcel couldn't be delivered — on its way back", icon: Pencil, tone: "warning" },
  delivery_coming_back_undo: { label: "Parcel back to dispatched — courier will retry", icon: Pencil, tone: "neutral" },
  courier_charge_edit: { label: "Edited courier charge", icon: Pencil, tone: "neutral" },
  courier_balance_adjust: { label: "Corrected courier balance", icon: Pencil, tone: "neutral" },
  courier_balance_adjust_undo: { label: "Undid courier balance correction", icon: Pencil, tone: "neutral" },
  sale_payment_recorded: { label: "Recorded a payment on a sale", icon: Pencil, tone: "neutral" },
  loyalty_adjust: { label: "Changed loyalty points", icon: Pencil, tone: "neutral" },
  loyalty_block: { label: "Changed whether a customer earns points", icon: Pencil, tone: "neutral" },
  sale_wholesale: { label: "Marked sale wholesale", icon: Pencil, tone: "neutral" },
  cashier_mode_on: { label: "Switched to cashier mode", icon: UserCog, tone: "neutral" },
  cashier_mode_off: { label: "Went back to admin", icon: UserCog, tone: "neutral" },
  till_approval: { label: "Approved at the till", icon: UserCog, tone: "warning" },
};

// Quick views over the log. An entry can sit in more than one (a refund is both a return and money).
type Group = "all" | "approvals" | "returns" | "money";
const GROUPS: { value: Group; label: string; hint: string }[] = [
  { value: "all", label: "Everything", hint: "All entries" },
  { value: "approvals", label: "Approvals", hint: "Requests, approvals and declines — including an admin's yes at the till" },
  { value: "returns", label: "Returns", hint: "Returns and exchanges, from request to refund" },
  { value: "money", label: "Money", hint: "Cash book, cheques, payments, voids, refunds, store credit and courier balances" },
];
const APPROVAL_ACTIONS = new Set([
  "till_approval", "return_approve", "return_decline", "return_pickup_requested", "return_pickup_approved", "return_pickup_declined",
  "return_pickup_report_approved", "return_pickup_report_sent_back", "return_pickup_rejected", "exchange_requested",
  "exchange_request_approved", "exchange_request_declined",
]);
const MONEY_ACTIONS = new Set([
  "sale_payment_recorded", "sale_void", "sale_removed", "purchase_delete", "return_pickup_refunded", "courier_charge_edit",
  "courier_balance_adjust", "courier_balance_adjust_undo", "store_credit_refund", "store_credit_grant", "delivery_fee_change", "delivery_fare_set",
]);
function inGroup(action: string, group: Group): boolean {
  if (group === "all") return true;
  if (group === "approvals") return APPROVAL_ACTIONS.has(action);
  if (group === "returns") return action.startsWith("return_") || action.startsWith("exchange_") || action.includes("coming_back") || action === "delivery_undelivered";
  return MONEY_ACTIONS.has(action) || action.startsWith("cash_book_") || action.startsWith("cheque_");
}
// Admins switching in and out of cashier mode is routine, and used to fill the top of the log.
const isModeSwitch = (action: string) => action === "cashier_mode_on" || action === "cashier_mode_off";

function actionMeta(action: string) {
  return ACTION_META[action] ?? { label: action.replace(/_/g, " "), icon: AlertTriangle, tone: "neutral" as const };
}

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [group, setGroup] = useState<Group>("all");
  const [showSwitches, setShowSwitches] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useKeyboardShortcut("/", () => searchInputRef.current?.focus());

  useEffect(() => {
    api
      .get<AuditLogEntry[]>("/audit-log")
      .then(setEntries)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Failed to load the audit log"))
      .finally(() => setLoading(false));
  }, []);

  const actionOptions = Array.from(new Set(entries.map((e) => e.action))).map((a) => ({
    value: a,
    label: actionMeta(a).label,
  }));

  // Mode switches stay out of the way unless asked for (or picked by name in the action list).
  const switchesWanted = showSwitches || isModeSwitch(actionFilter);
  const hiddenSwitches = entries.filter((e) => isModeSwitch(e.action)).length;
  const searched = entries.filter((e) => {
    if (!switchesWanted && isModeSwitch(e.action)) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return e.description.toLowerCase().includes(q) || e.staff_name.toLowerCase().includes(q);
  });
  const groupCounts = Object.fromEntries(GROUPS.map((g) => [g.value, searched.filter((e) => inGroup(e.action, g.value)).length])) as Record<Group, number>;
  const filtered = searched.filter((e) => inGroup(e.action, group) && (!actionFilter || e.action === actionFilter));

  const { sorted, sortKey, sortDir, toggleSort } = useSortableData<AuditLogEntry, AuditSortKey>(
    filtered,
    (e, key) => {
      switch (key) {
        case "date":
          return e.created_at;
        case "staff":
          return e.staff_name.toLowerCase();
        case "action":
          return actionMeta(e.action).label.toLowerCase();
      }
    },
    "date",
    "desc"
  );

  return (
    <div>
      <PageHeader
        title="Audit log"
        subtitle="Sensitive actions taken in the system — deletes, voids, approvals, and staff/HR changes."
      />

      <Card className="mb-5">
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search description or staff..."
              className="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-gray-400"
            />
          </div>
          <div className="w-56">
            <Dropdown
              value={actionFilter}
              onChange={(v) => {
                setActionFilter(v);
                if (v) setGroup("all");
              }}
              placeholder="All actions"
              options={[{ value: "", label: "All actions" }, ...actionOptions]}
            />
          </div>
        </div>
      </Card>

      {!loading && entries.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {GROUPS.map((g) => {
            const active = group === g.value;
            return (
              <button
                key={g.value}
                title={g.hint}
                onClick={() => {
                  setGroup(g.value);
                  setActionFilter("");
                }}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${
                  active ? "bg-black text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {g.label}
                <span className={`text-xs tabular-nums ${active ? "text-white/70" : "text-gray-400"}`}>{groupCounts[g.value]}</span>
              </button>
            );
          })}
          {hiddenSwitches > 0 && (
            <button onClick={() => setShowSwitches((v) => !v)} className="ml-auto text-xs text-gray-400 underline hover:text-gray-700">
              {showSwitches ? "Hide cashier-mode switches" : `Show ${hiddenSwitches} cashier-mode switch${hiddenSwitches === 1 ? "" : "es"} (hidden)`}
            </button>
          )}
        </div>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <PageLoader />
      ) : entries.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No activity recorded yet" subtitle="Sensitive actions will show up here as they happen." />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Search} title={group !== "all" || actionFilter ? "Nothing in this view" : "No entries match your search"} />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <SortHeader<AuditSortKey> label="Date" sortKey="date" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortHeader<AuditSortKey> label="Staff" sortKey="staff" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortHeader<AuditSortKey> label="Action" sortKey="action" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <Th>Description</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((e) => {
                const meta = actionMeta(e.action);
                const Icon = meta.icon;
                return (
                  <tr key={e.id} className="hover:bg-gray-50">
                    <Td className="whitespace-nowrap text-gray-500 text-xs">{formatDateTime(e.created_at)}</Td>
                    <Td className="font-medium">{e.staff_name}</Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5">
                        <Icon size={12} className={meta.tone === "danger" ? "text-red-500" : meta.tone === "warning" ? "text-amber-500" : "text-gray-400"} />
                        <Badge label={meta.label} tone={meta.tone} />
                      </span>
                    </Td>
                    <Td className="text-gray-600">{e.description}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
