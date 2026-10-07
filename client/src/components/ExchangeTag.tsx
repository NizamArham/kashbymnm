import { Sale } from "../lib/types";
import { Badge, RefLink } from "./ui";

type Flags = Pick<Sale, "exchange_out_status" | "exchange_out_invoice" | "exchange_out_sale_id" | "exchange_in_status" | "exchange_in_from">;

const OUT = {
  awaiting: { label: "Exchange pending", tone: "warning" },
  received: { label: "Exchanged", tone: "success" },
  not_returned: { label: "Exchange: item not returned", tone: "danger" },
} as const;

// What an invoice is doing in an exchange, as a small tag under its number in a list: its
// items are being swapped (with a link to the replacement order), were swapped, or it IS
// a replacement order. Nothing for an invoice that has nothing to do with an exchange.
export default function ExchangeTag({ sale, className = "" }: { sale: Flags; className?: string }) {
  const out = sale.exchange_out_status ? OUT[sale.exchange_out_status] : null;
  const inStatus = sale.exchange_in_status;
  if (!out && !inStatus) return null;
  return (
    <div className={`mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 ${className}`}>
      {out && (
        <>
          <Badge label={out.label} tone={out.tone} />
          {sale.exchange_out_invoice && sale.exchange_out_sale_id && (
            <span className="whitespace-nowrap text-xs text-gray-500">
              → <RefLink to={`/sales/${sale.exchange_out_sale_id}`}>{sale.exchange_out_invoice}</RefLink>
            </span>
          )}
        </>
      )}
      {inStatus && (
        <>
          <Badge label={inStatus === "cancelled" ? "Exchange cancelled" : "Exchange order"} tone={inStatus === "cancelled" ? "neutral" : "outline"} />
          {sale.exchange_in_from && <span className="whitespace-nowrap text-xs text-gray-500">for {sale.exchange_in_from.split(",").join(", ")}</span>}
        </>
      )}
    </div>
  );
}
