import { useEffect, useMemo, useState } from "react";
import { ChevronUp, ChevronDown, Download, BarChart3 } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { PageHeader, Card, StatCard, Table, Th, Td, ErrorText, DateRangePicker, Button, EmptyState } from "../components/ui";
import { RevenueProfitChart, RevenueProfitPoint } from "../components/RevenueChart";
import { downloadTabularReport, buildReportFilename, todayLongDate, rangeLabelFor } from "../lib/reportPdf";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";

type RangeTab = "today" | "week" | "month" | "year";

const TABS: { value: RangeTab; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "year", label: "This Year" },
];

interface ProductRow {
  product_id: number;
  product_title: string;
  brand: string | null;
  category: string | null;
  units: number;
  revenue: number;
  cost: number;
  profit: number;
  margin_pct: number;
}
interface CategoryRow {
  category: string;
  units: number;
  revenue: number;
  cost: number;
  profit: number;
  margin_pct: number;
}
interface Totals {
  gross_revenue: number;
  returns_amount: number;
  returns_count: number;
  revenue: number;
  cost: number;
  profit: number;
  margin_pct: number;
  orders: number;
  units: number;
  avg_order_value: number;
}
interface AnalyticsResponse {
  range: { start: string; end: string };
  totals: Totals;
  previous_totals: Totals;
  by_product: ProductRow[];
  by_category: CategoryRow[];
  trend: { date: string; revenue: number; profit: number }[];
}

// null when there's no comparable baseline (previous period had nothing),
// rather than showing a meaningless "+Infinity%" or misleading "+100%".
function deltaPct(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

type ProductSortKey = "product_title" | "units" | "revenue" | "cost" | "profit" | "margin_pct";
type CategorySortKey = "category" | "units" | "revenue" | "cost" | "profit" | "margin_pct";
type SortDir = "asc" | "desc";

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function formatShortDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// Shared sortable-column header for the two report tables below — click
// toggles asc/desc on that column, same interaction as Browse Categories.
function SortHeader<K extends string>({
  label,
  sortKey,
  activeKey,
  dir,
  onClick,
  align,
}: {
  label: string;
  sortKey: K;
  activeKey: K;
  dir: SortDir;
  onClick: (key: K) => void;
  align?: "right";
}) {
  const isActive = activeKey === sortKey;
  return (
    <Th className={align === "right" ? "text-right" : ""}>
      <button
        onClick={() => onClick(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-gray-700 transition-colors ${
          align === "right" ? "flex-row-reverse" : ""
        } ${isActive ? "text-gray-900" : ""}`}
      >
        {label}
        {isActive ? dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} /> : null}
      </button>
    </Th>
  );
}

export default function AnalyticsPage() {
  const [activeTab, setActiveTab] = useState<RangeTab>("month");
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);

  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [productSortKey, setProductSortKey] = useState<ProductSortKey>("revenue");
  const [productSortDir, setProductSortDir] = useState<SortDir>("desc");
  const [categorySortKey, setCategorySortKey] = useState<CategorySortKey>("revenue");
  const [categorySortDir, setCategorySortDir] = useState<SortDir>("desc");

  // Resolves whichever preset tab (or explicit custom range) is active
  // into concrete start/end dates — same derivation Sale History uses.
  const { rangeStart, rangeEnd, rangeLabel } = useMemo(() => {
    if (startDate && endDate) {
      return { rangeStart: startDate, rangeEnd: endDate, rangeLabel: rangeLabelFor(startDate, endDate) };
    }
    const today = toISODate(new Date());
    if (activeTab === "today") return { rangeStart: today, rangeEnd: today, rangeLabel: "Today" };
    if (activeTab === "week") {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 6);
      return { rangeStart: toISODate(weekAgo), rangeEnd: today, rangeLabel: "This Week" };
    }
    if (activeTab === "year") {
      const now = new Date();
      return { rangeStart: `${now.getFullYear()}-01-01`, rangeEnd: today, rangeLabel: "This Year" };
    }
    const now = new Date();
    const monthStart = toISODate(new Date(now.getFullYear(), now.getMonth(), 1));
    return { rangeStart: monthStart, rangeEnd: today, rangeLabel: "This Month" };
  }, [activeTab, startDate, endDate]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get<AnalyticsResponse>(`/analytics?start=${rangeStart}&end=${rangeEnd}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Failed to load analytics"))
      .finally(() => setLoading(false));
  }, [rangeStart, rangeEnd]);

  function toggleProductSort(key: ProductSortKey) {
    if (productSortKey === key) setProductSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setProductSortKey(key);
      setProductSortDir("desc");
    }
  }
  function toggleCategorySort(key: CategorySortKey) {
    if (categorySortKey === key) setCategorySortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setCategorySortKey(key);
      setCategorySortDir("desc");
    }
  }

  const sortedProducts = useMemo(() => {
    if (!data) return [];
    const sorted = [...data.by_product].sort((a, b) => {
      const cmp =
        productSortKey === "product_title"
          ? a.product_title.localeCompare(b.product_title)
          : a[productSortKey] - b[productSortKey];
      return productSortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [data, productSortKey, productSortDir]);

  const sortedCategories = useMemo(() => {
    if (!data) return [];
    const sorted = [...data.by_category].sort((a, b) => {
      const cmp = categorySortKey === "category" ? a.category.localeCompare(b.category) : a[categorySortKey] - b[categorySortKey];
      return categorySortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [data, categorySortKey, categorySortDir]);

  const chartData: RevenueProfitPoint[] = useMemo(
    () => (data ? data.trend.map((t) => ({ label: formatShortDate(t.date), revenue: t.revenue, profit: t.profit })) : []),
    [data]
  );

  function downloadProductPdf() {
    if (!data) return;
    downloadTabularReport({
      headerLabel: "M&M Clothing — Product Margin Report",
      headerFields: [
        { label: "Period", value: rangeLabel },
        { label: "Generated", value: todayLongDate() },
      ],
      rangeLabel,
      orientation: "landscape",
      columns: [
        { label: "Product", width: 160 },
        { label: "Brand", width: 90 },
        { label: "Category", width: 130 },
        { label: "Units", width: 60, align: "right" },
        { label: "Revenue", width: 90, align: "right" },
        { label: "Cost", width: 90, align: "right" },
        { label: "Profit", width: 90, align: "right" },
        { label: "Margin", width: 70, align: "right" },
      ],
      rows: sortedProducts.map((p) => ({
        cells: [
          p.product_title,
          p.brand ?? "—",
          p.category ?? "—",
          String(p.units),
          `Rs. ${p.revenue.toLocaleString()}`,
          `Rs. ${p.cost.toLocaleString()}`,
          `Rs. ${p.profit.toLocaleString()}`,
          `${p.margin_pct.toFixed(1)}%`,
        ],
      })),
      totalSummary: {
        label: "Total for this view",
        amount: `Rs. ${data.totals.profit.toLocaleString()} profit`,
        note: `Rs. ${data.totals.revenue.toLocaleString()} revenue · ${data.totals.margin_pct.toFixed(1)}% margin`,
      },
      filename: buildReportFilename("Product Margins", rangeLabel),
    });
  }

  useKeyboardShortcut("d", downloadProductPdf, { ctrlOrCmd: true, shift: true, enabled: !!data && data.by_product.length > 0 });

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle="Revenue, profit, and margin across the selected period."
        action={
          <div className="flex items-center gap-2">
            <DateRangePicker
              startDate={startDate}
              endDate={endDate}
              onChange={(s, e) => {
                setStartDate(s);
                setEndDate(e);
              }}
            />
            <Button
              onClick={downloadProductPdf}
              disabled={!data || data.by_product.length === 0}
              className="inline-flex items-center gap-1.5"
              title="Download PDF (Ctrl/Cmd+Shift+D)"
            >
              <Download size={14} />
              Download PDF
            </Button>
          </div>
        }
      />

      <div className="flex items-center gap-2 mb-5 flex-wrap">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => {
              setActiveTab(tab.value);
              setStartDate(null);
              setEndDate(null);
            }}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition ${
              activeTab === tab.value && !startDate ? "bg-black text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-[repeat(15,minmax(0,1fr))] gap-3 mb-5">
            <div className="lg:col-span-3">
              <StatCard
                label="Revenue"
                value={`Rs. ${data.totals.revenue.toLocaleString()}`}
                deltaPct={deltaPct(data.totals.revenue, data.previous_totals.revenue)}
              />
            </div>
            <div className="lg:col-span-3">
              <StatCard
                label="Profit"
                value={`Rs. ${data.totals.profit.toLocaleString()}`}
                deltaPct={deltaPct(data.totals.profit, data.previous_totals.profit)}
              />
            </div>
            <div className="lg:col-span-3">
              <StatCard
                label="Avg order value"
                value={`Rs. ${Math.round(data.totals.avg_order_value).toLocaleString()}`}
                deltaPct={deltaPct(data.totals.avg_order_value, data.previous_totals.avg_order_value)}
              />
            </div>
            <div className="lg:col-span-2">
              <StatCard
                label="Margin"
                value={`${data.totals.margin_pct.toFixed(1)}%`}
                deltaPct={deltaPct(data.totals.margin_pct, data.previous_totals.margin_pct)}
              />
            </div>
            <div className="lg:col-span-2">
              <StatCard
                label="Orders"
                value={data.totals.orders.toLocaleString()}
                deltaPct={deltaPct(data.totals.orders, data.previous_totals.orders)}
              />
            </div>
            <div className="lg:col-span-2">
              <StatCard
                label="Units sold"
                value={data.totals.units.toLocaleString()}
                deltaPct={deltaPct(data.totals.units, data.previous_totals.units)}
              />
            </div>
          </div>

          {data.totals.returns_count > 0 && (
            <p className="-mt-2 mb-5 px-1 text-xs text-gray-500">
              Sales Rs. {data.totals.gross_revenue.toLocaleString()} − Rs. {data.totals.returns_amount.toLocaleString()} returned or
              exchanged for credit ({data.totals.returns_count} item{data.totals.returns_count === 1 ? "" : "s"}, counted on the day
              each was processed) = Rs. {data.totals.revenue.toLocaleString()} revenue.
            </p>
          )}

          <Card className="mb-5">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Revenue & Profit over time</h3>
            {chartData.length === 0 ? (
              <EmptyState icon={BarChart3} title="No sales in this period" />
            ) : (
              <RevenueProfitChart data={chartData} />
            )}
          </Card>

          <Card className="p-0 overflow-hidden mb-5">
            <div className="p-5 pb-0">
              <h3 className="text-sm font-semibold text-gray-900">Margin by product</h3>
            </div>
            {sortedProducts.length === 0 ? (
              <div className="p-5">
                <EmptyState icon={BarChart3} title="No sales in this period" />
              </div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <SortHeader label="Product" sortKey="product_title" activeKey={productSortKey} dir={productSortDir} onClick={toggleProductSort} />
                    <Th>Category</Th>
                    <SortHeader label="Units" sortKey="units" activeKey={productSortKey} dir={productSortDir} onClick={toggleProductSort} align="right" />
                    <SortHeader label="Revenue" sortKey="revenue" activeKey={productSortKey} dir={productSortDir} onClick={toggleProductSort} align="right" />
                    <SortHeader label="Cost" sortKey="cost" activeKey={productSortKey} dir={productSortDir} onClick={toggleProductSort} align="right" />
                    <SortHeader label="Profit" sortKey="profit" activeKey={productSortKey} dir={productSortDir} onClick={toggleProductSort} align="right" />
                    <SortHeader label="Margin" sortKey="margin_pct" activeKey={productSortKey} dir={productSortDir} onClick={toggleProductSort} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {sortedProducts.map((p) => (
                    <tr key={p.product_id} className="hover:bg-gray-50">
                      <Td className="font-medium max-w-xs truncate" title={p.product_title}>
                        {p.product_title}
                        {p.brand && <span className="text-gray-400 font-normal"> · {p.brand}</span>}
                      </Td>
                      <Td className="text-gray-500 truncate max-w-[160px]" title={p.category ?? undefined}>
                        {p.category ?? "—"}
                      </Td>
                      <Td className="text-right">{p.units}</Td>
                      <Td className="text-right">Rs. {p.revenue.toLocaleString()}</Td>
                      <Td className="text-right text-gray-500">Rs. {p.cost.toLocaleString()}</Td>
                      <Td className="text-right font-medium">Rs. {p.profit.toLocaleString()}</Td>
                      <Td className={`text-right ${p.margin_pct <= 0 ? "text-red-500" : p.margin_pct < 15 ? "text-amber-600" : "text-gray-900"}`}>
                        {p.margin_pct.toFixed(1)}%
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card className="p-0 overflow-hidden">
            <div className="p-5 pb-0">
              <h3 className="text-sm font-semibold text-gray-900">Margin by category</h3>
            </div>
            {sortedCategories.length === 0 ? (
              <div className="p-5">
                <EmptyState icon={BarChart3} title="No sales in this period" />
              </div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <SortHeader label="Category" sortKey="category" activeKey={categorySortKey} dir={categorySortDir} onClick={toggleCategorySort} />
                    <SortHeader label="Units" sortKey="units" activeKey={categorySortKey} dir={categorySortDir} onClick={toggleCategorySort} align="right" />
                    <SortHeader label="Revenue" sortKey="revenue" activeKey={categorySortKey} dir={categorySortDir} onClick={toggleCategorySort} align="right" />
                    <SortHeader label="Cost" sortKey="cost" activeKey={categorySortKey} dir={categorySortDir} onClick={toggleCategorySort} align="right" />
                    <SortHeader label="Profit" sortKey="profit" activeKey={categorySortKey} dir={categorySortDir} onClick={toggleCategorySort} align="right" />
                    <SortHeader label="Margin" sortKey="margin_pct" activeKey={categorySortKey} dir={categorySortDir} onClick={toggleCategorySort} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {sortedCategories.map((c) => (
                    <tr key={c.category} className="hover:bg-gray-50">
                      <Td className="font-medium">{c.category}</Td>
                      <Td className="text-right">{c.units}</Td>
                      <Td className="text-right">Rs. {c.revenue.toLocaleString()}</Td>
                      <Td className="text-right text-gray-500">Rs. {c.cost.toLocaleString()}</Td>
                      <Td className="text-right font-medium">Rs. {c.profit.toLocaleString()}</Td>
                      <Td className={`text-right ${c.margin_pct <= 0 ? "text-red-500" : c.margin_pct < 15 ? "text-amber-600" : "text-gray-900"}`}>
                        {c.margin_pct.toFixed(1)}%
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}