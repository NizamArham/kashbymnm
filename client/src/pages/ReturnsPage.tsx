import { useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { Sale, InventoryUnit, ReturnRecord } from "../lib/types";
import { PageHeader, Card, Input, Select, Label, FormGroup, ErrorText, SuccessText, Button, Table, Th, Td } from "../components/ui";

export default function ReturnsPage() {
  const [invoiceQuery, setInvoiceQuery] = useState("");
  const [sale, setSale] = useState<Sale | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [condition, setCondition] = useState<"clean" | "damaged">("clean");
  const [resolution, setResolution] = useState<"refund" | "exchange">("refund");
  const [reason, setReason] = useState("");
  const [exchangeSku, setExchangeSku] = useState("");

  const [recentReturns, setRecentReturns] = useState<ReturnRecord[]>([]);
  const [processError, setProcessError] = useState<string | null>(null);
  const [processSuccess, setProcessSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleLookup() {
    setLookupError(null);
    setSale(null);
    const value = invoiceQuery.trim();
    if (!value) return;

    try {
      const all = await api.get<Sale[]>("/sales");
      const match = all.find((s) => s.invoice.toLowerCase() === value.toLowerCase());
      if (!match) {
        setLookupError("No sale found with that invoice number");
        return;
      }
      setSale(await api.get<Sale>(`/sales/${match.id}`));
    } catch (err) {
      setLookupError(err instanceof ApiRequestError ? err.message : "Lookup failed");
    }
  }

  async function handleProcessReturn() {
    setProcessError(null);
    setProcessSuccess(null);

    if (!selectedItemId) {
      setProcessError("Select which item is being returned");
      return;
    }

    let exchange_inventory_id: number | undefined;
    if (resolution === "exchange") {
      if (!exchangeSku.trim()) {
        setProcessError("Enter the SKU of the replacement item for an exchange");
        return;
      }
      try {
        const all = await api.get<InventoryUnit[]>("/inventory?status=available");
        const match = all.find((u) => u.sku.toLowerCase() === exchangeSku.trim().toLowerCase());
        if (!match) {
          setProcessError("No available item found with that SKU for the exchange");
          return;
        }
        exchange_inventory_id = match.id;
      } catch (err) {
        setProcessError(err instanceof ApiRequestError ? err.message : "Failed to look up exchange item");
        return;
      }
    }

    setSubmitting(true);
    try {
      const result = await api.post<ReturnRecord>("/returns", {
        sale_item_id: selectedItemId,
        condition,
        resolution,
        reason: reason.trim() || undefined,
        exchange_inventory_id,
      });
      setRecentReturns((r) => [result, ...r]);
      setProcessSuccess(
        resolution === "refund"
          ? `Return processed. Refund of Rs. ${result.refund_amount.toLocaleString()} logged to cash book.`
          : "Return processed and exchange completed."
      );
      setSale(null);
      setInvoiceQuery("");
      setSelectedItemId(null);
      setReason("");
      setExchangeSku("");
    } catch (err) {
      setProcessError(err instanceof ApiRequestError ? err.message : "Failed to process return");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader title="Returns" subtitle="Look up a sale by invoice number to process a return." />

      <Card className="mb-5">
        <div className="flex gap-2">
          <Input
            placeholder="Invoice number, e.g. INV-0001"
            value={invoiceQuery}
            onChange={(e) => setInvoiceQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLookup()}
          />
          <Button variant="primary" onClick={handleLookup}>
            Find sale
          </Button>
        </div>
        {lookupError && <ErrorText>{lookupError}</ErrorText>}
      </Card>

      {sale && (
        <Card className="mb-5">
          <h2 className="text-base font-semibold text-gray-900 mb-3">
            {sale.invoice} — {sale.customer_name ?? "Walk-in"}
          </h2>

          <FormGroup>
            <Label>Which item is being returned?</Label>
            <Select value={selectedItemId ?? ""} onChange={(e) => setSelectedItemId(Number(e.target.value))}>
              <option value="">— Select item —</option>
              {sale.items?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.product_title} ({item.sku}) — Rs. {item.unit_price.toLocaleString()}
                </option>
              ))}
            </Select>
          </FormGroup>

          <div className="grid grid-cols-2 gap-3">
            <FormGroup>
              <Label>Condition</Label>
              <Select value={condition} onChange={(e) => setCondition(e.target.value as "clean" | "damaged")}>
                <option value="clean">Clean — resellable</option>
                <option value="damaged">Damaged — write-off</option>
              </Select>
            </FormGroup>
            <FormGroup>
              <Label>Resolution</Label>
              <Select value={resolution} onChange={(e) => setResolution(e.target.value as "refund" | "exchange")}>
                <option value="refund">Cash refund</option>
                <option value="exchange">Exchange for another item</option>
              </Select>
            </FormGroup>
          </div>

          {resolution === "exchange" && (
            <FormGroup>
              <Label>Replacement item SKU</Label>
              <Input placeholder="SKU of the item going out instead" value={exchangeSku} onChange={(e) => setExchangeSku(e.target.value)} />
            </FormGroup>
          )}

          <FormGroup>
            <Label>Reason (optional)</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormGroup>

          {processError && <ErrorText>{processError}</ErrorText>}
          {processSuccess && <SuccessText>{processSuccess}</SuccessText>}

          <Button variant="primary" onClick={handleProcessReturn} disabled={submitting} className="mt-2">
            {submitting ? "Processing..." : "Process return"}
          </Button>
        </Card>
      )}

      {recentReturns.length > 0 && (
        <Card>
          <h2 className="text-base font-semibold text-gray-900 mb-3">Processed this session</h2>
          <Table>
            <thead>
              <tr>
                <Th>Condition</Th>
                <Th>Resolution</Th>
                <Th>Refund amount</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody>
              {recentReturns.map((r) => (
                <tr key={r.id}>
                  <Td className="capitalize">{r.condition}</Td>
                  <Td className="capitalize">{r.resolution}</Td>
                  <Td>{r.refund_amount > 0 ? `Rs. ${r.refund_amount.toLocaleString()}` : "—"}</Td>
                  <Td>{r.reason ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
