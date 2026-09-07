import { useEffect, useState, useMemo, FormEvent } from "react";
import { X, Plus, Wand2, AlertTriangle, Package, Tag, Building2, Layers, Ruler, Palette, DollarSign, Users, Hash, Calendar, Boxes } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Supplier, Product } from "../lib/types";
import { mainCategories, categoryStructure, genderOptions } from "../lib/categories";
import { PageHeader, Card, Input, Label, FormGroup, ErrorText, SuccessText, Button, Dropdown, TabToggle, NewSupplierModal } from "../components/ui";

interface VariantRow {
  size: string;
  color: string;
  quantity: string;
}

export default function AddProductPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  // "new" creates a brand-new product; "existing" adds more variants (with
  // their own cost/selling price for this batch) onto a product that
  // already exists, instead of accidentally creating a duplicate.
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [existingProductId, setExistingProductId] = useState("");

  // Warns if a NEW product's title matches one that already exists,
  // checked against the backend so casing/whitespace differences are
  // caught the same way the database would treat them as equal.
  const [duplicateWarning, setDuplicateWarning] = useState<{ id: number; title: string } | null>(null);

  const [showNewSupplierModal, setShowNewSupplierModal] = useState(false);

  const [form, setForm] = useState({
    product_title: "",
    brand: "",
    category: "",
    subCategory: "",
    gender: "",
    cost_price: "",
    selling_price: "",
    supplier_id: "",
  });

  const [colors, setColors] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [colorInput, setColorInput] = useState("");
  const [sizeInput, setSizeInput] = useState("");

  const [variantRows, setVariantRows] = useState<VariantRow[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get<Supplier[]>("/suppliers").then(setSuppliers).catch(() => {});
    api.get<Product[]>("/products").then(setProducts).catch(() => {});
  }, []);

  // Check for a duplicate title shortly after typing stops, so Add Product
  // can point toward "existing product" mode instead of silently creating
  // a second, separate product row with the same name.
  useEffect(() => {
    if (mode !== "new" || !form.product_title.trim()) {
      setDuplicateWarning(null);
      return;
    }
    const timeout = setTimeout(async () => {
      try {
        const result = await api.get<{ exists: boolean; product: { id: number; product_title: string } | null }>(
          `/products/check-title?title=${encodeURIComponent(form.product_title.trim())}`
        );
        setDuplicateWarning(result.exists && result.product ? result.product : null);
      } catch {
        // non-critical check — ignore failures silently
      }
    }, 400);
    return () => clearTimeout(timeout);
  }, [form.product_title, mode]);

  useEffect(() => {
    setVariantRows((prevRows) => {
      const bySizeColor = new Map(prevRows.map((r) => [`${r.size}|${r.color}`, r.quantity]));
      if (colors.length === 0 && sizes.length === 0) return [];

      const colorList = colors.length > 0 ? colors : [""];
      const sizeList = sizes.length > 0 ? sizes : [""];
      const next: VariantRow[] = [];
      for (const color of colorList) {
        for (const size of sizeList) {
          next.push({ size, color, quantity: bySizeColor.get(`${size}|${color}`) ?? "" });
        }
      }
      return next;
    });
  }, [colors, sizes]);

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function addColor() {
    const value = colorInput.trim();
    if (!value || colors.includes(value)) {
      setColorInput("");
      return;
    }
    setColors((c) => [...c, value]);
    setColorInput("");
  }

  function addSize() {
    const value = sizeInput.trim().toUpperCase();
    if (!value || sizes.includes(value)) {
      setSizeInput("");
      return;
    }
    setSizes((s) => [...s, value]);
    setSizeInput("");
  }

  function removeColor(value: string) {
    setColors((c) => c.filter((v) => v !== value));
  }

  function removeSize(value: string) {
    setSizes((s) => s.filter((v) => v !== value));
  }

  function updateQuantity(index: number, quantity: string) {
    const numeric = quantity.replace(/[^0-9]/g, "");
    setVariantRows((rows) => rows.map((r, i) => (i === index ? { ...r, quantity: numeric } : r)));
  }

  function fillAllQuantities(value: string) {
    setVariantRows((rows) => rows.map((r) => ({ ...r, quantity: value })));
  }

  const totalUnits = useMemo(
    () => variantRows.reduce((sum, r) => sum + (parseInt(r.quantity, 10) || 0), 0),
    [variantRows]
  );

  const availableSubCategories = form.category ? categoryStructure[form.category] ?? [] : [];

  function selectExistingProduct(id: string) {
    setExistingProductId(id);
    const product = products.find((p) => String(p.id) === id);
    if (product) {
      setForm((f) => ({
        ...f,
        cost_price: String(product.cost_price ?? ""),
        selling_price: String(product.selling_price),
        supplier_id: product.supplier_id ? String(product.supplier_id) : f.supplier_id,
      }));
    }
  }

  // Preview data
  const existingProduct = products.find((p) => String(p.id) === existingProductId);
  const previewTitle = mode === "existing" 
    ? existingProduct?.product_title || "—" 
    : form.product_title || "—";
  const previewBrand = form.brand || "—";
  const previewCategory = form.category ? `${form.category}${form.subCategory ? ` / ${form.subCategory}` : ""}` : "—";
  const previewGender = form.gender || "—";
  const previewSupplier = suppliers.find((s) => String(s.id) === form.supplier_id)?.name || "—";
  const previewCostPrice = form.cost_price ? `Rs. ${parseFloat(form.cost_price).toLocaleString()}` : "—";
  const previewSellingPrice = form.selling_price ? `Rs. ${parseFloat(form.selling_price).toLocaleString()}` : "—";
  const previewColors = colors.length > 0 ? colors.join(", ") : "—";
  const previewSizes = sizes.length > 0 ? sizes.join(", ") : "—";
  const previewVariants = variantRows.length > 0 ? variantRows.length : "—";
  const previewTotalUnits = totalUnits || 0;
  const previewCostValue = form.cost_price && totalUnits > 0 ? `Rs. ${(totalUnits * parseFloat(form.cost_price)).toLocaleString()}` : "—";
  const previewRetailValue = form.selling_price && totalUnits > 0 ? `Rs. ${(totalUnits * parseFloat(form.selling_price)).toLocaleString()}` : "—";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (mode === "new" && !form.product_title.trim()) {
      setError("Product title is required");
      return;
    }
    if (mode === "existing" && !existingProductId) {
      setError("Select which existing product to restock");
      return;
    }
    if (!form.cost_price || !form.selling_price) {
      setError("Cost price and selling price are required");
      return;
    }
    if (!form.supplier_id) {
      setError("Select a supplier — stock is received against a supplier for cost tracking");
      return;
    }
    const rowsWithQty = variantRows.filter((r) => parseInt(r.quantity, 10) > 0);
    if (rowsWithQty.length === 0) {
      setError("Add at least one color/size with a quantity greater than 0");
      return;
    }

    setSubmitting(true);
    try {
      let productId: number;

      if (mode === "existing") {
        productId = parseInt(existingProductId, 10);
      } else {
        const categoryParts = [form.category, form.subCategory].filter(Boolean).join(" / ");
        const genderSuffix = form.gender ? ` (${form.gender})` : "";

        const product = await api.post<{ id: number }>("/products", {
          product_title: form.product_title.trim(),
          brand: form.brand.trim() || undefined,
          category: (categoryParts + genderSuffix).trim() || undefined,
          cost_price: parseFloat(form.cost_price),
          selling_price: parseFloat(form.selling_price),
          supplier_id: parseInt(form.supplier_id, 10),
        });
        productId = product.id;
      }

      const result = await api.post<{ purchase_code: string; new_inventory_ids: number[] }>("/purchases", {
        supplier_id: parseInt(form.supplier_id, 10),
        items: rowsWithQty.map((row) => ({
          product_id: productId,
          quantity: parseInt(row.quantity, 10),
          unit_cost: parseFloat(form.cost_price),
          unit_selling_price: parseFloat(form.selling_price),
          size: row.size || undefined,
          color: row.color || undefined,
        })),
        amount_paid: 0,
      });

      setSuccess(
        `${mode === "existing" ? "Restocked" : "Product added"} with ${result.new_inventory_ids.length} unit(s) across ${rowsWithQty.length} variant(s) (${result.purchase_code}).`
      );
      setForm({ product_title: "", brand: "", category: "", subCategory: "", gender: "", cost_price: "", selling_price: "", supplier_id: "" });
      setColors([]);
      setSizes([]);
      setVariantRows([]);
      setExistingProductId("");
      setDuplicateWarning(null);
      api.get<Product[]>("/products").then(setProducts).catch(() => {});
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to add product");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Add Product"
        subtitle="Set up the style, then add its color/size variants — stock is created automatically."
        action={
          <TabToggle
            value={mode}
            onChange={(v) => {
              setMode(v);
              setDuplicateWarning(null);
            }}
            options={[
              { value: "new", label: "New product" },
              { value: "existing", label: "Add to existing" },
            ]}
          />
        }
      />

      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-5">
          {/* LEFT: Form */}
          <div className="space-y-5">
            <Card>
              <h2 className="text-base font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Package size={16} className="text-gray-600" />
                {mode === "existing" ? "Which product is this restocking?" : "Product Information"}
              </h2>

              {mode === "existing" ? (
                <FormGroup>
                  <Label>Existing product</Label>
                  <Dropdown
                    value={existingProductId}
                    onChange={selectExistingProduct}
                    placeholder="— Search and select product —"
                    searchable
                    options={products.map((p) => ({ value: String(p.id), label: p.product_title, sublabel: p.brand ?? undefined }))}
                  />
                </FormGroup>
              ) : (
                <>
                  <FormGroup>
                    <Label>Product title</Label>
                    <Input value={form.product_title} onChange={(e) => update("product_title", e.target.value)} placeholder="e.g. Classic Denim Jacket" />
                    {duplicateWarning && (
                      <div className="mt-2 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                        <AlertTriangle size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
                        <p className="text-xs text-amber-800">
                          "{duplicateWarning.title}" already exists. Consider switching to{" "}
                          <button
                            type="button"
                            onClick={() => {
                              setMode("existing");
                              setExistingProductId(String(duplicateWarning.id));
                              setDuplicateWarning(null);
                            }}
                            className="underline font-medium"
                          >
                            Add to existing
                          </button>{" "}
                          instead, to avoid a duplicate.
                        </p>
                      </div>
                    )}
                  </FormGroup>

                  <div className="grid grid-cols-2 gap-3">
                    <FormGroup>
                      <Label>Brand</Label>
                      <Input value={form.brand} onChange={(e) => update("brand", e.target.value)} />
                    </FormGroup>
                    <FormGroup>
                      <Label>Gender</Label>
                      <Dropdown
                        value={form.gender}
                        onChange={(v) => update("gender", v)}
                        placeholder="— Select gender —"
                        options={genderOptions.map((g) => ({ value: g, label: g }))}
                      />
                    </FormGroup>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <FormGroup>
                      <Label>Category</Label>
                      <Dropdown
                        value={form.category}
                        onChange={(v) => {
                          update("category", v);
                          update("subCategory", "");
                        }}
                        placeholder="— Select category —"
                        options={mainCategories.map((c) => ({ value: c, label: c }))}
                      />
                    </FormGroup>
                    <FormGroup>
                      <Label>Sub-category</Label>
                      <Dropdown
                        value={form.subCategory}
                        onChange={(v) => update("subCategory", v)}
                        placeholder={form.category ? "— Select sub-category —" : "Pick a category first"}
                        disabled={!form.category}
                        options={availableSubCategories.map((s) => ({ value: s, label: s }))}
                      />
                    </FormGroup>
                  </div>
                </>
              )}

              <div className="grid grid-cols-2 gap-3">
                <FormGroup>
                  <Label>Cost price for this batch (Rs.)</Label>
                  <Input type="number" min="0" step="0.01" value={form.cost_price} onChange={(e) => update("cost_price", e.target.value)} />
                  {mode === "existing" && <p className="text-xs text-gray-400 mt-1">Can differ from this product's previous cost.</p>}
                </FormGroup>
                <FormGroup>
                  <Label>Selling price for this batch (Rs.)</Label>
                  <Input type="number" min="0" step="0.01" value={form.selling_price} onChange={(e) => update("selling_price", e.target.value)} />
                  {mode === "existing" && <p className="text-xs text-gray-400 mt-1">Older stock keeps its own price; only new units use this.</p>}
                </FormGroup>
              </div>

              <FormGroup>
                <Label>Supplier</Label>
                <Dropdown
                  value={form.supplier_id}
                  onChange={(v) => update("supplier_id", v)}
                  placeholder="— Select supplier —"
                  searchable
                  onCreateNew={() => setShowNewSupplierModal(true)}
                  createNewLabel="+ New supplier"
                  options={suppliers.map((s) => ({ value: String(s.id), label: s.name, sublabel: s.supplier_code }))}
                />
              </FormGroup>
            </Card>

            <Card>
              <h2 className="text-base font-semibold text-gray-900 mb-1 flex items-center gap-2">
                <Layers size={16} className="text-gray-600" />
                Variants
              </h2>
              <p className="text-xs text-gray-400 mb-4">Add colors and sizes — every combination becomes a row below where you set quantity.</p>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Colors</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="e.g. Black, Navy"
                      value={colorInput}
                      onChange={(e) => setColorInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addColor())}
                    />
                    <button type="button" onClick={addColor} className="px-3.5 py-2.5 bg-black text-white rounded-xl text-sm flex items-center gap-1 hover:bg-gray-800">
                      <Plus size={14} />
                      Add
                    </button>
                  </div>
                  {colors.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {colors.map((c) => (
                        <span key={c} className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-100 border border-gray-200 rounded-full text-xs">
                          {c}
                          <button type="button" onClick={() => removeColor(c)} className="text-gray-400 hover:text-red-500">
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <Label>Sizes</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="e.g. S, M, L"
                      value={sizeInput}
                      onChange={(e) => setSizeInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addSize())}
                    />
                    <button type="button" onClick={addSize} className="px-3.5 py-2.5 bg-black text-white rounded-xl text-sm flex items-center gap-1 hover:bg-gray-800">
                      <Plus size={14} />
                      Add
                    </button>
                  </div>
                  {sizes.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {sizes.map((s) => (
                        <span key={s} className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-100 border border-gray-200 rounded-full text-xs font-medium">
                          {s}
                          <button type="button" onClick={() => removeSize(s)} className="text-gray-400 hover:text-red-500">
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {variantRows.length > 0 && (
                <div className="mt-5 border-t border-gray-100 pt-4">
                  <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                    <p className="text-sm text-gray-600">
                      <span className="font-medium">{variantRows.length}</span> variant{variantRows.length === 1 ? "" : "s"} — set a quantity for each
                    </p>
                    <button
                      type="button"
                      onClick={() => fillAllQuantities("1")}
                      className="text-xs text-gray-500 hover:text-gray-800 flex items-center gap-1 border border-gray-200 rounded-lg px-2.5 py-1.5"
                    >
                      <Wand2 size={13} />
                      Set all to 1
                    </button>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr>
                          <th className="text-left px-3 py-2 text-xs font-medium text-gray-400 border-b border-gray-100">
                            <Palette size={12} className="inline mr-1" /> Color
                          </th>
                          <th className="text-left px-3 py-2 text-xs font-medium text-gray-400 border-b border-gray-100">
                            <Ruler size={12} className="inline mr-1" /> Size
                          </th>
                          <th className="text-left px-3 py-2 text-xs font-medium text-gray-400 border-b border-gray-100">
                            <Hash size={12} className="inline mr-1" /> Quantity
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {variantRows.map((row, i) => (
                          <tr key={`${row.color}-${row.size}`}>
                            <td className="px-3 py-2 border-b border-gray-50">{row.color || "—"}</td>
                            <td className="px-3 py-2 border-b border-gray-50 font-medium">{row.size || "—"}</td>
                            <td className="px-3 py-2 border-b border-gray-50">
                              <input
                                type="text"
                                inputMode="numeric"
                                value={row.quantity}
                                onChange={(e) => updateQuantity(i, e.target.value)}
                                placeholder="0"
                                className="w-20 px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-gray-400 mt-2">Barcodes are generated automatically when you save.</p>
                </div>
              )}
            </Card>

            {error && <ErrorText>{error}</ErrorText>}
            {success && <SuccessText>{success}</SuccessText>}

            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Saving..." : "Save product and create stock"}
            </Button>
          </div>

          {/* RIGHT: Preview */}
          <div className="space-y-5">
            <Card className="sticky top-6">
              <h2 className="text-base font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Package size={18} className="text-gray-600" />
                Product Preview
              </h2>

              {/* Product Header */}
              <div className="mb-4 pb-4 border-b border-gray-100">
                <p className="font-semibold text-gray-900 text-lg">{previewTitle}</p>
                <div className="flex items-center gap-2 mt-1">
                  <Tag size={14} className="text-gray-400" />
                  <span className="text-xs text-gray-500">{mode === "existing" ? "Restocking existing" : "New product"}</span>
                </div>
              </div>

              {/* Product Details */}
              <div className="space-y-2 mb-4 pb-4 border-b border-gray-100">
                <div className="flex items-center gap-2 text-sm">
                  <Building2 size={14} className="text-gray-400 flex-shrink-0" />
                  <span className="text-gray-700">Brand: <span className="font-medium">{previewBrand}</span></span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Layers size={14} className="text-gray-400 flex-shrink-0" />
                  <span className="text-gray-700">Category: <span className="font-medium">{previewCategory}</span></span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Users size={14} className="text-gray-400 flex-shrink-0" />
                  <span className="text-gray-700">Gender: <span className="font-medium">{previewGender}</span></span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Building2 size={14} className="text-gray-400 flex-shrink-0" />
                  <span className="text-gray-700">Supplier: <span className="font-medium">{previewSupplier}</span></span>
                </div>
              </div>

              {/* Pricing */}
              <div className="space-y-2 mb-4 pb-4 border-b border-gray-100">
                <div className="flex items-center gap-2 text-sm">
                  <DollarSign size={14} className="text-gray-400 flex-shrink-0" />
                  <span className="text-gray-700">Cost Price: <span className="font-medium text-gray-900">{previewCostPrice}</span></span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <DollarSign size={14} className="text-gray-400 flex-shrink-0" />
                  <span className="text-gray-700">Selling Price: <span className="font-medium text-green-600">{previewSellingPrice}</span></span>
                </div>
              </div>

              {/* Variants Summary */}
              <div className="space-y-2 mb-4 pb-4 border-b border-gray-100">
                <div className="flex items-center gap-2 text-sm">
                  <Palette size={14} className="text-gray-400 flex-shrink-0" />
                  <span className="text-gray-700">Colors: <span className="font-medium">{previewColors}</span></span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Ruler size={14} className="text-gray-400 flex-shrink-0" />
                  <span className="text-gray-700">Sizes: <span className="font-medium">{previewSizes}</span></span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Boxes size={14} className="text-gray-400 flex-shrink-0" />
                  <span className="text-gray-700">Variants: <span className="font-medium">{previewVariants}</span></span>
                </div>
              </div>

              {/* Totals */}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <div className="bg-gray-50 rounded-lg px-3 py-2 text-center">
                  <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">Total Units</p>
                  <p className="text-lg font-bold text-gray-900">{previewTotalUnits}</p>
                </div>
                <div className="bg-gray-50 rounded-lg px-3 py-2 text-center">
                  <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">Cost Value</p>
                  <p className="text-sm font-bold text-gray-900">{previewCostValue}</p>
                </div>
                <div className="bg-gray-50 rounded-lg px-3 py-2 text-center col-span-2">
                  <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">Retail Value</p>
                  <p className="text-sm font-bold text-green-600">{previewRetailValue}</p>
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-gray-100">
                <p className="text-[10px] text-gray-400 text-center">
                  Preview updates as you type
                </p>
              </div>
            </Card>
          </div>
        </div>
      </form>

      {showNewSupplierModal && (
        <NewSupplierModal
          onClose={() => setShowNewSupplierModal(false)}
          onCreated={(supplier) => {
            setSuppliers((prev) => [...prev, supplier as any]);
            update("supplier_id", String(supplier.id));
            setShowNewSupplierModal(false);
          }}
        />
      )}
    </div>
  );
}