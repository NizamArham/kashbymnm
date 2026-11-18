import { BarChart3, Download, Receipt } from "lucide-react";

export type ProductView = "report" | "sales" | "analytics";

// One frame for all three popups, so moving between them never makes the window jump or resize.
export const PRODUCT_POPUP = { size: "xl", height: "h-[min(44rem,calc(100dvh-2rem))]" } as const;

const TABS: { view: ProductView; label: string; short: string; icon: typeof Receipt }[] = [
  { view: "report", label: "Download report", short: "Report", icon: Download },
  { view: "sales", label: "Sold invoices", short: "Invoices", icon: Receipt },
  { view: "analytics", label: "Analytics", short: "Analytics", icon: BarChart3 },
];

// The three things a product row's "⋮" menu opens, as a strip across the top of whichever one is open — so moving between
// them is one click, not close and reopen.
export default function ProductViewTabs({ current, onSelect }: { current: ProductView; onSelect: (view: ProductView) => void }) {
  return (
    <div role="tablist" aria-label="Product views" className="flex w-full gap-0.5 rounded-lg bg-gray-100 p-0.5 sm:inline-flex sm:w-auto">
      {TABS.map(({ view, label, short, icon: Icon }) => {
        const active = view === current;
        return (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => !active && onSelect(view)}
            className={`flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs transition sm:flex-none sm:text-sm ${
              active ? "bg-white font-medium text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-900"
            }`}
          >
            <Icon size={14} className="hidden sm:block" />
            <span className="sm:hidden">{short}</span>
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
