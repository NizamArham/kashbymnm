import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { Sale, InventoryUnit } from "../lib/types";
import { PageHeader, Card, StatCard, Table, Th, Td, EmptyState } from "../components/ui";

export default function DashboardPage() {
  const { user } = useAuth();
  const [recentSales, setRecentSales] = useState<Sale[]>([]);
  const [stockCount, setStockCount] = useState<number | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

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
    return () => {
      cancelled = true;
    };
  }, []);

  const todayTotal = recentSales
    .filter((s) => s.date.startsWith(new Date().toISOString().slice(0, 10)))
    .reduce((sum, s) => sum + s.total, 0);

  return (
    <div>
      <PageHeader title={`Welcome${user?.name ? `, ${user.name}` : ""}`} subtitle="Here's a quick look at where things stand." />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <StatCard label="Today's sales" value={`Rs. ${todayTotal.toLocaleString()}`} />
        <StatCard label="Units in stock" value={stockCount !== null ? String(stockCount) : "—"} />
        <StatCard label="Cash book balance" value={balance !== null ? `Rs. ${balance.toLocaleString()}` : "—"} />
      </div>

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
                  <Td>{sale.customer_name ?? "Walk-in"}</Td>
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
