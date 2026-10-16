import { useEffect, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";

// Puts the whole app — not one panel — into full screen (the browser's own full-screen mode, so the tabs and
// address bar go away), and back. It's hidden where the browser can't do it (an iPhone, for one).
export default function FullscreenToggle({ className = "" }: { className?: string }) {
  const [full, setFull] = useState(() => !!document.fullscreenElement);
  const supported = typeof document !== "undefined" && document.fullscreenEnabled;

  useEffect(() => {
    const sync = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  if (!supported) return null;

  async function toggle() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // the browser refused (for instance, it wasn't started by a click) — nothing to do
    }
  }

  const label = full ? "Exit full screen" : "Full screen";
  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      className={`items-center justify-center rounded-lg border border-gray-700 bg-black p-1.5 text-gray-300 transition hover:bg-gray-800 hover:text-white ${className}`}
    >
      {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
    </button>
  );
}
