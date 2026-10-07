import { ReactNode, useState, useRef, useEffect, useLayoutEffect, forwardRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronUp, Check, Plus, CalendarDays, ChevronLeft, ChevronRight, ArrowUp, ArrowDown, Minus, X, MoreVertical } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";

// ---------------------------------------------------------------------
// UI standards for the whole app — use these instead of one-off values.
//
// Icons: lucide-react only, default stroke, one size scale —
//    12  inside chips, badges and text-xs links
//    14  the default: buttons, table actions, anything beside text-sm
//    16  leading icons in inputs, nav items, standalone icon buttons
//    18  dialog close (X) and card/section headers
//    20, 24  stat tiles          32+  empty-state artwork
//  A close button is always <X size={18} /> in text-gray-400 — never a
//  typed "✕".
// Dialogs: <Modal> only — a header (title, optional subtitle, close), a body
//    that scrolls when it has to, and a footer that stays put with the
//    actions. Never a hand-built "fixed inset-0" overlay.
// Buttons: <Button> (rounded-xl; sm = px-3 py-1.5 text-xs, md = px-4
//    py-2.5 text-sm), icon + label gap-1.5. Table-row actions: <RowActions>.
// Status / type labels: <Badge> only.
// Shape: dialogs rounded-2xl; inputs, buttons and cards rounded-xl;
//    notice boxes rounded-lg. Dialog titles text-base font-semibold.
// Colour: black, grey and white. Red marks an error or a destructive
//    action, amber a warning notice; nothing else.
// ---------------------------------------------------------------------

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
          {isUp ? <ArrowUp size={12} className="flex-shrink-0" /> : isDown ? <ArrowDown size={12} className="flex-shrink-0" /> : <Minus size={12} className="flex-shrink-0" />}
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
  size = "md",
  menuClassName = "",
}: {
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  onCreateNew?: () => void;
  createNewLabel?: string;
  // "sm" is for dropdowns sitting inside a table row (inline edit): the
  // same text size and a row-friendly height, so editing a row doesn't
  // make it taller than its neighbours.
  size?: "sm" | "md";
  // Extra classes for the open list — e.g. a minimum width when the trigger
  // itself is narrow (a country-code picker) but the options need room.
  menuClassName?: string;
}) {
  const compact = size === "sm";
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
            className={`w-full ${compact ? "h-7 px-2 pr-6 text-xs rounded-lg" : "px-3.5 py-2.5 pr-8 text-sm rounded-xl"} bg-white border text-gray-900 placeholder:text-gray-400 transition-all duration-200
              ${disabled ? "opacity-50 cursor-not-allowed bg-gray-50" : "hover:border-gray-300"}
              ${open ? "border-gray-400 ring-2 ring-gray-100" : "border-gray-200"}`}
          />
          <ChevronDown
            size={compact ? 12 : 15}
            className={`pointer-events-none absolute ${compact ? "right-2" : "right-3.5"} top-1/2 -translate-y-1/2 text-gray-400 transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={toggleOpen}
          className={`w-full flex items-center justify-between gap-1.5 ${compact ? "h-7 px-2 text-xs rounded-lg" : "px-3.5 py-2.5 text-sm rounded-xl"} bg-white border text-left transition-all duration-200
            ${disabled ? "opacity-50 cursor-not-allowed bg-gray-50" : "hover:border-gray-300"}
            ${open ? "border-gray-400 ring-2 ring-gray-100" : "border-gray-200"}`}
        >
          <span className={`${selected ? "text-gray-900" : "text-gray-400"} ${compact ? "min-w-0 truncate" : ""}`}>{selected ? selected.label : placeholder}</span>
          <ChevronDown size={compact ? 12 : 15} className={`flex-shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      )}

      {open && !disabled && (
        <div
          className={`absolute z-20 w-full ${compact ? "min-w-[9rem] rounded-xl" : "rounded-2xl"} bg-white border border-gray-200 shadow-xl overflow-hidden ${
            openUpward ? "bottom-full mb-1.5" : "mt-1.5"
          } ${menuClassName}`}
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
                    className={`w-full flex items-center justify-between gap-2 rounded-lg ${compact ? "px-2.5 py-1.5 text-xs" : "px-3 py-2.5 text-sm"} text-left transition-colors ${
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

// Every dialog in the app. The header and the footer never scroll away — only
// the body between them does — so the title and the action buttons are always
// in reach however long the content gets. Escape and a click outside close it
// (only the top-most one, when a dialog opens another).
//   size   — sm 448px · md 512px (default) · lg 576px · xl 672px · 2xl 896px · 3xl 1024px
//   footer — the action buttons, right-aligned (usually Cancel then the main one)
//   stacked — set when it opens on top of another dialog
//   height — a fixed panel height instead of "as tall as the content" (wizards
//            with side-by-side columns); flush — a body with no padding that
//            doesn't scroll itself, for content that lays out and scrolls its own columns
const MODAL_WIDTH = { sm: "max-w-md", md: "max-w-lg", lg: "max-w-xl", xl: "max-w-2xl", "2xl": "max-w-4xl", "3xl": "max-w-5xl" } as const;
const openModals: symbol[] = [];

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = "md",
  stacked = false,
  dismissOnBackdrop = true,
  height,
  flush = false,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof MODAL_WIDTH;
  stacked?: boolean;
  dismissOnBackdrop?: boolean;
  height?: string;
  flush?: boolean;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const id = Symbol("modal");
    openModals.push(id);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && openModals[openModals.length - 1] === id) closeRef.current();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const at = openModals.indexOf(id);
      if (at >= 0) openModals.splice(at, 1);
    };
  }, []);

  return (
    <div
      className={`fixed inset-0 ${stacked ? "z-[70]" : "z-50"} flex items-center justify-center bg-black/50 p-4`}
      onClick={dismissOnBackdrop ? onClose : undefined}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`flex ${height ?? "max-h-[calc(100dvh-2rem)]"} w-full ${MODAL_WIDTH[size]} flex-col overflow-hidden rounded-2xl bg-white shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-gray-100 px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-gray-400">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-1 flex-shrink-0 rounded-lg p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>
        <div className={flush ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-y-auto px-6 py-5"}>{children}</div>
        {footer && (
          <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2 border-t border-gray-100 bg-gray-50 px-6 py-3.5">{footer}</div>
        )}
      </div>
    </div>
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

// children is optional: an empty header cell (an actions column) is normal.
export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
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

export interface RowAction {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  // Plain until hovered, then tinted: "good" green, "bad" red.
  tone?: "default" | "good" | "bad";
  disabled?: boolean;
}

// A table row's inline actions as one tidy segmented button group — equal
// 28px-high buttons divided by hairlines, neutral until hovered. Icon-only
// (the label is the tooltip and the screen-reader name) so a row of four
// actions stays compact.
export function RowActions({ actions }: { actions: RowAction[] }) {
  const hover = {
    default: "hover:bg-gray-100 hover:text-gray-900",
    good: "hover:bg-green-50 hover:text-green-700",
    bad: "hover:bg-red-50 hover:text-red-600",
  };
  return (
    <div className="inline-flex items-center divide-x divide-gray-200 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          title={action.label}
          aria-label={action.label}
          className={`inline-flex h-7 w-8 items-center justify-center text-gray-500 transition-colors focus:outline-none focus-visible:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 ${hover[action.tone ?? "default"]}`}
        >
          {action.icon}
        </button>
      ))}
    </div>
  );
}

// The "three dots" button at the end of a row, opening a small list of actions.
// The list is drawn above everything else (not inside the table), so a table
// that scrolls or clips its content can't cut it off, and it opens upward when
// there's no room below.
export function ActionMenu({ items }: { items: { label: string; icon?: ReactNode; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number; up: boolean }>({ top: 0, right: 0, up: false });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (!open && buttonRef.current) {
      const r = buttonRef.current.getBoundingClientRect();
      const roomBelow = window.innerHeight - r.bottom;
      const needed = items.length * 38 + 12;
      setPos({ top: roomBelow < needed ? r.top : r.bottom, right: window.innerWidth - r.right, up: roomBelow < needed });
    }
    setOpen((o) => !o);
  }

  useEffect(() => {
    if (!open) return;
    function close(e: Event) {
      if (menuRef.current?.contains(e.target as Node) || buttonRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        title="Actions"
        aria-label="Actions"
        className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
      >
        <MoreVertical size={16} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            onClick={(e) => e.stopPropagation()}
            style={{ position: "fixed", right: pos.right, ...(pos.up ? { bottom: window.innerHeight - pos.top + 4 } : { top: pos.top + 4 }) }}
            className="z-[80] w-52 rounded-xl border border-gray-200 bg-white py-1 shadow-lg"
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
                className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 transition hover:bg-gray-50"
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
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

// The one status / type label used everywhere in the app — the same quiet
// look on every page: black text on a light grey pill, no border, nothing
// that pulls the eye. What a label means is carried by its words (Paid,
// Unpaid, Bounced...), not by colour or weight. `tone` is still accepted so
// callers can say what kind of state it is, but it no longer changes the
// look — if a state ever needs to stand out again, this is the one place
// to do it.
export type BadgeTone = "success" | "warning" | "danger" | "neutral" | "outline";

export function Badge({ label }: { label: string; tone?: BadgeTone }) {
  return (
    <span className="inline-block whitespace-nowrap rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-900 first-letter:uppercase">
      {label}
    </span>
  );
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
    <Modal
      size="sm"
      stacked
      onClose={onClose}
      title="New supplier"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={submitting} onClick={handleCreate}>
            {submitting ? "Creating..." : "Create supplier"}
          </Button>
        </>
      }
    >
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
    </Modal>
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
    <Modal
      size="sm"
      stacked
      onClose={onClose}
      title="New category"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={submitting} onClick={handleCreate}>
            {submitting ? "Creating..." : "Create category"}
          </Button>
        </>
      }
    >
        <FormGroup>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </FormGroup>
        {error && <ErrorText>{error}</ErrorText>}
    </Modal>
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
    <Modal
      size="sm"
      stacked
      onClose={onClose}
      title="New sub-category"
      subtitle={`Under ${categoryName}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={submitting} onClick={handleCreate}>
            {submitting ? "Creating..." : "Create sub-category"}
          </Button>
        </>
      }
    >
        <FormGroup>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </FormGroup>
        {error && <ErrorText>{error}</ErrorText>}
    </Modal>
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
        <CalendarDays size={14} className="text-gray-400" />
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
              <ChevronLeft size={14} />
            </button>
            <span className="text-sm font-medium text-gray-900">{monthLabel}</span>
            <button
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}
              className="p-1 hover:bg-gray-100 rounded-lg transition"
            >
              <ChevronRight size={14} />
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
  // Screen coordinates for the portal-rendered panel below, computed
  // fresh each time it opens. Rendering into document.body via a portal
  // (instead of as a normal descendant) is what actually matters here —
  // positioned purely by these coordinates, the panel is never clipped
  // or forced to scroll by a modal's own overflow-y-auto card or any
  // other ancestor's bounds, no matter how tight the space around the
  // field is.
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null);
  const [viewMonth, setViewMonth] = useState(() => {
    const base = value ? new Date(value + "T00:00:00") : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const PANEL_WIDTH = 320;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Closing on scroll (rather than tracking/repositioning) matches how
  // a native <select> behaves, and sidesteps the panel drifting out of
  // sync if the modal's own body — not the window — is what scrolled.
  // Capture phase so this fires for a scroll anywhere, including inside
  // a nested overflow-y-auto container.
  useEffect(() => {
    if (!open) return;
    function handleScroll() {
      setOpen(false);
    }
    document.addEventListener("scroll", handleScroll, true);
    return () => document.removeEventListener("scroll", handleScroll, true);
  }, [open]);

  // Positions the panel right against the field first (a fixed, honest
  // guess — no invented height), then — once it's actually in the DOM —
  // corrects against its real measured height in a layout effect below.
  // That correction runs synchronously before the browser paints, so
  // there's no visible jump; it just means the very first guess here
  // only has to be reasonable, not exact.
  function handleToggle() {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const openLeftward = window.innerWidth - rect.left < PANEL_WIDTH;
      setPanelPos({
        top: rect.bottom + 6,
        left: openLeftward ? rect.right - PANEL_WIDTH : rect.left,
      });
    }
    setOpen((o) => !o);
  }

  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !panelRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const panelHeight = panelRef.current.getBoundingClientRect().height;
    const openUpward = window.innerHeight - rect.bottom < panelHeight + 8 && rect.top > panelHeight + 8;
    const openLeftward = window.innerWidth - rect.left < PANEL_WIDTH;
    setPanelPos({
      top: openUpward ? rect.top - panelHeight - 6 : rect.bottom + 6,
      left: openLeftward ? rect.right - PANEL_WIDTH : rect.left,
    });
    // Only re-runs when the panel opens (or the visible month changes
    // the panel's own height, e.g. a 5-row vs 6-row month) — not on
    // every panelPos update, which would just loop against itself.
  }, [open, viewMonth]);

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
        <CalendarDays size={14} className="text-gray-400 flex-shrink-0" />
        <span className={value ? "text-gray-900" : "text-gray-400"}>{value ? formatDisplay(value) : placeholder}</span>
      </button>

      {open &&
        panelPos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: "fixed", top: panelPos.top, left: panelPos.left, width: PANEL_WIDTH, zIndex: 60 }}
            className="bg-white border border-gray-200 rounded-xl shadow-lg p-3.5"
          >
            <div className="flex items-center justify-between mb-2">
              <button
                type="button"
                onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}
                className="p-1 hover:bg-gray-100 rounded-lg transition"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="text-sm font-medium text-gray-900">{monthLabel}</span>
              <button
                type="button"
                onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}
                className="p-1 hover:bg-gray-100 rounded-lg transition"
              >
                <ChevronRight size={14} />
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
          </div>,
          document.body
        )}
    </div>
  );
}