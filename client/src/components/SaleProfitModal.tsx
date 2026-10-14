import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Badge, Button, ErrorText, Modal } from "./ui";

interface ProfitItem {
  title: string;
  size: string | null;
  color: string | null;
  quantity: number;
  price: number;
  cost: number | null;
  profit: number | null;
  state: "sold" | "returned" | "returned_damaged" | "swapped";
}
interface ProfitData {
  invoice: string;
  voided: boolean;
  wholesale?: boolean;
  items?: ProfitItem[];
  sold_for?: number;
  items_profit?: number;
  discount?: number;
  goods_profit?: number;
  goods_margin_pct?: number | null;
  delivery?: { partner: string | null; charged: number; courier_cost: number; margin: number; estimated: boolean; note: string | null } | null;
  net_profit?: number;
  unknown_cost_items?: number;
  not_collected?: number;
}

const rs = (n: number) => `${n < 0 ? "−" : ""}Rs. ${Math.abs(Math.round(n * 100) / 100).toLocaleString()}`;
const tone = (n: number) => (n < 0 ? "text-red-600" : n > 0 ? "text-green-700" : "text-gray-900");

// A big (wholesale) bill is dozens of identical-looking pieces. They're added up per product
// here, with the size/colour breakdown one click away.
interface DetailLine {
  label: string;
  quantity: number;
  price: number;
  cost: number | null;
  profit: number | null;
  state: ProfitItem["state"];
}
interface ProductGroup {
  title: string;
  quantity: number;
  price: number;
  cost: number | null;
  profit: number | null;
  returned: number;
  details: DetailLine[];
}

function groupByProduct(items: ProfitItem[]): ProductGroup[] {
  const groups = new Map<string, ProductGroup>();
  for (const i of items) {
    const g = groups.get(i.title) ?? { title: i.title, quantity: 0, price: 0, cost: 0, profit: 0, returned: 0, details: [] };
    g.quantity += i.quantity;
    g.price += i.price;
    g.cost = g.cost == null || i.cost == null ? null : g.cost + i.cost;
    g.profit = g.profit == null || i.profit == null ? null : g.profit + i.profit;
    if (i.state === "returned" || i.state === "returned_damaged") g.returned += i.quantity;
    const label = [i.size, i.color].filter(Boolean).join(" · ") || "—";
    const same = g.details.find((d) => d.label === label && d.state === i.state && d.price / d.quantity === i.price / i.quantity);
    if (same) {
      same.quantity += i.quantity;
      same.price += i.price;
      same.cost = same.cost == null || i.cost == null ? null : same.cost + i.cost;
      same.profit = same.profit == null || i.profit == null ? null : same.profit + i.profit;
    } else {
      g.details.push({ label, quantity: i.quantity, price: i.price, cost: i.cost, profit: i.profit, state: i.state });
    }
    groups.set(i.title, g);
  }
  return Array.from(groups.values());
}

// A product with this many size/colour lines (or more) is folded into one row.
const FOLD_AT = 3;

const STATE_LABEL: Record<ProfitItem["state"], string | null> = { sold: null, swapped: "Swapped", returned: "Returned", returned_damaged: "Returned, damaged" };

// What one bill earned: each piece against what it cost, less the discount, plus what the
// delivery brought in against the courier's charge. Admin only — cost prices are never shown to staff.
export default function SaleProfitModal({ saleId, invoice, onClose }: { saleId: number; invoice: string; onClose: () => void }) {
  const [data, setData] = useState<ProfitData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ProfitData>(`/sales/${saleId}/profit`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Couldn't work out the profit"));
  }, [saleId]);

  const [open, setOpen] = useState<Set<string>>(new Set());
  const groups = useMemo(() => groupByProduct(data?.items ?? []), [data]);
  const toggle = (title: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });

  const kept = data?.items?.filter((i) => i.state === "sold" || i.state === "swapped") ?? [];
  const costOfGoods = kept.reduce((sum, i) => sum + (i.cost ?? 0), 0);

  return (
    <Modal
      size="xl"
      onClose={onClose}
      title={`Profit on ${invoice}`}
      subtitle="What this bill earned, after what each piece cost you"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {error && <ErrorText>{error}</ErrorText>}
      {!data && !error && <p className="py-6 text-sm text-gray-400">Working it out…</p>}

      {data?.voided && <p className="py-6 text-sm text-gray-500">This invoice was voided, so it earned nothing.</p>}

      {data && !data.voided && data.items && (
        <div className="space-y-5">
          <div className="rounded-xl bg-gray-50 px-5 py-4">
            <p className="text-xs text-gray-400">Profit on this bill</p>
            <p className={`mt-0.5 text-3xl font-semibold tabular-nums ${tone(data.net_profit ?? 0)}`}>{rs(data.net_profit ?? 0)}</p>
            {data.goods_margin_pct != null && (
              <p className="mt-1 text-xs text-gray-500">
                {data.goods_margin_pct.toFixed(1)}% margin on the goods
                {data.delivery && data.delivery.margin !== 0 && (
                  <>
                    {" · "}delivery {data.delivery.margin > 0 ? "added" : "cost"} {rs(Math.abs(data.delivery.margin))}
                  </>
                )}
              </p>
            )}
          </div>

          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl bg-gray-100">
            {[
              { label: "Sold for", value: rs(data.sold_for ?? 0), hint: (data.discount ?? 0) > 0.009 ? `after ${rs(data.discount ?? 0)} discount` : undefined },
              { label: "Cost of goods", value: rs(costOfGoods) },
              { label: "Profit on goods", value: rs(data.goods_profit ?? 0), className: tone(data.goods_profit ?? 0) },
            ].map((s) => (
              <div key={s.label} className="bg-white px-4 py-3">
                <p className="text-xs text-gray-400">{s.label}</p>
                <p className={`mt-0.5 text-base font-semibold tabular-nums ${s.className ?? "text-gray-900"}`}>{s.value}</p>
                {s.hint && <p className="mt-0.5 text-[11px] text-gray-400">{s.hint}</p>}
              </div>
            ))}
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-gray-400">
              {data.items.reduce((n, i) => n + i.quantity, 0)} piece{data.items.reduce((n, i) => n + i.quantity, 0) === 1 ? "" : "s"}
              {groups.length > 1 ? ` · ${groups.length} products` : ""}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-400">
                    <th className="py-1.5 pr-3 text-left font-medium">Product</th>
                    <th className="px-3 py-1.5 text-right font-medium">Sold for</th>
                    <th className="px-3 py-1.5 text-right font-medium">Cost</th>
                    <th className="py-1.5 pl-3 text-right font-medium">Profit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {groups.map((g) => {
                    // A couple of lines stay as they are; a long run of sizes and colours folds into the product.
                    if (g.details.length < (data.wholesale ? 2 : FOLD_AT)) {
                      return g.details.map((d, idx) => {
                        const back = d.state === "returned" || d.state === "returned_damaged";
                        return (
                          <tr key={`${g.title}-${idx}`} className={back ? "text-gray-400" : "text-gray-900"}>
                            <td className="py-2 pr-3">
                              <span className={back ? "line-through" : ""}>
                                {g.title}
                                {d.quantity > 1 && <span className="ml-1.5 text-gray-500">× {d.quantity}</span>}
                              </span>
                              {d.label !== "—" && <span className="ml-2 text-xs text-gray-400">{d.label}</span>}
                              {STATE_LABEL[d.state] && (
                                <span className="ml-2 align-middle">
                                  <Badge label={STATE_LABEL[d.state]!} />
                                </span>
                              )}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{rs(d.price)}</td>
                            <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{d.cost == null ? "?" : rs(d.cost)}</td>
                            <td className={`whitespace-nowrap py-2 pl-3 text-right font-medium tabular-nums ${d.profit == null || back ? "" : tone(d.profit)}`}>{d.profit == null ? "?" : rs(d.profit)}</td>
                          </tr>
                        );
                      });
                    }
                    const expandable = true;
                    const isOpen = open.has(g.title);
                    const allBack = g.returned === g.quantity;
                    return (
                      <Fragment key={g.title}>
                        <tr
                          onClick={expandable ? () => toggle(g.title) : undefined}
                          className={`${allBack ? "text-gray-400" : "text-gray-900"} ${expandable ? "cursor-pointer hover:bg-gray-50" : ""}`}
                        >
                          <td className="py-2 pr-3">
                            <span className="inline-flex items-center gap-1.5">
                              {expandable ? (
                                isOpen ? <ChevronDown size={13} className="text-gray-400" /> : <ChevronRight size={13} className="text-gray-400" />
                              ) : null}
                              <span className={allBack ? "line-through" : ""}>
                                {g.title}
                                {g.quantity > 1 && <span className="ml-1.5 text-gray-500">× {g.quantity}</span>}
                              </span>
                            </span>
                            <span className="ml-2 text-xs text-gray-400">{g.details.length} size / colour lines</span>
                            {g.returned > 0 && (
                              <span className="ml-2 align-middle">
                                <Badge label={allBack ? "Returned" : `${g.returned} returned`} />
                              </span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{rs(g.price)}</td>
                          <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{g.cost == null ? "?" : rs(g.cost)}</td>
                          <td className={`whitespace-nowrap py-2 pl-3 text-right font-medium tabular-nums ${g.profit == null || allBack ? "" : tone(g.profit)}`}>{g.profit == null ? "?" : rs(g.profit)}</td>
                        </tr>
                        {expandable &&
                          isOpen &&
                          g.details.map((d, idx) => {
                            const back = d.state === "returned" || d.state === "returned_damaged";
                            return (
                              <tr key={`${g.title}-${idx}`} className={`bg-gray-50/70 text-xs ${back ? "text-gray-400" : "text-gray-600"}`}>
                                <td className="py-1.5 pl-6 pr-3">
                                  <span className={back ? "line-through" : ""}>
                                    {d.label}
                                    {d.quantity > 1 && <span className="ml-1.5 text-gray-400">× {d.quantity}</span>}
                                  </span>
                                  {STATE_LABEL[d.state] && <span className="ml-2 text-gray-400">{STATE_LABEL[d.state]}</span>}
                                </td>
                                <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{rs(d.price)}</td>
                                <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{d.cost == null ? "?" : rs(d.cost)}</td>
                                <td className="whitespace-nowrap py-1.5 pl-3 text-right tabular-nums">{d.profit == null ? "?" : rs(d.profit)}</td>
                              </tr>
                            );
                          })}
                      </Fragment>
                    );
                  })}
                  {(data.discount ?? 0) > 0.009 && (
                    <tr className="text-gray-600">
                      <td className="py-2 pr-3">Discount given</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{rs(data.discount ?? 0)}</td>
                      <td className="px-3 py-2" />
                      <td className="whitespace-nowrap py-2 pl-3 text-right font-medium tabular-nums text-red-600">{rs(-(data.discount ?? 0))}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {data.delivery && (
            <div className="rounded-xl border border-gray-200 px-4 py-3 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-medium text-gray-900">Delivery{data.delivery.partner ? ` · ${data.delivery.partner}` : ""}</p>
                <p className={`font-semibold tabular-nums ${tone(data.delivery.margin)}`}>{rs(data.delivery.margin)}</p>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Customer paid {rs(data.delivery.charged)} · courier charge {rs(data.delivery.courier_cost)}
                {data.delivery.estimated && data.delivery.courier_cost > 0 ? " (estimate — not checked against their bill yet)" : ""}
              </p>
              {data.delivery.note && <p className="mt-1 text-xs text-gray-400">{data.delivery.note}</p>}
            </div>
          )}

          <div className="space-y-1 text-xs text-gray-400">
            {(data.not_collected ?? 0) > 0.009 && <p>{rs(data.not_collected ?? 0)} of this bill hasn't been collected yet — the profit above counts it as if it will be.</p>}
            {(data.unknown_cost_items ?? 0) > 0 && <p>{data.unknown_cost_items} piece{data.unknown_cost_items === 1 ? "" : "s"} no longer in the system, so their cost is unknown and left out.</p>}
            <p>Cost is what each piece itself cost when it was stocked — not the product's current cost price.</p>
          </div>
        </div>
      )}
    </Modal>
  );
}
