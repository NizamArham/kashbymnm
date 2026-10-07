// Persists the POS page's in-progress sale across navigation and
// refreshes — the cart itself has no backend record until checkout
// actually completes, so without this, leaving the page (even just to
// check something on Inventory) genuinely loses everything in it.
//
// Deliberately scoped to the "resume this exact sale" set — cart lines,
// the selected customer, sale type, and the payment/delivery/discount
// details that go with them. Ephemeral UI state (search boxes, the
// add-customer modal, which line is mid-edit) is NOT persisted, since
// restoring those would be confusing rather than helpful.
//
// No time-based expiry, per the confirmed design — a saved sale sticks
// around until it's completed or explicitly cleared, however long that
// takes.

import { InventoryUnit, Customer, SaleType, Coupon } from "./types";

const STORAGE_KEY = "mm_pos_draft_sale";

export interface CartLineSnapshot {
  units: InventoryUnit[];
  unit_price: number;
}

export interface PosDraftSale {
  saleType: SaleType;
  cart: CartLineSnapshot[];
  selectedCustomer: Customer | null;
  isCreditSale: boolean;
  creditAmountPaid: string;
  creditPaymentMethod: "cash" | "card" | "bank_transfer";
  deliveryPartner: string;
  packageWeight: string;
  isFreeDelivery: boolean;
  deliveryFare?: string;
  deliveryPaidBy?: "customer" | "shop" | "rider_direct";
  deliveryFareLater?: boolean;
  isWholesale?: boolean;
  advancePaid: string;
  advancePaymentMethod: "cash" | "card" | "bank_transfer";
  discountType: "percent" | "fixed";
  discountValue: string;
  couponCode: string;
  appliedCoupon: Coupon | null;
  useStoreCredit: boolean;
  paymentMethod: string;
  // Set while a saved quotation is reopened for editing/checkout, so a
  // refresh or navigating away and back doesn't silently turn it into
  // an unrelated new sale (and leave the quotation open forever).
  quotation?: { id: number; invoice: string } | null;
}

export function saveDraftSale(draft: PosDraftSale) {
  try {
    // An empty cart with nothing else customized isn't worth persisting
    // — avoids leaving a stale "empty sale" behind after a normal
    // checkout already cleared everything.
    if (draft.cart.length === 0 && !draft.selectedCustomer) {
      clearDraftSale();
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // localStorage can fail (private browsing, quota) — losing draft
    // persistence silently is far better than crashing the POS page
    // over it.
  }
}

export function loadDraftSale(): PosDraftSale | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PosDraftSale;
  } catch {
    return null;
  }
}

export function clearDraftSale() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing to do if this fails — worst case, a stale draft lingers
  }
}

// True when POS holds a cart with something in it — used before
// reopening a quotation there, so it doesn't silently replace a sale
// someone is in the middle of ringing up.
export function hasDraftInProgress(): boolean {
  const draft = loadDraftSale();
  return !!draft && draft.cart.length > 0;
}
