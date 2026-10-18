import { useState } from "react";
import { Printer } from "lucide-react";
import { ApiRequestError } from "../lib/api";
import { printRefundSlip } from "../lib/refundSlip";
import { ActionMenu } from "./ui";
import { useToast } from "./Feedback";

// A small print icon that opens the "Refund payment done" receipt for a refund that has been paid. `slipKey` is "pickup-<id>" (a courier return)
// or "return-<id>" (a refund paid at the shop).
export default function RefundSlipButton({ slipKey, className = "" }: { slipKey: string; className?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      title="Print the refund receipt"
      aria-label="Print the refund receipt"
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation(); // inside a row that opens on click
        setBusy(true);
        try {
          await printRefundSlip(slipKey);
        } catch (err) {
          toast.error(err instanceof ApiRequestError ? err.message : "Couldn't open the slip");
        } finally {
          setBusy(false);
        }
      }}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 transition hover:border-gray-400 hover:text-gray-900 disabled:opacity-50 ${className}`}
    >
      <Printer size={14} />
    </button>
  );
}

// The same, as an entry in a row's three-dot menu — how the Returns lists offer it ("Print refund receipt" under the dots at the end of a
// completed row).
export function RefundSlipMenu({ slipKey }: { slipKey: string }) {
  const toast = useToast();
  return (
    <ActionMenu
      items={[
        {
          label: "Print refund receipt",
          icon: <Printer size={14} />,
          onClick: async () => {
            try {
              await printRefundSlip(slipKey);
            } catch (err) {
              toast.error(err instanceof ApiRequestError ? err.message : "Couldn't open the receipt");
            }
          },
        },
      ]}
    />
  );
}
