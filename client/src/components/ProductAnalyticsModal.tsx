import { ReactNode, useEffect, useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { Button, ErrorText, Modal } from "./ui";
import { PRODUCT_POPUP } from "./ProductViewTabs";

interface Analytics {
  product: { id: number; product_title: string; selling_price: number };
  bought: { unit_cost: number; pieces: number; cost: number }[];
  invested: number;
  pieces_bought: number;
  cost_unknown: number;
  sold: { unit_price: number; pieces: number; revenue: number; cost: number }[];
  pieces_sold: number;
  revenue: number;
  cost_of_sold: number;
  on_shelf: { pieces: number; cost: number; worth: number; prices: number[] };
  written_off: { pieces: number; cost: number };
  sent_back: { pieces: number; cost: number };
  taken_out: { pieces: number; cost: number; note: string | null };
  sold_no_invoice: { pieces: number; cost: number };
  not_in_stock_list: { pieces: number; cost: number };
}

const rs = (n: number) => `Rs. ${Math.round(n).toLocaleString()}`;
// Profit and loss read as +/− so the direction is clear at a glance.
const signed = (n: number) => `${n < 0 ? "−" : "+"}${rs(Math.abs(n))}`;
const pcs = (n: number) => `${n} pc${n === 1 ? "" : "s"}`;

// One product's money story, in the shape the owner thinks about it: what was
// put in (10 pcs × Rs. 2,450), what was sold (5 pcs × Rs. 3,450), what that
// made, and what is still sitting on the shelf. Admin only — the numbers come
// from an admin-only endpoint.
export default function ProductAnalyticsModal({ productId, productTitle, onClose, tabs }: { productId: number; productTitle: string; onClose: () => void; tabs?: ReactNode }) {
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Analytics>(`/products/${productId}/analytics`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Couldn't load this product's numbers"));
  }, [productId]);

  const profit = data ? data.revenue - data.cost_of_sold : 0;

  // Money that is really out of pocket: everything bought, less what went back to the supplier.
  const outOfPocket = data ? data.invested - data.sent_back.cost : 0;
  const net = data ? data.revenue - outOfPocket : 0;
  const paidBackPct = data && outOfPocket > 0 ? Math.min(100, Math.round((data.revenue / outOfPocket) * 100)) : 0;

  // The target: how many more pieces must sell, at what price, for the money back to reach what was put in.
  // The price is what the pieces on the shelf are marked at today (their average if they differ).
  const target = (() => {
    if (!data || net >= 0) return null;
    const toRecover = -net;
    const shelf = data.on_shelf;
    if (shelf.pieces === 0) return { kind: "none" as const, toRecover };
    const mixed = shelf.prices.length > 1;
    const price = mixed ? Math.round(shelf.worth / shelf.pieces) : shelf.prices[0];
    if (!(price > 0)) return null;
    const need = Math.ceil(toRecover / price);
    if (need <= shelf.pieces) return { kind: "ok" as const, need, price, mixed, total: need * price, shelf: shelf.pieces };
    return { kind: "short" as const, price, mixed, pieces: shelf.pieces, total: shelf.pieces * price, short: toRecover - shelf.pieces * price, needEach: Math.ceil(toRecover / shelf.pieces) };
  })();

  return (
    <Modal
      size={PRODUCT_POPUP.size}
      height={PRODUCT_POPUP.height}
      onClose={onClose}
      tabs={tabs}
      title={`Analytics — ${productTitle}`}
      subtitle={data ? `${pcs(data.pieces_bought)} bought · ${pcs(data.pieces_sold)} sold` : error ? undefined : "Loading…"}
      footer={
        <>
          {data && data.pieces_bought > 0 && (
            <p className="mr-auto hidden text-xs text-gray-400 sm:block">Cost is each piece's own cost price. Voided invoices and returned pieces are left out of what was sold.</p>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {error && <ErrorText>{error}</ErrorText>}
      {data && data.pieces_bought === 0 && <p className="text-sm text-gray-500">No stock has been added for this product yet, so there is nothing to work out.</p>}
      {data && data.pieces_bought > 0 && (
        // Summary on the left, the headline numbers on the right. On a wide screen both fit without scrolling; on a phone they stack.
        <div className="grid gap-x-8 gap-y-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="space-y-3">
            <Section title="What you put in">
              {data.bought.map((g) => (
                <Line
                  key={g.unit_cost}
                  left={g.unit_cost > 0 ? `${pcs(g.pieces)} × ${rs(g.unit_cost)}` : `${pcs(g.pieces)} — cost not recorded`}
                  right={rs(g.cost)}
                />
              ))}
              <Line left="Total invested" right={rs(data.invested)} strong />
              {data.not_in_stock_list.pieces > 0 && (
                <p className="py-1 text-xs text-amber-700">
                  {pcs(data.not_in_stock_list.pieces)} of these was sold on an invoice but isn't in the stock list, so it is counted as bought at its cost.
                </p>
              )}
            </Section>

            <Section title="What you sold">
              {data.sold.length === 0 && <p className="py-1 text-sm text-gray-500">Nothing sold on an invoice yet.</p>}
              {data.sold.map((g) => (
                <Line key={g.unit_price} left={`${pcs(g.pieces)} × ${rs(g.unit_price)}`} right={rs(g.revenue)} />
              ))}
              {data.sold.length > 0 && (
                <>
                  <Line left="Total sold" right={rs(data.revenue)} strong />
                  <Line left={`Those ${pcs(data.pieces_sold)} cost`} right={`− ${rs(data.cost_of_sold)}`} muted />
                  <Line left="Profit on them" right={signed(profit)} strong tone={profit >= 0 ? "good" : "bad"} />
                </>
              )}
            </Section>

            <Section title="The rest of the stock">
              <Line
                left={`On the shelf — ${pcs(data.on_shelf.pieces)}`}
                right={rs(data.on_shelf.cost)}
                hint={data.on_shelf.pieces > 0 ? `cost · worth ${rs(data.on_shelf.worth)} at today's prices` : undefined}
              />
              {data.written_off.pieces > 0 && (
                <Line left={`Written off — ${pcs(data.written_off.pieces)}`} right={`− ${rs(data.written_off.cost)}`} hint="damaged, gifted, lost or stolen" tone="bad" />
              )}
              {data.taken_out.pieces > 0 && (
                <Line left={`Taken out of stock — ${pcs(data.taken_out.pieces)}`} right={rs(data.taken_out.cost)} hint={data.taken_out.note ?? "removed from stock for another reason"} />
              )}
              {data.sent_back.pieces > 0 && <Line left={`Sent back to supplier — ${pcs(data.sent_back.pieces)}`} right={rs(data.sent_back.cost)} hint="not counted as money out" />}
              {data.sold_no_invoice.pieces > 0 && (
                <Line left={`Sold, no invoice on record — ${pcs(data.sold_no_invoice.pieces)}`} right={rs(data.sold_no_invoice.cost)} hint="cost; no sales amount to show" />
              )}
            </Section>
          </div>

          {/* The question this answers: has the money put in come back yet? Profit is a smaller line below. */}
          <div className="order-first lg:order-none lg:border-l lg:border-gray-100 lg:pl-8">
            <div className="space-y-4">
              <div>
                <p className="text-xs text-gray-500">Invested</p>
                <p className="text-3xl font-medium tabular-nums text-gray-900">{rs(outOfPocket)}</p>
                {data.sent_back.pieces > 0 && <p className="text-xs text-gray-500">after {rs(data.sent_back.cost)} sent back to the supplier</p>}
              </div>
              <div>
                <p className="text-xs text-gray-500">Cash back from sales</p>
                <p className="text-3xl font-medium tabular-nums text-gray-900">{rs(data.revenue)}</p>
                <p className="text-xs text-gray-500">{pcs(data.pieces_sold)} sold</p>
              </div>

              {outOfPocket > 0 && (
                <div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-gray-200" role="progressbar" aria-valuenow={paidBackPct} aria-valuemin={0} aria-valuemax={100} aria-label="Share of the money invested that has come back">
                    <div className={`h-full rounded-full ${net >= 0 ? "bg-emerald-500" : "bg-gray-700"}`} style={{ width: `${paidBackPct}%` }} />
                  </div>
                  <p className="mt-1 text-xs tabular-nums text-gray-500">{paidBackPct}% back</p>
                </div>
              )}

              <div className={`rounded-xl px-4 py-3 ${net >= 0 ? "bg-emerald-50" : "bg-amber-50"}`}>
                <p className={`flex items-center gap-1.5 text-sm font-medium ${net >= 0 ? "text-emerald-600" : "text-amber-600"}`}>
                  <span className={`h-2 w-2 rounded-full ${net >= 0 ? "bg-emerald-500" : "bg-amber-500"}`} />
                  {net >= 0 ? "Covered" : "Not covered yet"}
                </p>
                <p className="mt-0.5 text-xl font-medium tabular-nums text-gray-900">{net >= 0 ? `${rs(net)} ahead` : `${rs(-net)} to recover`}</p>
              </div>

              {target && (
                <div className="rounded-xl border border-gray-200 px-4 py-3">
                  {target.kind === "ok" && (
                    <>
                      <p className="text-xs text-gray-500">Target to cover</p>
                      <p className="mt-0.5 text-xl font-medium tabular-nums text-gray-900">
                        Sell {pcs(target.need)} × {target.mixed ? "about " : ""}{rs(target.price)}
                      </p>
                      <p className="text-xs tabular-nums text-gray-500">= {rs(target.total)} · {target.shelf} on the shelf</p>
                    </>
                  )}
                  {target.kind === "short" && (
                    <>
                      <p className="text-xs text-amber-600">Can't cover at today's price</p>
                      <p className="mt-0.5 text-xl font-medium tabular-nums text-gray-900">
                        All {pcs(target.pieces)} × {target.mixed ? "about " : ""}{rs(target.price)}
                      </p>
                      <p className="text-xs tabular-nums text-gray-500">
                        = {rs(target.total)} · still {rs(target.short)} short · needs {rs(target.needEach)} each
                      </p>
                    </>
                  )}
                  {target.kind === "none" && (
                    <>
                      <p className="text-xs text-amber-600">Target to cover</p>
                      <p className="mt-0.5 text-xl font-medium text-gray-900">Nothing left to sell</p>
                      <p className="text-xs tabular-nums text-gray-500">{rs(target.toRecover)} will not come back</p>
                    </>
                  )}
                </div>
              )}

              <div className="divide-y divide-gray-100 border-y border-gray-100 text-sm">
                <div className="flex items-center justify-between py-2">
                  <span className="text-gray-600">Profit on sold items</span>
                  <span className={`font-medium tabular-nums ${data.pieces_sold === 0 ? "text-gray-400" : profit >= 0 ? "text-emerald-600" : "text-red-600"}`}>{data.pieces_sold === 0 ? "—" : signed(profit)}</span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-gray-600">Stock left, at cost</span>
                  <span className="font-medium tabular-nums text-gray-900">{rs(data.on_shelf.cost)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-1.5">{title}</p>
      <div className="divide-y divide-gray-100 border-y border-gray-100">{children}</div>
    </div>
  );
}

function Line({ left, right, hint, strong, muted, tone }: { left: string; right: string; hint?: string; strong?: boolean; muted?: boolean; tone?: "good" | "bad" }) {
  const rightColor = tone === "good" ? "text-emerald-600" : tone === "bad" ? "text-red-600" : muted ? "text-gray-500" : "text-gray-900";
  return (
    <div className="flex items-start justify-between gap-3 py-1 text-sm">
      <div className="min-w-0">
        <p className={strong ? "font-medium text-gray-900" : muted ? "text-gray-500" : "text-gray-700"}>{left}</p>
        {hint && <p className="text-xs leading-snug text-gray-500">{hint}</p>}
      </div>
      <p className={`flex-shrink-0 tabular-nums ${strong ? "font-medium" : ""} ${rightColor}`}>{right}</p>
    </div>
  );
}
