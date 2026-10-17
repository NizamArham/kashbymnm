import { useEffect, useRef, useState, FormEvent, KeyboardEvent, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Package, Receipt, User, Truck, ShoppingBag, UserCog, ArrowRight, Loader2, Landmark, Ticket, Gift, Copy, Check, History, CornerDownLeft, X } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { PageHeader, Card, Input, Button, Badge, RefLink } from "../components/ui";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";
import ExchangeTag from "../components/ExchangeTag";
import { useAuth } from "../context/AuthContext";
import { useAdminApproval } from "../components/AdminApproval";

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
  selling_price: number | null;
  // Not sent to a cashier at all.
  cost_price?: number | null;
  sold_sale_id: number | null;
  sold_invoice: string | null;
}
interface SaleResult {
  id: number;
  invoice: string;
  date: string;
  total: number;
  amount_paid: number;
  payment_status: string;
  sale_type: string;
  payment_method: string | null;
  is_voided: number;
  customer_id: number | null;
  delivery_status: string | null;
  delivery_partner_name: string | null;
  items: { title: string; size: string | null; color: string | null; unit_price: number }[];
  customer_name: string | null;
  deleted_customer_snapshot: string | null;
  exchange_out_status: "awaiting" | "received" | "not_returned" | null;
  exchange_out_invoice: string | null;
  exchange_out_sale_id: number | null;
  exchange_in_status: "awaiting_pickup" | "received" | "not_returned" | "cancelled" | null;
  exchange_in_from: string | null;
}
interface CustomerResult {
  id: number;
  customer_code: string;
  name: string;
  phone: string | null;
  phone2: string | null;
  gender: string;
  is_suspended: number;
  order_count: number;
  balance_due: number;
  with_courier: number;
  store_credit_balance: number;
  loyalty_points: number;
  last_order_date: string | null;
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
  reference_id: number | null;
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

const money = (n: number) => `Rs. ${Math.round(n * 100) / 100 === Math.round(n) ? Math.round(n).toLocaleString() : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cap = (t: string | null | undefined) => (t ? t.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—");
const when = (t: string) => t.slice(0, 16).replace("T", " ");

// One small copy-to-clipboard button — codes, phone numbers and barcodes are what people
// actually want to lift out of a lookup.
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          },
          () => {}
        );
      }}
      className="ml-1.5 inline-flex h-5 w-5 items-center justify-center rounded-md text-gray-300 hover:bg-gray-100 hover:text-gray-700 transition"
      title="Copy"
      aria-label={`Copy ${text}`}
    >
      {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
    </button>
  );
}

type Tone = "default" | "good" | "bad" | "muted";
const TONE_CLASS: Record<Tone, string> = {
  default: "text-gray-900",
  good: "text-green-700",
  bad: "text-red-600",
  muted: "text-gray-400",
};

interface Stat {
  label: string;
  value: ReactNode;
  tone?: Tone;
  hint?: ReactNode;
}
interface Action {
  label: string;
  to: string;
  primary?: boolean;
}
// Everything a result needs to be drawn the same way whatever record it is.
interface ResultView {
  title: string;
  chips?: ReactNode;
  stats?: Stat[];
  bar?: { used: number; label: string };
  details: [string, ReactNode][];
  items?: { title: string; sub: string; price: number }[];
  actions: Action[];
}

// Records a cashier can only see by having an admin type their password — and whose pages are admin-only,
// so for a cashier the card itself is all there is (no buttons into pages they can't open).
const ADMIN_ONLY_TYPES: FindResult["type"][] = ["supplier", "purchase", "staff", "transaction", "coupon", "gift_voucher"];

function buildView(result: FindResult, isAdmin: boolean): ResultView {
  const view = buildViewFor(result);
  return !isAdmin && ADMIN_ONLY_TYPES.includes(result.type) ? { ...view, actions: [] } : view;
}

function buildViewFor(result: FindResult): ResultView {
  switch (result.type) {
    case "inventory": {
      const d = result.data;
      const showCost = d.cost_price !== undefined;
      const margin = d.selling_price != null && d.cost_price != null ? d.selling_price - d.cost_price : null;
      return {
        title: d.product_title,
        chips: (
          <>
            <Badge label={cap(d.status)} />
            {d.size && <Badge label={`Size ${d.size}`} />}
            {d.color && <Badge label={d.color} />}
          </>
        ),
        stats: [
          { label: "Selling price", value: d.selling_price != null ? money(d.selling_price) : "—" },
          ...(showCost
            ? ([
                { label: "Cost", value: d.cost_price != null ? money(d.cost_price) : "—", tone: "muted" },
                { label: "Margin", value: margin != null ? money(margin) : "—", tone: margin != null && margin < 0 ? "bad" : "good" },
              ] as Stat[])
            : []),
        ],
        details: [
          ["Brand", d.brand ?? "—"],
          ["Category", d.category ?? "—"],
          ["SKU", <>{d.sku}<CopyButton text={d.sku} /></>],
          ["Barcode", d.barcode ? <>{d.barcode}<CopyButton text={d.barcode} /></> : "—"],
          ...(d.sold_sale_id && d.sold_invoice ? ([["Sold on", <RefLink key="inv" to={`/sales/${d.sold_sale_id}`}>{d.sold_invoice}</RefLink>]] as [string, ReactNode][]) : []),
        ],
        actions: [{ label: "View product", to: `/products/${d.product_id}`, primary: true }],
      };
    }
    case "sale": {
      const d = result.data;
      const owed = Math.max(0, d.total - d.amount_paid);
      // An unpaid online COD order isn't "owed" by the customer while it's on its way or the
      // courier is holding the cash — say what is actually going on.
      const isCod = d.sale_type === "online" && d.payment_method !== "credit" && owed > 0;
      const inTransit = !!d.delivery_status && ["pending", "packed", "dispatched"].includes(d.delivery_status);
      const balanceStat: Stat = d.is_voided
        ? { label: "Balance", value: "—", tone: "muted" }
        : d.exchange_in_status === "awaiting_pickup" && owed > 0
        ? { label: "Waiting for the old item", value: money(owed), hint: "its value comes off when the old item is received" }
        : isCod && inTransit
        ? { label: "COD to collect", value: money(owed), hint: "paid at the door" }
        : isCod && d.delivery_status === "delivered" && d.delivery_partner_name
        ? { label: `With ${d.delivery_partner_name}`, value: money(owed), hint: "settles with the courier" }
        : owed > 0
        ? { label: "Still owed", value: money(owed), tone: "bad" }
        : { label: "Balance", value: "Settled", tone: "good" };
      return {
        title: d.invoice,
        chips: (
          <>
            {d.is_voided ? <Badge label="Voided" /> : null}
            <Badge label={d.sale_type === "online" ? "Online" : "In-store"} />
            <Badge label={d.exchange_in_status === "awaiting_pickup" && d.payment_status !== "paid" ? "Exchange pending" : cap(d.payment_status)} />
            {d.delivery_status && <Badge label={`Delivery: ${cap(d.delivery_status)}`} />}
            <ExchangeTag sale={d} className="!mt-0" />
          </>
        ),
        stats: [
          { label: "Total", value: money(d.total) },
          { label: "Paid", value: money(d.amount_paid) },
          balanceStat,
        ],
        details: [
          [
            "Customer",
            d.customer_id && d.customer_name ? <RefLink to={`/customers/${d.customer_id}/orders`}>{d.customer_name}</RefLink> : d.customer_name ?? d.deleted_customer_snapshot ?? "Walk-in",
          ],
          ["Date", when(d.date)],
          ["Payment method", cap(d.payment_method)],
          ...(d.delivery_partner_name ? ([["Delivery by", d.delivery_partner_name]] as [string, ReactNode][]) : []),
        ],
        items: d.items.map((i) => ({
          title: i.title,
          sub: [i.size, i.color].filter(Boolean).join(" · "),
          price: i.unit_price,
        })),
        actions: [{ label: "View sale", to: `/sales/${d.id}`, primary: true }],
      };
    }
    case "customer": {
      const d = result.data;
      return {
        title: d.name,
        chips: d.is_suspended ? <Badge label="Suspended" /> : undefined,
        stats: [
          d.balance_due > 0
            ? { label: "Owes", value: money(d.balance_due), tone: "bad" }
            : { label: "Owes", value: "Nothing", tone: "good", hint: d.with_courier > 0 ? `${money(d.with_courier)} with the courier` : undefined },
          { label: "Store credit", value: d.store_credit_balance > 0 ? money(d.store_credit_balance) : "—", tone: d.store_credit_balance > 0 ? "default" : "muted" },
          { label: "Loyalty points", value: d.loyalty_points.toLocaleString() },
        ],
        details: [
          ["Customer code", <>{d.customer_code}<CopyButton text={d.customer_code} /></>],
          ["Phone", d.phone ? <>{d.phone}<CopyButton text={d.phone} /></> : "—"],
          ...(d.phone2 ? ([["Phone 2", <>{d.phone2}<CopyButton text={d.phone2} /></>]] as [string, ReactNode][]) : []),
          ["Orders", d.order_count.toLocaleString()],
          ["Last order", d.last_order_date ? d.last_order_date.slice(0, 10) : "No orders yet"],
          ["Gender", cap(d.gender)],
        ],
        actions: [
          { label: "View orders", to: `/customers/${d.id}/orders`, primary: true },
          { label: "Payment history", to: `/customers/${d.id}/payment-history` },
        ],
      };
    }
    case "supplier": {
      const d = result.data;
      return {
        title: d.name,
        details: [
          ["Supplier code", <>{d.supplier_code}<CopyButton text={d.supplier_code} /></>],
          ["Phone", d.phone ? <>{d.phone}<CopyButton text={d.phone} /></> : "—"],
          ["City", d.city ?? "—"],
        ],
        actions: [{ label: "Payment history", to: `/suppliers/${d.id}/payment-history`, primary: true }],
      };
    }
    case "purchase": {
      const d = result.data;
      const toPay = Math.max(0, d.total_cost - d.amount_paid);
      return {
        title: d.purchase_code,
        chips: (
          <>
            <Badge label={`Payment: ${cap(d.payment_status)}`} />
            <Badge label={cap(d.fulfillment_status)} />
          </>
        ),
        stats: [
          { label: "Total cost", value: money(d.total_cost) },
          { label: "Paid", value: money(d.amount_paid) },
          toPay > 0 ? { label: "Still to pay", value: money(toPay), tone: "bad" } : { label: "Balance", value: "Settled", tone: "good" },
        ],
        details: [
          ["Supplier", d.supplier_name],
          ["Date", when(d.purchase_date)],
        ],
        actions: [{ label: "Go to Purchases", to: "/purchases", primary: true }],
      };
    }
    case "staff": {
      const d = result.data;
      return {
        title: d.name ?? d.username,
        chips: <Badge label={cap(d.role)} />,
        details: [
          ["Username", <>{d.username}<CopyButton text={d.username} /></>],
          ["Job title", d.job_title ?? "—"],
          ["Phone", d.phone ? <>{d.phone}<CopyButton text={d.phone} /></> : "—"],
        ],
        actions: [{ label: "Go to Staff", to: "/staff", primary: true }],
      };
    }
    case "transaction": {
      const d = result.data;
      const isIncome = d.type === "income";
      const saleLinked = (d.category === "sale" || d.category === "sale_void") && d.reference_id;
      return {
        title: d.transaction_code,
        chips: (
          <>
            <Badge label={isIncome ? "Income" : "Expense"} />
            <Badge label={cap(d.category)} />
            {d.payment_method && <Badge label={cap(d.payment_method)} />}
          </>
        ),
        stats: [{ label: isIncome ? "Money in" : "Money out", value: `${isIncome ? "+" : "−"} ${money(d.amount)}`, tone: isIncome ? "good" : "bad" }],
        details: [
          ["Date", when(d.entry_date)],
          ["Category", cap(d.category)],
          ["Method", cap(d.payment_method)],
          ...(d.notes ? ([["Notes", d.notes]] as [string, ReactNode][]) : []),
        ],
        actions: [
          { label: "Go to Cash Book", to: "/cash-book", primary: true },
          ...(saleLinked ? [{ label: "Open the invoice", to: `/sales/${d.reference_id}` }] : []),
        ],
      };
    }
    case "coupon": {
      const d = result.data;
      const expired = !!d.expires_at && new Date(d.expires_at) < new Date();
      return {
        title: d.code,
        chips: <Badge label={!d.is_active ? "Inactive" : expired ? "Expired" : "Active"} />,
        stats: [
          { label: "Reward", value: d.discount_type === "percent" ? `${d.discount_value}% off` : `${money(d.discount_value)} off` },
          { label: "Expires", value: d.expires_at ? d.expires_at.slice(0, 10) : "Never", tone: expired ? "bad" : "default" },
        ],
        details: [],
        actions: [{ label: "Go to Promotions", to: "/promotions", primary: true }],
      };
    }
    case "gift_voucher": {
      const d = result.data;
      const expired = !!d.expires_at && new Date(d.expires_at) < new Date();
      const status = !d.is_enabled ? "Disabled" : !d.activated_at ? "Not yet sold" : expired ? "Expired" : d.remaining_value <= 0 ? "Used up" : "Active";
      const used = Math.max(0, d.initial_value - d.remaining_value);
      return {
        title: d.code,
        chips: <Badge label={status} />,
        stats: [
          { label: "Balance left", value: money(d.remaining_value), tone: d.remaining_value > 0 && status === "Active" ? "good" : "muted" },
          { label: "Face value", value: money(d.initial_value) },
          { label: "Used", value: money(used) },
        ],
        bar: d.initial_value > 0 ? { used: Math.min(1, used / d.initial_value), label: `${Math.round((used / d.initial_value) * 100)}% used` } : undefined,
        details: [
          ["Validity", d.activated_at ? `${d.validity_days} days from sale` : `${d.validity_days} days, once sold`],
          ...(d.activated_at ? ([["Sold", d.activated_at.slice(0, 10)]] as [string, ReactNode][]) : []),
          ...(d.expires_at ? ([["Expires", d.expires_at.slice(0, 10)]] as [string, ReactNode][]) : []),
          ...(d.notes ? ([["Notes", d.notes]] as [string, ReactNode][]) : []),
        ],
        actions: [{ label: "Go to Promotions", to: "/promotions", primary: true }],
      };
    }
  }
}

// What can be looked up, shown before anything has been — so the empty page teaches itself.
const LOOKUP_HINTS: { icon: typeof Package; label: string; example: string }[] = [
  { icon: Package, label: "Product unit", example: "barcode or SKU" },
  { icon: Receipt, label: "Invoice", example: "OCD283X0320" },
  { icon: User, label: "Customer", example: "C3100035F" },
  { icon: Truck, label: "Supplier", example: "supplier code" },
  { icon: ShoppingBag, label: "Purchase", example: "P26100011" },
  { icon: Landmark, label: "Cash Book entry", example: "TXN-0084" },
  { icon: Ticket, label: "Coupon", example: "coupon code" },
  { icon: Gift, label: "Gift voucher", example: "voucher code" },
  { icon: UserCog, label: "Staff", example: "username" },
];

// What a cashier can look up without anyone's say-so: stock units, invoices, customers.
const CASHIER_LOOKUP_HINTS = LOOKUP_HINTS.filter((h) => ["Product unit", "Invoice", "Customer"].includes(h.label));

export default function FindPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  // Typing the exact code of something beyond a cashier's limits (a supplier, a staff member, a cash
  // book entry...) asks for an admin's password for that one lookup.
  const { runWithApproval } = useAdminApproval();
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

  // A scanner types into whatever has focus. After a click elsewhere (the full-screen button, the page background)
  // nothing may be focused, and the scan would go nowhere — or its Enter would press a focused button. So when
  // nothing editable has focus and a character arrives, the box takes it; and it takes focus back when full
  // screen turns on or off.
  useEffect(() => {
    const refocus = () => inputRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      inputRef.current?.focus();
    };
    document.addEventListener("fullscreenchange", refocus);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("fullscreenchange", refocus);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const q = code.trim();
    if (q.length < 2 || result) {
      setSuggestions([]);
      return;
    }
    // `stale` stops an answer that arrives after the person has moved on — a code scanned and
    // looked up while a name search was still in flight — from popping the list back open.
    let stale = false;
    const timer = setTimeout(() => {
      api
        .get<SearchSuggestion[]>(`/find/search?q=${encodeURIComponent(q)}`)
        .then((found) => {
          if (!stale) setSuggestions(found);
        })
        .catch(() => {
          /* a failed suggestion fetch is silent — the exact-match Find button still works */
        });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [code, result]);

  function selectSuggestion(s: SearchSuggestion) {
    setSuggestions([]);
    setCode("");
    setResult(null);
    navigate(s.route);
  }

  async function lookup(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setSuggestions([]);
    try {
      const found = await runWithApproval((approval) => api.get<FindResult>(`/find?code=${encodeURIComponent(trimmed)}`, { approval }));
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

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    lookup(code);
  }

  // Empties the box and the result. Esc does this too, but browsers keep Esc for leaving full screen — so it
  // has a button as well.
  function clearAll() {
    setCode("");
    setError(null);
    setResult(null);
    setHistoryIndex(-1);
    setSuggestions([]);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      clearAll();
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
    const view = buildView(result, isAdmin);
    const primary = view.actions.find((a) => a.primary);
    const others = view.actions.filter((a) => !a.primary);

    return (
      <Card className="p-0 overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4 px-6 pt-6">
          <div className="flex min-w-0 items-start gap-3.5">
            <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl bg-gray-100">
              <Icon size={19} className="text-gray-700" />
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wider text-gray-400">{meta.label}</p>
              <h2 className="break-words text-xl font-semibold leading-tight text-gray-900">{view.title}</h2>
              {view.chips && <div className="mt-2 flex flex-wrap items-center gap-1.5">{view.chips}</div>}
            </div>
          </div>
          <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
            {others.map((a) => (
              <Button key={a.to + a.label} onClick={() => navigate(a.to)}>
                {a.label}
              </Button>
            ))}
            {primary && (
              <Button variant="primary" onClick={() => navigate(primary.to)} className="inline-flex items-center gap-1.5">
                {primary.label} <ArrowRight size={14} />
              </Button>
            )}
          </div>
        </div>

        {view.stats && (
          <div className="mx-6 mt-5 overflow-hidden rounded-xl bg-gray-100">
            <div className={`grid gap-px ${view.stats.length >= 3 ? "grid-cols-1 sm:grid-cols-3" : view.stats.length === 2 ? "grid-cols-2" : "grid-cols-1"}`}>
              {view.stats.map((st) => (
                <div key={st.label} className="bg-gray-50 px-4 py-3">
                  <p className="text-xs text-gray-400">{st.label}</p>
                  <p className={`mt-0.5 text-lg font-semibold tabular-nums ${TONE_CLASS[st.tone ?? "default"]}`}>{st.value}</p>
                  {st.hint && <p className="mt-0.5 text-xs text-gray-400">{st.hint}</p>}
                </div>
              ))}
            </div>
            {view.bar && (
              <div className="bg-gray-50 px-4 pb-3">
                <div className="h-1.5 overflow-hidden rounded-full bg-gray-200">
                  <div className="h-full rounded-full bg-gray-900" style={{ width: `${Math.round(view.bar.used * 100)}%` }} />
                </div>
                <p className="mt-1 text-xs text-gray-400">{view.bar.label}</p>
              </div>
            )}
          </div>
        )}

        {view.details.length > 0 && (
          <dl className="grid grid-cols-1 gap-x-10 gap-y-3.5 px-6 py-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {view.details.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs text-gray-400">{label}</dt>
                <dd className="mt-0.5 break-words text-sm font-medium text-gray-900">{value}</dd>
              </div>
            ))}
          </dl>
        )}

        {view.items && view.items.length > 0 && (
          <div className="border-t border-gray-100 px-6 py-4">
            <p className="mb-2 text-xs font-medium text-gray-400">
              {view.items.length} item{view.items.length === 1 ? "" : "s"}
            </p>
            <ul className="divide-y divide-gray-50">
              {view.items.slice(0, 6).map((it, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                  <span className="min-w-0 truncate text-gray-900">
                    {it.title}
                    {it.sub && <span className="ml-2 text-xs text-gray-400">{it.sub}</span>}
                  </span>
                  <span className="flex-shrink-0 tabular-nums text-gray-600">{money(it.price)}</span>
                </li>
              ))}
            </ul>
            {view.items.length > 6 && <p className="pt-1 text-xs text-gray-400">+ {view.items.length - 6} more on the sale page</p>}
          </div>
        )}
        {!(view.items && view.items.length > 0) && view.details.length > 0 && <div className="h-1" />}
      </Card>
    );
  }

  const showHints = !result && !error && !loading;

  return (
    <div>
      <PageHeader title="Find" subtitle="Scan or type a code, or start typing a name — then open whatever it turns up." />

      <Card className="mb-5">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              ref={inputRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Scan a code, or type a name…"
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
          {(code || result || error) && (
            <Button type="button" onClick={clearAll} className="inline-flex items-center gap-1.5">
              <X size={14} />
              Clear
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={loading || !code.trim()} className="inline-flex items-center gap-1.5">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <CornerDownLeft size={14} />}
            Find
          </Button>
        </form>
        <p className="mt-2.5 text-xs text-gray-400">
          <kbd className="rounded border border-gray-200 bg-gray-50 px-1 text-[10px] text-gray-500">↑</kbd> <kbd className="rounded border border-gray-200 bg-gray-50 px-1 text-[10px] text-gray-500">↓</kbd> recent codes ·{" "}
          <kbd className="rounded border border-gray-200 bg-gray-50 px-1 text-[10px] text-gray-500">Esc</kbd> clear ·{" "}
          <kbd className="rounded border border-gray-200 bg-gray-50 px-1 text-[10px] text-gray-500">/</kbd> jump here
        </p>

        {history.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-gray-100 pt-3">
            <History size={13} className="mr-0.5 text-gray-300" />
            {history.slice(0, 8).map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => lookup(h)}
                className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-200 transition"
              >
                {h}
              </button>
            ))}
          </div>
        )}
      </Card>

      {error && (
        <div className="flex items-start gap-3 rounded-2xl border border-red-100 bg-red-50 px-4 py-3.5">
          <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-white">
            <Search size={13} className="text-red-500" />
          </span>
          <div>
            <p className="text-sm font-medium text-red-700">{error}</p>
            <p className="mt-0.5 text-xs text-red-500/80">Check the code for typos, or type a name to search instead.</p>
          </div>
        </div>
      )}
      {loading && !result && (
        <Card>
          <div className="flex animate-pulse items-start gap-3.5">
            <span className="h-11 w-11 rounded-2xl bg-gray-100" />
            <div className="flex-1 space-y-2.5 pt-1">
              <div className="h-3 w-24 rounded bg-gray-100" />
              <div className="h-5 w-48 rounded bg-gray-100" />
              <div className="h-14 rounded-xl bg-gray-50" />
            </div>
          </div>
        </Card>
      )}
      {renderResult()}

      {showHints && (
        <div>
          <p className="mb-2.5 text-xs font-medium text-gray-400">What you can look up</p>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3 xl:grid-cols-5">
            {(isAdmin ? LOOKUP_HINTS : CASHIER_LOOKUP_HINTS).map((h) => {
              const HIcon = h.icon;
              return (
                <div key={h.label} className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3.5 py-3">
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-gray-100">
                    <HIcon size={14} className="text-gray-600" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-gray-900">{h.label}</span>
                    <span className="block truncate text-xs text-gray-400">{h.example}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
