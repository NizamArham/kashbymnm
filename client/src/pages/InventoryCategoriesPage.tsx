import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Loader2,
  Package,
  RefreshCw,
  Search,
  X,
  MoreVertical,
  Download,
  FileText,
  AlertTriangle,
} from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { InventoryUnit } from "../lib/types";
import {
  buildCategoryTree,
  buildGenderCategoryTree,
  splitCategoryWithGender,
  CategoryTreeNode,
  ProductGender,
} from "../lib/categoryTree";
import { groupByProduct, summarizeProductVariants } from "../lib/sizeSort";
import { createProductSearchIndex, searchProductUnits } from "../lib/productSearch";
import { Card, Input, ErrorText, EmptyState, Table, Th, Td, Badge, inventoryStatusTone } from "../components/ui";
import { downloadTabularReport, buildReportFilename, todayLongDate } from "../lib/reportPdf";

interface SelectedFilter {
  gender?: ProductGender;
  category?: string;
  subCategory?: string;
  brand?: string; // NEW: brand filter
}

type SortKey = "product" | "subCategory" | "brand" | "qty" | "price";
type SortDir = "asc" | "desc";

const summarizeVariants = summarizeProductVariants<InventoryUnit>;
const ALL = "__all__";

interface GenderNavItem {
  value: string;
  label: string;
  count: number;
  categories: CategoryTreeNode[];
}

// ---------------------------------------------------------------------------
// Gender tabs
// ---------------------------------------------------------------------------
function GenderNavTabs({
  items,
  activeValue,
  onHover,
  onSelectGender,
}: {
  items: GenderNavItem[];
  activeValue: string;
  onHover: (value: string | null) => void;
  onSelectGender: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 flex-shrink-0">
      {items.map((item) => {
        const isActive = activeValue === item.value;
        return (
          <button
            key={item.value}
            onMouseEnter={() => onHover(item.value)}
            onClick={() => onSelectGender(item.value)}
            className={`relative flex-shrink-0 flex items-center gap-1 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
              isActive ? "text-gray-900" : "text-gray-500 hover:text-gray-900"
            }`}
          >
            {item.label}
            <span className="text-xs text-gray-400">{item.count}</span>
            {isActive && (
              <span className="absolute left-3 right-3 -bottom-2 h-0.5 bg-gray-900 rounded-full" />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mega-menu panel
// ---------------------------------------------------------------------------
function GenderNavPanel({
  item,
  selectedGender,
  selectedCategory,
  selectedSubCategory,
  onSelectCategory,
  onSelectSubCategory,
}: {
  item: GenderNavItem;
  selectedGender?: string;
  selectedCategory?: string;
  selectedSubCategory?: string;
  onSelectCategory: (genderValue: string, category: string) => void;
  onSelectSubCategory: (genderValue: string, category: string, subCategory: string) => void;
}) {
  return (
    <div className="absolute left-0 right-0 top-full pt-2 z-30">
      <div className="bg-white border border-gray-200 rounded-2xl shadow-xl p-7 max-h-[70vh] overflow-y-auto">
        <div className="columns-2 sm:columns-4 lg:columns-6 gap-x-8">
          {item.categories.map((cat) => {
            const isCatActive =
              selectedGender === item.value &&
              selectedCategory === cat.category &&
              !selectedSubCategory;
            return (
              <div key={cat.category} className="break-inside-avoid mb-7">
                <button
                  onClick={() => onSelectCategory(item.value, cat.category)}
                  className={`group w-full flex items-center justify-between gap-2 pb-2 mb-2.5 border-b transition-colors ${
                    isCatActive ? "border-gray-900" : "border-gray-100 hover:border-gray-300"
                  }`}
                >
                  <span
                    className={`text-sm font-semibold truncate transition-colors ${
                      isCatActive ? "text-gray-900" : "text-gray-700 group-hover:text-gray-900"
                    }`}
                  >
                    {cat.category}
                  </span>
                  <span className="flex-shrink-0 text-[11px] font-medium text-gray-400 bg-gray-50 rounded-full px-2 py-0.5">
                    {cat.count}
                  </span>
                </button>
                {cat.subCategories.length > 0 && (
                  <div className="space-y-0.5">
                    {cat.subCategories.map((sub) => {
                      const isSubActive =
                        selectedGender === item.value &&
                        selectedCategory === cat.category &&
                        selectedSubCategory === sub.name;
                      return (
                        <button
                          key={sub.name}
                          onClick={() => onSelectSubCategory(item.value, cat.category, sub.name)}
                          className={`w-full flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 -mx-2 text-sm transition-colors ${
                            isSubActive ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                          }`}
                        >
                          <span className="truncate">{sub.name}</span>
                          <span className={`flex-shrink-0 text-[11px] ${isSubActive ? "text-gray-300" : "text-gray-400"}`}>
                            {sub.count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Product download modal — matrix report (Color × Size)
// ---------------------------------------------------------------------------
function ProductDownloadModal({
  title,
  rows,
  onClose,
}: {
  title: string;
  rows: { size: string; color: string; qty: number; sku: string; barcode: string; supplier: string; status: string }[];
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  function handleDownloadA4() {
    try {
      const sizes = Array.from(new Set(rows.map((r) => r.size))).sort((a, b) => {
        const [aw, ai] = a.split("/").map((n) => parseInt(n, 10));
        const [bw, bi] = b.split("/").map((n) => parseInt(n, 10));
        if (!isNaN(aw) && !isNaN(bw) && aw !== bw) return aw - bw;
        if (!isNaN(ai) && !isNaN(bi) && ai !== bi) return ai - bi;
        return a.localeCompare(b);
      });

      const colors = Array.from(new Set(rows.map((r) => r.color))).sort((a, b) =>
        a.localeCompare(b)
      );

      const grid: Record<string, Record<string, number>> = {};
      for (const c of colors) {
        grid[c] = {};
        for (const s of sizes) grid[c][s] = 0;
      }
      for (const r of rows) {
        grid[r.color][r.size] = (grid[r.color][r.size] ?? 0) + r.qty;
      }

      const sizeTotals: Record<string, number> = {};
      for (const s of sizes) {
        sizeTotals[s] = colors.reduce((sum, c) => sum + grid[c][s], 0);
      }
      const grandTotal = Object.values(sizeTotals).reduce((a, b) => a + b, 0);

      const pdfRows = colors.map((c) => {
        const rowTotal = sizes.reduce((sum, s) => sum + grid[c][s], 0);
        return {
          cells: [c, ...sizes.map((s) => String(grid[c][s])), String(rowTotal)],
        };
      });

      pdfRows.push({
        cells: ["TOTAL", ...sizes.map((s) => String(sizeTotals[s])), String(grandTotal)],
      });

      const longestColor = Math.max(...colors.map((c) => c.length), 6);
      const colorColWidth = Math.min(180, Math.max(80, longestColor * 6));

      downloadTabularReport({
        headerLabel: "M&M Clothing — Stock Breakdown",
        headerFields: [
          { label: "Product", value: title },
          { label: "Generated", value: todayLongDate() },
        ],
        rangeLabel: title,
        orientation: "landscape",
        columns: [
          { label: "Color", width: colorColWidth },
          ...sizes.map((s) => ({ label: s, width: 42, align: "center" as const })),
          { label: "TOTAL", width: 55, align: "center" as const },
        ],
        rows: pdfRows,
        totalSummary: {
          label: "Grand total",
          amount: String(grandTotal),
          note: `${colors.length} color${colors.length !== 1 ? "s" : ""} · ${sizes.length} size${sizes.length !== 1 ? "s" : ""}`,
        },
        filename: buildReportFilename("Stock", title.replace(/[^\w]+/g, "-")),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate report");
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl max-w-sm w-full shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-gray-100 flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-gray-900">Download report</h3>
            <p className="text-xs text-gray-400 truncate">{title}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-2.5">
          <button
            onClick={handleDownloadA4}
            className="w-full flex items-center gap-3 px-4 py-3 border border-gray-200 rounded-xl hover:border-black hover:shadow-sm transition text-left"
          >
            <div className="w-9 h-9 bg-gray-100 rounded-lg flex items-center justify-center flex-shrink-0">
              <FileText size={17} className="text-gray-700" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">Stock Breakdown (PDF)</p>
              <p className="text-xs text-gray-400">Color × Size matrix with totals</p>
            </div>
          </button>

          {error && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-1">
              <AlertTriangle size={13} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">{error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sortable header cell
// ---------------------------------------------------------------------------
function SortHeader({
  label,
  sortKey,
  currentKey,
  currentDir,
  onSort,
  className,
  align,
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  currentDir: SortDir;
  onSort: (key: SortKey) => void;
  className?: string;
  align?: "left" | "right";
}) {
  const isActive = currentKey === sortKey;
  return (
    <Th className={className}>
      <button
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-gray-900 transition ${
          isActive ? "text-gray-900" : ""
        } ${align === "right" ? "justify-end w-full" : ""}`}
      >
        <span>{label}</span>
        {isActive ? (
          currentDir === "asc" ? (
            <ChevronUp size={12} />
          ) : (
            <ChevronDown size={12} />
          )
        ) : (
          <ChevronDown size={12} className="opacity-0 group-hover:opacity-30" />
        )}
      </button>
    </Th>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function InventoryCategoriesPage() {
  const [units, setUnits] = useState<InventoryUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeGender, setActiveGender] = useState<ProductGender | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<SelectedFilter>({});
  const [expandedProductId, setExpandedProductId] = useState<number | null>(null);
  // Set only when a product is picked from the search dropdown — floats
  // that one row to the top of the (still normally sorted) table so
  // it's visible without scrolling, without changing anyone else's
  // position. Cleared by any further manual sort/filter/row action, so
  // it never lingers and silently reorders the table later.
  const [pinnedProductId, setPinnedProductId] = useState<number | null>(null);
  const [hoveredNav, setHoveredNav] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copiedPos, setCopiedPos] = useState<{ x: number; y: number } | null>(null);

  // NEW: sorting
  const [sortKey, setSortKey] = useState<SortKey>("product");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // ---- Per-row menu + download modal ----
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [downloadTarget, setDownloadTarget] = useState<{ title: string; rows: any[] } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const searchBoxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const searchOpen = searchFocused && query.trim().length > 0;

  // ---- Debounce query (150ms) ----
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(t);
  }, [query]);

  // ---- Restore filters from URL on mount ----
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const g = p.get("g") as ProductGender | null;
    const c = p.get("c");
    const s = p.get("s");
    const b = p.get("b");
    const q = p.get("q");
    const sk = p.get("sk") as SortKey | null;
    const sd = p.get("sd") as SortDir | null;

    if (g) {
      setActiveGender(g);
      setSelectedFilter({
        gender: g,
        category: c ?? undefined,
        subCategory: s ?? undefined,
        brand: b ?? undefined,
      });
    } else if (c || s || b) {
      setSelectedFilter({
        category: c ?? undefined,
        subCategory: s ?? undefined,
        brand: b ?? undefined,
      });
    }

    if (q) {
      setQuery(q);
      setDebouncedQuery(q);
      setAppliedQuery(q);
    }

    if (sk) setSortKey(sk);
    if (sd) setSortDir(sd);
  }, []);

  // ---- Sync filters → URL ----
  useEffect(() => {
    const p = new URLSearchParams();
    if (selectedFilter.gender) p.set("g", selectedFilter.gender);
    if (selectedFilter.category) p.set("c", selectedFilter.category);
    if (selectedFilter.subCategory) p.set("s", selectedFilter.subCategory);
    if (selectedFilter.brand) p.set("b", selectedFilter.brand);
    if (appliedQuery) p.set("q", appliedQuery);
    if (sortKey !== "product") p.set("sk", sortKey);
    if (sortDir !== "asc") p.set("sd", sortDir);
    const qs = p.toString();
    window.history.replaceState({}, "", qs ? `?${qs}` : window.location.pathname);
  }, [selectedFilter, appliedQuery, sortKey, sortDir]);

  // ---- Click outside closes dropdown + row menu ----
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setSearchFocused(false);
      }
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [available, damaged] = await Promise.all([
        api.get<InventoryUnit[]>(`/inventory?status=available`),
        api.get<InventoryUnit[]>(`/inventory?status=damaged`),
      ]);
      setUnits([...available, ...damaged]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load categories");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const flatTree = useMemo(() => buildCategoryTree(units), [units]);
  const genderGroups = useMemo(() => buildGenderCategoryTree(units), [units]);

  // ---- Brand list (sorted) ----
  const allBrands = useMemo(() => {
    const set = new Set<string>();
    for (const u of units) {
      if (u.brand) set.add(u.brand);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [units]);

  const searchIndex = useMemo(() => createProductSearchIndex(units), [units]);
  const searchMatches = useMemo(() => {
    if (!debouncedQuery.trim()) return [];
    return groupByProduct(searchProductUnits(searchIndex, debouncedQuery)).slice(0, 8);
  }, [searchIndex, debouncedQuery]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [searchMatches]);

  const genderNavItems: GenderNavItem[] = [
    { value: ALL, label: "All", count: units.length, categories: flatTree },
    ...genderGroups.map((g) => ({
      value: g.gender,
      label: g.label,
      count: g.count,
      categories: g.categories,
    })),
  ];
  const hoveredItem = genderNavItems.find((i) => i.value === hoveredNav && i.categories.length > 0);

  function selectGender(value: string) {
    const gender = value === ALL ? null : (value as ProductGender);
    setActiveGender(gender);
    setSelectedFilter(gender ? { gender } : {});
    setPinnedProductId(null);
  }

  function selectCategory(genderValue: string, category: string) {
    const gender = genderValue === ALL ? null : (genderValue as ProductGender);
    setActiveGender(gender);
    setSelectedFilter({ gender: gender ?? undefined, category });
    setHoveredNav(null);
    setPinnedProductId(null);
  }

  function selectSubCategory(genderValue: string, category: string, subCategory: string) {
    const gender = genderValue === ALL ? null : (genderValue as ProductGender);
    setActiveGender(gender);
    setSelectedFilter({ gender: gender ?? undefined, category, subCategory });
    setHoveredNav(null);
    setPinnedProductId(null);
  }

  function selectSearchResult(productId: number, sampleUnit: InventoryUnit) {
    const parts = splitCategoryWithGender(sampleUnit.category);
    setActiveGender(parts.gender);
    setSelectedFilter({
      gender: parts.gender,
      category: parts.category || undefined,
      subCategory: parts.subCategory || undefined,
    });
    setExpandedProductId(productId);
    setPinnedProductId(productId);
    setQuery("");
    setDebouncedQuery("");
    setAppliedQuery("");
    setSearchFocused(false);
  }

  function commitSearch() {
    setAppliedQuery(query.trim());
    setExpandedProductId(null);
    setPinnedProductId(null);
    setSearchFocused(false);
    inputRef.current?.blur();
  }

  function clearSearch() {
    setQuery("");
    setDebouncedQuery("");
    setAppliedQuery("");
    setSearchFocused(false);
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPinnedProductId(null);
  }

  // ---- Filtered units ----
  const filteredUnits = useMemo(() => {
    let base = units;

    // Search matches (title + brand + SKU + barcode, via productSearch helper)
    if (appliedQuery) {
      const matchedGroups = groupByProduct(searchProductUnits(searchIndex, appliedQuery));
      const matchedIds = new Set(matchedGroups.map((g) => g.product_id));
      base = units.filter((u) => u.product_id != null && matchedIds.has(u.product_id));
    }

    return base.filter((u) => {
      const parts = splitCategoryWithGender(u.category);
      if (selectedFilter.gender && parts.gender !== selectedFilter.gender) return false;
      if (selectedFilter.category && parts.category !== selectedFilter.category) return false;
      if (selectedFilter.subCategory && parts.subCategory !== selectedFilter.subCategory) return false;

      // Brand filter — case-insensitive substring match
      if (selectedFilter.brand) {
        const b = (u.brand ?? "").toLowerCase();
        if (!b.includes(selectedFilter.brand.toLowerCase())) return false;
      }

      return true;
    });
  }, [units, selectedFilter, appliedQuery, searchIndex]);

  // ---- Grouped + sorted ----
  const groups = useMemo(() => {
    const g = groupByProduct(filteredUnits);

    const sorted = [...g].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "product":
          cmp = a.product_title.localeCompare(b.product_title);
          break;
        case "subCategory": {
          const sa = splitCategoryWithGender(a.units[0]?.category).subCategory ?? "";
          const sb = splitCategoryWithGender(b.units[0]?.category).subCategory ?? "";
          cmp = sa.localeCompare(sb);
          break;
        }
        case "brand":
          cmp = (a.brand ?? "").localeCompare(b.brand ?? "");
          break;
        case "qty":
          cmp = a.units.length - b.units.length;
          break;
        case "price":
          cmp = (a.selling_price ?? 0) - (b.selling_price ?? 0);
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    if (pinnedProductId != null) {
      const pinnedIndex = sorted.findIndex((grp) => grp.product_id === pinnedProductId);
      if (pinnedIndex > 0) {
        const [pinned] = sorted.splice(pinnedIndex, 1);
        sorted.unshift(pinned);
      }
    }

    return sorted;
  }, [filteredUnits, sortKey, sortDir, pinnedProductId]);

  const showSubCategoryColumn = !selectedFilter.subCategory;

  // ---- Copy helper ----
  async function copyValue(key: string, value: string, e: React.MouseEvent) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setCopiedPos({ x: e.clientX, y: e.clientY });
      setTimeout(() => {
        setCopiedKey(null);
        setCopiedPos(null);
      }, 1200);
    } catch {
      /* ignore */
    }
  }

  function firstBarcode(range: string): string {
    return range.split(/\s*[-–]\s*/)[0].trim();
  }
  function isBarcodeRange(range: string): boolean {
    return /[-–]/.test(range);
  }

  function buildDownloadRows(group: (typeof groups)[number]) {
    const variants = summarizeVariants(group.units);
    return variants.map((v) => ({
      size: v.size,
      color: v.color,
      qty: v.count,
      sku: v.skuSample,
      barcode: v.barcodeRange,
      supplier: v.batchSupplierCode ?? "—",
      status: v.status,
    }));
  }

  return (
    <div>
      {/* ================= Header ================= */}
      <div
        className="sticky top-0 z-20 pb-3 mb-5 bg-white/95 backdrop-blur-sm border-b border-gray-200 relative"
        onMouseLeave={() => setHoveredNav(null)}
      >
        <div className="flex items-center gap-6">
          <button
            onClick={() => selectGender(ALL)}
            className="text-2xl font-bold text-gray-900 tracking-tight hover:text-gray-600 transition-colors flex-shrink-0"
          >
            Stocks
          </button>

          <GenderNavTabs
            items={genderNavItems}
            activeValue={activeGender ?? ALL}
            onHover={setHoveredNav}
            onSelectGender={selectGender}
          />

          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="relative flex-1 min-w-0" ref={searchBoxRef}>
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Search size={14} className="text-gray-400" />
              </div>
              <Input
                ref={inputRef}
                className="pl-8 pr-7 py-2 text-sm"
                placeholder="Search product, brand, SKU, barcode…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    if (searchMatches.length === 0) return;
                    setHighlightedIndex((i) => Math.min(i + 1, searchMatches.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setHighlightedIndex((i) => Math.max(i - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    if (searchMatches.length > 0) {
                      const chosen = searchMatches[highlightedIndex];
                      selectSearchResult(chosen.product_id, chosen.units[0] as InventoryUnit);
                    } else {
                      commitSearch();
                    }
                  } else if (e.key === "Escape") {
                    setSearchFocused(false);
                    inputRef.current?.blur();
                  }
                }}
              />
              {query && (
                <button
                  onClick={clearSearch}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X size={14} />
                </button>
              )}

              {searchOpen && (
                <div className="absolute right-0 top-full mt-1.5 w-[28rem] max-w-[95vw] bg-white border border-gray-200 rounded-xl shadow-lg z-30 max-h-96 overflow-y-auto">
                  <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-gray-400 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between">
                    <span>
                      {searchMatches.length > 0
                        ? `${searchMatches.length} match${searchMatches.length === 1 ? "" : "es"}`
                        : `No matches for "${query}"`}
                    </span>
                    {searchMatches.length > 0 && (
                      <span className="normal-case tracking-normal text-gray-400">
                        ↑↓ · Enter to pick
                      </span>
                    )}
                  </div>

                  {searchMatches.map((group, idx) => {
                    const parts = splitCategoryWithGender(group.units[0]?.category);
                    const isHighlighted = idx === highlightedIndex;
                    return (
                      <button
                        key={group.product_id}
                        onMouseEnter={() => setHighlightedIndex(idx)}
                        onClick={() =>
                          selectSearchResult(group.product_id, group.units[0] as InventoryUnit)
                        }
                        className={`w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors border-b border-gray-50 last:border-0 ${
                          isHighlighted ? "bg-gray-100" : "hover:bg-gray-50"
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="text-sm text-gray-900 truncate">{group.product_title}</p>
                          <p className="text-xs text-gray-400 truncate">
                            {[parts.category, parts.subCategory].filter(Boolean).join(" › ")}
                            {group.brand ? ` · ${group.brand}` : ""}
                          </p>
                        </div>
                        <span className="text-xs text-gray-400 flex-shrink-0 tabular-nums">
                          {group.units.length}
                        </span>
                      </button>
                    );
                  })}

                  {searchMatches.length > 0 && (
                    <button
                      onClick={commitSearch}
                      className="w-full px-4 py-2.5 text-xs text-gray-700 hover:bg-gray-100 text-left border-t border-gray-100 font-medium"
                    >
                      ↵ Show all {searchMatches.length} in table · "{query}"
                    </button>
                  )}
                </div>
              )}
            </div>

            <button
              onClick={load}
              disabled={loading}
              className="p-2.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-all"
            >
              <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>

        {hoveredItem && (
          <GenderNavPanel
            item={hoveredItem}
            selectedGender={selectedFilter.gender ?? ALL}
            selectedCategory={selectedFilter.category}
            selectedSubCategory={selectedFilter.subCategory}
            onSelectCategory={selectCategory}
            onSelectSubCategory={selectSubCategory}
          />
        )}
      </div>

      {/* ---- Active filter chips ---- */}
      {(selectedFilter.brand || selectedFilter.category || selectedFilter.subCategory || appliedQuery) && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {selectedFilter.brand && (
            <button
              onClick={() => {
                setSelectedFilter((f) => ({ ...f, brand: undefined }));
                setPinnedProductId(null);
              }}
              className="inline-flex items-center gap-1.5 text-xs bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-full pl-2.5 pr-1.5 py-1 transition"
            >
              Brand: {selectedFilter.brand}
              <X size={11} />
            </button>
          )}
        </div>
      )}

      {/* ================= Body ================= */}
      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <div className="flex flex-col items-center justify-center py-24">
          <Loader2 size={28} className="animate-spin text-gray-300" />
          <p className="mt-3 text-sm text-gray-400">Loading categories…</p>
        </div>
      ) : (
        <Card className="p-0 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              {appliedQuery && (
                <button
                  onClick={clearSearch}
                  className="inline-flex items-center gap-1.5 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full pl-2.5 pr-1.5 py-1 transition-colors flex-shrink-0"
                  title={`Search: ${appliedQuery}`}
                >
                  <Search size={11} />
                  <span className="max-w-[160px] truncate">"{appliedQuery}"</span>
                  <span className="text-[10px] bg-gray-200 text-gray-600 rounded-full px-1.5 py-0.5 tabular-nums">
                    {groups.length}
                  </span>
                  <X size={11} />
                </button>
              )}
              <p className="text-sm text-gray-500 truncate">
                {appliedQuery ? (
                  <span className="text-gray-700">Search results</span>
                ) : (
                  <>
                    {selectedFilter.gender
                      ? genderGroups.find((g) => g.gender === selectedFilter.gender)?.label
                      : "All"}
                    {selectedFilter.category && (
                      <>
                        <span className="text-gray-300"> › </span>
                        {selectedFilter.category}
                      </>
                    )}
                    {selectedFilter.subCategory && (
                      <>
                        <span className="text-gray-300"> › </span>
                        <span className="font-medium text-gray-900">
                          {selectedFilter.subCategory}
                        </span>
                      </>
                    )}
                  </>
                )}
              </p>
            </div>
            <p className="text-xs text-gray-400 tabular-nums flex-shrink-0">
              {groups.length} product{groups.length === 1 ? "" : "s"}, {filteredUnits.length} unit
              {filteredUnits.length === 1 ? "" : "s"}
            </p>
          </div>

          {groups.length === 0 ? (
            <EmptyState
              icon={Package}
              title={
                appliedQuery
                  ? `No products match "${appliedQuery}"`
                  : "No products in this selection"
              }
            />
          ) : (
            <Table className="[table-layout:fixed]">
              <thead>
                <tr>
                  <Th className="w-6"></Th>
                  <SortHeader
                    label="Product"
                    sortKey="product"
                    currentKey={sortKey}
                    currentDir={sortDir}
                    onSort={toggleSort}
                    className={showSubCategoryColumn ? "w-[30%]" : "w-[40%]"}
                  />
                  {showSubCategoryColumn && (
                    <SortHeader
                      label="Sub-category"
                      sortKey="subCategory"
                      currentKey={sortKey}
                      currentDir={sortDir}
                      onSort={toggleSort}
                      className="w-[16%]"
                    />
                  )}
                  <SortHeader
                    label="Brand"
                    sortKey="brand"
                    currentKey={sortKey}
                    currentDir={sortDir}
                    onSort={toggleSort}
                    className={showSubCategoryColumn ? "w-[16%]" : "w-[20%]"}
                  />
                  <SortHeader
                    label="Qty"
                    sortKey="qty"
                    currentKey={sortKey}
                    currentDir={sortDir}
                    onSort={toggleSort}
                    className="w-[14%] text-right"
                    align="right"
                  />
                  <SortHeader
                    label="Price"
                    sortKey="price"
                    currentKey={sortKey}
                    currentDir={sortDir}
                    onSort={toggleSort}
                    className="w-[14%] text-right"
                    align="right"
                  />
                  <Th className="w-[8%]"></Th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const isExpanded = expandedProductId === group.product_id;
                  const variants = isExpanded ? summarizeVariants(group.units) : [];
                  const subCategory = splitCategoryWithGender(group.units[0]?.category).subCategory;
                  return (
                    <Fragment key={group.product_id}>
                      <tr
                        onClick={() => {
                          setExpandedProductId(isExpanded ? null : group.product_id);
                          if (group.product_id !== pinnedProductId) setPinnedProductId(null);
                        }}
                        className="cursor-pointer hover:bg-gray-50 transition-colors"
                      >
                        <Td className="w-6">
                          {isExpanded ? (
                            <ChevronDown size={13} className="text-gray-400" />
                          ) : (
                            <ChevronRight size={13} className="text-gray-400" />
                          )}
                        </Td>
                        <Td className="font-medium text-gray-900 truncate" title={group.product_title}>
                          {group.product_title}
                        </Td>
                        {showSubCategoryColumn && (
                          <Td className="truncate text-gray-500">{subCategory || "—"}</Td>
                        )}
                        <Td className="truncate" title={group.brand ?? undefined}>
                          {group.brand ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedFilter((f) => ({ ...f, brand: group.brand ?? undefined }));
                                setPinnedProductId(null);
                              }}
                              className="hover:underline text-left"
                              title={`Filter by ${group.brand}`}
                            >
                              {group.brand}
                            </button>
                          ) : (
                            "—"
                          )}
                        </Td>
                        <Td className="text-right tabular-nums">{group.units.length}</Td>
                        <Td className="text-right tabular-nums">
                          {group.selling_price
                            ? `Rs. ${group.selling_price.toLocaleString()}`
                            : "—"}
                        </Td>

                        <Td className="text-right">
                          <div
                            className="relative inline-block"
                            ref={openMenuId === group.product_id ? menuRef : undefined}
                          >
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenuId(
                                  openMenuId === group.product_id ? null : group.product_id
                                );
                              }}
                              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
                              title="Actions"
                            >
                              <MoreVertical size={16} />
                            </button>
                            {openMenuId === group.product_id && (
                              <div
                                onClick={(e) => e.stopPropagation()}
                                className="absolute right-0 z-20 mt-1 w-48 bg-white border border-gray-200 rounded-xl shadow-lg py-1"
                              >
                                <button
                                  onClick={() => {
                                    setOpenMenuId(null);
                                    setDownloadTarget({
                                      title: group.product_title,
                                      rows: buildDownloadRows(group),
                                    });
                                  }}
                                  className="w-full flex items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition"
                                >
                                  <Download size={14} />
                                  Download report
                                </button>
                              </div>
                            )}
                          </div>
                        </Td>
                      </tr>

                      {isExpanded && (
                        <tr>
                          <Td
                            colSpan={showSubCategoryColumn ? 7 : 6}
                            className="bg-gray-50/70 !py-3 !px-4"
                          >
                            <div className="bg-white rounded-xl overflow-hidden shadow-sm">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="bg-gray-50">
                                    {["Size", "Color", "Qty", "SKU", "Barcode", "Supplier", "Status"].map(
                                      (h) => (
                                        <th
                                          key={h}
                                          className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide"
                                        >
                                          {h}
                                        </th>
                                      )
                                    )}
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                  {variants.map((row, i) => {
                                    const skuKey = `sku-${group.product_id}-${i}`;
                                    const barcodeKey = `bc-${group.product_id}-${i}`;
                                    const hasRange = isBarcodeRange(row.barcodeRange);
                                    const barcodeToCopy = firstBarcode(row.barcodeRange);

                                    return (
                                      <tr
                                        key={`${row.color}-${row.size}-${row.status}`}
                                        className={
                                          i % 2 === 1
                                            ? "bg-gray-50/50 hover:bg-gray-100/70"
                                            : "hover:bg-gray-50"
                                        }
                                      >
                                        <td className="px-4 py-2 font-medium text-gray-900">
                                          {row.size}
                                        </td>
                                        <td className="px-4 py-2 text-gray-600">{row.color}</td>
                                        <td className="px-4 py-2 text-gray-600">{row.count}</td>
                                        <td
                                          onClick={(e) => copyValue(skuKey, row.skuSample, e)}
                                          className="px-4 py-2 text-gray-600 cursor-pointer hover:bg-gray-100 rounded transition-colors select-none"
                                          title="Click to copy SKU"
                                        >
                                          {row.count > 1
                                            ? `${row.skuSample} (+${row.count - 1} more)`
                                            : row.skuSample}
                                        </td>
                                        <td
                                          onClick={(e) =>
                                            copyValue(barcodeKey, barcodeToCopy, e)
                                          }
                                          className="px-4 py-2 font-mono text-xs text-gray-500 cursor-pointer hover:bg-gray-100 rounded transition-colors select-none"
                                          title={
                                            hasRange
                                              ? `Click to copy first: ${barcodeToCopy}`
                                              : "Click to copy barcode"
                                          }
                                        >
                                          {row.barcodeRange}
                                        </td>
                                        <td className="px-4 py-2 text-gray-500">
                                          {row.batchSupplierCode ?? "—"}
                                        </td>
                                        <td className="px-4 py-2">
                                          <Badge
                                            label={row.status}
                                            tone={inventoryStatusTone(row.status)}
                                          />
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </Td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {/* ---------- Floating copy tooltip ---------- */}
      {copiedKey && copiedPos && (
        <div
          className="fixed z-50 pointer-events-none px-2.5 py-1 rounded-md bg-gray-900 text-white text-xs font-medium shadow-lg"
          style={{
            left: copiedPos.x + 10,
            top: copiedPos.y - 30,
          }}
        >
          Copied!
        </div>
      )}

      {/* ---------- Product download modal ---------- */}
      {downloadTarget && (
        <ProductDownloadModal
          title={downloadTarget.title}
          rows={downloadTarget.rows}
          onClose={() => setDownloadTarget(null)}
        />
      )}
    </div>
  );
}