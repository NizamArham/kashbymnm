import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageLoader } from "../components/Loader";
import { api, ApiRequestError } from "../lib/api";
import { Card, PageHeader, Table, Th, Td, Badge, ErrorText, RefLink, Button } from "../components/ui";
import { formatDate } from "../lib/dates";

interface CashLine {
  id: number;
  transaction_code: string | null;
  entry_date: string;
  payment_method: string | null;
  amount: number;
  notes: string | null;
}

interface PurchaseDetail {
  id: number;
  purchase_code: string;
  supplier_id: number;
  supplier_name: string;
  supplier_code: string;
  purchase_date: string;
  total_cost: number;
  amount_paid: number;
  payment_status: "paid" | "partial" | "unpaid";
  fulfillment_status: "pending" | "fulfilled";
  description: string | null;
  // What was bought, as entered when the goods arrived (a rough line each), and how much of each has been sorted into stock.
  lines: { id: number; description: string; quantity: number; unit_cost: number; fulfilled_quantity: number }[];
  // The real pieces that went into stock from it, by size and colour.
  items: { id: number; product_id: number | null; product_title: string | null; size: string | null; color: string | null; quantity: number; unit_cost: number }[];
  payments: { id: number; payment_date: string; amount: number; method: string | null; notes: string | null; transaction_code: string | null }[];
  at_purchase: CashLine[];
  extra_costs: CashLine[];
}

const money = (n: number) => `Rs. ${n.toLocaleString()}`;
const PAYMENT_WORD = { paid: "Paid", partial: "Part paid", unpaid: "Unpaid" } as const;
const how = (m: string | null) => (m ? m.replace(/_/g, " ") : null);

// One purchase from a supplier on a page of its own: what was bought (quantity, cost each, line total), the pieces sorted into stock from it,
// and every payment and extra cost against it, each with its transaction ID.
export default function PurchaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [purchase, setPurchase] = useState<PurchaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setPurchase(null);
    setError(null);
    api
      .get<PurchaseDetail>(`/purchases/${id}/detail`)
      .then((p) => {
        if (!cancelled) setPurchase(p);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiRequestError ? err.message : "Couldn't load this purchase");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const hasLines = !!purchase && purchase.lines.length > 0;
  const boughtTotal = purchase ? purchase.lines.reduce((s, l) => s + l.quantity * l.unit_cost, 0) : 0;
  const itemsTotal = purchase ? purchase.items.reduce((s, i) => s + i.quantity * i.unit_cost, 0) : 0;
  const piecesBought = purchase ? (hasLines ? purchase.lines.reduce((s, l) => s + l.quantity, 0) : purchase.items.reduce((s, i) => s + i.quantity, 0)) : 0;
  const piecesSorted = purchase ? purchase.items.reduce((s, i) => s + i.quantity, 0) : 0;

  // Every payment and extra cost against it, oldest first, on one list.
  const moneyOut = purchase
    ? [
        ...purchase.at_purchase.map((c) => ({ key: `a${c.id}`, date: c.entry_date, what: "Paid when the goods arrived", detail: how(c.payment_method), amount: c.amount, txn: c.transaction_code })),
        ...purchase.payments.map((p) => ({
          key: `p${p.id}`,
          date: p.payment_date,
          what: "Payment",
          detail: [how(p.method), p.notes ? p.notes.replace(/^\s*—\s*/, "") : null].filter(Boolean).join(" — ") || null,
          amount: p.amount,
          txn: p.transaction_code,
        })),
        ...purchase.extra_costs.map((c) => ({ key: `x${c.id}`, date: c.entry_date, what: "Extra cost", detail: c.notes, amount: c.amount, txn: c.transaction_code })),
      ].sort((a, b) => a.date.localeCompare(b.date))
    : [];

  return (
    <div>
      <button onClick={() => navigate(-1)} className="mb-3 inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft size={14} />
        Back
      </button>

      <PageHeader
        title={purchase?.purchase_code ?? "Purchase"}
        subtitle={purchase ? `${purchase.supplier_name} · ${formatDate(purchase.purchase_date)}${purchase.description ? ` · ${purchase.description}` : ""}` : undefined}
        action={purchase && <Button onClick={() => navigate(`/suppliers/${purchase.supplier_id}`)}>Open supplier</Button>}
      />

      {error && <ErrorText>{error}</ErrorText>}
      {!purchase && !error && <PageLoader />}

      {purchase && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge label={PAYMENT_WORD[purchase.payment_status]} />
            {purchase.fulfillment_status === "pending" && <Badge label="Not sorted yet" tone="outline" />}
            <span className="text-sm text-gray-500">
              from <RefLink to={`/suppliers/${purchase.supplier_id}`}>{purchase.supplier_name}</RefLink> · {purchase.supplier_code}
            </span>
          </div>

          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">Total cost</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900">{money(purchase.total_cost)}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">Paid</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900">{money(purchase.amount_paid)}</p>
              <p className="mt-0.5 text-xs text-gray-500">
                {purchase.payments.length + purchase.at_purchase.length} payment{purchase.payments.length + purchase.at_purchase.length === 1 ? "" : "s"}
                {purchase.extra_costs.length > 0 ? ` · ${purchase.extra_costs.length} extra cost${purchase.extra_costs.length === 1 ? "" : "s"}` : ""}
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">Pieces bought</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900">{piecesBought.toLocaleString()}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">Sorted into stock</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900">{piecesSorted.toLocaleString()}</p>
              {hasLines && piecesSorted !== piecesBought && <p className="mt-0.5 text-xs text-gray-500">{piecesSorted > piecesBought ? "more came in than was counted" : `${piecesBought - piecesSorted} still to sort`}</p>}
            </div>
          </div>

          {hasLines && (
            <section className="mb-5">
              <h2 className="mb-2 text-sm font-semibold text-gray-900">What was bought</h2>
              <Card className="overflow-clip p-0">
                <Table>
                  <thead>
                    <tr>
                      <Th>Item</Th>
                      <Th align="right">Qty</Th>
                      <Th align="right">Cost each</Th>
                      <Th align="right">Total</Th>
                      <Th align="right">Sorted into stock</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchase.lines.map((l) => (
                      <tr key={l.id}>
                        <Td>{l.description}</Td>
                        <Td align="right">{l.quantity}</Td>
                        <Td align="right">{l.unit_cost.toLocaleString()}</Td>
                        <Td align="right">{(l.quantity * l.unit_cost).toLocaleString()}</Td>
                        <Td align="right" className="text-gray-500">
                          {l.fulfilled_quantity} of {l.quantity}
                        </Td>
                      </tr>
                    ))}
                    <tr>
                      <Td className="font-medium" colSpan={3}>
                        Total
                      </Td>
                      <Td align="right" className="font-semibold">
                        {boughtTotal.toLocaleString()}
                      </Td>
                      <Td>{" "}</Td>
                    </tr>
                  </tbody>
                </Table>
              </Card>
            </section>
          )}

          {purchase.items.length > 0 && (
            <section className="mb-5">
              <h2 className="mb-2 text-sm font-semibold text-gray-900">{hasLines ? "Sorted into stock" : "Items"}</h2>
              <Card className="overflow-clip p-0">
                <Table>
                  <thead>
                    <tr>
                      <Th>Product</Th>
                      <Th>Size / colour</Th>
                      <Th align="right">Qty</Th>
                      <Th align="right">Cost each</Th>
                      <Th align="right">Total</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchase.items.map((i) => (
                      <tr key={i.id}>
                        <Td>{i.product_id ? <RefLink to={`/products/${i.product_id}`}>{i.product_title ?? "Item"}</RefLink> : i.product_title ?? "Item"}</Td>
                        <Td className="text-gray-500">{[i.size, i.color].filter(Boolean).join(" / ") || "—"}</Td>
                        <Td align="right">{i.quantity}</Td>
                        <Td align="right">{i.unit_cost.toLocaleString()}</Td>
                        <Td align="right">{(i.quantity * i.unit_cost).toLocaleString()}</Td>
                      </tr>
                    ))}
                    <tr>
                      <Td className="font-medium" colSpan={4}>
                        Total
                      </Td>
                      <Td align="right" className="font-semibold">
                        {itemsTotal.toLocaleString()}
                      </Td>
                    </tr>
                  </tbody>
                </Table>
              </Card>
              {hasLines && Math.abs(itemsTotal - boughtTotal) > 0.5 && (
                <p className="mt-2 text-xs text-gray-500">
                  More pieces came in than were counted when the goods arrived, so this list adds up to {money(itemsTotal)}. The purchase total of {money(purchase.total_cost)} is what was bought.
                </p>
              )}
            </section>
          )}

          {!hasLines && purchase.items.length === 0 && <p className="mb-5 text-sm text-gray-500">No items are recorded on this purchase.</p>}

          <section>
            <h2 className="mb-2 text-sm font-semibold text-gray-900">Payments and costs</h2>
            {moneyOut.length === 0 ? (
              <Card>
                <p className="text-sm text-gray-500">Nothing has been paid against this purchase yet.</p>
              </Card>
            ) : (
              <Card className="overflow-clip p-0">
                <Table>
                  <thead>
                    <tr>
                      <Th>Date</Th>
                      <Th>What</Th>
                      <Th>Details</Th>
                      <Th align="right">Amount</Th>
                      <Th>Transaction</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {moneyOut.map((m) => (
                      <tr key={m.key}>
                        <Td>{formatDate(m.date)}</Td>
                        <Td>{m.what}</Td>
                        <Td className="text-gray-500">{m.detail ?? "—"}</Td>
                        <Td align="right">{m.amount.toLocaleString()}</Td>
                        <Td>{m.txn ? <RefLink to={`/cash-book/${m.txn}`}>{m.txn}</RefLink> : <span className="text-gray-400">—</span>}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            )}
          </section>
        </>
      )}
    </div>
  );
}
