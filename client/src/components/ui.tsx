import { ReactNode, useState, useRef, useEffect, forwardRef } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronUp, Check, Plus, CalendarDays, ChevronLeft, ChevronRight, ArrowUp, ArrowDown, Minus } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";

// A reference to another record (an invoice, a product) shown inline
// in a list or a sentence — a dotted underline (not a solid one, and
// no color change) so it reads as "this is a reference" rather than a
// primary navigation link, and stays discoverable on touch devices
// where hover never happens. stopPropagation is baked in since every
// real usage sits inside a row that already has its own click handler
// (e.g. to expand it) — without this, clicking the reference would
// also trigger that row's own click.
export function RefLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const navigate = useNavigate();
  return (
    <span
      onClick={(e) => {
        e.stopPropagation();
        navigate(to);
      }}
      className={`cursor-pointer underline decoration-dotted decoration-gray-400 underline-offset-2 ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
        {subtitle && <p className="text-sm text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-white border border-gray-200 rounded-2xl p-5 shadow-sm ${className}`}>{children}</div>
  );
}

// deltaPct is optional and purely additive — every existing call site
// without it renders exactly as before. When present, it's read as
// "% change vs whatever the caller considers the comparison period"
// (e.g. the same-length window immediately before the current one).
//
// The delta line is kept to a single line no matter how narrow the card
// gets: whitespace-nowrap stops it wrapping to a second line, and the
// card's own overflow-hidden + the text's truncate clip anything that
// doesn't fit (with an ellipsis) rather than spilling outside the card.
export function StatCard({ label, value, deltaPct }: { label: string; value: string; deltaPct?: number | null }) {
  const showDelta = deltaPct != null && Number.isFinite(deltaPct);
  const isUp = showDelta && deltaPct! > 0.05;
  const isDown = showDelta && deltaPct! < -0.05;
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm overflow-hidden">
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="text-2xl font-semibold text-gray-900">{value}</div>
      {showDelta && (
        <div
          className={`mt-1.5 flex items-center gap-1 text-xs font-medium whitespace-nowrap ${
            isUp ? "text-green-600" : isDown ? "text-red-500" : "text-gray-400"
          }`}
        >
          {isUp ? <ArrowUp size={11} className="flex-shrink-0" /> : isDown ? <ArrowDown size={11} className="flex-shrink-0" /> : <Minus size={11} className="flex-shrink-0" />}
          <span className="truncate">{Math.abs(deltaPct!).toFixed(1)}% vs prev.</span>
        </div>
      )}
    </div>
  );
}

export function Button({
  children,
  onClick,
  type = "button",
  variant = "default",
  size = "md",
  disabled,
  className = "",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "default" | "primary" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const base = "font-medium rounded-xl transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed";
  const sizes = size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2.5 text-sm";
  const variants = {
    default: "bg-white border border-gray-200 text-gray-700 hover:bg-gray-50",
    primary: "bg-black text-white hover:bg-gray-800",
    danger: "bg-red-50 text-red-600 border border-red-200 hover:bg-red-100",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${sizes} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(props, ref) {
  const { className = "", ...rest } = props;
  return (
    <input
      {...rest}
      ref={ref}
      className={`w-full px-3.5 py-2.5 bg-white border border-gray-200 rounded-xl focus:outline-none focus:border-gray-400 focus:ring-2 focus:ring-gray-100 text-sm transition-all duration-200 ${className}`}
    />
  );
});

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = "", children, ...rest } = props;
  return (
    <select
      {...rest}
      className={`w-full px-3.5 py-2.5 bg-white border border-gray-200 rounded-xl focus:outline-none focus:border-gray-400 focus:ring-2 focus:ring-gray-100 text-sm transition-all duration-200 ${className}`}
    >
      {children}
    </select>
  );
}

export interface DropdownOption {
  value: string;
  label: string;
  sublabel?: string;
}

// Custom-styled dropdown replacing the plain native <select> for a more
// deliberate look — used for Category, Sub-category, Supplier, Gender,
// and (with searchable=true) long lists like "pick an existing product"
// where scrolling alone isn't practical.
export function Dropdown({
  value,
  onChange,
  options,
  placeholder = "— Select —",
  disabled = false,
  searchable = false,
  onCreateNew,
  createNewLabel = "+ Add new",
}: {
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  onCreateNew?: () => void;
  createNewLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Flips the panel above the trigger when there isn't enough room below
  // (e.g. a field sitting low in a modal or short column) — same idea as
  // any proper popover, so a long option list never gets cut off against
  // whatever container it's opening into. The real boundary is usually a
  // scrollable ancestor (a modal's own scroll area) rather than the whole
  // window, which is normally much taller than what's actually visible.
  function computeOpenUpward() {
    if (!ref.current) return false;
    const rect = ref.current.getBoundingClientRect();
    let boundaryBottom = window.innerHeight;
    let node = ref.current.parentElement;
    while (node) {
      if (/(auto|scroll)/.test(window.getComputedStyle(node).overflowY)) {
        boundaryBottom = Math.min(boundaryBottom, node.getBoundingClientRect().bottom);
        break;
      }
      node = node.parentElement;
    }
    const estimatedPanelHeight = (searchable ? 40 : 0) + 250;
    const spaceBelow = boundaryBottom - rect.bottom;
    return spaceBelow < estimatedPanelHeight && rect.top > spaceBelow;
  }

  function toggleOpen() {
    if (!open) setOpenUpward(computeOpenUpward());
    setOpen((o) => !o);
  }

  // Opens (never toggles closed) — for the searchable variant's trigger,
  // which is a real text input: focusing it should always open the list,
  // the same way any combobox does, rather than the open/close toggle a
  // button gets on click.
  function openPanel() {
    if (!open) {
      setOpenUpward(computeOpenUpward());
      setOpen(true);
      setQuery("");
    }
  }

  const selected = options.find((o) => o.value === value);
  const filteredOptions =
    searchable && query.trim()
      ? options.filter(
          (o) =>
            o.label.toLowerCase().includes(query.trim().toLowerCase()) ||
            o.sublabel?.toLowerCase().includes(query.trim().toLowerCase())
        )
      : options;

  return (
    <div className="relative" ref={ref}>
      {searchable ? (
        <div className="relative">
          <input
            ref={searchInputRef}
            type="text"
            disabled={disabled}
            value={open ? query : selected?.label ?? ""}
            onFocus={openPanel}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!open) openPanel();
            }}
            placeholder={placeholder}
            className={`w-full px-3.5 py-2.5 pr-8 bg-white border rounded-xl text-sm text-gray-900 placeholder:text-gray-400 transition-all duration-200
              ${disabled ? "opacity-50 cursor-not-allowed bg-gray-50" : "hover:border-gray-300"}
              ${open ? "border-gray-400 ring-2 ring-gray-100" : "border-gray-200"}`}
          />
          <ChevronDown
            size={15}
            className={`pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={toggleOpen}
          className={`w-full flex items-center justify-between px-3.5 py-2.5 bg-white border rounded-xl text-sm text-left transition-all duration-200
            ${disabled ? "opacity-50 cursor-not-allowed bg-gray-50" : "hover:border-gray-300"}
            ${open ? "border-gray-400 ring-2 ring-gray-100" : "border-gray-200"}`}
        >
          <span className={selected ? "text-gray-900" : "text-gray-400"}>{selected ? selected.label : placeholder}</span>
          <ChevronDown size={15} className={`text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      )}

      {open && !disabled && (
        <div
          className={`absolute z-20 w-full bg-white border border-gray-200 rounded-2xl shadow-xl overflow-hidden ${
            openUpward ? "bottom-full mb-1.5" : "mt-1.5"
          }`}
        >
          {/* Searching happens directly in the trigger input above (when
              searchable) — no separate search box in the panel anymore. */}
          <div className="max-h-72 overflow-y-auto p-1.5">
            {filteredOptions.length === 0 ? (
              onCreateNew ? (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setQuery("");
                    onCreateNew();
                  }}
                  className="w-full flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-left text-gray-900 font-medium hover:bg-gray-50 transition-colors"
                >
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center">
                    <Plus size={12} />
                  </span>
                  {query.trim() ? `${createNewLabel} "${query.trim()}"` : createNewLabel}
                </button>
              ) : (
                <div className="px-3 py-2.5 text-sm text-gray-400">No matches</div>
              )
            ) : (
              filteredOptions.map((opt) => {
                const isSelected = opt.value === value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                      setQuery("");
                    }}
                    className={`w-full flex items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-sm text-left transition-colors ${
                      isSelected ? "bg-gray-50 font-medium text-gray-900" : "text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    <span className="truncate">
                      {opt.label}
                      {opt.sublabel && <span className="text-gray-400 ml-1.5 text-xs font-normal">{opt.sublabel}</span>}
                    </span>
                    {isSelected && <Check size={14} className="flex-shrink-0 text-gray-900" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Tap a common reason instead of typing one from scratch every time —
// "Other" reveals a free-text field for anything that doesn't fit the
// presets. `value` is always the final reason string (a preset's own
// text, or whatever was typed under "Other"), so callers don't need to
// know which mode produced it.
export function ReasonPicker({
  value,
  onChange,
  presets,
  placeholder = "Type reason...",
}: {
  value: string;
  onChange: (value: string) => void;
  presets: string[];
  placeholder?: string;
}) {
  const [customMode, setCustomMode] = useState(() => value !== "" && !presets.includes(value));

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => {
              setCustomMode(false);
              onChange(p);
            }}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${
              !customMode && value === p
                ? "bg-black text-white border-black"
                : "border-gray-200 text-gray-600 hover:border-gray-400"
            }`}
          >
            {p}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            setCustomMode(true);
            onChange("");
          }}
          className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${
            customMode ? "bg-black text-white border-black" : "border-gray-200 text-gray-600 hover:border-gray-400"
          }`}
        >
          Other
        </button>
      </div>
      {customMode && (
        <Input className="mt-2" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus />
      )}
    </div>
  );
}

const REASON_OTHER = "__other__";

// Same idea as ReasonPicker (tap a common reason, or type your own) but
// as one compact dropdown row instead of a block of wrapping chips —
// for tight spaces like an inline row-expansion where every extra line
// of height is felt.
export function ReasonDropdown({
  value,
  onChange,
  presets,
  placeholder = "Type reason...",
}: {
  value: string;
  onChange: (value: string) => void;
  presets: string[];
  placeholder?: string;
}) {
  const [customMode, setCustomMode] = useState(() => value !== "" && !presets.includes(value));

  return (
    <div>
      <Dropdown
        value={customMode ? REASON_OTHER : value}
        onChange={(v) => {
          if (v === REASON_OTHER) {
            setCustomMode(true);
            onChange("");
          } else {
            setCustomMode(false);
            onChange(v);
          }
        }}
        placeholder="Select a reason"
        options={[...presets.map((p) => ({ value: p, label: p })), { value: REASON_OTHER, label: "Other — type your own" }]}
      />
      {customMode && (
        <Input className="mt-2" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus />
      )}
    </div>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="block text-xs font-medium text-gray-500 mb-1.5">{children}</label>;
}

// A small muted "?" — sits inline next to a label/heading, wherever a
// longer explanation would otherwise sit as permanent on-page text. Shows
// its tip on hover (desktop) and tap (touch, since hover never fires
// there); tapping elsewhere closes it.
export function HelpHint({ text, className = "" }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <span className={`relative inline-flex align-middle ml-1 ${className}`} ref={ref}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="w-3.5 h-3.5 flex items-center justify-center rounded-full bg-gray-200 text-gray-500 text-[9px] font-bold leading-none hover:bg-gray-300 hover:text-gray-700 transition-colors"
        aria-label="More info"
      >
        ?
      </button>
      {open && (
        <div
          role="tooltip"
          className="absolute z-30 left-1/2 -translate-x-1/2 top-full mt-1.5 w-72 max-w-[85vw] bg-gray-900 text-white text-xs leading-relaxed rounded-lg px-3.5 py-2.5 shadow-lg"
        >
          {text}
        </div>
      )}
    </span>
  );
}

export function FormGroup({ children }: { children: ReactNode }) {
  return <div className="mb-4">{children}</div>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <div className="text-xs text-red-500 mt-1.5">{children}</div>;
}

export function SuccessText({ children }: { children: ReactNode }) {
  return <div className="text-xs text-green-600 mt-1.5">{children}</div>;
}

export function HelperText({ children }: { children: ReactNode }) {
  return <p className="text-xs text-gray-400 mt-1">{children}</p>;
}

export function EmptyState({ icon: Icon, title, subtitle }: { icon?: any; title: string; subtitle?: string }) {
  return (
    <div className="text-center py-16 bg-white border border-gray-200 rounded-2xl">
      {Icon && <Icon size={48} className="text-gray-300 mx-auto mb-3" />}
      <h3 className="text-base font-medium text-gray-700">{title}</h3>
      {subtitle && <p className="text-sm text-gray-400 mt-1">{subtitle}</p>}
    </div>
  );
}

export function Table({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={`w-full text-sm ${className}`}>{children}</table>
    </div>
  );
}

export function Th({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <th className={`text-left px-3 py-2.5 text-xs font-medium text-gray-400 border-b border-gray-100 ${className}`}>{children}</th>;
}

// A clickable <Th> that shows the active sort column/direction — pairs
// with the useSortableData hook (lib/useSortableData.ts). Generic over
// the caller's own sort-key union so every table gets its own type-safe
// set of sortable columns without redeclaring this component.
export function SortHeader<K extends string>({
  label,
  sortKey,
  activeKey,
  dir,
  onClick,
  align,
  className = "",
}: {
  label: string;
  sortKey: K;
  activeKey: K;
  dir: "asc" | "desc";
  onClick: (key: K) => void;
  align?: "right";
  className?: string;
}) {
  const isActive = activeKey === sortKey;
  return (
    <Th className={`${align === "right" ? "text-right" : ""} ${className}`}>
      <button
        onClick={() => onClick(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-gray-700 transition-colors ${
          align === "right" ? "flex-row-reverse" : ""
        } ${isActive ? "text-gray-900" : ""}`}
      >
        {label}
        {isActive ? dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} /> : null}
      </button>
    </Th>
  );
}

export function Td({
  children,
  colSpan,
  className = "",
  title,
}: {
  children: ReactNode;
  colSpan?: number;
  className?: string;
  title?: string;
}) {
  return (
    <td colSpan={colSpan} title={title} className={`px-3 py-2.5 border-b border-gray-50 text-gray-700 ${className}`}>
      {children}
    </td>
  );
}

// Mobile replacement for a table row — used below `lg` where a wide table
// with 5+ columns stops being readable. One RowCard per record; put the
// most important 1-2 fields up top and secondary numbers in the stat strip.
export function RowCard({
  children,
  onClick,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <div
      onClick={onClick}
      className={`bg-white border border-gray-200 rounded-xl p-3.5 ${
        onClick ? "cursor-pointer active:bg-gray-50 transition-colors" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

// A row of small label/value stats inside a RowCard (qty, price, totals,
// etc.) — labels are uppercase and muted, values are the emphasis.
export function RowCardStats({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-5 mt-2.5 pt-2.5 border-t border-gray-100">{children}</div>;
}

export function RowCardStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <p className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</p>
      <p className="text-sm font-semibold text-gray-900 mt-0.5">{value}</p>
    </div>
  );
}

export function Badge({ label, tone }: { label: string; tone: "success" | "warning" | "danger" | "neutral" }) {
  const tones = {
    success: "bg-green-50 text-green-600",
    warning: "bg-yellow-50 text-yellow-600",
    danger: "bg-red-50 text-red-500",
    neutral: "bg-gray-100 text-gray-500",
  };
  return <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium capitalize ${tones[tone]}`}>{label}</span>;
}

export function paymentStatusTone(status: string): "success" | "warning" | "danger" {
  if (status === "paid") return "success";
  if (status === "partial") return "warning";
  return "danger";
}

export function inventoryStatusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "available") return "success";
  if (status === "sold") return "neutral";
  return "danger";
}

export function deliveryStatusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "delivered") return "success";
  if (status === "shipped") return "warning";
  if (status === "returned") return "danger";
  return "neutral";
}

export function TabToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex flex-wrap bg-gray-100 rounded-xl p-1 gap-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-all ${
            value === opt.value ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function NewSupplierModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (supplier: { id: number; name: string; supplier_code: string }) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate() {
    setError(null);
    if (!name.trim()) {
      setError("Supplier name is required");
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.post<{ id: number; name: string; supplier_code: string }>("/suppliers", {
        name: name.trim(),
        phone: phone.trim() || undefined,
        city: city.trim() || undefined,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to create supplier");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-gray-200 shadow-xl p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-gray-900 mb-3">New supplier</h3>
        <FormGroup>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </FormGroup>
        <FormGroup>
          <Label>Phone</Label>
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </FormGroup>
        <FormGroup>
          <Label>City</Label>
          <Input value={city} onChange={(e) => setCity(e.target.value)} />
        </FormGroup>
        {error && <ErrorText>{error}</ErrorText>}
        <div className="flex gap-2 mt-2">
          <Button variant="primary" size="sm" disabled={submitting} onClick={handleCreate}>
            {submitting ? "Creating..." : "Create supplier"}
          </Button>
          <Button size="sm" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

export function NewCategoryModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (category: { id: number; name: string; sub_categories: { id: number; name: string }[] }) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate() {
    setError(null);
    if (!name.trim()) {
      setError("Category name is required");
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.post<{ id: number; name: string; sub_categories: { id: number; name: string }[] }>(
        "/categories",
        { name: name.trim() }
      );
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to create category");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-gray-200 shadow-xl p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-gray-900 mb-3">New category</h3>
        <FormGroup>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </FormGroup>
        {error && <ErrorText>{error}</ErrorText>}
        <div className="flex gap-2 mt-2">
          <Button variant="primary" size="sm" disabled={submitting} onClick={handleCreate}>
            {submitting ? "Creating..." : "Create category"}
          </Button>
          <Button size="sm" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

export function NewSubCategoryModal({
  categoryId,
  categoryName,
  onClose,
  onCreated,
}: {
  categoryId: number;
  categoryName: string;
  onClose: () => void;
  onCreated: (subCategory: { id: number; category_id: number; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate() {
    setError(null);
    if (!name.trim()) {
      setError("Sub-category name is required");
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.post<{ id: number; category_id: number; name: string }>(
        `/categories/${categoryId}/sub-categories`,
        { name: name.trim() }
      );
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to create sub-category");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-gray-200 shadow-xl p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-gray-900 mb-3">New sub-category</h3>
        <p className="text-xs text-gray-400 mb-3">Under {categoryName}</p>
        <FormGroup>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </FormGroup>
        {error && <ErrorText>{error}</ErrorText>}
        <div className="flex gap-2 mt-2">
          <Button variant="primary" size="sm" disabled={submitting} onClick={handleCreate}>
            {submitting ? "Creating..." : "Create sub-category"}
          </Button>
          <Button size="sm" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

// Custom date-range picker — replaces the native <input type="date"> pair
// with a proper calendar dropdown, since native pickers vary wildly
// across browsers and look inconsistent with the rest of the app.
// Quick-range presets (Today, Last 7/30 days, This month) cover the
// common cases; the calendar handles anything else.
export function DateRangePicker({
  startDate,
  endDate,
  onChange,
}: {
  startDate: string | null; // "YYYY-MM-DD" or null
  endDate: string | null;
  onChange: (start: string | null, end: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => {
    const base = startDate ? new Date(startDate) : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [pendingStart, setPendingStart] = useState<string | null>(startDate);
  const [pendingEnd, setPendingEnd] = useState<string | null>(endDate);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    setPendingStart(startDate);
    setPendingEnd(endDate);
  }, [startDate, endDate, open]);

  function toISO(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function formatDisplay(iso: string): string {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function applyPreset(days: number | "month" | "today") {
    const today = new Date();
    let start: Date;
    let end = today;
    if (days === "today") {
      start = today;
    } else if (days === "month") {
      start = new Date(today.getFullYear(), today.getMonth(), 1);
    } else {
      start = new Date(today);
      start.setDate(start.getDate() - (days - 1));
    }
    const s = toISO(start);
    const e = toISO(end);
    onChange(s, e);
    setOpen(false);
  }

  function handleDayClick(d: Date) {
    const iso = toISO(d);
    if (!pendingStart || (pendingStart && pendingEnd)) {
      // Starting a fresh range
      setPendingStart(iso);
      setPendingEnd(null);
    } else if (iso < pendingStart) {
      // Clicked before the current start — becomes the new start
      setPendingStart(iso);
    } else {
      setPendingEnd(iso);
      onChange(pendingStart, iso);
      setOpen(false);
    }
  }

  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
  const firstWeekday = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1).getDay();
  const monthLabel = viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const displayLabel =
    startDate && endDate
      ? startDate === endDate
        ? formatDisplay(startDate)
        : `${formatDisplay(startDate)} – ${formatDisplay(endDate)}`
      : "Select date range";

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3.5 py-2.5 bg-white border border-gray-200 rounded-xl text-sm hover:border-gray-300 transition-all"
      >
        <CalendarDays size={15} className="text-gray-400" />
        <span className={startDate ? "text-gray-900" : "text-gray-400"}>{displayLabel}</span>
      </button>

      {open && (
        <div className="absolute z-20 mt-1.5 right-0 bg-white border border-gray-200 rounded-xl shadow-lg p-3 w-[320px]">
          <div className="flex gap-1.5 flex-wrap mb-3 pb-3 border-b border-gray-100">
            <button onClick={() => applyPreset("today")} className="px-2.5 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg transition">
              Today
            </button>
            <button onClick={() => applyPreset(7)} className="px-2.5 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg transition">
              Last 7 days
            </button>
            <button onClick={() => applyPreset(30)} className="px-2.5 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg transition">
              Last 30 days
            </button>
            <button onClick={() => applyPreset("month")} className="px-2.5 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg transition">
              This month
            </button>
          </div>

          <div className="flex items-center justify-between mb-2">
            <button
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}
              className="p-1 hover:bg-gray-100 rounded-lg transition"
            >
              <ChevronLeft size={15} />
            </button>
            <span className="text-sm font-medium text-gray-900">{monthLabel}</span>
            <button
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}
              className="p-1 hover:bg-gray-100 rounded-lg transition"
            >
              <ChevronRight size={15} />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 mb-1">
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
              <div key={i} className="text-center text-[10px] font-medium text-gray-400 py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: firstWeekday }).map((_, i) => (
              <div key={`blank-${i}`} />
            ))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const date = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), day);
              const iso = toISO(date);
              const isStart = pendingStart === iso;
              const isEnd = pendingEnd === iso;
              const inRange = pendingStart && pendingEnd && iso > pendingStart && iso < pendingEnd;
              return (
                <button
                  key={day}
                  onClick={() => handleDayClick(date)}
                  className={`aspect-square rounded-lg text-xs transition ${
                    isStart || isEnd
                      ? "bg-black text-white font-medium"
                      : inRange
                      ? "bg-gray-100 text-gray-900"
                      : "text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function DatePicker({
  value,
  onChange,
  placeholder = "Select date",
}: {
  value: string | null; // "YYYY-MM-DD" or null
  onChange: (date: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => {
    const base = value ? new Date(value + "T00:00:00") : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // The panel is roughly 320px tall — if there isn't that much room
  // below the field (e.g. it's near the bottom of a modal), open
  // upward instead of getting clipped by the modal's own boundary.
  function handleToggle() {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUpward(spaceBelow < 320);
    }
    setOpen((o) => !o);
  }

  function toISO(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function formatDisplay(iso: string): string {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function handleDayClick(d: Date) {
    onChange(toISO(d));
    setOpen(false);
  }

  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
  const firstWeekday = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1).getDay();
  const monthLabel = viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const todayIso = toISO(new Date());

  return (
    <div className="relative inline-block w-full" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        className="w-full flex items-center gap-2 px-3.5 py-2.5 bg-white border border-gray-200 rounded-xl text-sm hover:border-gray-300 transition-all"
      >
        <CalendarDays size={15} className="text-gray-400 flex-shrink-0" />
        <span className={value ? "text-gray-900" : "text-gray-400"}>{value ? formatDisplay(value) : placeholder}</span>
      </button>

      {open && (
        <div
          className={`absolute z-20 left-0 bg-white border border-gray-200 rounded-xl shadow-lg p-3 w-[280px] ${
            openUpward ? "bottom-full mb-1.5" : "top-full mt-1.5"
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}
              className="p-1 hover:bg-gray-100 rounded-lg transition"
            >
              <ChevronLeft size={15} />
            </button>
            <span className="text-sm font-medium text-gray-900">{monthLabel}</span>
            <button
              type="button"
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}
              className="p-1 hover:bg-gray-100 rounded-lg transition"
            >
              <ChevronRight size={15} />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 mb-1">
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
              <div key={i} className="text-center text-[10px] font-medium text-gray-400 py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: firstWeekday }).map((_, i) => (
              <div key={`blank-${i}`} />
            ))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const date = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), day);
              const iso = toISO(date);
              const isSelected = value === iso;
              const isToday = todayIso === iso;
              return (
                <button
                  type="button"
                  key={day}
                  onClick={() => handleDayClick(date)}
                  className={`aspect-square rounded-lg text-xs transition ${
                    isSelected
                      ? "bg-black text-white font-medium"
                      : isToday
                      ? "bg-gray-100 text-gray-900 font-medium"
                      : "text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}