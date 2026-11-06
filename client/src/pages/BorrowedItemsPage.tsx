import { useEffect, useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { useAdminApproval } from "../components/AdminApproval";
import { Button, Dropdown, ErrorText, FormGroup, Input, Label } from "../components/ui";

// Pieces sold at the till that weren't in stock. Each one stays here until it's settled at end of day:
// paid to its supplier, or returned to them. Nothing has to be closed before the day ends.
interface OpenItem {
  id: number;
  sku: string;
  size: string | null;
  color: string | null;
  status: string;
  cost_price: number | null;
  selling_price: number | null;
  product_title: string;
  purchase_code: string;
  supplier_name: string;
  invoice: string | null;
  sale_date: string | null;
}

type Pending = { id: number; kind: "paid" | "returned" } | null;

export default function BorrowedItemsPage() {
  const { runWithApproval } = useAdminApproval();
  const [items, setItems] = useState<OpenItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [method, setMethod] = useState<"cash" | "card">("cash");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);

  async function load() {
    try {
      setItems(await api.get<OpenItem[]>("/manual-items/open"));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : "Couldn't load the list");
    }
  }

  useEffect(() => {
    load();
  }, []);

  function start(id: number, kind: "paid" | "returned") {
    setPending({ id, kind });
    setMethod("cash");
    setNote("");
    setSettleError(null);
  }

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setSettleError(null);
    try {
      await runWithApproval((approval) =>
        api.post(
          `/manual-items/${pending.id}/settle`,
          {
            resolution: pending.kind,
            payment_method: pending.kind === "paid" ? method : undefined,
            note: note.trim() || undefined,
          },
          { approval }
        )
      );
      setPending(null);
      await load();
    } catch (err) {
      setSettleError(err instanceof ApiRequestError ? err.message : "Couldn't save that — try again");
    } finally {
      setBusy(false);
    }
  }

  const money = (n: number | null) => `Rs. ${(n ?? 0).toLocaleString()}`;

  return (
    <div className="p-4 lg:p-6 max-w-5xl">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-gray-900">Not-in-stock items</h1>
        <p className="text-sm text-gray-500 mt-1">
          Pieces sold before they were in stock. Settle each one at end of day: pay the supplier, or return the piece to them.
        </p>
      </div>

      {loadError && <ErrorText>{loadError}</ErrorText>}

      {items && items.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-8 text-center text-sm text-gray-500">
          Nothing open — every not-in-stock piece is settled.
        </div>
      )}

      {items && items.length > 0 && (
        <div className="space-y-2">
          {items.map((item) => {
            const isPending = pending?.id === item.id;
            return (
              <div key={item.id} className="bg-white border border-gray-200 rounded-xl p-4">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 text-sm">{item.product_title}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {[item.color, item.size].filter(Boolean).join(" / ") || "—"} · {item.sku}
                      {item.invoice ? ` · sold on ${item.invoice}` : ""}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      From {item.supplier_name} · {item.purchase_code} · cost {money(item.cost_price)} · sold for {money(item.selling_price)}
                      {item.status === "removed" ? " · back from the customer" : ""}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => start(item.id, "paid")}
                      className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm hover:bg-gray-50"
                    >
                      Paid to supplier
                    </button>
                    {item.status === "removed" && (
                      <button
                        type="button"
                        onClick={() => start(item.id, "returned")}
                        className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm hover:bg-gray-50"
                      >
                        Returned to supplier
                      </button>
                    )}
                  </div>
                </div>

                {isPending && (
                  <div className="mt-4 pt-4 border-t border-gray-100 space-y-3">
                    {pending.kind === "paid" && (
                      <FormGroup>
                        <Label>How was the supplier paid?</Label>
                        <Dropdown
                          value={method}
                          onChange={(v) => setMethod(v as "cash" | "card")}
                          options={[
                            { value: "cash", label: "Cash" },
                            { value: "card", label: "Card" },
                          ]}
                        />
                      </FormGroup>
                    )}
                    <FormGroup>
                      <Label>Note (optional)</Label>
                      <Input value={note} onChange={(e) => setNote(e.target.value)} />
                    </FormGroup>
                    {settleError && <ErrorText>{settleError}</ErrorText>}
                    <div className="flex gap-2 justify-end">
                      <Button onClick={() => setPending(null)}>Cancel</Button>
                      <Button variant="primary" onClick={confirm} disabled={busy}>
                        {busy ? "Saving..." : pending.kind === "paid" ? "Record payment" : "Record return"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
