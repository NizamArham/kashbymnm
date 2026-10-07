import { Router } from "express";
import { db } from "../db/connection";
import { ApiError, asyncHandler } from "../lib/errors";
import { requireAuth, requireRole } from "../lib/auth";
import { returnsInRange } from "../lib/returnedRevenue";

export const analyticsRouter = Router();

// Financial data — admin only, same split as products' cost_price.
analyticsRouter.use(requireAuth, requireRole("admin"));

interface ItemRow {
  sale_id: number;
  quantity: number;
  line_total: number;
  product_id: number | null;
  cost_price: number | null;
  product_title: string | null;
  brand: string | null;
  category: string | null;
}

// Just the top-level category name — same split as categories.ts, kept
// separate since this route doesn't share code with it.
function topCategory(raw: string | null): string {
  if (!raw) return "Unspecified";
  const withoutGender = raw.replace(/\s*\([^)]*\)\s*$/, "");
  const category = withoutGender.split(" / ")[0]?.trim();
  return category || "Unspecified";
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function monthStartISO(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysBetweenInclusive(start: string, end: string): number {
  const s = new Date(start + "T00:00:00Z").getTime();
  const e = new Date(end + "T00:00:00Z").getTime();
  return Math.round((e - s) / 86400000) + 1;
}

interface Totals {
  // Sales rung up in the range, before any returns.
  gross_revenue: number;
  // What was handed back in the range: store credit given for returned items
  // plus cash/bank refunds, and how many items that was.
  returns_amount: number;
  returns_count: number;
  // gross_revenue minus returns_amount — what the range really brought in.
  revenue: number;
  cost: number;
  profit: number;
  margin_pct: number;
  orders: number;
  units: number;
  avg_order_value: number;
}

// The plain KPI totals for a date range, with no per-product/category
// breakdown — used both for the requested range and for the comparison
// period, so the two numbers are computed identically.
function computeTotals(start: string, end: string): Totals {
  const salesInRange = db
    .prepare(`SELECT total FROM sales WHERE is_voided = 0 AND status = 'completed' AND date(date) BETWEEN date(?) AND date(?)`)
    .all(start, end) as { total: number }[];

  const gross_revenue = salesInRange.reduce((sum, s) => sum + s.total, 0);
  const orders = salesInRange.length;
  const returned = returnsInRange(start, end);
  const returns_amount = returned.reduce((sum, r) => sum + r.amount, 0);
  const revenue = gross_revenue - returns_amount;

  const itemAgg = db
    .prepare(
      `SELECT COALESCE(SUM(si.quantity), 0) as units, COALESCE(SUM(si.quantity * COALESCE(i.cost_price, 0)), 0) as cost
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN inventory i ON i.id = si.inventory_id
       WHERE s.is_voided = 0 AND s.status = 'completed' AND date(s.date) BETWEEN date(?) AND date(?)`
    )
    .get(start, end) as { units: number; cost: number };

  const cost = itemAgg.cost - returned.reduce((sum, r) => sum + r.cost, 0);
  const profit = revenue - cost;
  return {
    gross_revenue,
    returns_amount,
    returns_count: returned.length,
    revenue,
    cost,
    profit,
    margin_pct: revenue > 0 ? (profit / revenue) * 100 : 0,
    orders,
    units: itemAgg.units - returned.length,
    avg_order_value: orders > 0 ? revenue / orders : 0,
  };
}

analyticsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const start = String(req.query.start ?? monthStartISO());
    const end = String(req.query.end ?? todayISO());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      throw new ApiError(400, "start and end must be YYYY-MM-DD");
    }

    const totals = computeTotals(start, end);

    // Comparison period: the same number of days immediately before this
    // one (not the previous calendar month/week), so a partial "This
    // Month" (e.g. only 12 days in) is compared against 12 days too,
    // rather than a misleadingly larger full prior month.
    const durationDays = daysBetweenInclusive(start, end);
    const previousEnd = addDaysISO(start, -1);
    const previousStart = addDaysISO(previousEnd, -(durationDays - 1));
    const previous_totals = computeTotals(previousStart, previousEnd);

    const items = db
      .prepare(
        `SELECT si.sale_id, si.quantity, si.line_total, i.product_id, i.cost_price,
                p.product_title, p.brand, p.category
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN inventory i ON i.id = si.inventory_id
         LEFT JOIN products p ON p.id = i.product_id
         WHERE s.is_voided = 0 AND s.status = 'completed' AND date(s.date) BETWEEN date(?) AND date(?)`
      )
      .all(start, end) as ItemRow[];

    const salesInRange = db
      .prepare(`SELECT id, date, total FROM sales WHERE is_voided = 0 AND status = 'completed' AND date(date) BETWEEN date(?) AND date(?)`)
      .all(start, end) as { id: number; date: string; total: number }[];

    // ---- By product (item-level gross figures — pre order-level discount,
    // matching how most per-SKU margin reporting works; the totals above,
    // which use sales.total, are the true post-discount numbers) ----
    const byProduct = new Map<
      number,
      { product_id: number; product_title: string; brand: string | null; category: string | null; units: number; revenue: number; cost: number }
    >();
    for (const it of items) {
      if (it.product_id == null) continue;
      const existing = byProduct.get(it.product_id);
      if (existing) {
        existing.units += it.quantity;
        existing.revenue += it.line_total;
        existing.cost += it.quantity * (it.cost_price ?? 0);
      } else {
        byProduct.set(it.product_id, {
          product_id: it.product_id,
          product_title: it.product_title ?? "—",
          brand: it.brand,
          category: it.category,
          units: it.quantity,
          revenue: it.line_total,
          cost: it.quantity * (it.cost_price ?? 0),
        });
      }
    }
    const returned = returnsInRange(start, end);
    for (const r of returned) {
      if (r.product_id == null) continue;
      // An item sold on an earlier day and returned in this range has no sales
      // row here yet — it gets its own, so the table still adds up to the totals.
      let existing = byProduct.get(r.product_id);
      if (!existing) {
        existing = {
          product_id: r.product_id,
          product_title: r.product_title ?? "—",
          brand: r.brand,
          category: r.category,
          units: 0,
          revenue: 0,
          cost: 0,
        };
        byProduct.set(r.product_id, existing);
      }
      existing.units -= 1;
      existing.revenue -= r.amount;
      existing.cost -= r.cost;
    }
    const by_product = Array.from(byProduct.values())
      .filter((p) => p.units !== 0 || p.revenue !== 0 || p.cost !== 0)
      .map((p) => ({
        ...p,
        profit: p.revenue - p.cost,
        margin_pct: p.revenue > 0 ? ((p.revenue - p.cost) / p.revenue) * 100 : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    // ---- By category (rolled up from the same item rows) ----
    const byCategory = new Map<string, { category: string; units: number; revenue: number; cost: number }>();
    for (const it of items) {
      const cat = topCategory(it.category);
      const existing = byCategory.get(cat);
      const itemCost = it.quantity * (it.cost_price ?? 0);
      if (existing) {
        existing.units += it.quantity;
        existing.revenue += it.line_total;
        existing.cost += itemCost;
      } else {
        byCategory.set(cat, { category: cat, units: it.quantity, revenue: it.line_total, cost: itemCost });
      }
    }
    for (const r of returned) {
      const cat = topCategory(r.category);
      let existing = byCategory.get(cat);
      if (!existing) {
        existing = { category: cat, units: 0, revenue: 0, cost: 0 };
        byCategory.set(cat, existing);
      }
      existing.units -= 1;
      existing.revenue -= r.amount;
      existing.cost -= r.cost;
    }
    const by_category = Array.from(byCategory.values())
      .filter((c) => c.units !== 0 || c.revenue !== 0 || c.cost !== 0)
      .map((c) => ({
        ...c,
        profit: c.revenue - c.cost,
        margin_pct: c.revenue > 0 ? ((c.revenue - c.cost) / c.revenue) * 100 : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    // ---- Daily trend ----
    const revenueByDay = new Map<string, number>();
    for (const s of salesInRange) {
      const day = s.date.slice(0, 10);
      revenueByDay.set(day, (revenueByDay.get(day) ?? 0) + s.total);
    }
    // Items don't carry a date of their own — look each one's day up from
    // its parent sale instead.
    const costByDay = new Map<string, number>();
    const saleDateById = new Map(salesInRange.map((s) => [s.id, s.date.slice(0, 10)]));
    for (const it of items) {
      const day = saleDateById.get(it.sale_id);
      if (!day) continue;
      costByDay.set(day, (costByDay.get(day) ?? 0) + it.quantity * (it.cost_price ?? 0));
    }
    // Returns come off the day they were processed, in revenue and (when the
    // unit went back on the shelf) in cost.
    for (const r of returned) {
      revenueByDay.set(r.day, (revenueByDay.get(r.day) ?? 0) - r.amount);
      costByDay.set(r.day, (costByDay.get(r.day) ?? 0) - r.cost);
    }
    const allDays = Array.from(new Set([...revenueByDay.keys(), ...costByDay.keys()])).sort();
    const trend = allDays.map((day) => {
      const dayRevenue = revenueByDay.get(day) ?? 0;
      const dayCost = costByDay.get(day) ?? 0;
      return { date: day, revenue: dayRevenue, profit: dayRevenue - dayCost };
    });

    res.json({
      range: { start, end },
      totals,
      previous_totals,
      by_product,
      by_category,
      trend,
    });
  })
);
