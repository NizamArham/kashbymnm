import { useEffect, useRef, useState } from "react";
import { ClipboardList, Search, AlertTriangle, XCircle, Trash2, UserCog, Ban, PackageMinus, Ticket, Gift, Pencil } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { AuditLogEntry } from "../lib/types";
import { PageHeader, Card, Table, Th, Td, SortHeader, Badge, Dropdown, EmptyState, ErrorText } from "../components/ui";
import { useSortableData } from "../lib/useSortableData";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";

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
  coupon_create: { label: "Created coupon", icon: Ticket, tone: "neutral" },
  coupon_edit: { label: "Edited coupon", icon: Pencil, tone: "neutral" },
  coupon_delete: { label: "Deleted coupon", icon: Trash2, tone: "danger" },
  gift_voucher_create: { label: "Issued gift voucher", icon: Gift, tone: "neutral" },
  gift_voucher_edit: { label: "Edited gift voucher", icon: Pencil, tone: "neutral" },
  gift_voucher_delete: { label: "Deleted gift voucher", icon: Trash2, tone: "danger" },
};

function actionMeta(action: string) {
  return ACTION_META[action] ?? { label: action.replace(/_/g, " "), icon: AlertTriangle, tone: "neutral" as const };
}

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState("");
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

  const filtered = entries.filter((e) => {
    if (actionFilter && e.action !== actionFilter) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return e.description.toLowerCase().includes(q) || e.staff_name.toLowerCase().includes(q);
  });

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
              placeholder="Search description or staff... (/)"
              className="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-gray-400"
            />
          </div>
          <div className="w-56">
            <Dropdown
              value={actionFilter}
              onChange={setActionFilter}
              placeholder="All actions"
              options={[{ value: "", label: "All actions" }, ...actionOptions]}
            />
          </div>
        </div>
      </Card>

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : entries.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No activity recorded yet" subtitle="Sensitive actions will show up here as they happen." />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Search} title="No entries match your search" />
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
                    <Td className="whitespace-nowrap text-gray-500 text-xs">{e.created_at.slice(0, 16).replace("T", " ")}</Td>
                    <Td className="font-medium">{e.staff_name}</Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5">
                        <Icon size={13} className={meta.tone === "danger" ? "text-red-500" : meta.tone === "warning" ? "text-amber-500" : "text-gray-400"} />
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
