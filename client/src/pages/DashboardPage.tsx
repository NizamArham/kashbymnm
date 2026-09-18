import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { Sale, InventoryUnit } from "../lib/types";
import { PageHeader, Card, Table, Th, Td, EmptyState } from "../components/ui";

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

  const [recentSales, setRecentSales] = useState<Sale[]>([]);
  const [cashTotal, setCashTotal] = useState<number | null>(null);
  const [bankTotal, setBankTotal] = useState<number | null>(null);
  const [lowStockCount, setLowStockCount] = useState<number | null>(null);
  const [owingSuppliers, setOwingSuppliers] = useState<SupplierBalance[]>([]);
  const [owingCustomers, setOwingCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);

  const [chequeReminders, setChequeReminders] = useState<{
    to_deposit: ChequeReminder[];
    to_pay: ChequeReminder[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [sales, inventory, summary, suppliers, customers] = await Promise.all([
          api.get<Sale[]>("/sales"),
          api.get<InventoryUnit[]>("/inventory?status=available"),
          api.get<{ cash_total: number; bank_total: number }>("/cash-book/summary"),
          api.get<SupplierBalance[]>("/supplier-payments/summary"),
          api.get<Customer[]>("/customers"),
        ]);
        if (cancelled) return;

        setRecentSales(sales.slice(0, 5));
        setCashTotal(summary.cash_total);
        setBankTotal(summary.bank_total);

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

  const todayIso = new Date().toISOString().slice(0, 10);
  const todaySales = recentSales.filter((s) => s.date.startsWith(todayIso));
  const todayTotal = todaySales.reduce((sum, s) => sum + s.total, 0);

  const supplierOwedTotal = owingSuppliers.reduce((sum, s) => sum + s.balance_owed, 0);
  const customerOwedTotal = owingCustomers.reduce((sum, c) => sum + c.balance_due, 0);

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

      {/* Row 3 — Recent sales */}
      <Card className="p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Recent sales</h2>
          <button
            onClick={() => navigate("/sales")}
            className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1"
          >
            View all
            <ArrowRight size={12} />
          </button>
        </div>
        {loading ? (
          <p className="text-sm text-gray-400 p-4">Loading...</p>
        ) : recentSales.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No sales recorded yet." />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Invoice</Th>
                <Th>Customer</Th>
                <Th>Type</Th>
                <Th className="text-right">Total</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {recentSales.map((sale) => (
                <tr key={sale.id}>
                  <Td className="text-gray-500 text-xs">{sale.invoice}</Td>
                  <Td>
                    {sale.customer_name ??
                      (sale.deleted_customer_snapshot ? `[Deleted: ${sale.deleted_customer_snapshot}]` : "Walk-in")}
                  </Td>
                  <Td className="text-gray-500 text-xs">{sale.sale_type === "online" ? "Online" : "In-store"}</Td>
                  <Td className="text-right tabular-nums font-medium">Rs. {sale.total.toLocaleString()}</Td>
                  <Td>
                    <span
                      className={`inline-block text-xs px-2 py-0.5 rounded-full ${
                        sale.payment_status === "paid"
                          ? "text-green-700 bg-green-50"
                          : sale.payment_status === "partial"
                          ? "text-amber-700 bg-amber-50"
                          : "text-red-700 bg-red-50"
                      }`}
                    >
                      {sale.payment_status}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}