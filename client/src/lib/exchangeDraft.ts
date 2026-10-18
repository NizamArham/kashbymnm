// Holds an exchange-by-delivery popup that is being filled in, the way the POS holds a cart: leaving the page, reloading
// or coming back later finds it as it was. Like the POS draft it sticks around until the exchange is created, held as a
// quotation, or cancelled — closing the popup (X, Esc, a click outside) only puts it aside.
//
// It lives in local storage (it survives a closed browser, same as the POS draft), belongs to the logged-in person, and
// is tied to the invoice (or quotation) the popup was opened from.

import { useEffect, useState } from "react";

const KEY = "mm_exchange_draft";
const CHANGED = "mm-exchange-draft";

export interface ExchangeDraftLine {
  key: string;
  qty: string;
  price: string;
  unitId?: number;
}

export interface ExchangeDraft {
  userId: number | null;
  // The invoice the popup was opened from — or, when `quote` is set, the quotation being confirmed.
  saleId: number;
  quote: boolean;
  customer: string;
  invoice: string;
  oldIds: number[];
  lines: ExchangeDraftLine[];
  partnerCode: string;
  weight: string;
  freeDelivery: boolean;
  pickup: string;
  pickupEdited: boolean;
  sharePct: number | null;
  payment: string;
  holdStock?: boolean;
  // How the old items come back: with the delivery of the new order (default), or separately by another service.
  returnVia?: "delivery" | "separate";
  returnService?: string;
}

function notify() {
  window.dispatchEvent(new Event(CHANGED));
}

export function loadExchangeDraft(): ExchangeDraft | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ExchangeDraft) : null;
  } catch {
    return null;
  }
}

export function saveExchangeDraft(draft: ExchangeDraft) {
  try {
    localStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // losing the held popup silently beats breaking the page over it
  }
  notify();
}

export function clearExchangeDraft() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // a stale draft lingering is the worst case
  }
  notify();
}

// The held popup for this invoice / quotation and this person, if there is one.
export function exchangeDraftFor(saleId: number, quote: boolean, userId: number | null | undefined): ExchangeDraft | null {
  const d = loadExchangeDraft();
  return d && d.saleId === saleId && d.quote === quote && d.userId === (userId ?? null) ? d : null;
}

// Whether the popup is on screen right now — so the "exchange in progress" reminder only shows when it isn't.
let popupVisible = false;
export function setExchangePopupVisible(visible: boolean) {
  popupVisible = visible;
  notify();
}

export function useHeldExchange(): { draft: ExchangeDraft | null; visible: boolean } {
  const [, tick] = useState(0);
  useEffect(() => {
    const on = () => tick((n) => n + 1);
    window.addEventListener(CHANGED, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(CHANGED, on);
      window.removeEventListener("storage", on);
    };
  }, []);
  return { draft: loadExchangeDraft(), visible: popupVisible };
}
