import { ShoppingBag } from "lucide-react";

// The "something is loading" mark used everywhere in place of a bare "Loading…" line: the shop's bag icon in a black disc,
// ringed by a turning arc. The first-paint splash in index.html draws the same thing, so a reload goes from the splash to
// the page's own loader to the content without the picture jumping.
export default function Loader({
  label = "Loading",
  size = 44,
  fullScreen = false,
  className = "",
}: {
  label?: string;
  size?: number;
  fullScreen?: boolean;
  className?: string;
}) {
  const mark = (
    <div role="status" aria-live="polite" className={`flex flex-col items-center gap-3 ${className}`}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg className="absolute inset-0 animate-spin motion-reduce:animate-pulse" style={{ animationDuration: "1.1s" }} viewBox="0 0 44 44" fill="none" aria-hidden="true">
          <circle cx="22" cy="22" r="20" stroke="#e5e7eb" strokeWidth="3" />
          <path d="M22 2a20 20 0 0 1 20 20" stroke="#000" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <div className="absolute flex items-center justify-center rounded-full bg-black" style={{ inset: Math.round(size * 0.16) }}>
          <ShoppingBag size={Math.round(size * 0.36)} strokeWidth={2} className="text-white" aria-hidden="true" />
        </div>
      </div>
      {label && <p className="text-xs text-gray-400">{label}…</p>}
    </div>
  );
  return fullScreen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-50">{mark}</div> : mark;
}

// A page's own content area while its data comes in.
export function PageLoader({ label = "Loading" }: { label?: string }) {
  return <Loader label={label} size={52} className="py-16" />;
}
