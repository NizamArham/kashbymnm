import { useEffect, useState } from "react";
import { PageLoader } from "./Loader";
import { api, ApiRequestError } from "../lib/api";
import { Modal, Button, Badge, ErrorText, RefLink } from "./ui";
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
  // What it was for, when it can be traced.
  supplier_payment: { id: number; supplier_id: number; supplier_name: string; supplier_code: string; purchase_id: number | null; purchase_code: string | null } | null;
  sale: { id: number; invoice: string } | null;
}

const words = (s: string | null) => (s ? s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—");

// One cash book transaction by its ID: when, how much, how it was paid, the note on it, and — when it can be traced — who the money went to
// and which purchase or invoice it was for. Opens from a "TXN-…" code wherever one is shown.
export default function TransactionDetailModal({ code, onClose, onOpenPurchase }: { code: string; onClose: () => void; onOpenPurchase?: (purchaseId: number) => void }) {
  const [tx, setTx] = useState<TransactionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
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

  return (
    <Modal
      size="md"
      onClose={onClose}
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          Transaction {code}
          {tx && <Badge label={out ? "Money out" : "Money in"} />}
        </span>
      }
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {error && <ErrorText>{error}</ErrorText>}
      {!tx && !error && <PageLoader />}
      {tx && (
        <div className="space-y-5">
          <p className={`text-2xl font-semibold tabular-nums ${out ? "text-gray-900" : "text-green-700"}`}>
            {out ? "−" : "+"} Rs. {tx.amount.toLocaleString()}
          </p>
          <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <p className="text-xs text-gray-500">Date</p>
              <p className="text-gray-900">{formatDateTime(tx.entry_date)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Category</p>
              <p className="text-gray-900">{words(tx.category)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Paid by</p>
              <p className="text-gray-900">{words(tx.payment_method)}</p>
            </div>
            {tx.supplier_payment && (
              <div>
                <p className="text-xs text-gray-500">Paid to</p>
                <p className="text-gray-900">
                  <RefLink to={`/suppliers/${tx.supplier_payment.supplier_id}`}>{tx.supplier_payment.supplier_name}</RefLink>
                  <span className="text-gray-500"> · {tx.supplier_payment.supplier_code}</span>
                </p>
              </div>
            )}
            {tx.supplier_payment?.purchase_id && tx.supplier_payment.purchase_code && (
              <div>
                <p className="text-xs text-gray-500">For purchase</p>
                <p className="text-gray-900">
                  {onOpenPurchase ? (
                    <button type="button" onClick={() => onOpenPurchase(tx.supplier_payment!.purchase_id!)} className="cursor-pointer underline decoration-dotted decoration-gray-400 underline-offset-2">
                      {tx.supplier_payment.purchase_code}
                    </button>
                  ) : (
                    tx.supplier_payment.purchase_code
                  )}
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
          </div>
          {tx.notes && (
            <div>
              <p className="text-xs text-gray-500">Notes</p>
              <p className="text-sm text-gray-900">{tx.notes}</p>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
