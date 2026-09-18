import { useEffect, useState, Fragment, useRef } from "react";
import { Package, ChevronDown, ChevronRight, Plus, X, Pencil, AlertTriangle, MinusCircle, CheckCircle, Search, Trash2 } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Product, InventoryUnit, Supplier, RemovalReason, Purchase } from "../lib/types";
import { compareSizes } from "../lib/sizeSort";
import { mainCategories } from "../lib/categories";
import {
  PageHeader,
  Card,
  Table,
  Th,
  Td,
  Input,
  Dropdown,
  Button,
  Badge,
  inventoryStatusTone,
  EmptyState,
  ErrorText,
  SuccessText,
  Label,
  FormGroup,
  NewSupplierModal,
} from "../components/ui";

const LOW_STOCK_THRESHOLD = 5;
const removalReasons: RemovalReason[] = ["Damaged", "Gifted", "Staff Use", "Stolen", "Lost", "Other"];

type ExpandedTab = "stock" | "restock" | "details";

interface VariantSummary {
  color: string;
  size: string;
  count: number;
  skuSample: string;
  barcodeRange: string;
  status: string;
  hasMixedBatches: boolean;
  batches: { cost: number | null; supplierName: string | null; count: number }[];
}

function summarizeVariants(units: InventoryUnit[]): VariantSummary[] {
  const map = new Map<string, InventoryUnit[]>();
  for (const u of units) {
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
    if (barcodes.length === 1) barcodeRange = barcodes[0];
    else if (barcodes.length > 1) barcodeRange = `${barcodes[0]} – ${barcodes[barcodes.length - 1]}`;

    const batchMap = new Map<string, { cost: number | null; supplierName: string | null; count: number }>();
    for (const u of sorted) {
      const cost = u.cost_price ?? null;
      const supplierName = u.batch_supplier_name ?? null;
      const batchKey = `${cost}|${supplierName}`;
      const existing = batchMap.get(batchKey);
      if (existing) existing.count++;
      else batchMap.set(batchKey, { cost, supplierName, count: 1 });
    }
    const batches = Array.from(batchMap.values());

    summaries.push({
      color: sorted[0].color ?? "—",
      size: sorted[0].size ?? "—",
      count: sorted.length,
      skuSample: sorted[0].sku,
      barcodeRange,
      status: sorted[0].status,
      hasMixedBatches: batches.length > 1,
      batches,
    });
  }

  return summaries.sort((a, b) => {
    const colorCompare = a.color.localeCompare(b.color);
    if (colorCompare !== 0) return colorCompare;
    return compareSizes(a.size, b.size);
  });
}

function ComboPicker({
  label,
  placeholder,
  existing,
  selected,
  onSelect,
  onDeselect,
  uppercase,
}: {
  label: string;
  placeholder: string;
  existing: string[];
  selected: string[];
  onSelect: (v: string) => void;
  onDeselect: (v: string) => void;
  uppercase?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const normalized = uppercase ? query.trim().toUpperCase() : query.trim();

  const available = existing.filter((v) => !selected.includes(v));
  const matches = normalized
    ? available.filter((v) => v.toLowerCase().includes(normalized.toLowerCase()))
    : available;

  const canAddNew =
    normalized.length > 0 &&
    !existing.some((v) => v.toLowerCase() === normalized.toLowerCase()) &&
    !selected.some((v) => v.toLowerCase() === normalized.toLowerCase());

  function commit(value: string) {
    const v = uppercase ? value.trim().toUpperCase() : value.trim();
    if (!v) return;
    if (!selected.includes(v)) onSelect(v);
    setQuery("");
    setOpen(false);
  }

  return (
    <div ref={wrapRef} className="relative">
      <Label>{label}</Label>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selected.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-100 border border-gray-200 rounded-full text-xs font-medium"
            >
              {v}
              <button
                type="button"
                onClick={() => onDeselect(v)}
                className="text-gray-400 hover:text-red-500"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (matches.length > 0) commit(matches[0]);
              else if (canAddNew) commit(query);
            }
            if (e.key === "Escape") {
              setOpen(false);
              setQuery("");
            }
          }}
          placeholder={
            existing.length
              ? placeholder
              : "No colors on record yet — type to add one"
          }
          className="w-full pl-3 pr-10 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400"
        />
        <button
          type="button"
          disabled={!canAddNew}
          onClick={() => commit(query)}
          className={`absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-7 h-7 rounded-md transition ${
            canAddNew
              ? "bg-black text-white hover:bg-gray-800"
              : "bg-gray-100 text-gray-300 cursor-not-allowed"
          }`}
          title={canAddNew ? "Add as new" : "Type a value to add"}
        >
          <Plus size={14} />
        </button>
      </div>

      {open && (matches.length > 0 || canAddNew) && (
        <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-sm max-h-44 overflow-y-auto">
          {matches.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => commit(m)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
            >
              {m}
            </button>
          ))}
          {canAddNew && (
            <button
              type="button"
              onClick={() => commit(query)}
              className="w-full text-left px-3 py-2 text-sm text-amber-700 hover:bg-amber-50 border-t border-gray-100"
            >
              Add new {uppercase ? "size" : "color"}: <span className="font-medium">{normalized}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function ManageProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [inventoryByProduct, setInventoryByProduct] = useState<Record<number, InventoryUnit[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedTab, setExpandedTab] = useState<ExpandedTab>("stock");

  const [editForm, setEditForm] = useState({
    product_title: "",
    brand: "",
    category: "",
    cost_price: "",
    selling_price: "",
    allow_returns: true,
  });
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState<string | null>(null);

  const [restockColors, setRestockColors] = useState<string[]>([]);
  const [restockSizes, setRestockSizes] = useState<string[]>([]);
  const [restockVariantRows, setRestockVariantRows] = useState<{ color: string; size: string; quantity: string }[]>([]);
  const [restockCost, setRestockCost] = useState("");
  const [restockSellingPrice, setRestockSellingPrice] = useState("");
  const [restockSupplierId, setRestockSupplierId] = useState("");
  const [fulfillsLineId, setFulfillsLineId] = useState("");
  const [pendingPurchases, setPendingPurchases] = useState<Purchase[]>([]);
  const [restockError, setRestockError] = useState<string | null>(null);
  const [restockSuccess, setRestockSuccess] = useState<string | null>(null);
  const [restockSubmitting, setRestockSubmitting] = useState(false);

  const [removeOpenKey, setRemoveOpenKey] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState<RemovalReason>("Damaged");
  const [removeNote, setRemoveNote] = useState("");
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeSubmitting, setRemoveSubmitting] = useState(false);

  const [batchDetailKey, setBatchDetailKey] = useState<string | null>(null);

  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [showNewSupplierModal, setShowNewSupplierModal] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [prods, supps, pending] = await Promise.all([
        api.get<Product[]>("/products"),
        api.get<Supplier[]>("/suppliers"),
        api.get<Purchase[]>("/purchases/pending"),
      ]);
      setProducts(prods);
      setSuppliers(supps);
      setPendingPurchases(pending);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load products");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    setRestockVariantRows((prevRows) => {
      const byKey = new Map(prevRows.map((r) => [`${r.color}|${r.size}`, r.quantity]));
      if (restockColors.length === 0 && restockSizes.length === 0) return [];
      const colorList = restockColors.length > 0 ? restockColors : [""];
      const sizeList = restockSizes.length > 0 ? restockSizes : [""];
      const next: { color: string; size: string; quantity: string }[] = [];
      for (const color of colorList) {
        for (const size of sizeList) {
          next.push({ color, size, quantity: byKey.get(`${color}|${size}`) ?? "" });
        }
      }
      return next;
    });
  }, [restockColors, restockSizes]);

  async function loadInventoryFor(productId: number) {
    if (inventoryByProduct[productId]) return;
    try {
      const units = await api.get<InventoryUnit[]>(`/inventory?product_id=${productId}`);
      setInventoryByProduct((prev) => ({ ...prev, [productId]: units }));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load inventory for this product");
    }
  }

  async function refreshInventoryFor(productId: number) {
    try {
      const units = await api.get<InventoryUnit[]>(`/inventory?product_id=${productId}`);
      setInventoryByProduct((prev) => ({ ...prev, [productId]: units }));
    } catch {
      // non-critical
    }
  }

  function toggleExpand(p: Product) {
    if (expandedId === p.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(p.id);
    setExpandedTab("stock");
    setIsEditingDetails(false);
    setRestockColors([]);
    setRestockSizes([]);
    setRestockVariantRows([]);
    setRestockCost(String(p.cost_price ?? ""));
    setRestockSellingPrice(String(p.selling_price));
    setRestockSupplierId(p.supplier_id ? String(p.supplier_id) : "");
    setRestockError(null);
    setRestockSuccess(null);
    setFulfillsLineId("");
    setEditForm({
      product_title: p.product_title,
      brand: p.brand ?? "",
      category: p.category ?? "",
      cost_price: String(p.cost_price ?? ""),
      selling_price: String(p.selling_price),
      allow_returns: p.allow_returns !== 0,
    });
    setEditError(null);
    setEditSuccess(null);
    loadInventoryFor(p.id);
  }

  async function saveEdit(id: number) {
    setEditError(null);
    setEditSuccess(null);
    try {
      await api.put(`/products/${id}`, {
        product_title: editForm.product_title,
        brand: editForm.brand || undefined,
        category: editForm.category || undefined,
        cost_price: parseFloat(editForm.cost_price),
        selling_price: parseFloat(editForm.selling_price),
        allow_returns: editForm.allow_returns,
      });
      setEditSuccess("Saved.");
      setIsEditingDetails(false);
      load();
    } catch (err) {
      setEditError(err instanceof ApiRequestError ? err.message : "Failed to update product");
    }
  }

  async function handleDelete(p: Product) {
    if (
      !confirm(
        `Delete "${p.product_title}" permanently?\n\n` +
          `This removes the product and every unit of its stock — including units already sold. This cannot be undone.\n\n` +
          `Old sale receipts and purchase history are preserved.`
      )
    )
      return;
    try {
      await api.delete(`/products/${p.id}`);
      setExpandedId(null);
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to delete product");
    }
  }

  function openRestockTab(p: Product) {
    setRestockColors([]);
    setRestockSizes([]);
    setRestockVariantRows([]);
    setRestockCost(String(p.cost_price ?? ""));
    setRestockSellingPrice(String(p.selling_price));
    setRestockSupplierId(p.supplier_id ? String(p.supplier_id) : "");
    setRestockError(null);
    setRestockSuccess(null);
    setFulfillsLineId("");
  }

  function cancelEdit(p: Product) {
    setIsEditingDetails(false);
    setEditForm({
      product_title: p.product_title,
      brand: p.brand ?? "",
      category: p.category ?? "",
      cost_price: String(p.cost_price ?? ""),
      selling_price: String(p.selling_price),
      allow_returns: p.allow_returns !== 0,
    });
    setEditError(null);
    setEditSuccess(null);
  }

  async function submitRestock(p: Product) {
    setRestockError(null);
    setRestockSuccess(null);

    const rowsWithQty = restockVariantRows.filter((r) => (parseInt(r.quantity, 10) || 0) > 0);
    if (rowsWithQty.length === 0) {
      setRestockError("Add at least one color/size with a quantity greater than 0");
      return;
    }
    if (!restockSupplierId) {
      setRestockError("Select a supplier for this restock");
      return;
    }
    if (!restockCost || !restockSellingPrice) {
      setRestockError("Enter a cost and selling price for this batch");
      return;
    }

    setRestockSubmitting(true);
    try {
      const result = await api.post<{ purchase_code: string; new_inventory_ids: number[]; quantity_warning: string | null }>(
        "/purchases",
        {
          supplier_id: parseInt(restockSupplierId, 10),
          items: rowsWithQty.map((row) => ({
            product_id: p.id,
            quantity: parseInt(row.quantity, 10),
            unit_cost: parseFloat(restockCost),
            unit_selling_price: parseFloat(restockSellingPrice),
            size: row.size || undefined,
            color: row.color || undefined,
          })),
          amount_paid: 0,
          fulfills_line_id: fulfillsLineId ? parseInt(fulfillsLineId, 10) : undefined,
        }
      );

      const existingUnits = inventoryByProduct[p.id] ?? [];
      const messages = rowsWithQty.map((row) => {
        const colorLabel = row.color.trim() || "—";
        const sizeLabel = row.size.trim() || "—";
        const qty = parseInt(row.quantity, 10);
        const isNewVariant = !existingUnits.some(
          (u) => (u.color ?? "").toLowerCase() === colorLabel.toLowerCase() && (u.size ?? "").toUpperCase() === sizeLabel.toUpperCase()
        );
        return isNewVariant
          ? `New variant "${colorLabel} / ${sizeLabel}" created with ${qty} pcs`
          : `${qty} pcs added to ${colorLabel} / ${sizeLabel}`;
      });

      setRestockSuccess(messages.join(" · ") + (result.quantity_warning ? ` Note: ${result.quantity_warning}` : ""));
      setRestockColors([]);
      setRestockSizes([]);
      setRestockVariantRows([]);
      setFulfillsLineId("");
      refreshInventoryFor(p.id);
      load();
    } catch (err) {
      setRestockError(err instanceof ApiRequestError ? err.message : "Failed to restock");
    } finally {
      setRestockSubmitting(false);
    }
  }

  function openRemove(key: string) {
    setRemoveOpenKey(key);
    setRemoveReason("Damaged");
    setRemoveNote("");
    setRemoveError(null);
  }

  async function submitRemoval(p: Product, units: InventoryUnit[], color: string, size: string, status: string) {
    setRemoveError(null);
    const candidate = units.find(
      (u) => (u.color ?? "—") === color && (u.size ?? "—") === size && u.status === status
    );
    if (!candidate) {
      setRemoveError("Could not find a matching unit to remove.");
      return;
    }

    setRemoveSubmitting(true);
    try {
      await api.put(`/inventory/${candidate.id}/remove`, {
        reason: removeReason,
        note: removeNote.trim() || undefined,
      });
      setRemoveOpenKey(null);
      refreshInventoryFor(p.id);
      load();
    } catch (err) {
      setRemoveError(err instanceof ApiRequestError ? err.message : "Failed to remove this unit");
    } finally {
      setRemoveSubmitting(false);
    }
  }

  const filteredProducts = products.filter((p) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      p.product_title.toLowerCase().includes(q) ||
      (p.brand ?? "").toLowerCase().includes(q) ||
      (p.category ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Fixed top section — never scrolls */}
      <div className="flex-shrink-0">
        <PageHeader title="Manage products" subtitle="Click a product to view its stock, edit details, or restock." />

        {error && <ErrorText>{error}</ErrorText>}

        {!loading && products.length > 0 && (
          <div className="relative mb-4 max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by product name, brand, or category..."
              className="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-gray-400"
            />
          </div>
        )}
      </div>

      {/* Scrollable table region — fills remaining height */}
      <div className="flex-1 min-h-0">
        {loading ? (
          <p className="text-sm text-gray-400">Loading...</p>
        ) : products.length === 0 ? (
          <EmptyState icon={Package} title="No products yet" subtitle="Add one to get started" />
        ) : filteredProducts.length === 0 ? (
          <EmptyState icon={Search} title="No products match your search" subtitle={`Nothing found for "${searchQuery}"`} />
        ) : (
          <Card className="p-0 overflow-hidden h-full flex flex-col">
            <div className="flex-1 min-h-0 overflow-y-auto">
              <Table>
                <thead className="sticky top-0 z-10 bg-white">
                  <tr>
                    <Th className="w-8"></Th>
                    <Th>Product title</Th>
                    <Th>Brand</Th>
                    <Th>Category</Th>
                    <Th>Selling price</Th>
                    <Th>In stock</Th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProducts.map((p) => {
                    const isExpanded = expandedId === p.id;
                    const units = inventoryByProduct[p.id] ?? [];

                    return (
                      <Fragment key={p.id}>
                        <tr onClick={() => toggleExpand(p)} className="cursor-pointer hover:bg-gray-50">
                          <Td className="w-8">
                            {isExpanded ? <ChevronDown size={15} className="text-gray-400" /> : <ChevronRight size={15} className="text-gray-400" />}
                          </Td>
                          <Td className="font-medium">{p.product_title}</Td>
                          <Td>{p.brand ?? "—"}</Td>
                          <Td>{p.category ?? "—"}</Td>
                          <Td>Rs. {p.selling_price.toLocaleString()}</Td>
                          <Td>
                            <div className="flex items-center gap-2">
                              <span>{p.qty}</span>
                              {p.qty < LOW_STOCK_THRESHOLD && (
                                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                                  <AlertTriangle size={11} />
                                  Low
                                </span>
                              )}
                            </div>
                          </Td>
                        </tr>

                        {isExpanded && (
                          <tr>
                            <Td colSpan={6} className="bg-gray-50">
                              <div className="py-3 space-y-4">
                                <div className="flex items-center gap-1 border-b border-gray-200">
                                  {(["stock", "restock", "details"] as ExpandedTab[]).map((tab) => (
                                    <button
                                      key={tab}
                                      onClick={() => {
                                        setExpandedTab(tab);
                                        if (tab === "restock") openRestockTab(p);
                                      }}
                                      className={`px-3 py-1.5 text-xs font-medium rounded-t-lg transition ${
                                        expandedTab === tab
                                          ? "bg-white border border-b-white border-gray-200 text-gray-900 -mb-px"
                                          : "text-gray-500 hover:text-gray-800"
                                      }`}
                                    >
                                      {tab === "stock" ? "Stock" : tab === "restock" ? "Restock" : "Details"}
                                    </button>
                                  ))}
                                </div>

                                {/* STOCK TAB */}
                                {expandedTab === "stock" && (
                                  <>
                                    {units.length === 0 ? (
                                      <p className="text-xs text-gray-400 px-1 py-2">No inventory units yet for this product.</p>
                                    ) : (
                                      <>
                                        <div className="border border-gray-200 rounded-xl overflow-hidden bg-white">
                                          <table className="w-full text-sm">
                                            <thead>
                                              <tr>
                                                <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">Color</th>
                                                <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">Size</th>
                                                <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">Qty</th>
                                                <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">SKU</th>
                                                <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">Barcode</th>
                                                <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">Status</th>
                                                <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400"></th>
                                              </tr>
                                            </thead>
                                            <tbody className="divide-y divide-gray-100">
                                              {summarizeVariants(units).map((row) => {
                                                const rowKey = `${row.color}::${row.size}::${row.status}`;
                                                const canRemove = row.status === "available";
                                                return (
                                                  <Fragment key={rowKey}>
                                                    <tr className={removeOpenKey === rowKey ? "bg-red-50/40" : ""}>
                                                      <td className="px-3 py-2">{row.color}</td>
                                                      <td className="px-3 py-2 font-medium">{row.size}</td>
                                                      <td className="px-3 py-2">
                                                        {row.count}
                                                        {row.hasMixedBatches && (
                                                          <button
                                                            onClick={() => setBatchDetailKey(batchDetailKey === rowKey ? null : rowKey)}
                                                            className="ml-2 inline-flex items-center text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 hover:bg-amber-100"
                                                            title="This variant has units from more than one batch"
                                                          >
                                                            mixed batches
                                                          </button>
                                                        )}
                                                      </td>
                                                      <td className="px-3 py-2">
                                                        {row.count > 1 ? `${row.skuSample} (+${row.count - 1} more)` : row.skuSample}
                                                      </td>
                                                      <td className="px-3 py-2 font-mono text-xs">{row.barcodeRange}</td>
                                                      <td className="px-3 py-2">
                                                        <Badge label={row.status} tone={inventoryStatusTone(row.status)} />
                                                      </td>
                                                      <td className="px-3 py-2">
                                                        {canRemove && (
                                                          <button
                                                            onClick={() => (removeOpenKey === rowKey ? setRemoveOpenKey(null) : openRemove(rowKey))}
                                                            className="text-gray-400 hover:text-red-500 transition inline-flex items-center gap-1 text-xs"
                                                            title="Remove one unit from stock (damage, gift, etc.)"
                                                          >
                                                            <MinusCircle size={14} />
                                                          </button>
                                                        )}
                                                      </td>
                                                    </tr>
                                                    {batchDetailKey === rowKey && (
                                                      <tr>
                                                        <td colSpan={7} className="px-3 py-2 bg-amber-50/50">
                                                          <p className="text-xs text-amber-800 mb-1">
                                                            This variant was restocked more than once under different terms:
                                                          </p>
                                                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
                                                            {row.batches.map((b, i) => (
                                                              <span key={i}>
                                                                {b.count} pcs @ Rs. {b.cost?.toLocaleString() ?? "—"}
                                                                {b.supplierName ? ` from ${b.supplierName}` : ""}
                                                              </span>
                                                            ))}
                                                          </div>
                                                        </td>
                                                      </tr>
                                                    )}
                                                  </Fragment>
                                                );
                                              })}
                                            </tbody>
                                          </table>
                                        </div>

                                        {removeOpenKey &&
                                          (() => {
                                            const [color, size, status] = removeOpenKey.split("::");
                                            return (
                                              <div className="bg-white border border-gray-200 rounded-xl p-4 mt-4">
                                                <div className="flex flex-wrap items-end gap-3">
                                                  <FormGroup>
                                                    <Label>Reason</Label>
                                                    <Dropdown
                                                      value={removeReason}
                                                      onChange={(v) => setRemoveReason(v as RemovalReason)}
                                                      options={removalReasons.map((r) => ({ value: r, label: r }))}
                                                    />
                                                  </FormGroup>
                                                  <FormGroup>
                                                    <Label>Note (optional)</Label>
                                                    <Input value={removeNote} onChange={(e) => setRemoveNote(e.target.value)} placeholder="Details..." />
                                                  </FormGroup>
                                                  <div className="ml-auto flex gap-2">
                                                    <Button size="sm" onClick={() => setRemoveOpenKey(null)}>
                                                      Cancel
                                                    </Button>
                                                    <Button
                                                      size="sm"
                                                      variant="danger"
                                                      disabled={removeSubmitting}
                                                      onClick={() => submitRemoval(p, units, color, size, status)}
                                                    >
                                                      {removeSubmitting ? "Removing..." : "Remove 1 unit"}
                                                    </Button>
                                                  </div>
                                                </div>
                                                {removeError && <ErrorText>{removeError}</ErrorText>}
                                              </div>
                                            );
                                          })()}
                                      </>
                                    )}
                                  </>
                                )}

                                {/* RESTOCK TAB */}
                                {expandedTab === "restock" && (
                                  <div className="bg-white border border-gray-200 rounded-xl p-4">
                                    <div className="flex items-center justify-between mb-3">
                                      <h3 className="text-sm font-semibold text-gray-900">Restock this product</h3>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4 mb-4">
                                      <ComboPicker
                                        label="Colors"
                                        placeholder="— Type to search or add a color —"
                                        existing={Array.from(
                                          new Set(units.map((u) => u.color).filter((c): c is string => !!c))
                                        ).sort()}
                                        selected={restockColors}
                                        onSelect={(v) => setRestockColors((c) => (c.includes(v) ? c : [...c, v]))}
                                        onDeselect={(v) => setRestockColors((c) => c.filter((x) => x !== v))}
                                      />
                                      <ComboPicker
                                        label="Sizes"
                                        placeholder="— Type to search or add a size —"
                                        existing={Array.from(
                                          new Set(units.map((u) => u.size).filter((s): s is string => !!s))
                                        ).sort()}
                                        selected={restockSizes}
                                        onSelect={(v) => setRestockSizes((s) => (s.includes(v) ? s : [...s, v]))}
                                        onDeselect={(v) => setRestockSizes((s) => s.filter((x) => x !== v))}
                                        uppercase
                                      />
                                    </div>

                                    {restockVariantRows.length > 0 && (
                                      <div className="mb-4 border border-gray-100 rounded-xl overflow-hidden">
                                        <table className="w-full text-sm">
                                          <thead>
                                            <tr className="bg-gray-50">
                                              <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">Color</th>
                                              <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">Size</th>
                                              <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">Currently in stock</th>
                                              <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">Quantity to add</th>
                                              <th className="text-left px-3 py-1.5 text-xs font-medium text-gray-400">New total</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {restockVariantRows.map((row, i) => {
                                              const current = units.filter(
                                                (u) => (u.color ?? "") === row.color && (u.size ?? "") === row.size && u.status === "available"
                                              ).length;
                                              const adding = parseInt(row.quantity, 10) || 0;
                                              return (
                                                <tr key={`${row.color}-${row.size}`}>
                                                  <td className="px-3 py-1.5 border-t border-gray-50">{row.color || "—"}</td>
                                                  <td className="px-3 py-1.5 border-t border-gray-50 font-medium">{row.size || "—"}</td>
                                                  <td className="px-3 py-1.5 border-t border-gray-50 text-gray-500">{current}</td>
                                                  <td className="px-3 py-1.5 border-t border-gray-50">
                                                    <input
                                                      type="text"
                                                      inputMode="numeric"
                                                      value={row.quantity}
                                                      onChange={(e) => {
                                                        const numeric = e.target.value.replace(/[^0-9]/g, "");
                                                        setRestockVariantRows((rows) =>
                                                          rows.map((r, idx) => (idx === i ? { ...r, quantity: numeric } : r))
                                                        );
                                                      }}
                                                      placeholder="0"
                                                      className="w-20 px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400"
                                                    />
                                                  </td>
                                                  <td className="px-3 py-1.5 border-t border-gray-50 font-medium text-gray-900">
                                                    {adding > 0 ? current + adding : "—"}
                                                  </td>
                                                </tr>
                                              );
                                            })}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}

                                    {(() => {
                                      const matchingPending = pendingPurchases.filter(
                                        (pp) => !restockSupplierId || String(pp.supplier_id) === restockSupplierId
                                      );
                                      const openLines = matchingPending.flatMap((pp) =>
                                        (pp.lines ?? [])
                                          .filter((line) => !line.is_fulfilled)
                                          .map((line) => ({ purchase: pp, line }))
                                      );
                                      if (openLines.length === 0) return null;
                                      return (
                                        <div className="mb-3 border border-gray-300 rounded-xl p-3">
                                          <Label>Fulfilling a line from an existing pending purchase?</Label>
                                          <Dropdown
                                            value={fulfillsLineId}
                                            onChange={(v) => {
                                              setFulfillsLineId(v);
                                              const match = openLines.find((ol) => String(ol.line.id) === v);
                                              if (match) {
                                                setRestockSupplierId(String(match.purchase.supplier_id));
                                                setRestockCost(String(match.line.unit_cost));
                                              }
                                            }}
                                            placeholder="— Not linked to a pending purchase —"
                                            options={openLines.map(({ purchase, line }) => ({
                                              value: String(line.id),
                                              label: `${purchase.purchase_code} — ${line.description} (${line.quantity} pcs @ Rs. ${line.unit_cost.toLocaleString()})`,
                                            }))}
                                          />
                                          <p className="text-xs text-gray-500 mt-1">
                                            Linking this restock to a pending purchase line means the supplier cost/payment for that line are
                                            already recorded — this step just adds the actual product/variant details. Other lines on the same
                                            purchase can still be fulfilled separately later.
                                          </p>
                                        </div>
                                      );
                                    })()}

                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                      <FormGroup>
                                        <Label>Supplier</Label>
                                        <Dropdown
                                          value={restockSupplierId}
                                          onChange={setRestockSupplierId}
                                          placeholder="— Select —"
                                          searchable
                                          onCreateNew={() => setShowNewSupplierModal(true)}
                                          createNewLabel="+ New supplier"
                                          options={suppliers.map((s) => ({ value: String(s.id), label: s.name, sublabel: s.supplier_code }))}
                                        />
                                      </FormGroup>
                                      <FormGroup>
                                        <Label>Cost for this batch (Rs.)</Label>
                                        <Input type="number" min="0" value={restockCost} onChange={(e) => setRestockCost(e.target.value)} />
                                      </FormGroup>
                                      <FormGroup>
                                        <Label>Selling price for this batch (Rs.)</Label>
                                        <Input type="number" min="0" value={restockSellingPrice} onChange={(e) => setRestockSellingPrice(e.target.value)} />
                                      </FormGroup>
                                    </div>
                                    <p className="text-xs text-gray-400 mt-1">
                                      Older stock keeps its own cost/price — this only applies to the new units you're adding now. This same
                                      cost/price applies to every variant row above.
                                    </p>
                                    {restockError && <ErrorText>{restockError}</ErrorText>}
                                    {restockSuccess && <SuccessText>{restockSuccess}</SuccessText>}
                                    <div className="flex justify-end gap-2 mt-3">
                                      <Button size="sm" onClick={() => setExpandedTab("stock")}>
                                        Cancel
                                      </Button>
                                      <Button variant="primary" disabled={restockSubmitting} onClick={() => submitRestock(p)}>
                                        {restockSubmitting ? "Adding stock..." : "Add stock"}
                                      </Button>
                                    </div>
                                  </div>
                                )}

                                {/* DETAILS TAB */}
                                {expandedTab === "details" && (
                                  <div className="bg-white border border-gray-200 rounded-xl p-4">
                                    <div className="flex items-center justify-between mb-3">
                                      <h3 className="text-sm font-semibold text-gray-900">Product details</h3>
                                      {!isEditingDetails && (
                                        <div className="flex items-center gap-1">
                                          <button
                                            onClick={() => setIsEditingDetails(true)}
                                            className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100"
                                          >
                                            <Pencil size={12} />
                                            Edit
                                          </button>
                                          <button
                                            onClick={() => handleDelete(p)}
                                            className="text-xs text-red-500 hover:text-red-700 inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-red-50"
                                          >
                                            <Trash2 size={12} />
                                            Delete
                                          </button>
                                        </div>
                                      )}
                                    </div>

                                    {isEditingDetails ? (
                                      <>
                                        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                          <FormGroup>
                                            <Label>Title</Label>
                                            <Input
                                              value={editForm.product_title}
                                              onChange={(e) => setEditForm((f) => ({ ...f, product_title: e.target.value }))}
                                            />
                                          </FormGroup>
                                          <FormGroup>
                                            <Label>Brand</Label>
                                            <Input value={editForm.brand} onChange={(e) => setEditForm((f) => ({ ...f, brand: e.target.value }))} />
                                          </FormGroup>
                                          <FormGroup>
                                            <Label>Category</Label>
                                            <Dropdown
                                              value={editForm.category}
                                              onChange={(v) => setEditForm((f) => ({ ...f, category: v }))}
                                              placeholder="— Select —"
                                              options={mainCategories.map((c) => ({ value: c, label: c }))}
                                            />
                                          </FormGroup>
                                          <FormGroup>
                                            <Label>Cost price (Rs.)</Label>
                                            <Input
                                              type="number"
                                              value={editForm.cost_price}
                                              onChange={(e) => setEditForm((f) => ({ ...f, cost_price: e.target.value }))}
                                            />
                                          </FormGroup>
                                          <FormGroup>
                                            <Label>Selling price (Rs.)</Label>
                                            <Input
                                              type="number"
                                              value={editForm.selling_price}
                                              onChange={(e) => setEditForm((f) => ({ ...f, selling_price: e.target.value }))}
                                            />
                                          </FormGroup>
                                        </div>
                                        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer mt-3">
                                          <input
                                            type="checkbox"
                                            checked={editForm.allow_returns}
                                            onChange={(e) => setEditForm((f) => ({ ...f, allow_returns: e.target.checked }))}
                                            className="rounded"
                                          />
                                          Allow returns on this product
                                        </label>
                                        {!editForm.allow_returns && (
                                          <p className="text-xs text-amber-600 mt-1">
                                            Marked as Final Sale — customers won't see a return option for this item, though an admin can still
                                            force one through with a logged reason.
                                          </p>
                                        )}
                                        {editError && <ErrorText>{editError}</ErrorText>}
                                        {editSuccess && <SuccessText>{editSuccess}</SuccessText>}
                                        <div className="flex justify-end gap-2 mt-3">
                                          <Button size="sm" onClick={() => cancelEdit(p)}>
                                            Cancel
                                          </Button>
                                          <Button variant="primary" size="sm" onClick={() => saveEdit(p.id)}>
                                            Save changes
                                          </Button>
                                        </div>
                                      </>
                                    ) : (
                                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                                        <div>
                                          <p className="text-xs text-gray-400">Title</p>
                                          <p className="text-gray-900">{p.product_title}</p>
                                        </div>
                                        <div>
                                          <p className="text-xs text-gray-400">Brand</p>
                                          <p className="text-gray-900">{p.brand ?? "—"}</p>
                                        </div>
                                        <div>
                                          <p className="text-xs text-gray-400">Category</p>
                                          <p className="text-gray-900">{p.category ?? "—"}</p>
                                        </div>
                                        <div>
                                          <p className="text-xs text-gray-400">Cost price</p>
                                          <p className="text-gray-900">Rs. {p.cost_price?.toLocaleString() ?? "—"}</p>
                                        </div>
                                        <div>
                                          <p className="text-xs text-gray-400">Selling price</p>
                                          <p className="text-gray-900">Rs. {p.selling_price.toLocaleString()}</p>
                                        </div>
                                        <div>
                                          <p className="text-xs text-gray-400">Returns</p>
                                          <p className="text-gray-900">{p.allow_returns !== 0 ? "Allowed" : "Final Sale — No Returns"}</p>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </Td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </Table>
            </div>
            {/* Optional footer showing count — helps replace pagination at a glance */}
            <div className="flex-shrink-0 border-t border-gray-100 px-4 py-2 text-xs text-gray-400">
              Showing {filteredProducts.length} of {products.length} product{products.length === 1 ? "" : "s"}
            </div>
          </Card>
        )}
      </div>

      {showNewSupplierModal && (
        <NewSupplierModal
          onClose={() => setShowNewSupplierModal(false)}
          onCreated={(supplier) => {
            setSuppliers((prev) => [...prev, supplier as any]);
            setRestockSupplierId(String(supplier.id));
            setShowNewSupplierModal(false);
          }}
        />
      )}
    </div>
  );
}