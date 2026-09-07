import { useEffect, useState, useMemo, useRef, Fragment } from "react";
import { Search, Package, RefreshCw, Loader2, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { InventoryUnit } from "../lib/types";
import { useAuth } from "../context/AuthContext";
import { groupByProduct, compareSizes } from "../lib/sizeSort";
import { PageHeader, Card, Input, Dropdown, Table, Th, Td, Badge, inventoryStatusTone, EmptyState, ErrorText } from "../components/ui";

export default function InventoryPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [units, setUnits] = useState<InventoryUnit[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [subCategoryFilter, setSubCategoryFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [focusedProductId, setFocusedProductId] = useState<number | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setSuggestionsOpen(false);
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
      setError(err instanceof ApiRequestError ? err.message : "Failed to load inventory");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function splitCategory(raw?: string | null): { category: string; subCategory: string } {
    if (!raw) return { category: "", subCategory: "" };
    const withoutGender = raw.replace(/\s*\([^)]*\)\s*$/, "");
    const [category, subCategory] = withoutGender.split(" / ").map((s) => s.trim());
    return { category: category ?? "", subCategory: subCategory ?? "" };
  }

  // Category filter options are derived from what's actually in the data
  // — not a fixed list — so imported/legacy category names (e.g. "Pants",
  // "Tees" from a spreadsheet import) always show up correctly, instead
  // of silently mismatching a hardcoded list built for new products only.
  const realCategories = useMemo(() => {
    const set = new Set<string>();
    units.forEach((u) => {
      const { category } = splitCategory(u.category);
      if (category) set.add(category);
    });
    return Array.from(set).sort();
  }, [units]);

  const realSubCategories = useMemo(() => {
    if (!categoryFilter) return [];
    const set = new Set<string>();
    units.forEach((u) => {
      const parts = splitCategory(u.category);
      if (parts.category === categoryFilter && parts.subCategory) set.add(parts.subCategory);
    });
    return Array.from(set).sort();
  }, [units, categoryFilter]);

  const trimmedQuery = query.trim().toLowerCase();

  // Groups a product's individual units by color+size into one summary row
  // — e.g. 11 identical "Gray 30/31" units collapse into a single row
  // instead of 11 nearly-identical ones. The barcode column shows a
  // start–end range when there are multiple units (since barcodes are
  // generated sequentially per batch), or the single barcode when there's
  // only one unit.
  interface VariantSummary {
    color: string;
    size: string;
    count: number;
    skuSample: string;
    barcodeRange: string;
    status: string;
  }

  function summarizeVariants(productUnits: InventoryUnit[]): VariantSummary[] {
    const map = new Map<string, InventoryUnit[]>();
    for (const u of productUnits) {
      // Units of different status are kept separate even within the same
      // color+size, so an "available" row is never merged with a "damaged"
      // one under one misleading count.
      const key = `${u.color ?? ""}|${u.size ?? ""}|${u.status}`;
      const list = map.get(key) ?? [];
      list.push(u);
      map.set(key, list);
    }

    const summaries: VariantSummary[] = [];
    for (const list of map.values()) {
      const sorted = [...list].sort((a, b) => (a.barcode ?? "").localeCompare(b.barcode ?? ""));
      const barcodes = sorted.map((u) => u.barcode).filter((b): b is string => !!b);

      let barcodeRange = "—";
      if (barcodes.length === 1) {
        barcodeRange = barcodes[0];
      } else if (barcodes.length > 1) {
        barcodeRange = `${barcodes[0]} – ${barcodes[barcodes.length - 1]}`;
      }

      summaries.push({
        color: sorted[0].color ?? "—",
        size: sorted[0].size ?? "—",
        count: sorted.length,
        skuSample: sorted[0].sku,
        barcodeRange,
        status: sorted[0].status,
      });
    }

    return summaries.sort((a, b) => {
      const colorCompare = a.color.localeCompare(b.color);
      if (colorCompare !== 0) return colorCompare;
      return compareSizes(a.size, b.size);
    });
  }

  const liveMatches = useMemo(() => {
    if (!trimmedQuery) return [];
    return units.filter(
      (u) =>
        u.barcode?.toLowerCase().includes(trimmedQuery) ||
        u.sku.toLowerCase().includes(trimmedQuery) ||
        (u.product_title ?? "").toLowerCase().includes(trimmedQuery) ||
        (u.brand ?? "").toLowerCase().includes(trimmedQuery)
    );
  }, [units, trimmedQuery]);

  const exactUnit = useMemo(() => {
    if (!trimmedQuery) return null;
    return units.find((u) => u.barcode?.toLowerCase() === trimmedQuery || u.sku.toLowerCase() === trimmedQuery) ?? null;
  }, [units, trimmedQuery]);

  useEffect(() => {
    if (exactUnit) {
      setFocusedProductId(exactUnit.product_id);
    } else if (!trimmedQuery) {
      setFocusedProductId(null);
    }
  }, [exactUnit, trimmedQuery]);

  function selectSuggestion(unit: InventoryUnit) {
    setFocusedProductId(unit.product_id);
    setSuggestionsOpen(false);
  }

  function clearSearch() {
    setQuery("");
    setFocusedProductId(null);
    setSuggestionsOpen(false);
  }

  const filteredForTable = useMemo(() => {
    let result = units;
    if (categoryFilter) result = result.filter((u) => splitCategory(u.category).category === categoryFilter);
    if (subCategoryFilter) result = result.filter((u) => splitCategory(u.category).subCategory === subCategoryFilter);
    return result;
  }, [units, categoryFilter, subCategoryFilter]);

  const groups = useMemo(() => {
    const grouped = groupByProduct(filteredForTable);
    if (focusedProductId == null) return grouped;

    // A scan/SKU match (or a clicked suggestion) sets focusedProductId —
    // bring that product's row to the very top of the main table so it's
    // immediately visible without scrolling, same as the exact-match card
    // and variant grid above already highlight it.
    const matchIndex = grouped.findIndex((g) => g.product_id === focusedProductId);
    if (matchIndex <= 0) return grouped;

    const reordered = [...grouped];
    const [matched] = reordered.splice(matchIndex, 1);
    reordered.unshift(matched);
    return reordered;
  }, [filteredForTable, focusedProductId]);

  // Clicking a row in the main table expands it in place to show that
  // product's variants — independent of the search zone above, though a
  // search match also auto-expands its row via focusedProductId.
  const [expandedRowId, setExpandedRowId] = useState<number | null>(null);

  useEffect(() => {
    // When a search match brings a product to the top, also expand its
    // row right away — no extra click needed to see the same detail
    // twice (the variant grid above already showed it, but expanding the
    // row too keeps the table self-consistent if the person scrolls).
    if (focusedProductId != null) setExpandedRowId(focusedProductId);
  }, [focusedProductId]);

  return (
    <div>
      <PageHeader
        title="Inventory"
        subtitle={`${groups.length} product${groups.length === 1 ? "" : "s"}, ${filteredForTable.length} unit${filteredForTable.length === 1 ? "" : "s"}${isAdmin ? "" : " — view only"}`}
        action={
          <button onClick={load} disabled={loading} className="p-2.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-all">
            <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
          </button>
        }
      />

      <Card className="mb-5 border-0 shadow-none">
        <div className="relative" ref={searchBoxRef}>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
              <Search size={16} className="text-gray-400" />
            </div>
            <Input
              className="pl-10"
              placeholder="Scan a barcode, or type a SKU / product name to check availability..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSuggestionsOpen(true);
              }}
              onFocus={() => query && setSuggestionsOpen(true)}
              autoFocus
            />
            {query && (
              <button onClick={clearSearch} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-600">
                Clear
              </button>
            )}
          </div>

          {/* Floating suggestion dropdown — only for a text search still
              narrowing toward a product, not shown once there's an exact
              barcode/SKU match (that gets the dedicated card below instead). */}
          {suggestionsOpen && !exactUnit && trimmedQuery && (
            <div className="absolute z-20 mt-1.5 w-full bg-white border border-gray-200 rounded-xl shadow-lg max-h-72 overflow-y-auto">
              {liveMatches.length === 0 ? (
                <p className="text-xs text-gray-400 px-3.5 py-3">No matches yet for "{query}".</p>
              ) : (
                <>
                  {liveMatches.slice(0, 8).map((u) => (
                    <button
                      key={u.id}
                      onClick={() => selectSuggestion(u)}
                      className="w-full flex items-center justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-gray-50 transition-colors border-b border-gray-50 last:border-0"
                    >
                      <div>
                        <span className="text-sm text-gray-900">{u.product_title}</span>
                        <span className="text-xs text-gray-400 ml-2">
                          {u.color ?? "—"} / {u.size ?? "—"} · {u.sku}
                        </span>
                      </div>
                      <Badge label={u.status} tone={inventoryStatusTone(u.status)} />
                    </button>
                  ))}
                  {liveMatches.length > 8 && (
                    <div className="px-3.5 py-2 text-xs text-gray-400 bg-gray-50">+{liveMatches.length - 8} more — keep typing to narrow down</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {exactUnit && (
          <div className="mt-4 flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl p-3.5">
            <CheckCircle2 size={20} className="text-green-600 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-gray-900">{exactUnit.product_title}</p>
              <p className="text-xs text-gray-600 mt-0.5">
                {exactUnit.color ?? "—"} · Size {exactUnit.size ?? "—"} · {exactUnit.brand} · SKU {exactUnit.sku}
              </p>
            </div>
            <Badge label={exactUnit.status} tone={inventoryStatusTone(exactUnit.status)} />
          </div>
        )}
      </Card>

      <Card className="mb-5 border-0 shadow-none">
        <p className="text-xs font-medium text-gray-500 mb-2">Filter by category</p>
        <div className="flex gap-3 flex-wrap">
          <div className="w-48">
            <Dropdown
              value={categoryFilter}
              onChange={(v) => {
                setCategoryFilter(v);
                setSubCategoryFilter("");
              }}
              placeholder="All categories"
              options={realCategories.map((c) => ({ value: c, label: c }))}
            />
          </div>
          <div className="w-48">
            <Dropdown
              value={subCategoryFilter}
              onChange={setSubCategoryFilter}
              placeholder={
                !categoryFilter
                  ? "Pick a category first"
                  : realSubCategories.length === 0
                  ? "No sub-categories for this one"
                  : "All sub-categories"
              }
              disabled={!categoryFilter}
              options={realSubCategories.map((s) => ({ value: s, label: s }))}
            />
          </div>
        </div>
      </Card>

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <div className="flex flex-col items-center justify-center py-16">
          <Loader2 size={32} className="animate-spin text-gray-300" />
          <p className="mt-3 text-sm text-gray-400">Loading inventory...</p>
        </div>
      ) : groups.length === 0 ? (
        <EmptyState icon={Package} title="No inventory units found" subtitle="Try adjusting your filters" />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th></Th>
                <Th>Product title</Th>
                <Th>Brand</Th>
                <Th>Category</Th>
                <Th>Selling price</Th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const isFocused = group.product_id === focusedProductId;
                const isExpanded = expandedRowId === group.product_id;
                const groupCategory = group.units[0]?.category ?? null;

                return (
                  <Fragment key={group.product_id}>
                    <tr
                      onClick={() => setExpandedRowId(isExpanded ? null : group.product_id)}
                      className={`cursor-pointer ${isFocused ? "bg-green-50/60 hover:bg-green-50" : "hover:bg-gray-50"}`}
                    >
                      <Td className="w-8">
                        {isExpanded ? <ChevronDown size={15} className="text-gray-400" /> : <ChevronRight size={15} className="text-gray-400" />}
                      </Td>
                      <Td className="font-medium">{group.product_title}</Td>
                      <Td>{group.brand ?? "—"}</Td>
                      <Td>{groupCategory ?? "—"}</Td>
                      <Td>Rs. {group.selling_price?.toLocaleString() ?? "—"}</Td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <Td colSpan={5} className="bg-gray-50">
                          <div className="py-2">
                            <table className="w-full text-sm">
                              <thead>
                                <tr>
                                  <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">Color</th>
                                  <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">Size</th>
                                  <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">Qty</th>
                                  <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">SKU</th>
                                  <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">Barcode</th>
                                  <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {summarizeVariants(group.units).map((row) => {
                                  const isExactVariant =
                                    exactUnit && exactUnit.color === row.color && exactUnit.size === row.size && exactUnit.status === row.status;
                                  return (
                                    <tr key={`${row.color}-${row.size}-${row.status}`} className={isExactVariant ? "bg-green-50/60" : ""}>
                                      <td className="px-3 py-1.5">{row.color}</td>
                                      <td className="px-3 py-1.5 font-medium">{row.size}</td>
                                      <td className="px-3 py-1.5">{row.count}</td>
                                      <td className="px-3 py-1.5">{row.count > 1 ? `${row.skuSample} (+${row.count - 1} more)` : row.skuSample}</td>
                                      <td className="px-3 py-1.5 font-mono text-xs">{row.barcodeRange}</td>
                                      <td className="px-3 py-1.5">
                                        <Badge label={row.status} tone={inventoryStatusTone(row.status)} />
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
        </Card>
      )}
    </div>
  );
}
