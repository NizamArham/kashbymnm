import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Package } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Product } from "../lib/types";
import { PageHeader, Card, ErrorText } from "../components/ui";

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
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
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div>
      <button
        onClick={() => navigate(-1)}
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-3"
      >
        <ArrowLeft size={15} />
        Back
      </button>

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : product ? (
        <>
          <PageHeader title={product.product_title} subtitle={[product.brand, product.category].filter(Boolean).join(" · ")} />

          <Card>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-xs text-gray-400">Selling price</p>
                <p className="text-gray-900 font-medium">Rs. {product.selling_price.toLocaleString()}</p>
              </div>
              {product.cost_price !== undefined && (
                <div>
                  <p className="text-xs text-gray-400">Cost price</p>
                  <p className="text-gray-900 font-medium">Rs. {product.cost_price.toLocaleString()}</p>
                </div>
              )}
              <div>
                <p className="text-xs text-gray-400">Available stock</p>
                <p className="text-gray-900 font-medium">{product.qty}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Type</p>
                <p className="text-gray-900 font-medium">{product.product_type}</p>
              </div>
              {product.supplier_name && (
                <div>
                  <p className="text-xs text-gray-400">Supplier</p>
                  <p className="text-gray-900 font-medium">
                    {product.supplier_name} {product.supplier_code ? `(${product.supplier_code})` : ""}
                  </p>
                </div>
              )}
              <div>
                <p className="text-xs text-gray-400">Returns</p>
                <p className="text-gray-900 font-medium">{product.allow_returns ? "Allowed" : "Final sale"}</p>
              </div>
            </div>
          </Card>
        </>
      ) : (
        !error && (
          <p className="text-sm text-gray-400 flex items-center gap-2">
            <Package size={14} /> Product not found.
          </p>
        )
      )}
    </div>
  );
}
