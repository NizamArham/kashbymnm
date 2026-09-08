import { useEffect, useState, Fragment } from "react";
import { Package, ChevronDown, ChevronRight, Plus, X, Pencil, AlertTriangle, MinusCircle, CheckCircle } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Product, InventoryUnit, Supplier, RemovalReason } from "../lib/types";
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

interface VariantSummary {
  color: string;
  size: string;
  count: number;
  skuSample: string;
  barcodeRange: string;
  status: string;
  // True when this variant's units don't all share the same cost_price
  // or the same batch supplier — i.e. it was restocked more than once
  // under different terms. The flat count still shows as one row; this
  // just says "there's more going on here than one number implies."
  hasMixedBatches: boolean;
  // The actual per-batch breakdown, shown only on demand (not by
  // default) since this is real cost data — appropriate to have
  // available on this admin page, just not shoved in front of every row.
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

    // Group this variant's own units by (cost, supplier) pair to see if
    // they actually came from more than one batch under different terms.
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

export default function ManageProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [inventoryByProduct, setInventoryByProduct] = useState<Record<number, InventoryUnit[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

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

  const [restockOpenFor, setRestockOpenFor] = useState<number | null>(null);
  // Multi-select, matching Add Product's pattern: pick several colors and
  // several sizes, and every combination becomes its own row with its
  // own quantity — restocking "Navy + Black" in "S + M" in one go
  // produces 4 separate variant rows, not just one.
  const [restockColors, setRestockColors] = useState<string[]>([]);
  const [restockSizes, setRestockSizes] = useState<string[]>([]);
  const [restockVariantRows, setRestockVariantRows] = useState<{ color: string; size: string; quantity: string }[]>([]);
  const [restockCost, setRestockCost] = useState("");
  const [restockSellingPrice, setRestockSellingPrice] = useState("");
  const [restockSupplierId, setRestockSupplierId] = useState("");
  const [restockError, setRestockError] = useState<string | null>(null);
  const [restockSuccess, setRestockSuccess] = useState<string | null>(null);
  const [restockSubmitting, setRestockSubmitting] = useState(false);
  // Toggles the color/size fields into "type it" mode for a genuinely new
  // variant — off by default, since picking from what's already on
  // record is what prevents a typo'd duplicate (e.g. "Navy" vs "Navy Blue").
  const [restockAddingNewColor, setRestockAddingNewColor] = useState(false);
  const [restockAddingNewSize, setRestockAddingNewSize] = useState(false);
  const [restockNewColorInput, setRestockNewColorInput] = useState("");
  const [restockNewSizeInput, setRestockNewSizeInput] = useState("");

  // Write-off (remove stock) state, per variant row
  const [removeOpenKey, setRemoveOpenKey] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState<RemovalReason>("Damaged");
  const [removeNote, setRemoveNote] = useState("");
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeSubmitting, setRemoveSubmitting] = useState(false);

  // Which variant row's batch/cost breakdown is currently shown — only
  // one at a time, and hidden by default even when a variant has mixed
  // batches, since the flat count + a small flag is enough at a glance.
  const [batchDetailKey, setBatchDetailKey] = useState<string | null>(null);

  // Edit footer is read-only until "Edit" is explicitly clicked, so an
  // accidental click/keystroke while browsing can never change a price.
  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [showNewSupplierModal, setShowNewSupplierModal] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [prods, supps] = await Promise.all([api.get<Product[]>("/products"), api.get<Supplier[]>("/suppliers")]);
      setProducts(prods);
      setSuppliers(supps);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load products");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Regenerate the restock variant grid whenever the picked colors/sizes
  // change — every (color, size) combination gets its own row, keeping
  // whatever quantity was already typed for a combination that's still
  // present after the change.
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
      setRestockOpenFor(null);
      return;
    }
    setExpandedId(p.id);
    setRestockOpenFor(null);
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

  async function handleDelete(id: number) {
    if (!confirm("Delete this product? This only works if it has no inventory units.")) return;
    try {
      await api.delete(`/products/${id}`);
      setExpandedId(null);
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to delete product");
    }
  }

  function openRestock(p: Product) {
    setRestockOpenFor(p.id);
    setRestockColors([]);
    setRestockSizes([]);
    setRestockVariantRows([]);
    setRestockCost(String(p.cost_price ?? ""));
    setRestockSellingPrice(String(p.selling_price));
    setRestockSupplierId(p.supplier_id ? String(p.supplier_id) : "");
    setRestockError(null);
    setRestockSuccess(null);
    setRestockAddingNewColor(false);
    setRestockAddingNewSize(false);
    setRestockNewColorInput("");
    setRestockNewSizeInput("");
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
      const result = await api.post<{ purchase_code: string; new_inventory_ids: number[] }>("/purchases", {
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
      });

      // Report each variant separately, distinguishing a genuinely new
      // combination from restocking something already on record — same
      // wording as before, just now covering every row in one go.
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

      setRestockSuccess(messages.join(" · "));
      setRestockColors([]);
      setRestockSizes([]);
      setRestockVariantRows([]);
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

  // Removing a whole variant SUMMARY row (which can represent several
  // physical units sharing the same color/size/status) writes off just
  // ONE unit from that group per click — the safer default, since
  // removing several units at once from one button press risks an
  // accidental bulk write-off. The person clicks again for each
  // additional unit they actually need to remove.
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

  return (
    <div>
      <PageHeader title="Manage products" subtitle="Click a product to view its stock, edit details, or restock." />

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : products.length === 0 ? (
        <EmptyState icon={Package} title="No products yet" subtitle="Add one to get started" />
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
                <Th>In stock</Th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
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
                            {units.length === 0 ? (
                              <p className="text-xs text-gray-400 px-1">No inventory units yet for this product.</p>
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
                                    <tbody>
                                      {summarizeVariants(units).map((row) => {
                                        const rowKey = `${row.color}::${row.size}::${row.status}`;
                                        const canRemove = row.status === "available";
                                        return (
                                          <Fragment key={rowKey}>
                                            <tr className={removeOpenKey === rowKey ? "bg-red-50/40" : ""}>
                                              <td className="px-3 py-1.5">{row.color}</td>
                                              <td className="px-3 py-1.5 font-medium">{row.size}</td>
                                              <td className="px-3 py-1.5">
                                                {row.count}
                                                {row.hasMixedBatches && (
                                                  <button
                                                    onClick={() => setBatchDetailKey(batchDetailKey === rowKey ? null : rowKey)}
                                                    className="ml-1.5 text-[10px] text-amber-600 hover:text-amber-800 underline"
                                                    title="This variant has units from more than one batch"
                                                  >
                                                    multiple batches
                                                  </button>
                                                )}
                                              </td>
                                              <td className="px-3 py-1.5">
                                                {row.count > 1 ? `${row.skuSample} (+${row.count - 1} more)` : row.skuSample}
                                              </td>
                                              <td className="px-3 py-1.5 font-mono text-xs">{row.barcodeRange}</td>
                                              <td className="px-3 py-1.5">
                                                <Badge label={row.status} tone={inventoryStatusTone(row.status)} />
                                              </td>
                                              <td className="px-3 py-1.5">
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

                                {/* Removal panel lives OUTSIDE the overflow-hidden table
                                    container above, so its Reason dropdown can render its
                                    floating list without being clipped. */}
                                {removeOpenKey &&
                                  (() => {
                                    const [color, size, status] = removeOpenKey.split("::");
                                    return (
                                      <div className="bg-white border border-gray-200 rounded-xl p-4">
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
                                          <Button
                                            size="sm"
                                            variant="danger"
                                            disabled={removeSubmitting}
                                            onClick={() => submitRemoval(p, units, color, size, status)}
                                          >
                                            {removeSubmitting ? "Removing..." : "Remove 1 unit"}
                                          </Button>
                                          <Button size="sm" onClick={() => setRemoveOpenKey(null)}>
                                            Cancel
                                          </Button>
                                        </div>
                                        {removeError && <ErrorText>{removeError}</ErrorText>}
                                      </div>
                                    );
                                  })()}
                              </>
                            )}

                            {restockOpenFor === p.id ? (
                              <div className="bg-white border border-gray-200 rounded-xl p-4">
                                <div className="flex items-center justify-between mb-3">
                                  <h3 className="text-sm font-semibold text-gray-900">Restock this product</h3>
                                  <button onClick={() => setRestockOpenFor(null)} className="text-gray-400 hover:text-gray-600">
                                    <X size={16} />
                                  </button>
                                </div>

                                <div className="grid grid-cols-2 gap-4 mb-4">
                                  <div>
                                    <Label>Colors</Label>
                                    {(() => {
                                      const units = inventoryByProduct[p.id] ?? [];
                                      const existingColors = Array.from(new Set(units.map((u) => u.color).filter((c): c is string => !!c))).sort();
                                      return restockAddingNewColor ? (
                                        <div className="flex gap-1.5">
                                          <Input
                                            value={restockNewColorInput}
                                            onChange={(e) => setRestockNewColorInput(e.target.value)}
                                            placeholder="e.g. Black"
                                            autoFocus
                                            onKeyDown={(e) => {
                                              if (e.key !== "Enter") return;
                                              e.preventDefault();
                                              const v = restockNewColorInput.trim();
                                              if (v && !restockColors.includes(v)) setRestockColors((c) => [...c, v]);
                                              setRestockNewColorInput("");
                                              setRestockAddingNewColor(false);
                                            }}
                                          />
                                          <button
                                            type="button"
                                            onClick={() => {
                                              const v = restockNewColorInput.trim();
                                              if (v && !restockColors.includes(v)) setRestockColors((c) => [...c, v]);
                                              setRestockNewColorInput("");
                                              setRestockAddingNewColor(false);
                                            }}
                                            className="flex items-center justify-center w-9 h-9 bg-black text-white rounded-lg hover:bg-gray-800 flex-shrink-0"
                                            title="Add this color"
                                          >
                                            <CheckCircle size={14} />
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setRestockAddingNewColor(false);
                                              setRestockNewColorInput("");
                                            }}
                                            className="flex items-center justify-center w-9 h-9 border border-gray-200 rounded-lg text-gray-500 hover:bg-gray-50 flex-shrink-0"
                                            title="Cancel"
                                          >
                                            <X size={14} />
                                          </button>
                                        </div>
                                      ) : (
                                        <Dropdown
                                          value=""
                                          onChange={(v) => {
                                            if (!restockColors.includes(v)) setRestockColors((c) => [...c, v]);
                                          }}
                                          placeholder={existingColors.length ? "— Pick an existing color —" : "No colors on record yet"}
                                          searchable
                                          onCreateNew={() => setRestockAddingNewColor(true)}
                                          createNewLabel="+ New color"
                                          options={existingColors.filter((c) => !restockColors.includes(c)).map((c) => ({ value: c, label: c }))}
                                        />
                                      );
                                    })()}
                                    {restockColors.length > 0 && (
                                      <div className="flex flex-wrap gap-1.5 mt-2">
                                        {restockColors.map((c) => (
                                          <span key={c} className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-100 border border-gray-200 rounded-full text-xs">
                                            {c}
                                            <button
                                              type="button"
                                              onClick={() => setRestockColors((cs) => cs.filter((v) => v !== c))}
                                              className="text-gray-400 hover:text-red-500"
                                            >
                                              <X size={12} />
                                            </button>
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>

                                  <div>
                                    <Label>Sizes</Label>
                                    {(() => {
                                      const units = inventoryByProduct[p.id] ?? [];
                                      const existingSizes = Array.from(new Set(units.map((u) => u.size).filter((s): s is string => !!s))).sort();
                                      return restockAddingNewSize ? (
                                        <div className="flex gap-1.5">
                                          <Input
                                            value={restockNewSizeInput}
                                            onChange={(e) => setRestockNewSizeInput(e.target.value)}
                                            placeholder="e.g. M"
                                            autoFocus
                                            onKeyDown={(e) => {
                                              if (e.key !== "Enter") return;
                                              e.preventDefault();
                                              const v = restockNewSizeInput.trim().toUpperCase();
                                              if (v && !restockSizes.includes(v)) setRestockSizes((s) => [...s, v]);
                                              setRestockNewSizeInput("");
                                              setRestockAddingNewSize(false);
                                            }}
                                          />
                                          <button
                                            type="button"
                                            onClick={() => {
                                              const v = restockNewSizeInput.trim().toUpperCase();
                                              if (v && !restockSizes.includes(v)) setRestockSizes((s) => [...s, v]);
                                              setRestockNewSizeInput("");
                                              setRestockAddingNewSize(false);
                                            }}
                                            className="flex items-center justify-center w-9 h-9 bg-black text-white rounded-lg hover:bg-gray-800 flex-shrink-0"
                                            title="Add this size"
                                          >
                                            <CheckCircle size={14} />
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setRestockAddingNewSize(false);
                                              setRestockNewSizeInput("");
                                            }}
                                            className="flex items-center justify-center w-9 h-9 border border-gray-200 rounded-lg text-gray-500 hover:bg-gray-50 flex-shrink-0"
                                            title="Cancel"
                                          >
                                            <X size={14} />
                                          </button>
                                        </div>
                                      ) : (
                                        <Dropdown
                                          value=""
                                          onChange={(v) => {
                                            if (!restockSizes.includes(v)) setRestockSizes((s) => [...s, v]);
                                          }}
                                          placeholder={existingSizes.length ? "— Pick an existing size —" : "No sizes on record yet"}
                                          searchable
                                          onCreateNew={() => setRestockAddingNewSize(true)}
                                          createNewLabel="+ New size"
                                          options={existingSizes.filter((s) => !restockSizes.includes(s)).map((s) => ({ value: s, label: s }))}
                                        />
                                      );
                                    })()}
                                    {restockSizes.length > 0 && (
                                      <div className="flex flex-wrap gap-1.5 mt-2">
                                        {restockSizes.map((s) => (
                                          <span key={s} className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-100 border border-gray-200 rounded-full text-xs font-medium">
                                            {s}
                                            <button
                                              type="button"
                                              onClick={() => setRestockSizes((ss) => ss.filter((v) => v !== s))}
                                              className="text-gray-400 hover:text-red-500"
                                            >
                                              <X size={12} />
                                            </button>
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
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
                                          const units = inventoryByProduct[p.id] ?? [];
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
                                <Button variant="primary" className="mt-3" disabled={restockSubmitting} onClick={() => submitRestock(p)}>
                                  {restockSubmitting ? "Adding stock..." : "Add stock"}
                                </Button>
                              </div>
                            ) : (
                              <Button size="sm" onClick={() => openRestock(p)} className="inline-flex items-center gap-1.5">
                                <Plus size={14} />
                                Restock this product
                              </Button>
                            )}

                            <div className="bg-white border border-gray-200 rounded-xl p-4">
                              <div className="flex items-center justify-between mb-3">
                                <h3 className="text-sm font-semibold text-gray-900">Product details</h3>
                                {!isEditingDetails && (
                                  <button
                                    onClick={() => setIsEditingDetails(true)}
                                    className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1"
                                  >
                                    <Pencil size={12} />
                                    Edit
                                  </button>
                                )}
                              </div>

                              {isEditingDetails ? (
                                <>
                                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
                                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer mt-1">
                                    <input
                                      type="checkbox"
                                      checked={editForm.allow_returns}
                                      onChange={(e) => setEditForm((f) => ({ ...f, allow_returns: e.target.checked }))}
                                      className="rounded"
                                    />
                                    Allow returns on this product
                                  </label>
                                  {!editForm.allow_returns && (
                                    <p className="text-xs text-amber-600 -mt-1">
                                      Marked as Final Sale — customers won't see a return option for this item, though an admin can still
                                      force one through with a logged reason.
                                    </p>
                                  )}
                                  {editError && <ErrorText>{editError}</ErrorText>}
                                  {editSuccess && <SuccessText>{editSuccess}</SuccessText>}
                                  <div className="flex gap-2 mt-3">
                                    <Button variant="primary" size="sm" onClick={() => saveEdit(p.id)}>
                                      Save changes
                                    </Button>
                                    <Button size="sm" onClick={() => cancelEdit(p)}>
                                      Cancel
                                    </Button>
                                    <Button variant="danger" size="sm" onClick={() => handleDelete(p.id)}>
                                      Delete product
                                    </Button>
                                  </div>
                                </>
                              ) : (
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
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
