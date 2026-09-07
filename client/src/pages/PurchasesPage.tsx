import { useEffect, useState, FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Supplier, Product } from "../lib/types";
import { PageHeader, Card, Input, Select, Label, FormGroup, ErrorText, SuccessText, Button, Table, Th, Td } from "../components/ui";

interface PurchaseLine {
  product_id: number;
  product_title: string;
  quantity: number;
  unit_cost: number;
}

export default function PurchasesPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [lines, setLines] = useState<PurchaseLine[]>([]);
  const [productToAdd, setProductToAdd] = useState("");
  const [qtyToAdd, setQtyToAdd] = useState("1");
  const [costToAdd, setCostToAdd] = useState("");
  const [amountPaid, setAmountPaid] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get<Supplier[]>("/suppliers").then(setSuppliers).catch(() => {});
    api.get<Product[]>("/products").then(setProducts).catch(() => {});
  }, []);

  function addLine() {
    const product = products.find((p) => p.id === Number(productToAdd));
    if (!product || !qtyToAdd || !costToAdd) return;
    setLines((l) => [...l, { product_id: product.id, product_title: product.product_title, quantity: parseInt(qtyToAdd, 10), unit_cost: parseFloat(costToAdd) }]);
    setProductToAdd("");
    setQtyToAdd("1");
    setCostToAdd("");
  }

  function removeLine(index: number) {
    setLines((l) => l.filter((_, i) => i !== index));
  }

  const totalCost = lines.reduce((sum, l) => sum + l.quantity * l.unit_cost, 0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!supplierId) {
      setError("Select a supplier");
      return;
    }
    if (lines.length === 0) {
      setError("Add at least one item");
      return;
    }

    setSubmitting(true);
    try {
      const result = await api.post<{ purchase_code: string; new_inventory_ids: number[] }>("/purchases", {
        supplier_id: parseInt(supplierId, 10),
        items: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity, unit_cost: l.unit_cost })),
        amount_paid: parseFloat(amountPaid) || 0,
      });
      setSuccess(`Purchase ${result.purchase_code} recorded. ${result.new_inventory_ids.length} new inventory unit(s) created — assign size/color/barcode under Inventory.`);
      setLines([]);
      setSupplierId("");
      setAmountPaid("");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to record purchase");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader title="Purchases" subtitle="Recording a purchase creates new inventory units automatically." />

      <Card>
        <form onSubmit={handleSubmit}>
          <FormGroup>
            <Label>Supplier</Label>
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">— Select supplier —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.supplier_code})
                </option>
              ))}
            </Select>
          </FormGroup>

          <h3 className="text-sm font-semibold text-gray-900 mt-4 mb-2">Items</h3>
          <div className="flex gap-2 items-end flex-wrap">
            <div className="flex-[2] min-w-[160px]">
              <Label>Product</Label>
              <Select value={productToAdd} onChange={(e) => setProductToAdd(e.target.value)}>
                <option value="">— Select —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.product_title}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-24">
              <Label>Qty</Label>
              <Input type="number" min="1" value={qtyToAdd} onChange={(e) => setQtyToAdd(e.target.value)} />
            </div>
            <div className="w-32">
              <Label>Unit cost</Label>
              <Input type="number" min="0" value={costToAdd} onChange={(e) => setCostToAdd(e.target.value)} />
            </div>
            <Button type="button" onClick={addLine} className="mb-0.5">
              Add item
            </Button>
          </div>

          {lines.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <Th>Product</Th>
                  <Th>Qty</Th>
                  <Th>Unit cost</Th>
                  <Th>Line total</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <Td>{l.product_title}</Td>
                    <Td>{l.quantity}</Td>
                    <Td>Rs. {l.unit_cost.toLocaleString()}</Td>
                    <Td>Rs. {(l.quantity * l.unit_cost).toLocaleString()}</Td>
                    <Td>
                      <button type="button" onClick={() => removeLine(i)} className="text-red-400 hover:text-red-600">
                        <Trash2 size={16} />
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}

          <div className="max-w-[220px] mt-4">
            <Label>Amount paid now (Rs.)</Label>
            <Input type="number" min="0" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} />
          </div>

          <div className="flex justify-between font-semibold max-w-[300px] mt-3 text-sm">
            <span>Total cost</span>
            <span>Rs. {totalCost.toLocaleString()}</span>
          </div>

          {error && <ErrorText>{error}</ErrorText>}
          {success && <SuccessText>{success}</SuccessText>}

          <Button type="submit" variant="primary" disabled={submitting} className="mt-3">
            {submitting ? "Recording..." : "Record purchase"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
