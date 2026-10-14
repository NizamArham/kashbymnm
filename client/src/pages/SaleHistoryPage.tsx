import { useEffect, useState, Fragment, useMemo, MouseEvent, useRef, ReactNode } from "react";
import { ChevronDown, ChevronRight, Receipt, Printer, MoreVertical, Wallet, Download, FileText, MessageCircle, Star, Repeat, TrendingUp, Search, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, ApiRequestError } from "../lib/api";
import { Sale } from "../lib/types";
import { downloadTabularReport, rangeLabelFor, buildReportFilename, formatLongDate, todayLongDate } from "../lib/reportPdf";
import { downloadA4Pdf, downloadThermalPdf, sendWhatsAppBill, groupSaleItemsForDisplay } from "../lib/receipts";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";
import { useSortableData } from "../lib/useSortableData";
import { useCopyToClipboard } from "../lib/useCopyToClipboard";
import { isAwaitingCod, salePaymentLabel, saleStatusLabel } from "../lib/salePayment";
import { PageHeader, Card, Th, Td, Badge, SortHeader, paymentStatusTone, EmptyState, ErrorText, DateRangePicker, Button, RowCard, RowCardStats, RowCardStat, FormGroup, Label, Input, Modal, RefLink, TabToggle } from "../components/ui";
import ReceiptOptionsModal, { ModalOption } from "../components/ReceiptOptionsModal";
import ExchangeTag from "../components/ExchangeTag";
import SaleProfitModal from "../components/SaleProfitModal";
import DeliveryChargeSummary from "../components/DeliveryChargeSummary";
import { useAuth } from "../context/AuthContext";

// Two separate questions, each answered on its own: WHEN (the period, or a custom date range) and
// WHAT KIND of sale. They used to share one row of tabs, so picking "Voided" forgot the period.
type Period = "today" | "week" | "month" | "all";
type Kind = "all" | "cash" | "credit" | "cod" | "wholesale" | "voided";
type SaleSortKey = "invoice" | "date" | "customer" | "total" | "paid";

const PERIODS: { value: Period; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

const KINDS: { value: Kind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "cash", label: "Cash" },
  { value: "credit", label: "Credit / not paid" },
  { value: "cod", label: "COD" },
  { value: "wholesale", label: "Wholesale" },
  { value: "voided", label: "Voided" },
];

// The invoice number already says what kind of order it is: OCD = online cash on delivery,
// SCR / OCR = in-store / online credit, OPS = online paid up front, STR = in-store paid.
const isCodSale = (s: Sale) => s.invoice.startsWith("OCD");

// A voided invoice earned and owes nothing, so it only appears under "Voided".
const KIND_FILTER: Record<Kind, (s: Sale) => boolean> = {
  all: (s) => !s.is_voided,
  cash: (s) => s.payment_method === "cash" && !s.is_voided && !isAwaitingCod(s),
  // Still owes money: a credit sale not yet settled, or any part-paid bill — but not a COD that is
  // simply on its way (that's under COD).
  credit: (s) => !s.is_voided && s.payment_status !== "paid" && !isCodSale(s),
  cod: (s) => !s.is_voided && isCodSale(s),
  wholesale: (s) => !s.is_voided && !!s.is_wholesale,
  voided: (s) => !!s.is_voided,
};

// The list fits the screen on desktop and is read a page at a time. A row is this tall (taller when an
// exchange tag sits under the invoice number), so the number of rows that fit is worked out
// from the room on screen. Phones and tablets get stacked cards, a fixed number to a page.
const ROW_HEIGHT = 57;
const TAGGED_ROW_HEIGHT = 89;
const TABLE_HEAD_HEIGHT = 37;
const CARDS_PER_PAGE = 12;
const MENU_HEIGHT = 340;
const rowHeightOf = (s: Sale) => (s.exchange_out_status || s.exchange_in_status ? TAGGED_ROW_HEIGHT : ROW_HEIGHT);
const PAGER_BUTTON =
  "px-2.5 py-1 text-xs border border-gray-200 rounded-lg hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed bg-white";

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatShortDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// Full month name for the "Report" field's value ("September", not
// "Sep") — reads better spelled out than the compact form used in the
// smaller "Generated ..." line and the filename. (formatLongDate for a
// full day+month+year comes from reportPdf.ts — shared, not redefined.)
function formatLongMonthYear(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

// The title a standard business report actually has — the period baked
// right into the heading ("Sales Report — September 2026") instead of
// a bare "Sales Report" with the date only mentioned in small print
// below. Whole-month stays just "Month Year" (the exact day cutoff
// still shows in the smaller "Generated ..." line); a week or a custom
// range spells out the day span; a single day gets its own full date.
// This is the VALUE for the header block's "Report" row — "Report" is
// the label now, so this no longer repeats the word itself (matching
// how the invoice's own kvRow values never restate their label).
function reportTitleFor(tab: Period, startDate: string | null, endDate: string | null): string {
  if (startDate && endDate) {
    return startDate === endDate ? `Sales — ${formatLongDate(startDate)}` : `Sales — ${formatShortDate(startDate)} to ${formatLongDate(endDate)}`;
  }
  if (tab === "today") return `Sales — ${formatLongDate(toISODate(new Date()))}`;
  if (tab === "week") {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 6);
    return `Sales — ${formatShortDate(toISODate(weekAgo))} to ${formatLongDate(toISODate(new Date()))}`;
  }
  if (tab === "month") return `Sales — ${formatLongMonthYear(toISODate(new Date()))}`;
  return `Sales — ${PERIODS.find((p) => p.value === tab)?.label ?? "All time"}`;
}

// "This Month" on its own doesn't say what it actually covers — this
// spells it out (e.g. "This Month (1–27 Sep 2026)") so the PDF is
// self-explanatory without having to know this page's own tab logic.
function formatPresetRange(startIso: string, endIso: string, presetLabel: string): string {
  if (startIso === endIso) return `${presetLabel} (${formatShortDate(startIso)})`;
  const start = new Date(startIso + "T00:00:00");
  const end = new Date(endIso + "T00:00:00");
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  const startPart = sameMonth ? String(start.getDate()) : formatShortDate(startIso);
  return `${presetLabel} (${startPart}–${formatShortDate(endIso)})`;
}

// A short, filename-safe identifier for what's in the download — e.g.
// "Sep2026" for the whole current month, "28Sep2026" for a single day,
// "22-28Sep2026" for a week. Deliberately terser than the on-page range
// text above: a filename needs to stay short and stay unique across
// repeats, not read like a sentence.
function formatFilenameTag(iso: string): string {
  return formatShortDate(iso).replace(/\s+/g, "");
}
function filenameRangeTag(startIso: string, endIso: string): string {
  if (startIso === endIso) return formatFilenameTag(startIso);
  const start = new Date(startIso + "T00:00:00");
  const end = new Date(endIso + "T00:00:00");
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  return sameMonth ? `${start.getDate()}-${formatFilenameTag(endIso)}` : `${formatFilenameTag(startIso)}-${formatFilenameTag(endIso)}`;
}

// The buyer's name — a link to their profile on the Customers page when the
// sale has a real customer (not a walk-in, and not one that's since been deleted).
function CustomerName({ sale }: { sale: Sale }) {
  if (sale.customer_id && sale.customer_name) {
    return <RefLink to={`/customers?open=${sale.customer_id}`}>{sale.customer_name}</RefLink>;
  }
  return <>{sale.deleted_customer_snapshot ? `[Deleted: ${sale.deleted_customer_snapshot}]` : "Walk-in"}</>;
}

export default function SaleHistoryPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [sales, setSales] = useState<Sale[]>([]);
  const [expanded, setExpanded] = useState<Sale | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [receiptSale, setReceiptSale] = useState<Sale | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<number | null>(null);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  // Two separate refs, not one shared between the desktop row and the
  // mobile card: both markups exist in the DOM at once (CSS just hides
  // whichever doesn't match the viewport), so a single ref's `current`
  // would get overwritten by whichever renders second — silently
  // pointing "outside click" detection at the wrong (invisible) element
  // and closing the menu on every click inside it, before the click
  // itself could ever reach a menu item's onClick.
  const desktopMenuRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  // "Mark as paid / COD collected" — self-delivered orders only, since
  // courier-collected COD is settled separately in bulk elsewhere.
  const [codConfirmSale, setCodConfirmSale] = useState<Sale | null>(null);
  // The already-rung-up sale being marked wholesale (admin): takes back its loyalty points.
  const [wholesaleSale, setWholesaleSale] = useState<Sale | null>(null);
  const [profitSale, setProfitSale] = useState<Sale | null>(null);
  const [wholesaleReason, setWholesaleReason] = useState("");
  const [wholesaleError, setWholesaleError] = useState<string | null>(null);
  const [wholesaleBusy, setWholesaleBusy] = useState(false);
  const [codConfirming, setCodConfirming] = useState(false);
  const [codError, setCodError] = useState<string | null>(null);
  const [codPaymentMethod, setCodPaymentMethod] = useState<"cash" | "bank_transfer" | "card">("cash");
  const [undoingId, setUndoingId] = useState<number | null>(null);

  const [period, setPeriod] = useState<Period>("month");
  const [kind, setKind] = useState<Kind>("all");
  const [search, setSearch] = useState("");

  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);

  // Paging. `rowRoom` is how many pixels of rows fit in the table area on screen right now.
  const [page, setPage] = useState(1);
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  const [rowRoom, setRowRoom] = useState(CARDS_PER_PAGE * ROW_HEIGHT);
  const tableBodyRef = useRef<HTMLDivElement>(null);
  // Where the open "…" menu sits. It is fixed to the screen, not to its row, so the last rows' menus
  // aren't cut off by the table area (and open upward when there is no room below).
  const [menuPos, setMenuPos] = useState<{ top?: number; bottom?: number; right: number; maxHeight: number } | null>(null);

  useEffect(() => {
    api
      .get<Sale[]>("/sales")
      .then(setSales)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Failed to load sales"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    function handleClickOutside(e: globalThis.MouseEvent) {
      const target = e.target as Node;
      const insideDesktop = desktopMenuRef.current?.contains(target) ?? false;
      const insideMobile = mobileMenuRef.current?.contains(target) ?? false;
      if (!insideDesktop && !insideMobile) setOpenMenuId(null);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // First by when…
  const inPeriod = useMemo(() => {
    if (startDate && endDate) {
      return sales.filter((s) => {
        const d = s.date.slice(0, 10);
        return d >= startDate && d <= endDate;
      });
    }
    const today = toISODate(new Date());
    if (period === "today") return sales.filter((s) => s.date.slice(0, 10) === today);
    if (period === "week") {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 6);
      const start = toISODate(weekAgo);
      return sales.filter((s) => s.date.slice(0, 10) >= start);
    }
    if (period === "month") {
      const now = new Date();
      const monthStart = toISODate(new Date(now.getFullYear(), now.getMonth(), 1));
      return sales.filter((s) => s.date.slice(0, 10) >= monthStart);
    }
    return sales;
  }, [sales, period, startDate, endDate]);

  // …how many of each kind fall in that period (shown on the kind buttons)…
  const kindCounts = useMemo(() => {
    const counts = {} as Record<Kind, number>;
    for (const k of KINDS) counts[k.value] = inPeriod.filter(KIND_FILTER[k.value]).length;
    return counts;
  }, [inPeriod]);

  // …then the kind and anything typed in the search box (invoice number or customer).
  const filteredSales = useMemo(() => {
    const q = search.trim().toLowerCase();
    return inPeriod.filter(KIND_FILTER[kind]).filter((s) => {
      if (!q) return true;
      return (
        s.invoice.toLowerCase().includes(q) ||
        (s.customer_name ?? s.deleted_customer_snapshot ?? "walk-in").toLowerCase().includes(q) ||
        (s.customer_phone ?? "").includes(q)
      );
    });
  }, [inPeriod, kind, search]);

  const { sorted: sortedSales, sortKey, sortDir, toggleSort } = useSortableData<Sale, SaleSortKey>(
    filteredSales,
    (s, key) => {
      switch (key) {
        case "invoice":
          return s.invoice.toLowerCase();
        case "date":
          return s.date;
        case "customer":
          return (s.customer_name ?? s.deleted_customer_snapshot ?? "Walk-in").toLowerCase();
        case "total":
          return s.total;
        case "paid":
          return s.amount_paid;
      }
    },
    "date",
    "desc"
  );

  // Fill the table area with as many rows as fit — never fewer than five. The area keeps one height
  // whether the list is loading, empty or full (the footer is always there), so this can't flip back and forth.
  useEffect(() => {
    const el = tableBodyRef.current;
    if (!el) return;
    const fit = () => {
      const isDesktop = window.matchMedia("(min-width: 1024px)").matches;
      setDesktop(isDesktop);
      setRowRoom(isDesktop ? Math.max(5 * ROW_HEIGHT, el.clientHeight - TABLE_HEAD_HEIGHT) : CARDS_PER_PAGE * ROW_HEIGHT);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  // Pages are filled row by row until the room runs out, so a page with a few taller rows simply
  // holds one or two fewer sales instead of spilling out of the table area.
  const pages = useMemo(() => {
    const out: Sale[][] = [];
    let current: Sale[] = [];
    let used = 0;
    for (const sale of sortedSales) {
      const h = desktop ? rowHeightOf(sale) : ROW_HEIGHT;
      if (current.length > 0 && used + h > rowRoom) {
        out.push(current);
        current = [];
        used = 0;
      }
      current.push(sale);
      used += h;
    }
    if (current.length > 0) out.push(current);
    return out.length > 0 ? out : [[]];
  }, [sortedSales, desktop, rowRoom]);

  const totalPages = pages.length;
  const currentPage = Math.min(page, totalPages);
  const pageSales = pages[currentPage - 1];
  const rangeStart = pageSales.length === 0 ? 0 : pages.slice(0, currentPage - 1).reduce((n, p) => n + p.length, 0) + 1;
  const rangeEnd = rangeStart === 0 ? 0 : rangeStart + pageSales.length - 1;

  // A different list (period, kind, search, sort) starts again from the first page.
  useEffect(() => {
    setPage(1);
    setExpanded(null);
    setOpenMenuId(null);
  }, [period, kind, search, startDate, endDate, sortKey, sortDir]);

  function goToPage(p: number) {
    setPage(Math.min(totalPages, Math.max(1, p)));
    setExpanded(null);
    setOpenMenuId(null);
  }

  // Opens the "…" menu under its button, or above it when the screen has no room below.
  function toggleMenu(e: MouseEvent, saleId: number) {
    e.stopPropagation();
    if (openMenuId === saleId) {
      setOpenMenuId(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const right = window.innerWidth - r.right;
    setMenuPos(
      below >= MENU_HEIGHT || below >= above
        ? { top: r.bottom + 4, right, maxHeight: below }
        : { bottom: window.innerHeight - r.top + 4, right, maxHeight: above }
    );
    setOpenMenuId(saleId);
  }

  const { copy: copySku, tooltip: skuCopyTooltip } = useCopyToClipboard();

  const periodTotal = filteredSales.reduce((sum, s) => sum + s.total, 0);

  // Downloads exactly what's currently on screen (the active tab or date
  // range) — the same "what you see is what you export" rule used
  // elsewhere, since `sales` already holds everything and filtering is
  // done client-side.
  function downloadSalesPdf() {
    const periodLabel = PERIODS.find((p) => p.value === period)?.label ?? "Sales";
    let rangeLabel: string;
    // Short and filename-safe — deliberately separate from rangeLabel
    // above, which is free to be as descriptive as the page needs.
    let filenameTag: string;
    if (startDate && endDate) {
      rangeLabel = rangeLabelFor(startDate, endDate);
      filenameTag = filenameRangeTag(startDate, endDate);
    } else if (period === "today") {
      const today = toISODate(new Date());
      rangeLabel = formatPresetRange(today, today, periodLabel);
      filenameTag = filenameRangeTag(today, today);
    } else if (period === "week") {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 6);
      rangeLabel = formatPresetRange(toISODate(weekAgo), toISODate(new Date()), periodLabel);
      filenameTag = filenameRangeTag(toISODate(weekAgo), toISODate(new Date()));
    } else if (period === "month") {
      const now = new Date();
      const monthStart = toISODate(new Date(now.getFullYear(), now.getMonth(), 1));
      rangeLabel = formatPresetRange(monthStart, toISODate(now), periodLabel);
      // The common case — a whole month's report — gets the plain
      // "Sep2026" tag rather than a day-range, since that's what it
      // actually is once you're downloading the current month's sales.
      filenameTag = now.toLocaleDateString("en-GB", { month: "short", year: "numeric" }).replace(/\s+/g, "");
    } else {
      rangeLabel = periodLabel;
      filenameTag = periodLabel.replace(/[^\w]+/g, "");
    }

    downloadTabularReport({
      headerLabel: "M&M Clothing — Sales Report",
      headerFields: [
        { label: "Report", value: reportTitleFor(period, startDate, endDate) },
        { label: "Period", value: rangeLabel },
        ...(kind !== "all" ? [{ label: "Showing", value: KINDS.find((k) => k.value === kind)?.label ?? "" }] : []),
        { label: "Generated", value: todayLongDate() },
      ],
      rangeLabel,
      orientation: "landscape",
      columns: [
        { label: "Invoice", width: 80 },
        { label: "Date", width: 90 },
        { label: "Customer", width: 130 },
        { label: "Type", width: 60 },
        { label: "Total", width: 80, align: "right" },
        { label: "Paid", width: 80, align: "right" },
        { label: "Payment", width: 100 },
        { label: "Status", width: 90 },
      ],
      rows: filteredSales.map((sale) => ({
        cells: [
          sale.invoice + (sale.is_voided ? " (Voided)" : ""),
          sale.date.slice(0, 16).replace("T", " "),
          sale.customer_name ?? (sale.deleted_customer_snapshot ? `[Deleted: ${sale.deleted_customer_snapshot}]` : "Walk-in"),
          sale.sale_type === "online" ? "Online" : "In-Store",
          `Rs. ${sale.total.toLocaleString()}`,
          `Rs. ${sale.amount_paid.toLocaleString()}`,
          salePaymentLabel(sale),
          sale.is_voided ? "Voided" : saleStatusLabel(sale),
        ],
        styles: sale.is_voided ? [{ color: 150 }, { color: 150 }, { color: 150 }, { color: 150 }, { color: 150 }, { color: 150 }, { color: 150 }, { color: 150 }] : undefined,
      })),
      totalSummary: {
        label: "Total for this view",
        amount: `Rs. ${periodTotal.toLocaleString()}`,
        note: `${filteredSales.length} sale${filteredSales.length !== 1 ? "s" : ""}`,
      },
      filename: buildReportFilename(kind === "all" ? "Sales Report" : `Sales Report ${KINDS.find((k) => k.value === kind)?.label ?? ""}`, rangeLabel),
    });
  }

  useKeyboardShortcut("d", downloadSalesPdf, { ctrlOrCmd: true, shift: true, enabled: filteredSales.length > 0 });

  async function toggleExpand(sale: Sale) {
    if (expanded?.id === sale.id) {
      setExpanded(null);
      return;
    }
    setExpanded(await api.get<Sale>(`/sales/${sale.id}`));
  }

  async function openReceipt(sale: Sale) {
    setOpenMenuId(null);
    setReceiptError(null);
    const full = expanded?.id === sale.id ? expanded : await api.get<Sale>(`/sales/${sale.id}`);
    setReceiptSale(full);
  }

  function receiptOptionsFor(sale: Sale): ModalOption[] {
    return [
      {
        key: "a4",
        icon: <FileText size={16} className="text-gray-700" />,
        title: "A4 Invoice (PDF)",
        subtitle: "Full-page printable invoice",
        onClick: () => downloadA4Pdf(sale),
      },
      {
        key: "thermal",
        icon: <Receipt size={16} className="text-gray-700" />,
        title: "80mm Receipt (PDF)",
        subtitle: "For thermal till printers",
        onClick: () => downloadThermalPdf(sale),
      },
      {
        key: "whatsapp",
        icon: <MessageCircle size={16} className="text-green-600" />,
        iconBgClass: "bg-green-50",
        title: "Send via WhatsApp",
        subtitle: "Text summary to customer's phone",
        onClick: () => {
          if (!sale.customer_phone) {
            setReceiptError("This customer has no saved phone number — add one on the Customers page first.");
            return;
          }
          setReceiptError(null);
          sendWhatsAppBill(sale, sale.customer_phone);
        },
      },
    ];
  }

  async function handleVoid(sale: Sale) {
    setOpenMenuId(null);
    setError(null);

    const saleDay = sale.date.slice(0, 10);
    const today = toISODate(new Date());
    const sameDayWarning = saleDay !== today ? "\n\nNote: this sale was NOT made today — voiding an older sale should be rare." : "";
    const reason = prompt(`Void invoice ${sale.invoice}? Stock will be returned and any payment reversed in the cash book.${sameDayWarning}\n\nReason (optional):`);
    if (reason === null) return;

    setVoidingId(sale.id);
    try {
      await api.put(`/sales/${sale.id}/void`, { reason: reason.trim() || undefined });
      const refreshed = await api.get<Sale[]>("/sales");
      setSales(refreshed);
      setExpanded(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to void this sale");
    } finally {
      setVoidingId(null);
    }
  }

  async function handleWholesale() {
    if (!wholesaleSale) return;
    setWholesaleError(null);
    setWholesaleBusy(true);
    try {
      await api.put(`/sales/${wholesaleSale.id}/wholesale`, { reason: wholesaleReason.trim() || undefined });
      setSales(await api.get<Sale[]>("/sales"));
      setWholesaleSale(null);
    } catch (err) {
      setWholesaleError(err instanceof ApiRequestError ? err.message : "Failed to mark this sale wholesale");
    } finally {
      setWholesaleBusy(false);
    }
  }

  async function handleConfirmCod() {
    if (!codConfirmSale) return;
    setCodError(null);
    setCodConfirming(true);
    try {
      await api.put(`/sales/${codConfirmSale.id}/confirm-cod`, { payment_method: codPaymentMethod });
      const refreshed = await api.get<Sale[]>("/sales");
      setSales(refreshed);
      setCodConfirmSale(null);
    } catch (err) {
      setCodError(err instanceof ApiRequestError ? err.message : "Failed to confirm this payment");
    } finally {
      setCodConfirming(false);
    }
  }

  async function handleUndoCod(sale: Sale) {
    setOpenMenuId(null);
    setError(null);
    if (!confirm(`Undo the COD confirmation for invoice ${sale.invoice}? This reverts it to unpaid and removes the matching cash book entry. Only possible within 24 hours of confirming.`)) return;

    setUndoingId(sale.id);
    try {
      await api.put(`/sales/${sale.id}/undo-cod`, {});
      const refreshed = await api.get<Sale[]>("/sales");
      setSales(refreshed);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to undo this confirmation");
    } finally {
      setUndoingId(null);
    }
  }

  // Shared between the desktop row's expanded panel and the mobile
  // card's expanded section, so the two views never drift apart.
  function renderExpandedItems(sale: Sale): ReactNode {
    return (
      <>
        <strong className="text-xs text-gray-700">Items</strong>
        <table className="w-full text-sm mt-2">
          <thead>
            <tr>
              <Th>SKU</Th>
              <Th className="min-w-[16rem]">Product</Th>
              <Th>Size/Color</Th>
              <Th>Qty</Th>
              <Th>Price</Th>
              <Th>Total</Th>
            </tr>
          </thead>
          <tbody>
            {groupSaleItemsForDisplay(sale.items ?? [], { wholesale: !!sale.is_wholesale }).map((item) => (
              <tr key={item.ids.join(",")} className={item.is_returned ? "opacity-60" : ""}>
                <td
                  onClick={(e) => item.sku && copySku(`sku-${item.ids.join(",")}`, item.sku, e)}
                  className={`px-3 py-2.5 border-b border-gray-50 text-gray-700 ${item.sku ? "cursor-pointer hover:bg-gray-100 rounded transition-colors select-none" : ""} ${item.is_returned ? "line-through" : ""}`}
                  title={item.sku ? "Click to copy SKU" : undefined}
                >
                  {item.sku ?? "—"}
                </td>
                <Td className={`min-w-[16rem] ${item.is_returned ? "line-through" : ""}`}>
                  {item.product_title}
                  {item.is_returned ? (
                    <span className="ml-2 not-italic no-underline">
                      <Badge label="RTN" tone="danger" />
                    </span>
                  ) : null}
                </Td>
                <Td className={item.is_returned ? "line-through" : ""}>
                  {sale.is_wholesale ? (
                    <span className="text-gray-400">{item.merged_lines && item.merged_lines > 1 ? `${item.merged_lines} sizes / colours` : [item.size, item.color].filter(Boolean).join(" / ") || "—"}</span>
                  ) : (
                    <>
                      {item.size ?? "—"} / {item.color ?? "—"}
                    </>
                  )}
                </Td>
                <Td className={item.is_returned ? "line-through" : ""}>{item.quantity}</Td>
                <Td className={item.is_returned ? "line-through" : ""}>Rs. {item.unit_price.toLocaleString()}</Td>
                <Td className={item.is_returned ? "line-through" : ""}>Rs. {item.line_total.toLocaleString()}</Td>
              </tr>
            ))}
          </tbody>
        </table>
        {sale.is_wholesale ? (
          <p className="text-xs text-gray-400 mt-2">
            Wholesale bill — counted in pieces per product. <RefLink to={`/sales/${sale.id}`}>Open the invoice</RefLink> for the size and colour breakdown.
          </p>
        ) : null}
        {sale.discount > 0 && (
          <p className="text-xs text-gray-400 mt-2">
            Discounts & Coupons: Rs. {sale.discount.toLocaleString()}
            {sale.manual_discount > 0 && ` (manual: Rs. ${sale.manual_discount.toLocaleString()})`}
            {sale.coupon_discount > 0 && ` (coupon ${sale.coupon_code}: Rs. ${sale.coupon_discount.toLocaleString()})`}
          </p>
        )}
        <DeliveryChargeSummary sale={sale} className="mt-2" />
        {!sale.is_voided && (
          <p className="text-xs text-gray-400 mt-1">
            {sale.is_wholesale ? "Wholesale order — no loyalty points" : `Loyalty points earned: ${sale.loyalty_points_earned}`}
          </p>
        )}
        {sale.is_voided ? (
          <p className="text-xs text-red-500 mt-2">
            Voided {sale.voided_at?.slice(0, 16).replace("T", " ")}
            {sale.void_reason ? ` — ${sale.void_reason}` : ""}
            {sale.loyalty_points_earned > 0 ? ` · ${sale.loyalty_points_earned} loyalty points reversed` : null}
          </p>
        ) : null}
      </>
    );
  }

  // Same menu content for the desktop row's "..." button and the mobile
  // card's — only the trigger/positioning differs between the two.
  function renderActionsMenuItems(sale: Sale): ReactNode {
    return (
      <>
        <button onClick={() => openReceipt(sale)} className="w-full flex items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition">
          <Printer size={14} />
          Get receipt
        </button>
        <button
          onClick={() => {
            setOpenMenuId(null);
            toggleExpand(sale);
          }}
          className="w-full flex items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition"
        >
          <Receipt size={14} />
          View details
        </button>
        {sale.sale_type === "online" && sale.delivery_status === "delivered" && !sale.is_voided && sale.customer_id && (
          <button
            onClick={() => {
              setOpenMenuId(null);
              navigate(`/sales/${sale.id}?exchange=1`);
            }}
            className="w-full flex items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition"
          >
            <Repeat size={14} />
            Exchange by delivery
          </button>
        )}
        {sale.invoice.startsWith("OCD") &&
          !sale.is_voided &&
          sale.payment_status !== "paid" &&
          (!sale.delivery_partner || sale.delivery_partner_kind === "on_demand") && (
            <button
              onClick={() => {
                setOpenMenuId(null);
                setCodError(null);
                setCodPaymentMethod("cash");
                setCodConfirmSale(sale);
              }}
              className="w-full flex items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition"
            >
              <Wallet size={14} />
              Mark as paid / COD collected
            </button>
          )}
        {sale.invoice.startsWith("OCD") &&
          !sale.is_voided &&
          sale.payment_status === "paid" &&
          (!sale.delivery_partner || sale.delivery_partner_kind === "on_demand") && (
            <button
              onClick={() => handleUndoCod(sale)}
              disabled={undoingId === sale.id}
              className="w-full flex items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition disabled:opacity-50"
            >
              <Wallet size={14} />
              {undoingId === sale.id ? "Undoing..." : "Undo COD confirmation"}
            </button>
          )}
        {isAdmin && !sale.is_voided && !sale.is_wholesale && sale.status !== "quotation" && sale.customer_id && sale.loyalty_points_earned > 0 && (
          <button
            onClick={() => {
              setOpenMenuId(null);
              setWholesaleReason("");
              setWholesaleError(null);
              setWholesaleSale(sale);
            }}
            className="w-full flex items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition"
          >
            <Star size={14} />
            Mark as wholesale
          </button>
        )}
        {isAdmin && !sale.is_voided && sale.status !== "quotation" && (
          <button
            onClick={() => {
              setOpenMenuId(null);
              setProfitSale(sale);
            }}
            className="w-full flex items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition"
          >
            <TrendingUp size={14} />
            Profit on this bill
          </button>
        )}
        {isAdmin && !sale.is_voided && (
          <button
            onClick={() => handleVoid(sale)}
            disabled={voidingId === sale.id}
            className="w-full flex items-center gap-2 px-3.5 py-2 text-left text-sm text-red-600 hover:bg-red-50 transition disabled:opacity-50 border-t border-gray-100 mt-1 pt-2"
          >
            Void sale
          </button>
        )}
      </>
    );
  }

  // Shown in place of the list while it loads or when nothing matches.
  const listMessage = loading ? (
    <p className="text-sm text-gray-400">Loading...</p>
  ) : filteredSales.length === 0 ? (
    <EmptyState icon={Receipt} title="No sales match these filters" subtitle="Try another period, or clear the filters." />
  ) : null;

  // The page buttons and "Showing a–b of n", under the table (desktop) or the cards (phones).
  const pager = (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-gray-100 bg-gray-50/50 flex-shrink-0">
      <p className="text-xs text-gray-500">
        Showing <span className="text-gray-700">{rangeStart}–{rangeEnd}</span> of{" "}
        <span className="text-gray-700">{sortedSales.length.toLocaleString()}</span>
      </p>
      <div className="flex items-center gap-1">
        <button onClick={() => goToPage(1)} disabled={currentPage === 1} className={PAGER_BUTTON}>
          First
        </button>
        <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage === 1} className={PAGER_BUTTON}>
          Previous
        </button>
        <span className="px-2 text-xs text-gray-500 tabular-nums">
          Page {currentPage} of {totalPages}
        </span>
        <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= totalPages} className={PAGER_BUTTON}>
          Next
        </button>
        <button onClick={() => goToPage(totalPages)} disabled={currentPage >= totalPages} className={PAGER_BUTTON}>
          Last
        </button>
      </div>
    </div>
  );

  return (
    // On desktop the page takes the screen's height (see AppShell): the title and filters stay put and
    // only the table area below them is sized to what is left.
    <div className="lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
      <div className="flex-shrink-0">
      <PageHeader
        title="Sale history"
        subtitle="Click a row to see the items included."
        action={
          <div className="flex items-center gap-2">
            <DateRangePicker
              startDate={startDate}
              endDate={endDate}
              onChange={(s, e) => {
                setStartDate(s);
                setEndDate(e);
              }}
            />
            <Button
              onClick={downloadSalesPdf}
              disabled={filteredSales.length === 0}
              className="inline-flex items-center gap-1.5"
              title="Download PDF (Ctrl/Cmd+Shift+D)"
            >
              <Download size={14} />
              Download PDF
            </Button>
          </div>
        }
      />

      {/* When… */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <TabToggle<Period | "custom">
            value={startDate && endDate ? "custom" : period}
            onChange={(v) => {
              if (v === "custom") return;
              setPeriod(v);
              setStartDate(null);
              setEndDate(null);
            }}
            options={[...PERIODS, ...(startDate && endDate ? [{ value: "custom" as const, label: "Custom dates" }] : [])]}
          />
          {startDate && endDate && (
            <button
              onClick={() => {
                setStartDate(null);
                setEndDate(null);
              }}
              className="text-xs text-gray-400 hover:text-gray-700 underline"
            >
              Clear dates
            </button>
          )}
        </div>
        <div className="relative w-full sm:w-72">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            className="py-2 pl-8 pr-8 text-sm"
            placeholder="Invoice, customer or phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearch("");
            }}
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" title="Clear">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* …and what kind of sale, with how many of each in that period. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {KINDS.map((k) => {
          const active = kind === k.value;
          return (
            <button
              key={k.value}
              onClick={() => setKind(k.value)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${
                active ? (k.value === "voided" ? "bg-red-600 text-white" : "bg-black text-white") : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {k.label}
              {!loading && <span className={`text-xs tabular-nums ${active ? "text-white/70" : "text-gray-400"}`}>{kindCounts[k.value]}</span>}
            </button>
          );
        })}
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      {!loading && (
        <p className="text-xs text-gray-400 mb-3">
          {filteredSales.length} sale{filteredSales.length !== 1 ? "s" : ""} · Rs. {periodTotal.toLocaleString()} total
          {kind === "credit" && filteredSales.length > 0 && (
            <>
              {" · "}
              <span className="font-medium text-red-600">Rs. {filteredSales.reduce((sum, x) => sum + Math.max(0, x.total - x.amount_paid), 0).toLocaleString()} still owed</span>
            </>
          )}
          {kind === "cod" && filteredSales.some((x) => x.payment_status !== "paid") && (
            <> · {filteredSales.filter((x) => x.payment_status !== "paid").length} still to be collected</>
          )}
          {(kind !== "all" || search || (startDate && endDate)) && (
            <>
              {" · "}
              <button
                onClick={() => {
                  setKind("all");
                  setSearch("");
                  setStartDate(null);
                  setEndDate(null);
                }}
                className="underline hover:text-gray-700"
              >
                Clear filters
              </button>
            </>
          )}
        </p>
      )}

      </div>

      {/* Desktop / tablet-landscape */}
      <Card className="p-0 overflow-hidden hidden lg:flex lg:flex-col lg:flex-1 lg:min-h-0">
        {/* Scrolls inside itself (an opened row, a narrow window) so the page never has to. */}
        <div ref={tableBodyRef} onScroll={() => setOpenMenuId(null)} className="flex-1 min-h-0 overflow-auto">
          {listMessage ? (
            <div className="p-4">{listMessage}</div>
          ) : (
            /* Fixed column widths: every column keeps the same place and size whichever filter is on,
               instead of stretching and shrinking to fit whatever happens to be in the rows. */
            <table className="w-full text-sm [table-layout:fixed] min-w-[980px]">
              <thead className="sticky top-0 z-10 bg-gray-50 shadow-[inset_0_-1px_0_0_#f3f4f6]">
                <tr className="bg-gray-50">
                  <SortHeader<SaleSortKey> label="Invoice" sortKey="invoice" activeKey={sortKey} dir={sortDir} onClick={toggleSort} className="w-[13%]" />
                  <SortHeader<SaleSortKey> label="Date" sortKey="date" activeKey={sortKey} dir={sortDir} onClick={toggleSort} className="w-[14%]" />
                  <SortHeader<SaleSortKey> label="Customer" sortKey="customer" activeKey={sortKey} dir={sortDir} onClick={toggleSort} className="w-[14%]" />
                  <Th className="w-[8%]">Type</Th>
                  <SortHeader<SaleSortKey> label="Total" sortKey="total" activeKey={sortKey} dir={sortDir} onClick={toggleSort} className="w-[10%]" />
                  <SortHeader<SaleSortKey> label="Paid" sortKey="paid" activeKey={sortKey} dir={sortDir} onClick={toggleSort} className="w-[10%]" />
                  <Th className="w-[12%]">Payment</Th>
                  <Th className="w-[14%]">Status</Th>
                  <Th className="w-[5%]"></Th>
                </tr>
              </thead>
              <tbody>
                {pageSales.map((sale) => (
                  <Fragment key={sale.id}>
                    <tr
                      onClick={() => toggleExpand(sale)}
                      style={{ height: ROW_HEIGHT }}
                      className={`cursor-pointer hover:bg-gray-50 ${sale.is_voided ? "opacity-50" : ""}`}
                    >
                      <Td>
                        <div className="whitespace-nowrap">
                          <RefLink to={`/sales/${sale.id}`}>{sale.invoice}</RefLink>
                          {sale.is_voided ? " (Voided)" : ""}
                        </div>
                        <ExchangeTag sale={sale} />
                      </Td>
                      <Td className="whitespace-nowrap">{sale.date.slice(0, 16).replace("T", " ")}</Td>
                      <Td className="truncate" title={sale.customer_name ?? sale.deleted_customer_snapshot ?? "Walk-in"}>
                        <CustomerName sale={sale} />
                      </Td>
                      <Td>{sale.sale_type === "online" ? "Online" : "In-Store"}</Td>
                      <Td className="whitespace-nowrap tabular-nums">Rs. {sale.total.toLocaleString()}</Td>
                      <Td className="whitespace-nowrap tabular-nums">Rs. {sale.amount_paid.toLocaleString()}</Td>
                      <Td>
                        <div className="capitalize">{salePaymentLabel(sale)}</div>
                        {sale.change_due > 0 && <div className="text-xs text-gray-400 whitespace-nowrap">Change: Rs. {sale.change_due.toLocaleString()}</div>}
                        {sale.overpaid_amount > 0 && (
                          <div className="text-xs text-amber-600 whitespace-nowrap">Overpaid: Rs. {sale.overpaid_amount.toLocaleString()}</div>
                        )}
                      </Td>
                      <Td>
                        {sale.is_voided ? <Badge label="voided" tone="danger" /> : <Badge label={saleStatusLabel(sale)} tone={saleStatusLabel(sale) === "exchange pending" ? "warning" : paymentStatusTone(sale.payment_status)} />}
                      </Td>
                      <Td>
                        <div className="relative" ref={openMenuId === sale.id ? desktopMenuRef : undefined}>
                          <button
                            onClick={(e) => toggleMenu(e, sale.id)}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
                            title="Actions"
                          >
                            <MoreVertical size={16} />
                          </button>
                          {openMenuId === sale.id && menuPos && (
                            <div
                              onClick={(e: MouseEvent) => e.stopPropagation()}
                              style={{ position: "fixed", ...menuPos }}
                              className="z-30 w-44 overflow-y-auto bg-white border border-gray-200 rounded-xl shadow-lg py-1"
                            >
                              {renderActionsMenuItems(sale)}
                            </div>
                          )}
                        </div>
                      </Td>
                    </tr>
                    {expanded?.id === sale.id && (
                      <tr>
                        <Td colSpan={9} className="bg-gray-50">
                          <div className="py-2">{renderExpandedItems(expanded)}</div>
                        </Td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {/* Always there, so the table area above keeps one height whether it is loading, empty or full. */}
        {pager}
      </Card>

      {/* Mobile / tablet-portrait: stacked cards, same tap-to-expand */}
      <div className="lg:hidden">
        {listMessage}
        {!listMessage && (
          <>
          <div className="space-y-2.5">
            {pageSales.map((sale) => {
              const isExpanded = expanded?.id === sale.id;
              return (
                <RowCard key={sale.id} onClick={() => toggleExpand(sale)} className={sale.is_voided ? "opacity-50" : ""}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 leading-snug">
                        <RefLink to={`/sales/${sale.id}`}>{sale.invoice}</RefLink>
                        {sale.is_voided ? " (Voided)" : ""}
                      </p>
                      <ExchangeTag sale={sale} />
                      <p className="text-xs text-gray-400 mt-0.5">{sale.date.slice(0, 16).replace("T", " ")}</p>
                      <p className="text-xs text-gray-500 mt-1">
                        <CustomerName sale={sale} /> · {sale.sale_type === "online" ? "Online" : "In-Store"}
                      </p>
                    </div>
                    <div className="flex-shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      {sale.is_voided ? <Badge label="voided" tone="danger" /> : <Badge label={saleStatusLabel(sale)} tone={saleStatusLabel(sale) === "exchange pending" ? "warning" : paymentStatusTone(sale.payment_status)} />}
                      <div className="relative" ref={openMenuId === sale.id ? mobileMenuRef : undefined}>
                        <button
                          onClick={() => setOpenMenuId(openMenuId === sale.id ? null : sale.id)}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
                          title="Actions"
                        >
                          <MoreVertical size={16} />
                        </button>
                        {openMenuId === sale.id && (
                          <div className="absolute right-0 z-20 mt-1 w-52 bg-white border border-gray-200 rounded-xl shadow-lg py-1">
                            {renderActionsMenuItems(sale)}
                          </div>
                        )}
                      </div>
                      {isExpanded ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
                    </div>
                  </div>

                  <RowCardStats>
                    <RowCardStat label="Total" value={`Rs. ${sale.total.toLocaleString()}`} />
                    <RowCardStat label="Paid" value={`Rs. ${sale.amount_paid.toLocaleString()}`} />
                    <RowCardStat label="Payment" value={<span className="capitalize">{salePaymentLabel(sale)}</span>} />
                  </RowCardStats>
                  {(sale.change_due > 0 || sale.overpaid_amount > 0) && (
                    <p className="text-xs mt-1.5">
                      {sale.change_due > 0 && <span className="text-gray-400">Change: Rs. {sale.change_due.toLocaleString()}</span>}
                      {sale.overpaid_amount > 0 && <span className="text-amber-600">Overpaid: Rs. {sale.overpaid_amount.toLocaleString()}</span>}
                    </p>
                  )}

                  {isExpanded && (
                    <div className="mt-3 pt-3 border-t border-gray-100" onClick={(e) => e.stopPropagation()}>
                      {renderExpandedItems(expanded)}
                    </div>
                  )}
                </RowCard>
              );
            })}
          </div>
          <Card className="p-0 overflow-hidden mt-3">{pager}</Card>
          </>
        )}
      </div>

      {receiptSale && (
        <ReceiptOptionsModal
          heading="Get receipt"
          subtitle={receiptSale.invoice}
          options={receiptOptionsFor(receiptSale)}
          error={receiptError}
          onClose={() => setReceiptSale(null)}
        />
      )}

      {profitSale && <SaleProfitModal saleId={profitSale.id} invoice={profitSale.invoice} onClose={() => setProfitSale(null)} />}

      {wholesaleSale && (
        <Modal
          size="md"
          onClose={() => setWholesaleSale(null)}
          title="Mark as wholesale"
          subtitle="Takes back the loyalty points this sale earned. It's added to the customer's points history; nothing else about the sale changes."
          footer={
            <>
              <Button onClick={() => setWholesaleSale(null)}>Cancel</Button>
              <Button variant="primary" onClick={handleWholesale} disabled={wholesaleBusy}>
                {wholesaleBusy ? "Saving..." : "Remove points"}
              </Button>
            </>
          }
        >
              <p className="text-sm text-gray-600 mb-1">
                Invoice {wholesaleSale.invoice}
                {wholesaleSale.customer_name ? ` · ${wholesaleSale.customer_name}` : ""}
              </p>
              <p className="text-2xl font-semibold text-gray-900 mb-1">{wholesaleSale.loyalty_points_earned} points</p>
              <p className="text-xs text-gray-500 mb-3">will be taken back from the customer.</p>
              <FormGroup>
                <Label>Reason (optional)</Label>
                <Input value={wholesaleReason} onChange={(e) => setWholesaleReason(e.target.value)} placeholder="e.g. Bulk order for resale" />
              </FormGroup>
              {wholesaleError && <ErrorText>{wholesaleError}</ErrorText>}
        </Modal>
      )}

      {codConfirmSale && (
        <Modal
          size="md"
          onClose={() => setCodConfirmSale(null)}
          title="Confirm COD collected"
          subtitle="Marks the order as fully paid and records the amount in the cash book, together, in one step."
          footer={
            <>
              <Button onClick={() => setCodConfirmSale(null)}>Cancel</Button>
              <Button variant="primary" onClick={handleConfirmCod} disabled={codConfirming}>
                {codConfirming ? "Confirming..." : "Confirm, collected"}
              </Button>
            </>
          }
        >
              <p className="text-sm text-gray-600 mb-1">Invoice {codConfirmSale.invoice}</p>
              <p className="text-2xl font-semibold text-gray-900 mb-3">
                Rs. {(codConfirmSale.total - codConfirmSale.amount_paid).toLocaleString()}
              </p>
              <div className="mb-4">
                <p className="text-xs font-medium text-gray-500 mb-1.5">How was it collected?</p>
                <div className="flex gap-2">
                  {(["cash", "bank_transfer", "card"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setCodPaymentMethod(m)}
                      className={`flex-1 border rounded-xl py-2 text-xs font-medium capitalize transition ${
                        codPaymentMethod === m ? "border-black bg-black text-white" : "border-gray-200 text-gray-600 hover:border-gray-400"
                      }`}
                    >
                      {m.replace("_", " ")}
                    </button>
                  ))}
                </div>
              </div>
              {codError && <ErrorText>{codError}</ErrorText>}
        </Modal>
      )}

      {skuCopyTooltip}
    </div>
  );
}
