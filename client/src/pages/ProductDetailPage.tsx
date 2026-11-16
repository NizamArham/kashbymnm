import { useEffect, useMemo, useState } from "react";
import { PageLoader } from "../components/Loader";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Boxes, Package, Receipt, SquarePen } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { InventoryUnit, Product } from "../lib/types";
import { PageHeader, Card, ErrorText, ActionMenu } from "../components/ui";
import ProductSalesModal from "../components/ProductSalesModal";
import { useAuth } from "../context/AuthContext";
import { compareSizes } from "../lib/sizeSort";
import { openProductInInventory } from "../lib/productView";
import { formatDate } from "../lib/dates";

// What the sold-invoices lookup tells us at a glance (the full list is in the popup).
interface SoldSummary {
  pieces: number;
  amount: number;
  lastSold: string | null;
  anySold: boolean;
}

// One product: its facts, what is in stock in each colour and size, what has sold, and (for admins) a menu to see the invoices, restock or edit it.
// Opened by tapping a product's name on an invoice, a purchase, a return or the till.
export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [product, setProduct] = useState<Product | null>(null);
  const [units, setUnits] = useState<InventoryUnit[] | null>(null);
  const [sold, setSold] = useState<SoldSummary | null>(null);
  const [showInvoices, setShowInvoices] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setUnits(null);
    setSold(null);
    api
      .get<Product>(`/products/${id}`)
      .then((p) => {
        if (!cancelled) setProduct(p);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiRequestError ? err.message : "Failed to load this product");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // The side figures are extras: if they fail the page still shows the product.
    api
      .get<InventoryUnit[]>(`/inventory?product_id=${id}`)
      .then((u) => !cancelled && setUnits(u))
      .catch(() => {});
    if (isAdmin) {
      api
        .get<{ rows: { sale_id: number; date: string; is_voided: number; is_returned: number }[]; pieces: number; amount: number }>(`/products/${id}/sales`)
        .then((r) => {
          if (cancelled) return;
          // Rows come newest first; the last sale that really stands (not voided, not returned) is the first such row.
          const live = r.rows.find((x) => !x.is_voided && !x.is_returned);
          setSold({ pieces: r.pieces, amount: r.amount, lastSold: live?.date ?? null, anySold: r.rows.length > 0 });
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [id, isAdmin]);

  // What is in stock, colour by colour: only the sizes that have pieces left (a product can come in 25 sizes — a table of mostly dashes would hide the
  // few that matter). Pieces held for a payment request still count as in stock.
  const stock = useMemo(() => {
    if (!units) return null;
    const byColour = new Map<string, Map<string, number>>();
    let held = 0;
    for (const u of units) {
      if (u.status !== "available") continue;
      const colour = u.color || "—";
      const size = u.size || "—";
      const sizes = byColour.get(colour) ?? new Map<string, number>();
      sizes.set(size, (sizes.get(size) ?? 0) + 1);
      byColour.set(colour, sizes);
      if (u.is_held) held++;
    }
    const colours = [...byColour.entries()]
      .map(([colour, sizes]) => ({
        colour,
        total: [...sizes.values()].reduce((sum, n) => sum + n, 0),
        sizes: [...sizes.entries()].sort(([a], [b]) => compareSizes(a, b)).map(([size, count]) => ({ size, count })),
      }))
      .sort((a, b) => a.colour.localeCompare(b.colour));
    return { colours, total: colours.reduce((sum, c) => sum + c.total, 0), held, everStocked: units.length > 0 };
  }, [units]);

  return (
    <div>
      <button
        onClick={() => navigate(-1)}
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-3"
      >
        <ArrowLeft size={14} />
        Back
      </button>

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <PageLoader />
      ) : product ? (
        <>
          <PageHeader
            title={product.product_title}
            subtitle={[product.brand, product.category].filter(Boolean).join(" · ")}
            action={
              isAdmin && (
                <ActionMenu
                  items={[
                    { label: "Sold invoices", icon: <Receipt size={14} />, onClick: () => setShowInvoices(true) },
                    { label: "Restock", icon: <Boxes size={14} />, onClick: () => openProductInInventory(navigate, product.id, "restock") },
                    { label: "Edit details", icon: <SquarePen size={14} />, onClick: () => openProductInInventory(navigate, product.id, "details") },
                  ]}
                />
              )
            }
          />

          <Card>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-xs text-gray-500">Selling price</p>
                <p className="text-gray-900 font-medium">Rs. {product.selling_price.toLocaleString()}</p>
              </div>
              {product.cost_price !== undefined && (
                <div>
                  <p className="text-xs text-gray-500">Cost price</p>
                  <p className="text-gray-900 font-medium">Rs. {product.cost_price.toLocaleString()}</p>
                </div>
              )}
              <div>
                <p className="text-xs text-gray-500">Available stock</p>
                <p className="text-gray-900 font-medium">{product.qty}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Type</p>
                <p className="text-gray-900 font-medium">{product.product_type}</p>
              </div>
              {product.supplier_name && (
                <div>
                  <p className="text-xs text-gray-500">Supplier</p>
                  <p className="text-gray-900 font-medium">
                    {product.supplier_name} {product.supplier_code ? `(${product.supplier_code})` : ""}
                  </p>
                </div>
              )}
              <div>
                <p className="text-xs text-gray-500">Returns</p>
                <p className="text-gray-900 font-medium">{product.allow_returns ? "Allowed" : "Final sale"}</p>
              </div>
              {isAdmin && sold && (
                <>
                  <div>
                    <p className="text-xs text-gray-500">Sold so far</p>
                    <p className="text-gray-900 font-medium">
                      {sold.anySold ? `${sold.pieces} pc${sold.pieces === 1 ? "" : "s"} · Rs. ${sold.amount.toLocaleString()}` : "Not sold yet"}
                    </p>
                  </div>
                  {sold.lastSold && (
                    <div>
                      <p className="text-xs text-gray-500">Last sold</p>
                      <p className="text-gray-900 font-medium">{formatDate(sold.lastSold)}</p>
                    </div>
                  )}
                </>
              )}
            </div>
          </Card>

          {stock && (
            <Card className="mt-4">
              <div className="flex items-baseline justify-between gap-3 mb-3">
                <h2 className="text-sm font-semibold text-gray-900">Stock by colour and size</h2>
                {stock.total > 0 && (
                  <p className="text-xs text-gray-500">
                    {stock.total} piece{stock.total === 1 ? "" : "s"} in {stock.colours.length} colour{stock.colours.length === 1 ? "" : "s"}
                  </p>
                )}
              </div>
              {!stock.everStocked ? (
                <p className="text-sm text-gray-500">No stock has been added for this product yet.</p>
              ) : stock.total === 0 ? (
                <p className="text-sm text-gray-500">Out of stock — every piece of this product has been sold or taken out.</p>
              ) : (
                <div className="divide-y divide-gray-50">
                  {stock.colours.map((c) => (
                    <div key={c.colour} className="flex items-start gap-4 py-2.5 first:pt-0 last:pb-0">
                      <div className="w-32 flex-shrink-0">
                        <p className="text-sm text-gray-900">{c.colour}</p>
                        <p className="text-xs text-gray-500">{c.total} piece{c.total === 1 ? "" : "s"}</p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {c.sizes.map((s) => (
                          <span key={s.size} className="inline-flex items-baseline gap-1.5 rounded-lg bg-gray-100 px-2.5 py-1 text-xs text-gray-700">
                            {s.size}
                            <span data-stock-count className="font-semibold text-gray-900">{s.count}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {stock.held > 0 && (
                <p className="text-xs text-gray-500 mt-3">
                  {stock.held} of these {stock.held === 1 ? "is" : "are"} being held for a payment request.
                </p>
              )}
            </Card>
          )}

          {showInvoices && <ProductSalesModal productId={product.id} productTitle={product.product_title} onClose={() => setShowInvoices(false)} />}
        </>
      ) : (
        !error && (
          <p className="text-sm text-gray-500 flex items-center gap-2">
            <Package size={14} /> Product not found.
          </p>
        )
      )}
    </div>
  );
}
