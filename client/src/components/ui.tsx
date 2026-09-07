import { ReactNode, useState, useRef, useEffect } from "react";
import { ChevronDown, Check, Plus, CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";

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

export function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="text-2xl font-semibold text-gray-900">{value}</div>
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
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "default" | "primary" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
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
      className={`${base} ${sizes} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return (
    <input
      {...rest}
      className={`w-full px-3.5 py-2.5 bg-white border border-gray-200 rounded-xl focus:outline-none focus:border-gray-400 focus:ring-2 focus:ring-gray-100 text-sm transition-all duration-200 ${className}`}
    />
  );
}

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
  dropUp = false,
  onCreateNew,
  createNewLabel = "+ Add new",
}: {
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  dropUp?: boolean;
  onCreateNew?: () => void;
  createNewLabel?: string;
}) {
  const [open, setOpen] = useState(false);
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

  useEffect(() => {
    if (open && searchable) searchInputRef.current?.focus();
  }, [open, searchable]);

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
      {open && searchable ? (
        <div className="relative w-full rounded-xl border border-gray-400 bg-white ring-2 ring-gray-100">
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            className="w-full rounded-xl bg-transparent px-3.5 py-2.5 pr-10 text-sm focus:outline-none"
            onClick={(e) => e.stopPropagation()}
          />
          <ChevronDown size={15} className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 rotate-180 text-gray-400" />
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          className={`w-full flex items-center justify-between px-3.5 py-2.5 bg-white border rounded-xl text-sm text-left transition-all duration-200
            ${disabled ? "opacity-50 cursor-not-allowed bg-gray-50" : "hover:border-gray-300"}
            ${open ? "border-gray-400 ring-2 ring-gray-100" : "border-gray-200"}`}
        >
          <span className={selected ? "text-gray-900" : "text-gray-400"}>{selected ? selected.label : placeholder}</span>
          <ChevronDown size={15} className={`text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      )}

      {open && !disabled && (
        <div className={`absolute z-20 w-full bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden ${dropUp ? "bottom-full mb-1.5" : "mt-1.5"}`}>
          <div className="max-h-72 overflow-y-auto py-1">
            {onCreateNew && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setQuery("");
                  onCreateNew();
                }}
                className="w-full flex items-center gap-1.5 px-3.5 py-2.5 text-sm text-left text-gray-900 font-medium hover:bg-gray-50 transition-colors border-b border-gray-100"
              >
                <Plus size={14} />
                {createNewLabel}
              </button>
            )}
            {filteredOptions.length === 0 ? (
              <div className="px-3.5 py-2.5 text-sm text-gray-400">No matches</div>
            ) : (
              filteredOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="w-full flex items-center justify-between px-3.5 py-2.5 text-sm text-left hover:bg-gray-50 transition-colors"
                >
                  <span>
                    {opt.label}
                    {opt.sublabel && <span className="text-gray-400 ml-1.5 text-xs">{opt.sublabel}</span>}
                  </span>
                  {opt.value === value && <Check size={14} className="text-black" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="block text-xs font-medium text-gray-500 mb-1.5">{children}</label>;
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

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

export function Th({ children }: { children: ReactNode }) {
  return <th className="text-left px-3 py-2.5 text-xs font-medium text-gray-400 border-b border-gray-100">{children}</th>;
}

export function Td({ children, colSpan, className = "" }: { children: ReactNode; colSpan?: number; className?: string }) {
  return (
    <td colSpan={colSpan} className={`px-3 py-2.5 border-b border-gray-50 text-gray-700 ${className}`}>
      {children}
    </td>
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
    <div className="inline-flex bg-gray-100 rounded-xl p-1 gap-1">
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
