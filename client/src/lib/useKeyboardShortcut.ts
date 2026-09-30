import { useEffect } from "react";

// Binds a global keydown shortcut for as long as the calling component is
// mounted — lets a page trigger its own primary action (almost always
// "download this PDF") from the keyboard, without a click. Ignored while
// focus is inside a text input/textarea/select/contenteditable so it can
// never steal a keystroke from someone typing, and only fires with the
// exact modifier combination requested (defaults to none).
export function useKeyboardShortcut(
  key: string,
  handler: () => void,
  options: { ctrlOrCmd?: boolean; shift?: boolean; enabled?: boolean } = {}
) {
  const { ctrlOrCmd = false, shift = false, enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;

      const hasCtrlOrCmd = e.ctrlKey || e.metaKey;
      if (ctrlOrCmd !== hasCtrlOrCmd) return;
      if (shift !== e.shiftKey) return;
      if (e.key.toLowerCase() !== key.toLowerCase()) return;

      e.preventDefault();
      handler();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [key, handler, ctrlOrCmd, shift, enabled]);
}
