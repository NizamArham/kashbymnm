// Remembers WHERE someone was on a browsing page — what they searched for, which filters and product were open, how far
// they had scrolled — so leaving for another page (or a reload) and coming back finds the place as it was left.
//
// Unlike the POS draft (a sale that exists nowhere else, kept until it's finished), this is only a place in a list, so it
// lives in the tab's session storage: it survives reloads and moving between pages, and is gone when the tab is closed
// or the person logs out — a new day should never open on yesterday's search.

import { Dispatch, SetStateAction, useEffect, useLayoutEffect, useRef, useState } from "react";

const PREFIX = "mm_view:";

export function readMemory<T>(key: string): T | undefined {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

export function writeMemory(key: string, value: unknown) {
  try {
    if (value === undefined || value === null) sessionStorage.removeItem(PREFIX + key);
    else sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // storage can be unavailable (a private window) — the page just doesn't remember
  }
}

export function clearViewMemory() {
  try {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith(PREFIX)) sessionStorage.removeItem(k);
  } catch {
    // nothing to clear
  }
}

// useState that starts from, and keeps writing to, the remembered value.
export function useRemembered<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readMemory<T>(key) ?? initial);
  useEffect(() => {
    writeMemory(key, value);
  }, [key, value]);
  return [value, setValue];
}

// Puts the page back where it was scrolled once its content is there (`ready`), and keeps noting where it is.
// The position is saved from the scroll events themselves and once more as the page is left — in a layout-effect cleanup,
// which runs before the next page's content replaces this one's (afterwards the browser may already have clamped the
// scroll to the shorter page).
export function useRememberedScroll(key: string, ready: boolean) {
  const restored = useRef(false);
  useEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    const y = readMemory<number>(`${key}.scroll`);
    if (y && y > 0) requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, y)));
  }, [ready, key]);
  useLayoutEffect(() => {
    let frame = 0;
    const save = () => {
      if (restored.current) writeMemory(`${key}.scroll`, window.scrollY);
    };
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(save);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      save();
    };
  }, [key]);
}
