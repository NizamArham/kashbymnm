import { Link } from "react-router-dom";
import { Repeat, X } from "lucide-react";
import { clearExchangeDraft, useHeldExchange } from "../lib/exchangeDraft";
import { useAuth } from "../context/AuthContext";

// The reminder for an exchange-by-delivery popup that was put aside: it's held (see lib/exchangeDraft.ts), and this is the
// way back to it from any page. Gone once it's created, held as a quote, or thrown away with the ×.
export default function ExchangeResume() {
  const { user } = useAuth();
  const { draft, visible } = useHeldExchange();
  if (!draft || visible || draft.userId !== (user?.id ?? null)) return null;
  return (
    <div className="fixed right-4 top-3 z-40 flex max-w-[calc(100vw-2rem)] items-center gap-1 rounded-full border border-gray-700 bg-black py-1 pl-3 pr-1 text-xs text-gray-200 shadow-lg">
      <Link to={`/sales/${draft.saleId}?exchange=1`} className="flex min-w-0 items-center gap-1.5 hover:text-white" title="Open the exchange you were filling in">
        <Repeat size={12} className="flex-shrink-0" />
        <span className="truncate">
          {draft.quote ? "Payment request exchange" : "Exchange"} in progress · {draft.customer}
        </span>
        <span className="flex-shrink-0 font-medium text-white underline">Resume</span>
      </Link>
      <button
        type="button"
        onClick={() => {
          if (confirm("Throw away this exchange you were filling in?")) clearExchangeDraft();
        }}
        className="ml-1 flex-shrink-0 rounded-full p-1 text-gray-400 hover:bg-gray-800 hover:text-white"
        title="Throw it away"
        aria-label="Throw away the held exchange"
      >
        <X size={12} />
      </button>
    </div>
  );
}
