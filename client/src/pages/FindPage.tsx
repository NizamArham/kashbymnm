import { useEffect, useRef, useState, FormEvent, KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Package, Receipt, User, Truck, ShoppingBag, UserCog, ArrowRight, Loader2, Landmark, Ticket, Gift } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { PageHeader, Card, Input, Button, Badge, ErrorText } from "../components/ui";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";

type FindResult =
  | { type: "inventory"; data: InventoryResult }
  | { type: "sale"; data: SaleResult }
  | { type: "customer"; data: CustomerResult }
  | { type: "supplier"; data: SupplierResult }
  | { type: "purchase"; data: PurchaseResult }
  | { type: "staff"; data: StaffResult }
  | { type: "transaction"; data: TransactionResult }
  | { type: "coupon"; data: CouponResult }
  | { type: "gift_voucher"; data: GiftVoucherResult };

interface InventoryResult {
  id: number;
  product_id: number;
  sku: string;
  barcode: string | null;
  size: string | null;
  color: string | null;
  status: string;
  product_title: string;
  brand: string | null;
  category: string | null;
}
interface SaleResult {
  id: number;
  invoice: string;
  date: string;
  total: number;
  amount_paid: number;
  payment_status: string;
  sale_type: string;
  is_voided: number;
  customer_name: string | null;
  deleted_customer_snapshot: string | null;
}
interface CustomerResult {
  id: number;
  customer_code: string;
  name: string;
  phone: string | null;
  phone2: string | null;
  gender: string;
  is_suspended: number;
}
interface SupplierResult {
  id: number;
  supplier_code: string;
  name: string;
  phone: string | null;
  city: string | null;
}
interface PurchaseResult {
  id: number;
  purchase_code: string;
  purchase_date: string;
  total_cost: number;
  amount_paid: number;
  payment_status: string;
  fulfillment_status: string;
  supplier_name: string;
}
interface StaffResult {
  id: number;
  username: string;
  name: string | null;
  role: string;
  job_title: string | null;
  phone: string | null;
}
interface TransactionResult {
  id: number;
  transaction_code: string;
  entry_date: string;
  type: "income" | "expense";
  category: string;
  payment_method: string | null;
  amount: number;
  notes: string | null;
}
interface CouponResult {
  id: number;
  code: string;
  discount_type: "percent" | "fixed";
  discount_value: number;
  is_active: number;
  expires_at: string | null;
}
interface GiftVoucherResult {
  id: number;
  code: string;
  initial_value: number;
  remaining_value: number;
  validity_days: number;
  activated_at: string | null;
  expires_at: string | null;
  is_enabled: number;
  notes: string | null;
}

type SearchSuggestionType = "product" | "customer" | "supplier" | "sale" | "staff" | "coupon" | "gift_voucher";

interface SearchSuggestion {
  type: SearchSuggestionType;
  id: number;
  title: string;
  subtitle: string;
  route: string;
}

const SUGGESTION_META: Record<SearchSuggestionType, { label: string; icon: typeof Package }> = {
  product: { label: "Product", icon: Package },
  customer: { label: "Customer", icon: User },
  supplier: { label: "Supplier", icon: Truck },
  sale: { label: "Sale", icon: Receipt },
  staff: { label: "Staff", icon: UserCog },
  coupon: { label: "Coupon", icon: Ticket },
  gift_voucher: { label: "Gift voucher", icon: Gift },
};

const TYPE_META: Record<FindResult["type"], { label: string; icon: typeof Package }> = {
  inventory: { label: "Inventory unit", icon: Package },
  sale: { label: "Sale", icon: Receipt },
  customer: { label: "Customer", icon: User },
  supplier: { label: "Supplier", icon: Truck },
  purchase: { label: "Purchase", icon: ShoppingBag },
  staff: { label: "Staff", icon: UserCog },
  transaction: { label: "Cash Book transaction", icon: Landmark },
  coupon: { label: "Coupon", icon: Ticket },
  gift_voucher: { label: "Gift voucher", icon: Gift },
};

// Key-value row shared by every result card below — keeps the layout
// identical across record types instead of each one inventing its own.
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
      <span className="text-xs text-gray-400">{label}</span>
      <span className="text-sm text-gray-900 font-medium text-right">{value}</span>
    </div>
  );
}

export default function FindPage() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [result, setResult] = useState<FindResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Recently-looked-up codes, most recent first — Up/Down cycles through
  // them like shell history, since scanning is usually a run of several
  // codes in a row and re-checking a recent one shouldn't need retyping.
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // The fuzzy complement to the exact-code lookup above — typing a name
  // (not necessarily a code) shows live suggestions below the input,
  // debounced so it's not a request per keystroke. Cleared as soon as an
  // exact lookup succeeds, since the result card below takes over at
  // that point.
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);

  useKeyboardShortcut("/", () => inputRef.current?.focus());

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const q = code.trim();
    if (q.length < 2 || result) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .get<SearchSuggestion[]>(`/find/search?q=${encodeURIComponent(q)}`)
        .then((found) => setSuggestions(found))
        .catch(() => {
          /* a failed suggestion fetch is silent — the exact-match Find button still works */
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [code, result]);

  function selectSuggestion(s: SearchSuggestion) {
    setSuggestions([]);
    setCode("");
    setResult(null);
    navigate(s.route);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const found = await api.get<FindResult>(`/find?code=${encodeURIComponent(trimmed)}`);
      setResult(found);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Lookup failed");
    } finally {
      setLoading(false);
      setCode("");
      setHistory((prev) => [trimmed, ...prev.filter((c) => c !== trimmed)].slice(0, 20));
      setHistoryIndex(-1);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setCode("");
      setError(null);
      setResult(null);
      setHistoryIndex(-1);
      setSuggestions([]);
      return;
    }
    if (e.key === "ArrowUp") {
      if (history.length === 0) return;
      e.preventDefault();
      const nextIndex = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(nextIndex);
      setCode(history[nextIndex]);
      return;
    }
    if (e.key === "ArrowDown") {
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setCode("");
        return;
      }
      e.preventDefault();
      const nextIndex = historyIndex - 1;
      setHistoryIndex(nextIndex);
      setCode(history[nextIndex]);
    }
  }

  function renderResult() {
    if (!result) return null;
    const meta = TYPE_META[result.type];
    const Icon = meta.icon;

    return (
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0">
              <Icon size={16} className="text-gray-700" />
            </span>
            <Badge label={meta.label} tone="neutral" />
          </div>
        </div>

        {result.type === "inventory" && (
          <>
            <h3 className="text-base font-semibold text-gray-900 mb-3">{result.data.product_title}</h3>
            <Row label="Brand" value={result.data.brand ?? "—"} />
            <Row label="Category" value={result.data.category ?? "—"} />
            <Row label="Size / Color" value={`${result.data.size ?? "—"} / ${result.data.color ?? "—"}`} />
            <Row label="SKU" value={result.data.sku} />
            <Row label="Barcode" value={result.data.barcode ?? "—"} />
            <Row label="Status" value={<span className="capitalize">{result.data.status}</span>} />
            <Button variant="primary" className="w-full mt-4 justify-center" onClick={() => navigate(`/products/${result.data.product_id}`)}>
              View product <ArrowRight size={14} className="ml-1.5" />
            </Button>
          </>
        )}

        {result.type === "sale" && (
          <>
            <h3 className="text-base font-semibold text-gray-900 mb-3">
              {result.data.invoice}
              {result.data.is_voided ? <span className="ml-2"><Badge label="voided" tone="danger" /></span> : null}
            </h3>
            <Row label="Customer" value={result.data.customer_name ?? result.data.deleted_customer_snapshot ?? "Walk-in"} />
            <Row label="Date" value={result.data.date.slice(0, 16).replace("T", " ")} />
            <Row label="Type" value={result.data.sale_type === "online" ? "Online" : "In-store"} />
            <Row label="Total" value={`Rs. ${result.data.total.toLocaleString()}`} />
            <Row label="Paid" value={`Rs. ${result.data.amount_paid.toLocaleString()}`} />
            <Row label="Status" value={<span className="capitalize">{result.data.payment_status}</span>} />
            <Button variant="primary" className="w-full mt-4 justify-center" onClick={() => navigate(`/sales/${result.data.id}`)}>
              View sale <ArrowRight size={14} className="ml-1.5" />
            </Button>
          </>
        )}

        {result.type === "customer" && (
          <>
            <h3 className="text-base font-semibold text-gray-900 mb-3">
              {result.data.name}
              {result.data.is_suspended ? <span className="ml-2"><Badge label="suspended" tone="danger" /></span> : null}
            </h3>
            <Row label="Customer code" value={result.data.customer_code} />
            <Row label="Phone" value={result.data.phone ?? "—"} />
            {result.data.phone2 && <Row label="Phone 2" value={result.data.phone2} />}
            <Row label="Gender" value={<span className="capitalize">{result.data.gender}</span>} />
            <Button variant="primary" className="w-full mt-4 justify-center" onClick={() => navigate(`/customers/${result.data.id}/orders`)}>
              View orders <ArrowRight size={14} className="ml-1.5" />
            </Button>
          </>
        )}

        {result.type === "supplier" && (
          <>
            <h3 className="text-base font-semibold text-gray-900 mb-3">{result.data.name}</h3>
            <Row label="Supplier code" value={result.data.supplier_code} />
            <Row label="Phone" value={result.data.phone ?? "—"} />
            <Row label="City" value={result.data.city ?? "—"} />
            <Button
              variant="primary"
              className="w-full mt-4 justify-center"
              onClick={() => navigate(`/suppliers/${result.data.id}/payment-history`)}
            >
              View payment history <ArrowRight size={14} className="ml-1.5" />
            </Button>
          </>
        )}

        {result.type === "purchase" && (
          <>
            <h3 className="text-base font-semibold text-gray-900 mb-3">{result.data.purchase_code}</h3>
            <Row label="Supplier" value={result.data.supplier_name} />
            <Row label="Date" value={result.data.purchase_date.slice(0, 16).replace("T", " ")} />
            <Row label="Total cost" value={`Rs. ${result.data.total_cost.toLocaleString()}`} />
            <Row label="Paid" value={`Rs. ${result.data.amount_paid.toLocaleString()}`} />
            <Row label="Payment" value={<span className="capitalize">{result.data.payment_status}</span>} />
            <Row label="Fulfillment" value={<span className="capitalize">{result.data.fulfillment_status}</span>} />
            <Button variant="primary" className="w-full mt-4 justify-center" onClick={() => navigate(`/purchases`)}>
              Go to Purchases <ArrowRight size={14} className="ml-1.5" />
            </Button>
          </>
        )}

        {result.type === "staff" && (
          <>
            <h3 className="text-base font-semibold text-gray-900 mb-3">{result.data.name ?? result.data.username}</h3>
            <Row label="Username" value={result.data.username} />
            <Row label="Role" value={<span className="capitalize">{result.data.role}</span>} />
            <Row label="Job title" value={result.data.job_title ?? "—"} />
            <Row label="Phone" value={result.data.phone ?? "—"} />
            <Button variant="primary" className="w-full mt-4 justify-center" onClick={() => navigate(`/staff`)}>
              Go to Staff <ArrowRight size={14} className="ml-1.5" />
            </Button>
          </>
        )}

        {result.type === "transaction" && (
          <>
            <h3 className="text-base font-semibold text-gray-900 mb-3">{result.data.transaction_code}</h3>
            <Row label="Date" value={result.data.entry_date.slice(0, 16).replace("T", " ")} />
            <Row
              label="Type"
              value={
                <span className={result.data.type === "income" ? "text-green-600" : "text-red-500"}>
                  {result.data.type === "income" ? "Income" : "Expense"}
                </span>
              }
            />
            <Row label="Category" value={<span className="capitalize">{result.data.category.replace(/_/g, " ")}</span>} />
            <Row label="Method" value={result.data.payment_method ? <span className="capitalize">{result.data.payment_method.replace("_", " ")}</span> : "—"} />
            <Row label="Amount" value={`Rs. ${result.data.amount.toLocaleString()}`} />
            {result.data.notes && <Row label="Notes" value={result.data.notes} />}
            <Button variant="primary" className="w-full mt-4 justify-center" onClick={() => navigate(`/cash-book`)}>
              Go to Cash Book <ArrowRight size={14} className="ml-1.5" />
            </Button>
          </>
        )}

        {result.type === "coupon" && (
          <>
            <h3 className="text-base font-semibold text-gray-900 mb-3">
              {result.data.code}
              {!result.data.is_active ? (
                <span className="ml-2"><Badge label="inactive" tone="danger" /></span>
              ) : result.data.expires_at && new Date(result.data.expires_at) < new Date() ? (
                <span className="ml-2"><Badge label="expired" tone="danger" /></span>
              ) : null}
            </h3>
            <Row
              label="Reward"
              value={result.data.discount_type === "percent" ? `${result.data.discount_value}% off` : `Rs. ${result.data.discount_value.toLocaleString()} off`}
            />
            <Row label="Expires" value={result.data.expires_at ? result.data.expires_at.slice(0, 10) : "Never"} />
            <Button variant="primary" className="w-full mt-4 justify-center" onClick={() => navigate(`/promotions`)}>
              Go to Promotions <ArrowRight size={14} className="ml-1.5" />
            </Button>
          </>
        )}

        {result.type === "gift_voucher" && (
          <>
            <h3 className="text-base font-semibold text-gray-900 mb-3">
              {result.data.code}
              {!result.data.is_enabled ? (
                <span className="ml-2"><Badge label="disabled" tone="danger" /></span>
              ) : !result.data.activated_at ? (
                <span className="ml-2"><Badge label="not yet sold" tone="warning" /></span>
              ) : result.data.expires_at && new Date(result.data.expires_at) < new Date() ? (
                <span className="ml-2"><Badge label="expired" tone="danger" /></span>
              ) : result.data.remaining_value <= 0 ? (
                <span className="ml-2"><Badge label="used up" tone="neutral" /></span>
              ) : (
                <span className="ml-2"><Badge label="active" tone="success" /></span>
              )}
            </h3>
            <Row label="Balance" value={`Rs. ${result.data.remaining_value.toLocaleString()} / Rs. ${result.data.initial_value.toLocaleString()}`} />
            <Row label="Validity" value={result.data.activated_at ? `${result.data.validity_days} days from sale` : `${result.data.validity_days} days, once sold`} />
            {result.data.activated_at && <Row label="Sold" value={result.data.activated_at.slice(0, 10)} />}
            {result.data.expires_at && <Row label="Expires" value={result.data.expires_at.slice(0, 10)} />}
            {result.data.notes && <Row label="Notes" value={result.data.notes} />}
            <Button variant="primary" className="w-full mt-4 justify-center" onClick={() => navigate(`/promotions`)}>
              Go to Promotions <ArrowRight size={14} className="ml-1.5" />
            </Button>
          </>
        )}
      </Card>
    );
  }

  return (
    <div>
      <PageHeader
        title="Find"
        subtitle="Scan or type an exact code (barcode, SKU, invoice, customer/supplier/purchase code, transaction code, coupon/gift voucher code, username) — or just type a name (or “gift”, “voucher”, “coupon”) to search."
      />

      <Card className="mb-5">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              ref={inputRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Scan an exact code, or type a name to search... (↑/↓ for recent, Esc to clear)"
              className="pl-10"
            />

            {suggestions.length > 0 && (
              <div className="absolute z-20 left-0 right-0 mt-1.5 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
                {suggestions.map((s) => {
                  const meta = SUGGESTION_META[s.type];
                  const Icon = meta.icon;
                  return (
                    <button
                      key={`${s.type}-${s.id}`}
                      type="button"
                      onClick={() => selectSuggestion(s)}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-gray-50 transition border-b border-gray-50 last:border-0"
                    >
                      <span className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                        <Icon size={12} className="text-gray-600" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-gray-900 truncate">{s.title}</span>
                        <span className="block text-xs text-gray-400 truncate">
                          {meta.label} · {s.subtitle || "—"}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <Button type="submit" variant="primary" disabled={loading || !code.trim()} className="inline-flex items-center gap-1.5">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            Find
          </Button>
        </form>
      </Card>

      {error && <ErrorText>{error}</ErrorText>}
      {renderResult()}
    </div>
  );
}
