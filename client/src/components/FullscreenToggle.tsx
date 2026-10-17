import { useEffect, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";

// Puts the whole app — not one panel — into full screen (the browser's own full-screen mode, so the tabs and
// address bar go away), and back. It's hidden where the browser can't do it (an iPhone, for one).
//
// Safari is the exception. Its page-level full screen runs on a separate desktop and fights with text boxes: opening
// a page that focuses one (Find) throws you back to the browser's desktop. Safari's OWN full screen (View ▸ Enter
// Full Screen, ⌃⌘F) has none of that, but a page can't start it — so in Safari the button explains how, instead.
//
// Browsers leave full screen on their own in a few situations — above all when Esc is pressed (the Find page uses
// Esc to clear its box), and on a page reload. So the choice is remembered for this tab: once you've turned full
// screen on, the next click brings it back if the browser dropped it, and this button is the only off switch.
// Where the browser allows it (Chrome and Edge), Esc is also kept for the app while in full screen, so Esc
// clears and closes things as usual and holding Esc is what leaves full screen.

const WANTED = "mm_fullscreen";
const wanted = () => {
  try {
    return sessionStorage.getItem(WANTED) === "1";
  } catch {
    return false;
  }
};
const setWanted = (on: boolean) => {
  try {
    if (on) sessionStorage.setItem(WANTED, "1");
    else sessionStorage.removeItem(WANTED);
  } catch {
    // storage can be unavailable (a private window) — full screen still works, it just isn't remembered
  }
};
const isSafari = typeof navigator !== "undefined" && /^((?!chrome|chromium|crios|fxios|edg|android).)*safari/i.test(navigator.userAgent);
const isTouch = typeof navigator !== "undefined" && navigator.maxTouchPoints > 1;
const keyboard = () => (navigator as any).keyboard as { lock?: (keys: string[]) => Promise<void>; unlock?: () => void } | undefined;

async function enterFullscreen() {
  await document.documentElement.requestFullscreen();
  try {
    await keyboard()?.lock?.(["Escape"]);
  } catch {
    // not available in this browser — Esc will simply leave full screen, and a click brings it back
  }
}

export default function FullscreenToggle({ className = "" }: { className?: string }) {
  const [full, setFull] = useState(() => !!document.fullscreenElement);
  const [remembered, setRemembered] = useState(wanted);
  const [tip, setTip] = useState(false);
  const supported = typeof document !== "undefined" && document.fullscreenEnabled;

  // The Safari explanation closes on a click elsewhere or Esc.
  useEffect(() => {
    if (!tip) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && (e.target as Element | null)?.closest?.("[data-fullscreen-toggle]")) return;
      setTip(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [tip]);

  useEffect(() => {
    if (isSafari) return; // Safari doesn't use the page-level full screen at all (see the note at the top)
    const sync = () => {
      const now = !!document.fullscreenElement;
      setFull(now);
      if (!now) keyboard()?.unlock?.();
    };
    // The browser dropped full screen but it hasn't been turned off here: the next click puts it back.
    const comeBack = (e: Event) => {
      if (!wanted() || document.fullscreenElement) return;
      if ((e.target as Element | null)?.closest?.("[data-fullscreen-toggle]")) return;
      enterFullscreen().catch(() => {});
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("pointerdown", comeBack, true);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("pointerdown", comeBack, true);
    };
  }, []);

  // An iPad's Safari can't be given full screen from a page either; there, "Add to Home Screen" is the way.
  if (isSafari ? isTouch : !supported) return null;

  async function toggle() {
    if (isSafari) {
      setTip((t) => !t);
      return;
    }
    try {
      if (document.fullscreenElement) {
        setWanted(false);
        setRemembered(false);
        keyboard()?.unlock?.();
        await document.exitFullscreen();
      } else {
        setWanted(true);
        setRemembered(true);
        await enterFullscreen();
      }
    } catch {
      // the browser refused (for instance, it wasn't started by a click) — nothing to do
    }
  }

  const label = full ? "Exit full screen" : remembered ? "Back to full screen" : "Full screen";
  return (
    <div className={`relative ${className}`}>
    <button
      type="button"
      data-fullscreen-toggle
      // Never take keyboard focus: whatever had it (the Find box, say) keeps it, so a barcode scanner's Enter can't
      // land on this button and switch full screen off again.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.currentTarget.blur();
        toggle();
      }}
      title={label}
      aria-label={label}
      className="flex items-center justify-center rounded-lg border border-gray-700 bg-black p-1.5 text-gray-300 transition hover:bg-gray-800 hover:text-white"
    >
      {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
    </button>
    {isSafari && tip && (
      <div className="absolute right-0 top-full z-[60] mt-2 w-56 rounded-xl border border-gray-700 bg-gray-900 p-3.5 text-xs leading-relaxed text-gray-300 shadow-2xl">
        <p className="mb-1.5 text-sm font-medium text-white">Full screen in Safari</p>
        <p>
          Press <kbd className="rounded bg-gray-800 px-1 text-gray-100">⌃</kbd> <kbd className="rounded bg-gray-800 px-1 text-gray-100">⌘</kbd>{" "}
          <kbd className="rounded bg-gray-800 px-1 text-gray-100">F</kbd> (View ▸ Enter Full Screen). Safari's own full screen keeps the keyboard and
          barcode scanner working on every page.
        </p>
        <p className="mt-2 text-gray-400">Tip: File ▸ Add to Dock opens Kash as its own window, with no tabs or address bar.</p>
      </div>
    )}
    </div>
  );
}
