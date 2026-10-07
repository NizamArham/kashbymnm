import { useEffect, useMemo, useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { Badge, Button, ErrorText, Modal, RefLink, Table, Td, Th } from "./ui";

interface SoldRow {
  sale_item_id: number;
  sale_id: number;
  invoice: string;
  date: string;
  sale_type: string;
  is_voided: number;
  is_returned: number;
  sku: string | null;
  size: string | null;
  color: string | null;
  quantity: number;
  unit_price: number;
  line_total: number;
  customer_name: string | null;
}

interface ProductSales {
  product: { id: number; product_title: string };
  rows: SoldRow[];
  pieces: number;
  amount: number;
}

// Every invoice a product was sold on — date and invoice both open that invoice —
// with the colour/size, the buyer and what each piece sold for. Admin only: the
// list comes from an admin-only endpoint.
export default function ProductSalesModal({ productId, productTitle, onClose }: { productId: number; productTitle: string; onClose: () => void }) {
  const [data, setData] = useState<ProductSales | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ProductSales>(`/products/${productId}/sales`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Couldn't load this product's sales"));
  }, [productId]);

  // Pieces of the same size/colour on the same invoice at the same price read
  // as one line ("50 pcs"), not fifty identical rows.
  const lines = useMemo(() => {
    const byKey = new Map<string, SoldRow>();
    for (const r of data?.rows ?? []) {
      const key = [r.sale_id, r.color, r.size, r.unit_price, r.is_voided, r.is_returned].join("|");
      const seen = byKey.get(key);
      if (seen) {
        seen.quantity += r.quantity;
        seen.line_total += r.line_total;
      } else {
        byKey.set(key, { ...r });
      }
    }
    return [...byKey.values()];
  }, [data]);

  // Price per piece across the pieces that really sold (voided and returned
  // ones don't count): the lowest, the highest and the average, each with how
  // many pieces went at that price and the latest invoice it was on. Rows come
  // newest first, so the first match is the latest invoice.
  const priceRange = useMemo(() => {
    const live = (data?.rows ?? []).filter((r) => !r.is_voided && !r.is_returned && r.quantity > 0);
    if (live.length === 0) return null;
    const prices = live.map((r) => r.unit_price);
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    const at = (price: number) => {
      const matches = live.filter((r) => r.unit_price === price);
      return {
        price,
        pieces: matches.reduce((sum, r) => sum + r.quantity, 0),
        invoices: new Set(matches.map((r) => r.sale_id)).size,
        latest: matches[0],
      };
    };
    const pieces = live.reduce((sum, r) => sum + r.quantity, 0);
    const average = Math.round(live.reduce((sum, r) => sum + r.unit_price * r.quantity, 0) / pieces);
    return { low: at(low), high: at(high), average, same: low === high };
  }, [data]);

  const subtitle = data
    ? data.rows.length === 0
      ? "Not sold yet"
      : `${data.pieces} pc${data.pieces === 1 ? "" : "s"} sold · Rs. ${data.amount.toLocaleString()}`
    : error
    ? undefined
    : "Loading…";

  return (
    <Modal size="2xl" onClose={onClose} title={`Sold invoices — ${productTitle}`} subtitle={subtitle} footer={<Button onClick={onClose}>Close</Button>}>
      {error && <ErrorText>{error}</ErrorText>}
      {data && data.rows.length === 0 && <p className="text-sm text-gray-500">No piece of this product has been sold on an invoice yet.</p>}
      {priceRange && (
        <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-4">
          <PriceStat label="Lowest price" stat={priceRange.low} />
          <div className="bg-gray-50 rounded-lg px-2.5 sm:px-3 py-2 min-w-0">
            <p className="text-xs text-gray-500">Average price</p>
            <p className="text-sm sm:text-base font-semibold text-gray-900">Rs. {priceRange.average.toLocaleString()}</p>
            <p className="text-xs text-gray-400">per piece</p>
          </div>
          <PriceStat label="Highest price" stat={priceRange.high} />
        </div>
      )}
      {data && data.rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Invoice</Th>
              <Th>Colour / size</Th>
              <Th>Customer</Th>
              <Th>Pcs</Th>
              <Th>Each</Th>
              <Th>Amount</Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((r) => {
              const dead = !!(r.is_voided || r.is_returned);
              return (
                <tr key={`${r.sale_id}-${r.sale_item_id}`} className={dead ? "opacity-60" : ""}>
                  <Td className="whitespace-nowrap">
                    <RefLink to={`/sales/${r.sale_id}`}>{r.date.slice(0, 16).replace("T", " ")}</RefLink>
                  </Td>
                  <Td className="whitespace-nowrap font-medium">
                    <RefLink to={`/sales/${r.sale_id}`}>{r.invoice}</RefLink>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {r.color ?? "—"} / {r.size ?? "—"}
                  </Td>
                  <Td>{r.customer_name ?? "Walk-in"}</Td>
                  <Td>{r.quantity}</Td>
                  <Td className="whitespace-nowrap text-gray-500">Rs. {r.unit_price.toLocaleString()}</Td>
                  <Td className="whitespace-nowrap">
                    <span className={dead ? "line-through" : "font-medium text-gray-900"}>Rs. {r.line_total.toLocaleString()}</span>
                    {r.is_voided ? <span className="ml-2"><Badge label="Voided" tone="neutral" /></span> : r.is_returned ? <span className="ml-2"><Badge label="Returned" tone="neutral" /></span> : null}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Modal>
  );
}

function PriceStat({
  label,
  stat,
}: {
  label: string;
  stat: { price: number; pieces: number; invoices: number; latest: SoldRow };
}) {
  return (
    <div className="bg-gray-50 rounded-lg px-2.5 sm:px-3 py-2 min-w-0">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-sm sm:text-base font-semibold text-gray-900">Rs. {stat.price.toLocaleString()}</p>
      <p className="text-xs text-gray-400">
        {stat.pieces} pc{stat.pieces === 1 ? "" : "s"}
        <span className="hidden sm:inline"> · {stat.invoices > 1 ? "latest " : ""}</span>
        <span className="block sm:inline break-all sm:break-normal">
          <RefLink to={`/sales/${stat.latest.sale_id}`}>{stat.latest.invoice}</RefLink>
        </span>
      </p>
    </div>
  );
}
