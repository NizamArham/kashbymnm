import { useEffect, useState, Fragment } from "react";
import { Package, ChevronDown, ChevronRight, Plus, X, Pencil, AlertTriangle, MinusCircle } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Product, InventoryUnit, Supplier, RemovalReason } from "../lib/types";
import { compareSizes } from "../lib/sizeSort";
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

export default function ManageProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [inventoryByProduct, setInventoryByProduct] = useState<Record<number, InventoryUnit[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const [editForm, setEditForm] = useState({ product_title: "", brand: "", cost_price: "", selling_price: "" });
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState<string | null>(null);

  const [restockOpenFor, setRestockOpenFor] = useState<number | null>(null);
  const [restockColor, setRestockColor] = useState("");
  const [restockSize, setRestockSize] = useState("");
  const [restockQty, setRestockQty] = useState("1");
  const [restockCost, setRestockCost] = useState("");
  const [restockSellingPrice, setRestockSellingPrice] = useState("");
  const [restockSupplierId, setRestockSupplierId] = useState("");
  const [restockError, setRestockError] = useState<string | null>(null);
  const [restockSuccess, setRestockSuccess] = useState<string | null>(null);
  const [restockSubmitting, setRestockSubmitting] = useState(false);

  // Write-off (remove stock) state, per variant row
  const [removeOpenKey, setRemoveOpenKey] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState<RemovalReason>("Damaged");
  const [removeNote, setRemoveNote] = useState("");
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeSubmitting, setRemoveSubmitting] = useState(false);

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
      cost_price: String(p.cost_price ?? ""),
      selling_price: String(p.selling_price),
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
        cost_price: parseFloat(editForm.cost_price),
        selling_price: parseFloat(editForm.selling_price),
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
    setRestockColor("");
    setRestockSize("");
    setRestockQty("1");
    setRestockCost(String(p.cost_price ?? ""));
    setRestockSellingPrice(String(p.selling_price));
    setRestockSupplierId(p.supplier_id ? String(p.supplier_id) : "");
    setRestockError(null);
    setRestockSuccess(null);
  }

  function cancelEdit(p: Product) {
    setIsEditingDetails(false);
    setEditForm({
      product_title: p.product_title,
      brand: p.brand ?? "",
      cost_price: String(p.cost_price ?? ""),
      selling_price: String(p.selling_price),
    });
    setEditError(null);
    setEditSuccess(null);
  }

  async function submitRestock(p: Product) {
    setRestockError(null);
    setRestockSuccess(null);

    const qty = parseInt(restockQty, 10);
    if (!qty || qty <= 0) {
      setRestockError("Enter a quantity greater than 0");
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
        items: [
          {
            product_id: p.id,
            quantity: qty,
            unit_cost: parseFloat(restockCost),
            unit_selling_price: parseFloat(restockSellingPrice),
            size: restockSize || undefined,
            color: restockColor || undefined,
          },
        ],
        amount_paid: 0,
      });

      setRestockSuccess(`Added ${result.new_inventory_ids.length} unit(s) (${result.purchase_code}).`);
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
                                          <tr key={rowKey} className={removeOpenKey === rowKey ? "bg-red-50/40" : ""}>
                                            <td className="px-3 py-1.5">{row.color}</td>
                                            <td className="px-3 py-1.5 font-medium">{row.size}</td>
                                            <td className="px-3 py-1.5">{row.count}</td>
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
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                  <FormGroup>
                                    <Label>Color</Label>
                                    <Input value={restockColor} onChange={(e) => setRestockColor(e.target.value)} placeholder="e.g. Black" />
                                  </FormGroup>
                                  <FormGroup>
                                    <Label>Size</Label>
                                    <Input value={restockSize} onChange={(e) => setRestockSize(e.target.value)} placeholder="e.g. M" />
                                  </FormGroup>
                                  <FormGroup>
                                    <Label>Quantity</Label>
                                    <Input
                                      type="number"
                                      min="1"
                                      value={restockQty}
                                      onChange={(e) => setRestockQty(e.target.value.replace(/[^0-9]/g, ""))}
                                    />
                                  </FormGroup>
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
                                  Older stock keeps its own cost/price — this only applies to the new units you're adding now.
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
                                    <p className="text-xs text-gray-400">Cost price</p>
                                    <p className="text-gray-900">Rs. {p.cost_price?.toLocaleString() ?? "—"}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-gray-400">Selling price</p>
                                    <p className="text-gray-900">Rs. {p.selling_price.toLocaleString()}</p>
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
