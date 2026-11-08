import { useEffect, useState } from "react";
import { PageLoader } from "./Loader";
import { api, ApiRequestError } from "../lib/api";
import { Modal, Button, Badge, ErrorText, RefLink } from "./ui";
import { formatDate } from "../lib/dates";

interface PurchaseDetail {
  id: number;
  purchase_code: string;
  supplier_id: number;
  supplier_name: string;
  purchase_date: string;
  total_cost: number;
  amount_paid: number;
  payment_status: "paid" | "partial" | "unpaid";
  fulfillment_status: "pending" | "fulfilled";
  description: string | null;
  // What was bought, as entered when the goods arrived (a rough line each), and how much of each has been sorted into stock.
  lines: { id: number; description: string; quantity: number; unit_cost: number; fulfilled_quantity: number }[];
  // The real pieces that went into stock from it, by size and colour.
  items: { id: number; product_title: string | null; size: string | null; color: string | null; quantity: number; unit_cost: number }[];
}

const money = (n: number) => `Rs. ${n.toLocaleString()}`;
const PAYMENT_WORD = { paid: "Paid", partial: "Part paid", unpaid: "Unpaid" } as const;

const th = "px-3 py-2 text-left text-xs font-medium text-gray-500";
const td = "px-3 py-2 text-sm text-gray-900 border-t border-gray-100";

// What one purchase from a supplier brought in: the things bought (with quantity, cost each and the line total), and the pieces that were
// sorted into stock from them. Opens from a purchase's code wherever one is shown.
export default function PurchaseDetailModal({ purchaseId, onClose }: { purchaseId: number; onClose: () => void }) {
  const [purchase, setPurchase] = useState<PurchaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<PurchaseDetail>(`/purchases/${purchaseId}`)
      .then((p) => {
        if (!cancelled) setPurchase(p);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiRequestError ? err.message : "Couldn't load this purchase");
      });
    return () => {
      cancelled = true;
    };
  }, [purchaseId]);

  const boughtTotal = purchase ? purchase.lines.reduce((sum, l) => sum + l.quantity * l.unit_cost, 0) : 0;
  const itemsTotal = purchase ? purchase.items.reduce((sum, i) => sum + i.quantity * i.unit_cost, 0) : 0;
  const hasLines = !!purchase && purchase.lines.length > 0;

  return (
    <Modal
      size="lg"
      onClose={onClose}
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          Purchase {purchase?.purchase_code ?? ""}
          {purchase && <Badge label={PAYMENT_WORD[purchase.payment_status]} />}
          {purchase && purchase.fulfillment_status === "pending" && <Badge label="Not sorted yet" tone="outline" />}
        </span>
      }
      subtitle={purchase ? `${purchase.supplier_name} · ${formatDate(purchase.purchase_date)}` : undefined}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {error && <ErrorText>{error}</ErrorText>}
      {!purchase && !error && <PageLoader />}
      {purchase && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs text-gray-500">Supplier</p>
              <p className="text-gray-900">
                <RefLink to={`/suppliers/${purchase.supplier_id}`}>{purchase.supplier_name}</RefLink>
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Date</p>
              <p className="text-gray-900">{formatDate(purchase.purchase_date)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Total cost</p>
              <p className="font-medium text-gray-900">{money(purchase.total_cost)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Paid</p>
              <p className="text-gray-900">{money(purchase.amount_paid)}</p>
            </div>
          </div>
          {purchase.description && <p className="text-sm text-gray-500">{purchase.description}</p>}

          <div>
            <h3 className="mb-2 text-sm font-semibold text-gray-900">{hasLines ? "What was bought" : "Items"}</h3>
            {hasLines ? (
              <div className="overflow-x-auto rounded-xl border border-gray-200">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className={th}>Item</th>
                      <th className={`${th} text-right`}>Qty</th>
                      <th className={`${th} text-right`}>Cost each</th>
                      <th className={`${th} text-right`}>Total</th>
                      <th className={`${th} text-right`}>Sorted into stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchase.lines.map((l) => (
                      <tr key={l.id}>
                        <td className={td}>{l.description}</td>
                        <td className={`${td} text-right tabular-nums`}>{l.quantity}</td>
                        <td className={`${td} text-right tabular-nums`}>{l.unit_cost.toLocaleString()}</td>
                        <td className={`${td} text-right tabular-nums`}>{(l.quantity * l.unit_cost).toLocaleString()}</td>
                        <td className={`${td} text-right tabular-nums text-gray-500`}>
                          {l.fulfilled_quantity} of {l.quantity}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-gray-50">
                      <td className={`${td} font-medium`} colSpan={3}>
                        Total
                      </td>
                      <td className={`${td} text-right font-semibold tabular-nums`}>{boughtTotal.toLocaleString()}</td>
                      <td className={td}></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : purchase.items.length === 0 ? (
              <p className="text-sm text-gray-500">No items are recorded on this purchase.</p>
            ) : null}
          </div>

          {purchase.items.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-gray-900">{hasLines ? "Sorted into stock" : "Pieces received"}</h3>
              <div className="overflow-x-auto rounded-xl border border-gray-200">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className={th}>Product</th>
                      <th className={th}>Size / colour</th>
                      <th className={`${th} text-right`}>Qty</th>
                      <th className={`${th} text-right`}>Cost each</th>
                      <th className={`${th} text-right`}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchase.items.map((i) => (
                      <tr key={i.id}>
                        <td className={td}>{i.product_title ?? "Item"}</td>
                        <td className={`${td} text-gray-500`}>{[i.size, i.color].filter(Boolean).join(" / ") || "—"}</td>
                        <td className={`${td} text-right tabular-nums`}>{i.quantity}</td>
                        <td className={`${td} text-right tabular-nums`}>{i.unit_cost.toLocaleString()}</td>
                        <td className={`${td} text-right tabular-nums`}>{(i.quantity * i.unit_cost).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                  {!hasLines && (
                    <tfoot>
                      <tr className="bg-gray-50">
                        <td className={`${td} font-medium`} colSpan={4}>
                          Total
                        </td>
                        <td className={`${td} text-right font-semibold tabular-nums`}>{itemsTotal.toLocaleString()}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              {hasLines && Math.abs(itemsTotal - boughtTotal) > 0.5 && (
                <p className="mt-2 text-xs text-gray-500">
                  More pieces came in than were counted when the goods arrived, so this list adds up to {money(itemsTotal)}; the purchase total of {money(purchase.total_cost)} is what was bought.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
