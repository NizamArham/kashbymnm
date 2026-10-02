import { Sale } from "../lib/types";
import { deliveryBreakdown } from "../lib/receipts";
import { Badge } from "./ui";

// One line saying what delivery cost on an online order and whether it
// has been paid — so nobody has to work it out from a "+550" sitting
// next to a total that doesn't include it.
export default function DeliveryChargeSummary({ sale, className = "" }: { sale: Sale; className?: string }) {
  const d = deliveryBreakdown(sale);
  if (!d) return null;
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${className}`}>
      <span className="text-gray-500">Delivery{sale.delivery_partner_name ? ` (${sale.delivery_partner_name})` : ""}</span>
      <span className="font-medium text-gray-900">Rs. {d.fee.toLocaleString()}</span>
      {d.payable !== null && (
        <span className="text-gray-500">
          Total incl. delivery <strong className="text-gray-900">Rs. {d.payable.toLocaleString()}</strong>
        </span>
      )}
      {d.state === "paid" && <Badge label="delivery paid" tone="success" />}
      {d.state === "collected" && <Badge label="collected on delivery" tone="success" />}
      {d.state === "due" && <Badge label={`Rs. ${d.cod.toLocaleString()} to pay on delivery`} tone="warning" />}
      {d.note && <span className="text-xs text-gray-400">{d.note}</span>}
    </div>
  );
}
