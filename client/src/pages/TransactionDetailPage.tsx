import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageLoader } from "../components/Loader";
import { api, ApiRequestError } from "../lib/api";
import { Card, PageHeader, Badge, ErrorText, RefLink, Button } from "../components/ui";
import { formatDateTime } from "../lib/dates";

interface TransactionDetail {
  id: number;
  transaction_code: string;
  entry_date: string;
  type: "income" | "expense";
  category: string;
  payment_method: string | null;
  reference_id: number | null;
  amount: number;
  notes: string | null;
  // Who it was paid to (or received from) and what it was against, traced from what the cash book points at.
  party: { kind: "supplier" | "customer" | "courier"; id: number | null; name: string; code: string | null } | null;
  purchase: { id: number; purchase_code: string } | null;
  sale: { id: number; invoice: string } | null;
  // The cash book's running balance right after this entry.
  balance_after: number;
}

const words = (s: string | null) => (s ? s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—");
const money = (n: number) => `Rs. ${n.toLocaleString()}`;

// One cash book transaction on a page of its own: how much, when, how it was paid, who the money went to or came from, which purchase or
// invoice it was against, the note on it, and where the cash book stood right after it.
export default function TransactionDetailPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [tx, setTx] = useState<TransactionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    setTx(null);
    setError(null);
    api
      .get<TransactionDetail>(`/cash-book/by-code/${encodeURIComponent(code)}`)
      .then((t) => {
        if (!cancelled) setTx(t);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiRequestError ? err.message : "Couldn't load this transaction");
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const out = tx?.type === "expense";
  const partyTo = (p: NonNullable<TransactionDetail["party"]>) => (p.kind === "supplier" ? `/suppliers/${p.id}` : p.kind === "customer" ? `/customers/${p.id}` : "/couriers");

  return (
    <div>
      <button onClick={() => navigate(-1)} className="mb-3 inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft size={14} />
        Back
      </button>

      <PageHeader
        title={tx?.transaction_code ?? code ?? "Transaction"}
        subtitle={tx ? `${out ? "Money out" : "Money in"} · ${formatDateTime(tx.entry_date)}` : undefined}
        action={
          tx && (
            <div className="flex flex-wrap items-center gap-2">
              {tx.party && tx.party.id !== null && (
                <Button onClick={() => navigate(partyTo(tx.party!))}>{tx.party.kind === "supplier" ? "Open supplier" : tx.party.kind === "customer" ? "Open customer" : "Open courier settlements"}</Button>
              )}
              {tx.purchase && <Button onClick={() => navigate(`/purchases/${tx.purchase!.id}`)}>Open purchase</Button>}
              {tx.sale && <Button onClick={() => navigate(`/sales/${tx.sale!.id}`)}>Open invoice</Button>}
              <Button onClick={() => navigate("/cash-book")}>Cash book</Button>
            </div>
          )
        }
      />

      {error && <ErrorText>{error}</ErrorText>}
      {!tx && !error && <PageLoader />}

      {tx && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">{out ? "Money out" : "Money in"}</p>
              <p className={`mt-0.5 text-lg font-semibold tabular-nums ${out ? "text-gray-900" : "text-green-700"}`}>
                {out ? "−" : "+"} {money(tx.amount)}
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">Cash book balance after</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900">{money(tx.balance_after)}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">Category</p>
              <p className="mt-0.5 text-lg font-semibold text-gray-900">{words(tx.category)}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">{out ? "Paid by" : "Received by"}</p>
              <p className="mt-0.5 text-lg font-semibold text-gray-900">{words(tx.payment_method)}</p>
            </div>
          </div>

          <Card>
            <h2 className="mb-4 text-sm font-semibold text-gray-900">Details</h2>
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 text-sm md:grid-cols-2">
              <div>
                <p className="text-xs text-gray-500">{out ? "Paid to" : "Received from"}</p>
                {tx.party ? (
                  <p className="text-gray-900">
                    {tx.party.id !== null ? <RefLink to={partyTo(tx.party)}>{tx.party.name}</RefLink> : tx.party.name}
                    {tx.party.code && <span className="text-gray-500"> · {tx.party.code}</span>}
                    <span className="ml-2 align-middle">
                      <Badge label={tx.party.kind === "supplier" ? "Supplier" : tx.party.kind === "customer" ? "Customer" : "Courier"} tone="outline" />
                    </span>
                  </p>
                ) : (
                  <p className="text-gray-500">Not tied to a supplier, customer or courier — see the note.</p>
                )}
              </div>
              {tx.purchase && (
                <div>
                  <p className="text-xs text-gray-500">For purchase</p>
                  <p className="text-gray-900">
                    <RefLink to={`/purchases/${tx.purchase.id}`}>{tx.purchase.purchase_code}</RefLink>
                  </p>
                </div>
              )}
              {tx.sale && (
                <div>
                  <p className="text-xs text-gray-500">Invoice</p>
                  <p className="text-gray-900">
                    <RefLink to={`/sales/${tx.sale.id}`}>{tx.sale.invoice}</RefLink>
                  </p>
                </div>
              )}
              <div>
                <p className="text-xs text-gray-500">Date and time</p>
                <p className="text-gray-900">{formatDateTime(tx.entry_date)}</p>
              </div>
              <div className="md:col-span-2">
                <p className="text-xs text-gray-500">Note on the transaction</p>
                <p className="text-gray-900">{tx.notes ?? "—"}</p>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
