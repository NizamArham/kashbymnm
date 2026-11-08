import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShoppingBag } from "lucide-react";
import { PageLoader } from "../components/Loader";
import { api, ApiRequestError } from "../lib/api";
import { Purchase } from "../lib/types";
import { Card, Table, Th, Td, EmptyState, ErrorText, Badge, RowCard, RowCardStats, RowCardStat } from "../components/ui";
import { formatDate } from "../lib/dates";
import PurchaseDetailModal from "../components/PurchaseDetailModal";

const PAYMENT_WORD: Record<Purchase["payment_status"], string> = { paid: "Paid", partial: "Part paid", unpaid: "Unpaid" };

// Everything bought from one supplier, newest first: what each delivery cost, what was paid on it, and whether it has been sorted into
// products yet — the same columns as the Purchases page. There is deliberately no "to pay" figure per purchase: a lump-sum payment is
// not tied to one purchase, so what is owed is the supplier's balance at the top of the page, never a sum of purchase rows.
// Shown as the Purchases tab on the supplier's profile page.
export default function SupplierPurchaseHistory({ supplierId }: { supplierId: number }) {
  const navigate = useNavigate();
  const [purchases, setPurchases] = useState<Purchase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPurchases(null);
    setError(null);
    api
      .get<Purchase[]>(`/purchases?supplier_id=${supplierId}`)
      .then((rows) => {
        if (!cancelled) setPurchases(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiRequestError ? err.message : "Couldn't load this supplier's purchases");
      });
    return () => {
      cancelled = true;
    };
  }, [supplierId]);

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!purchases) return <PageLoader />;

  if (purchases.length === 0) {
    return (
      <EmptyState
        icon={ShoppingBag}
        title="No purchases yet"
        subtitle="Nothing has been bought from this supplier."
        actions={[{ label: "Record a purchase", primary: true, onClick: () => navigate("/purchases") }]}
      />
    );
  }

  return (
    <>
      <p className="mb-3 text-sm text-gray-500">
        {purchases.length} purchase{purchases.length === 1 ? "" : "s"}
      </p>

      {/* Desktop / tablet-landscape */}
      <Card className="hidden overflow-clip p-0 lg:block">
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Purchase</Th>
              <Th>Description</Th>
              <Th align="right">Total cost</Th>
              <Th align="right">Paid</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p, i) => (
              <tr key={p.id} className={i % 2 === 1 ? "bg-gray-50/60" : ""}>
                <Td>{formatDate(p.purchase_date)}</Td>
                <Td>
                  <button type="button" title="See what was bought" onClick={() => setOpenId(p.id)} className="cursor-pointer font-medium underline decoration-dotted decoration-gray-400 underline-offset-2 hover:decoration-gray-900">
                    {p.purchase_code}
                  </button>
                </Td>
                <Td className="text-gray-500">{p.description || "—"}</Td>
                <Td align="right">{p.total_cost.toLocaleString()}</Td>
                <Td align="right">{p.amount_paid.toLocaleString()}</Td>
                <Td>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge label={PAYMENT_WORD[p.payment_status]} />
                    {p.fulfillment_status === "pending" && <Badge label="Not sorted yet" tone="outline" />}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {/* Phone / tablet-portrait */}
      <div className="space-y-2.5 lg:hidden">
        {purchases.map((p) => (
          <RowCard key={p.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="leading-snug text-gray-900">
                  <button type="button" title="See what was bought" onClick={() => setOpenId(p.id)} className="cursor-pointer font-medium underline decoration-dotted decoration-gray-400 underline-offset-2 hover:decoration-gray-900">
                    {p.purchase_code}
                  </button>
                </p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {formatDate(p.purchase_date)}
                  {p.description ? ` · ${p.description}` : ""}
                </p>
              </div>
              <span className="flex flex-shrink-0 flex-wrap justify-end gap-1.5">
                <Badge label={PAYMENT_WORD[p.payment_status]} />
                {p.fulfillment_status === "pending" && <Badge label="Not sorted yet" tone="outline" />}
              </span>
            </div>
            <RowCardStats>
              <RowCardStat label="Total cost" value={`Rs. ${p.total_cost.toLocaleString()}`} />
              <RowCardStat label="Paid" value={`Rs. ${p.amount_paid.toLocaleString()}`} />
            </RowCardStats>
          </RowCard>
        ))}
      </div>
      {openId !== null && <PurchaseDetailModal purchaseId={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
