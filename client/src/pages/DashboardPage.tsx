import { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { Sale, InventoryUnit } from "../lib/types";
import { PageHeader, Card, StatCard, Table, Th, Td, EmptyState } from "../components/ui";

interface ChequeReminder {
  id: number;
  cheque_number: string;
  bank_name: string;
  amount: number;
  cheque_date: string;
  customer_name?: string;
  supplier_name?: string;
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [recentSales, setRecentSales] = useState<Sale[]>([]);
  const [stockCount, setStockCount] = useState<number | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [chequeReminders, setChequeReminders] = useState<{ to_deposit: ChequeReminder[]; to_pay: ChequeReminder[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [sales, inventory, cashBalance] = await Promise.all([
          api.get<Sale[]>("/sales"),
          api.get<InventoryUnit[]>("/inventory?status=available"),
          api.get<{ balance: number }>("/cash-book/balance"),
        ]);
        if (cancelled) return;
        setRecentSales(sales.slice(0, 5));
        setStockCount(inventory.length);
        setBalance(cashBalance.balance);
      } catch {
        // summary widgets fail quietly — not critical path
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();

    // Cheque reminders are admin-only server-side and a separate,
    // optional widget — loaded independently so a failure here (e.g. a
    // non-admin account) never blocks the rest of the dashboard.
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

  const todayTotal = recentSales
    .filter((s) => s.date.startsWith(new Date().toISOString().slice(0, 10)))
    .reduce((sum, s) => sum + s.total, 0);

  const hasChequeReminders =
    chequeReminders && (chequeReminders.to_deposit.length > 0 || chequeReminders.to_pay.length > 0);

  return (
    <div>
      <PageHeader title={`Welcome${user?.name ? `, ${user.name}` : ""}`} subtitle="Here's a quick look at where things stand." />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <StatCard label="Today's sales" value={`Rs. ${todayTotal.toLocaleString()}`} />
        <StatCard label="Units in stock" value={stockCount !== null ? String(stockCount) : "—"} />
        <StatCard label="Cash book balance" value={balance !== null ? `Rs. ${balance.toLocaleString()}` : "—"} />
      </div>

      {hasChequeReminders && (
        <Card className="mb-6 border-amber-200 bg-amber-50/40">
          <div className="flex items-start gap-2 mb-3">
            <AlertCircle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
            <h2 className="text-base font-semibold text-gray-900">Cheques due today or tomorrow</h2>
          </div>
          <div className="space-y-1.5 text-sm">
            {chequeReminders!.to_deposit.map((c) => (
              <p key={`d-${c.id}`}>
                <span className="text-gray-500">Deposit</span> #{c.cheque_number} ({c.bank_name}) — Rs. {c.amount.toLocaleString()} from{" "}
                {c.customer_name} — {c.cheque_date.slice(0, 10)}
              </p>
            ))}
            {chequeReminders!.to_pay.map((c) => (
              <p key={`p-${c.id}`}>
                <span className="text-gray-500">Pay</span> #{c.cheque_number} ({c.bank_name}) — Rs. {c.amount.toLocaleString()} to{" "}
                {c.supplier_name} — {c.cheque_date.slice(0, 10)}
              </p>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <h2 className="text-base font-semibold text-gray-900 mb-3">Recent activity</h2>
        {loading ? (
          <p className="text-sm text-gray-400">Loading...</p>
        ) : recentSales.length === 0 ? (
          <EmptyState title="No sales recorded yet." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Invoice</Th>
                <Th>Customer</Th>
                <Th>Type</Th>
                <Th>Total</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {recentSales.map((sale) => (
                <tr key={sale.id}>
                  <Td>{sale.invoice}</Td>
                  <Td>{sale.customer_name ?? (sale.deleted_customer_snapshot ? `[Deleted: ${sale.deleted_customer_snapshot}]` : "Walk-in")}</Td>
                  <Td>{sale.sale_type === "online" ? "Online" : "In-Store"}</Td>
                  <Td>Rs. {sale.total.toLocaleString()}</Td>
                  <Td className="capitalize">{sale.payment_status}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
