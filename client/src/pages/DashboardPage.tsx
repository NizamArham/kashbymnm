import { useEffect, useMemo, useState } from "react";
import { ArrowRight, ShoppingBag, Truck, PackageCheck, RotateCcw, CheckCircle2, XCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { Sale, InventoryUnit, Delivery, ReturnRequest } from "../lib/types";
import { PageHeader, Card, EmptyState, Dropdown } from "../components/ui";
import { RevenueChart, RevenuePoint } from "../components/RevenueChart";
import { todayInSriLanka } from "../lib/time";

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface ActivityEvent {
  id: string;
  icon: any;
  tone: "blue" | "green" | "amber" | "red";
  title: string;
  date: string;
}

const TONE_CLASSES: Record<ActivityEvent["tone"], string> = {
  blue: "bg-blue-50 text-blue-500",
  green: "bg-green-50 text-green-600",
  amber: "bg-amber-50 text-amber-600",
  red: "bg-red-50 text-red-500",
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return mins <= 1 ? "Just now" : `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

// Merges sales, delivery-status changes, and returns into one
// chronological feed — each mapped to an icon/tone in the same visual
// language, newest first.
function buildActivity(sales: Sale[], deliveries: Delivery[], returns: ReturnRequest[]): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  for (const s of sales) {
    events.push({
      id: `sale-${s.id}`,
      icon: ShoppingBag,
      tone: "blue",
      title: `${s.invoice} placed — Rs. ${s.total.toLocaleString()}`,
      date: s.date,
    });
  }

  for (const d of deliveries) {
    if (d.dispatched_at) {
      events.push({ id: `disp-${d.id}`, icon: Truck, tone: "blue", title: `${d.invoice ?? "Order"} — Dispatched`, date: d.dispatched_at });
    }
    if (d.delivery_date) {
      events.push({
        id: `deliv-${d.id}`,
        icon: PackageCheck,
        tone: "green",
        title: `${d.invoice ?? "Order"} — Delivered`,
        date: d.delivery_date,
      });
    }
  }

  for (const r of returns) {
    events.push({
      id: `ret-${r.id}`,
      icon: RotateCcw,
      tone: "amber",
      title: `${r.invoice} — Return requested (${r.product_title})`,
      date: r.requested_at,
    });
    if (r.decided_at && r.status !== "pending") {
      events.push({
        id: `retd-${r.id}`,
        icon: r.status === "approved" ? CheckCircle2 : XCircle,
        tone: r.status === "approved" ? "green" : "red",
        title: `${r.invoice} — Return ${r.status}`,
        date: r.decided_at,
      });
    }
  }

  return events.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
}

interface ChequeReminder {
  id: number;
  cheque_number: string;
  bank_name: string;
  amount: number;
  cheque_date: string;
  customer_name?: string;
  supplier_name?: string;
}

interface SupplierBalance {
  id: number;
  supplier_code: string;
  name: string;
  balance_owed: number;
}

interface Customer {
  id: number;
  name: string;
  balance_due: number;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [allSales, setAllSales] = useState<Sale[]>([]);
  const [cashTotal, setCashTotal] = useState<number | null>(null);
  const [bankTotal, setBankTotal] = useState<number | null>(null);
  const [lowStockCount, setLowStockCount] = useState<number | null>(null);
  const [owingSuppliers, setOwingSuppliers] = useState<SupplierBalance[]>([]);
  const [owingCustomers, setOwingCustomers] = useState<Customer[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [returns, setReturns] = useState<ReturnRequest[]>([]);
  const [chartPeriod, setChartPeriod] = useState<"year" | "month">("year");
  const [loading, setLoading] = useState(true);

  const [chequeReminders, setChequeReminders] = useState<{
    to_deposit: ChequeReminder[];
    to_pay: ChequeReminder[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [sales, inventory, summary, suppliers, customers, deliveriesRes, returnsRes] = await Promise.all([
          api.get<Sale[]>("/sales"),
          api.get<InventoryUnit[]>("/inventory?status=available"),
          api.get<{ cash_total: number; bank_total: number }>("/cash-book/summary"),
          api.get<SupplierBalance[]>("/supplier-payments/summary"),
          api.get<Customer[]>("/customers"),
          api.get<Delivery[]>("/deliveries").catch(() => []),
          api.get<ReturnRequest[]>("/returns/requests").catch(() => []),
        ]);
        if (cancelled) return;

        setAllSales(sales);
        setCashTotal(summary.cash_total);
        setBankTotal(summary.bank_total);
        setDeliveries(deliveriesRes);
        setReturns(returnsRes);

        // Low stock count: how many distinct (product, color, size) variants
        // have 5 or fewer available units. Matches the threshold used on the
        // Inventory page so it doesn't drift.
        const counts = new Map<string, number>();
        for (const u of inventory) {
          const key = `${u.product_id}|${u.color ?? ""}|${u.size ?? ""}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const lowCount = Array.from(counts.values()).filter((n) => n <= 5).length;
        setLowStockCount(lowCount);

        setOwingSuppliers(suppliers.filter((s) => (s.balance_owed ?? 0) > 0));

        const owing = customers
          .filter((c) => (c.balance_due ?? 0) > 0)
          .sort((a, b) => (b.balance_due ?? 0) - (a.balance_due ?? 0));
        setOwingCustomers(owing);
      } catch {
        // summary widgets fail quietly — not critical path
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();

    if (user?.role === "admin") {
      api
        .get<{ to_deposit: ChequeReminder[]; to_pay: ChequeReminder[] }>("/cheques/dashboard-reminders")
        .then((result) => {
          if (!cancelled) setChequeReminders(result);
        })
        .catch(() => {
          // quietly skip the reminder card if this fails
        });
    }

    return () => {
      cancelled = true;
    };
  }, [user]);

  // A voided sale is money that was reversed — it never counts as real
  // revenue or shows up as if it were still an active order.
  const activeSales = allSales.filter((s) => !s.is_voided);

  const todayIso = todayInSriLanka();
  const todaySales = activeSales.filter((s) => s.date.startsWith(todayIso));
  const todayTotal = todaySales.reduce((sum, s) => sum + s.total, 0);

  const supplierOwedTotal = owingSuppliers.reduce((sum, s) => sum + s.balance_owed, 0);
  const customerOwedTotal = owingCustomers.reduce((sum, c) => sum + c.balance_due, 0);

  const activity = useMemo(() => buildActivity(activeSales, deliveries, returns), [activeSales, deliveries, returns]);

  const revenueSeries: RevenuePoint[] = useMemo(() => {
    const now = new Date();
    if (chartPeriod === "year") {
      const year = now.getFullYear();
      const months = MONTH_LABELS.map((label) => ({ label, value: 0 }));
      for (const s of activeSales) {
        const d = new Date(s.date);
        if (d.getFullYear() === year) months[d.getMonth()].value += s.total;
      }
      return months;
    }
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const days = Array.from({ length: daysInMonth }, (_, i) => ({ label: String(i + 1), value: 0 }));
    for (const s of activeSales) {
      const d = new Date(s.date);
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) days[d.getDate() - 1].value += s.total;
    }
    return days;
  }, [activeSales, chartPeriod]);

  const revenueTotal = revenueSeries.reduce((sum, p) => sum + p.value, 0);

  const chequesToDeposit = chequeReminders?.to_deposit ?? [];
  const chequesToPay = chequeReminders?.to_pay ?? [];
  const hasCheques = chequesToDeposit.length > 0 || chequesToPay.length > 0;

  const needsAttentionCount =
    (hasCheques ? 1 : 0) +
    (lowStockCount !== null && lowStockCount > 0 ? 1 : 0) +
    (owingSuppliers.length > 0 ? 1 : 0) +
    (owingCustomers.length > 0 ? 1 : 0);

  return (
    <div>
      <PageHeader
        title={`Welcome${user?.name ? `, ${user.name.split(" ")[0]}` : ""}`}
        subtitle={new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
      />

      {/* Row 1 — three primary figures */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <Card>
          <p className="text-xs text-gray-500 mb-1">Today's sales</p>
          <p className="text-2xl font-semibold text-gray-900 tabular-nums">
            Rs. {todayTotal.toLocaleString()}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {todaySales.length === 0
              ? "No sales yet today"
              : `${todaySales.length} sale${todaySales.length === 1 ? "" : "s"} today`}
          </p>
        </Card>

        <Card>
          <p className="text-xs text-gray-500 mb-1">Cash in hand</p>
          <p className="text-2xl font-semibold text-gray-900 tabular-nums">
            Rs. {(cashTotal ?? 0).toLocaleString()}
          </p>
          <p className="text-xs text-gray-400 mt-1">Physical currency on hand</p>
        </Card>

        <Card>
          <p className="text-xs text-gray-500 mb-1">Bank balance</p>
          <p className="text-2xl font-semibold text-gray-900 tabular-nums">
            Rs. {(bankTotal ?? 0).toLocaleString()}
          </p>
          <p className="text-xs text-gray-400 mt-1">Including cheques</p>
        </Card>
      </div>

      {/* Row 2 — needs attention + today's cheques */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-900">Needs attention</h2>
            {needsAttentionCount > 0 && (
              <span className="text-xs text-amber-600 font-medium">
                {needsAttentionCount} item{needsAttentionCount === 1 ? "" : "s"}
              </span>
            )}
          </div>

          {loading ? (
            <p className="text-sm text-gray-400">Loading...</p>
          ) : needsAttentionCount === 0 ? (
            <p className="text-sm text-gray-400">Nothing pending. All clear.</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {hasCheques && (
                <button
                  onClick={() => navigate("/cheques")}
                  className="w-full flex items-center justify-between py-2.5 text-left hover:bg-gray-50 -mx-2 px-2 rounded transition"
                >
                  <span className="text-sm text-gray-700">
                    {chequesToDeposit.length > 0 && `${chequesToDeposit.length} cheque${chequesToDeposit.length === 1 ? "" : "s"} to deposit`}
                    {chequesToDeposit.length > 0 && chequesToPay.length > 0 && " · "}
                    {chequesToPay.length > 0 && `${chequesToPay.length} cheque${chequesToPay.length === 1 ? "" : "s"} to pay`}
                  </span>
                  <ArrowRight size={14} className="text-gray-400" />
                </button>
              )}

              {lowStockCount !== null && lowStockCount > 0 && (
                <button
                  onClick={() => navigate("/inventory")}
                  className="w-full flex items-center justify-between py-2.5 text-left hover:bg-gray-50 -mx-2 px-2 rounded transition"
                >
                  <span className="text-sm text-gray-700">
                    {lowStockCount} low-stock variant{lowStockCount === 1 ? "" : "s"} (5 or fewer left)
                  </span>
                  <ArrowRight size={14} className="text-gray-400" />
                </button>
              )}

              {owingSuppliers.length > 0 && (
                <button
                  onClick={() => navigate("/supplier-payments")}
                  className="w-full flex items-center justify-between py-2.5 text-left hover:bg-gray-50 -mx-2 px-2 rounded transition"
                >
                  <span className="text-sm text-gray-700">
                    Owe {owingSuppliers.length} supplier{owingSuppliers.length === 1 ? "" : "s"} —{" "}
                    <span className="tabular-nums">Rs. {supplierOwedTotal.toLocaleString()}</span>
                  </span>
                  <ArrowRight size={14} className="text-gray-400" />
                </button>
              )}

              {owingCustomers.length > 0 && (
                <button
                  onClick={() => navigate("/customers")}
                  className="w-full flex items-center justify-between py-2.5 text-left hover:bg-gray-50 -mx-2 px-2 rounded transition"
                >
                  <span className="text-sm text-gray-700">
                    {owingCustomers.length} customer{owingCustomers.length === 1 ? "" : "s"} owe you —{" "}
                    <span className="tabular-nums">Rs. {customerOwedTotal.toLocaleString()}</span>
                  </span>
                  <ArrowRight size={14} className="text-gray-400" />
                </button>
              )}
            </div>
          )}
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-900">Cheques due today or tomorrow</h2>
            {hasCheques && (
              <button
                onClick={() => navigate("/cheques")}
                className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1"
              >
                View all
                <ArrowRight size={12} />
              </button>
            )}
          </div>

          {loading ? (
            <p className="text-sm text-gray-400">Loading...</p>
          ) : !hasCheques ? (
            <p className="text-sm text-gray-400">No cheques due today or tomorrow.</p>
          ) : (
            <div className="space-y-3">
              {chequesToDeposit.length > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-400 font-medium mb-1.5">To deposit</p>
                  <div className="space-y-1.5">
                    {chequesToDeposit.slice(0, 3).map((c) => (
                      <div key={`d-${c.id}`} className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="text-gray-700 truncate">
                          <span className="font-medium">#{c.cheque_number}</span>
                          <span className="text-gray-400"> · </span>
                          {c.customer_name}
                        </span>
                        <span className="text-gray-900 tabular-nums flex-shrink-0">
                          Rs. {c.amount.toLocaleString()}
                        </span>
                      </div>
                    ))}
                    {chequesToDeposit.length > 3 && (
                      <p className="text-xs text-gray-400">+{chequesToDeposit.length - 3} more</p>
                    )}
                  </div>
                </div>
              )}

              {chequesToPay.length > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-400 font-medium mb-1.5">To pay</p>
                  <div className="space-y-1.5">
                    {chequesToPay.slice(0, 3).map((c) => (
                      <div key={`p-${c.id}`} className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="text-gray-700 truncate">
                          <span className="font-medium">#{c.cheque_number}</span>
                          <span className="text-gray-400"> · </span>
                          {c.supplier_name}
                        </span>
                        <span className="text-gray-900 tabular-nums flex-shrink-0">
                          Rs. {c.amount.toLocaleString()}
                        </span>
                      </div>
                    ))}
                    {chequesToPay.length > 3 && (
                      <p className="text-xs text-gray-400">+{chequesToPay.length - 3} more</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* Row 3 — Revenue trend */}
      <Card className="mb-6">
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm text-gray-500">Total Revenue</p>
          <div className="w-32">
            <Dropdown
              value={chartPeriod}
              onChange={(v) => setChartPeriod(v as "year" | "month")}
              options={[
                { value: "year", label: "Yearly" },
                { value: "month", label: "This month" },
              ]}
            />
          </div>
        </div>
        <p className="text-2xl font-semibold text-gray-900 tabular-nums mb-2">Rs. {revenueTotal.toLocaleString()}</p>
        {loading ? <p className="text-sm text-gray-400 py-10 text-center">Loading...</p> : <RevenueChart data={revenueSeries} />}
      </Card>

      {/* Row 4 — Activity timeline */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-900">Activity Timeline</h2>
          <button
            onClick={() => navigate("/sales")}
            className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1"
          >
            See all
            <ArrowRight size={12} />
          </button>
        </div>
        {loading ? (
          <p className="text-sm text-gray-400">Loading...</p>
        ) : activity.length === 0 ? (
          <EmptyState title="No activity recorded yet." />
        ) : (
          <div className="space-y-4">
            {activity.map((ev) => {
              const Icon = ev.icon;
              return (
                <div key={ev.id} className="flex items-start gap-3">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${TONE_CLASSES[ev.tone]}`}>
                    <Icon size={14} />
                  </div>
                  <div className="min-w-0 pt-1">
                    <p className="text-sm text-gray-800">{ev.title}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{timeAgo(ev.date)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}