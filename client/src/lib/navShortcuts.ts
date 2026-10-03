import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

// Keyboard shortcuts that jump straight to a page from anywhere in the app.
// This one list drives the key handling, the sidebar tooltips AND the table
// on Admin → General Settings → Reference, so they can never disagree.
//
// Every jump is Alt/Option + letter. Plain letters are deliberately NOT used —
// they would fire while someone types or while a barcode scanner is typing —
// and Ctrl/Cmd + S or C can't be taken over without breaking Save and Copy.
// Dashboard and Inventory also answer to Cmd (Mac) / Ctrl (Windows) + D / I.
export interface NavShortcut {
  letter: string;
  label: string;
  path: string;
  adminOnly?: boolean;
  // Also reachable with Cmd/Ctrl + the letter (only where that clashes with nothing important).
  withCtrlCmd?: boolean;
}

export const NAV_SHORTCUTS: NavShortcut[] = [
  { letter: "d", label: "Dashboard", path: "/", withCtrlCmd: true },
  { letter: "f", label: "Find", path: "/find", adminOnly: true },
  { letter: "a", label: "Analytics", path: "/analytics", adminOnly: true },
  { letter: "p", label: "POS · Checkout", path: "/pos" },
  { letter: "h", label: "Sale History", path: "/sales" },
  { letter: "q", label: "Quotations", path: "/quotations" },
  { letter: "i", label: "Inventory · Stocks", path: "/inventory", withCtrlCmd: true },
  { letter: "m", label: "Manage Products", path: "/products", adminOnly: true },
  { letter: "n", label: "Add Product", path: "/products/add", adminOnly: true },
  { letter: "u", label: "Customers", path: "/customers" },
  { letter: "v", label: "Suppliers", path: "/suppliers", adminOnly: true },
  { letter: "r", label: "Returns", path: "/returns" },
  { letter: "b", label: "Purchases", path: "/purchases", adminOnly: true },
  { letter: "c", label: "Cash Book", path: "/cash-book", adminOnly: true },
  { letter: "e", label: "Cheques", path: "/cheques", adminOnly: true },
  { letter: "s", label: "Shipments · Deliveries", path: "/deliveries" },
  { letter: "w", label: "Waybill Generator", path: "/waybill-generator" },
  { letter: "t", label: "Attendance", path: "/attendance", adminOnly: true },
  { letter: "l", label: "Audit Log", path: "/audit-log", adminOnly: true },
  { letter: "g", label: "General Settings", path: "/settings/general", adminOnly: true },
];

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// "⌥D" on a Mac, "Alt+D" elsewhere — for the sidebar tooltips.
export function navShortcutHint(path: string): string | undefined {
  const s = NAV_SHORTCUTS.find((n) => n.path === path);
  if (!s) return undefined;
  const L = s.letter.toUpperCase();
  return isMac ? `${s.label} (⌥${L}${s.withCtrlCmd ? ` or ⌘${L}` : ""})` : `${s.label} (Alt+${L}${s.withCtrlCmd ? ` or Ctrl+${L}` : ""})`;
}

// Binds the jumps for as long as the app shell is mounted. A shortcut for an
// admin-only page does nothing for staff, same as the page missing from their menu.
export function useNavShortcuts(isAdmin: boolean) {
  const navigate = useNavigate();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.repeat || e.isComposing || !e.code.startsWith("Key")) return;
      // The physical key (KeyD), not the character: Option+D types "∂" on a Mac.
      const letter = e.code.slice(3).toLowerCase();
      const viaAlt = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      // Cmd on a Mac, Ctrl elsewhere (Ctrl+D / Ctrl+I mean other things in Mac text fields).
      const modifier = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      const viaCtrlCmd = modifier && !e.altKey && !e.shiftKey;
      const hit = NAV_SHORTCUTS.find((s) => s.letter === letter && (viaAlt || (viaCtrlCmd && s.withCtrlCmd)));
      if (!hit || (hit.adminOnly && !isAdmin)) return;
      e.preventDefault();
      navigate(hit.path);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navigate, isAdmin]);
}
