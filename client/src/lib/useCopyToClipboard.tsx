import { useState } from "react";

// Click-to-copy for a table cell (SKU, barcode, transaction code, any
// short reference value) — copies on click and shows a small floating
// "Copied!" bubble at the click position for ~1.2s. Originally built for
// Stocks' variant table; pulled out here so any table can use the exact
// same interaction without re-declaring the state and tooltip markup.
//
// Usage:
//   const { copy, tooltip } = useCopyToClipboard();
//   <td onClick={(e) => copy("sku-123", "ABC123", e)} className="cursor-pointer hover:bg-gray-100" title="Click to copy">
//     ABC123
//   </td>
//   {tooltip}
export function useCopyToClipboard() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copiedPos, setCopiedPos] = useState<{ x: number; y: number } | null>(null);

  async function copy(key: string, value: string, e: { clientX: number; clientY: number }) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setCopiedPos({ x: e.clientX, y: e.clientY });
      setTimeout(() => {
        setCopiedKey(null);
        setCopiedPos(null);
      }, 1200);
    } catch {
      /* clipboard access denied or unavailable — silently ignore, nothing to recover */
    }
  }

  const tooltip =
    copiedKey && copiedPos ? (
      <div
        className="fixed z-50 pointer-events-none px-2.5 py-1 rounded-md bg-gray-900 text-white text-xs font-medium shadow-lg"
        style={{ left: copiedPos.x + 10, top: copiedPos.y - 30 }}
      >
        Copied!
      </div>
    ) : null;

  return { copy, copiedKey, tooltip };
}
