import { useState, useEffect, useLayoutEffect, useMemo, useRef, KeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Trash2,
  ShoppingCart,
  Search,
  UserPlus,
  X,
  User,
  Star,
  AlertTriangle,
  Package,
  Phone,
  MapPin,
  UserRound,
  Wallet,
  CreditCard,
  Smartphone,
  CheckCircle,
  Edit2,
  Plus,
  Minus,
  FileText,
  Printer,
  Receipt,
  MessageCircle,
  ChevronUp,
} from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { InventoryUnit, Customer, SaleType, CustomerAddress, Coupon, CustomerGender, Sale } from "../lib/types";
import { createProductSearchIndex, searchProductUnits } from "../lib/productSearch";
import { Input, Label, FormGroup, ErrorText, SuccessText, Button, Dropdown, HelpHint, RefLink, Modal } from "../components/ui";
import { CityPicker } from "../components/CityPicker";
import { OnDemandFareInput, OnDemandPaidByPicker } from "../components/OnDemandFareFields";
import { useAuth } from "../context/AuthContext";
import {
  DeliveryPartner,
  DeliveryPaidBy,
  OnDemandFare,
  onDemandFareError,
  onDemandPayload,
  useDeliveryPartners,
  partnerLabel,
  calculateDeliveryFee,
  calculateCodAmount,
} from "../lib/delivery";
import { saveDraftSale, loadDraftSale, clearDraftSale, PosDraftSale } from "../lib/posDraft";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";
import { whatsappMessageLink, loyaltyPointsMessage } from "../lib/whatsapp";
import { normalizePhone, phoneError } from "../lib/phone";
import PhoneInput from "../components/PhoneInput";
import { downloadA4Pdf, downloadThermalPdf, sendWhatsAppBill } from "../lib/receipts";
import ReceiptOptionsModal, { ModalOption } from "../components/ReceiptOptionsModal";

// A cart line represents one or more physical units that share the same
// product + color + size — merged into one row with a quantity, rather
// than one row per physical unit. Each unit's own id is kept in `units`
// so checkout can still reference the exact physical items being sold.
interface CartLine {
  units: InventoryUnit[];
  unit_price: number;
}

function cartLineKey(u: InventoryUnit): string {
  return `${u.product_id}::${u.color ?? ""}::${u.size ?? ""}`;
}

// One tick box with a short label and its explanation in a hint, so the
// options under the customer all read the same.
function PosTick({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center">
      <label className={`flex items-center gap-2 text-sm ${disabled ? "text-gray-400" : "text-gray-700 cursor-pointer"}`}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="rounded" />
        {label}
      </label>
      <HelpHint text={hint} />
    </div>
  );
}

export default function PosPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [searchParams, setSearchParams] = useSearchParams();

  const [saleType, setSaleType] = useState<SaleType>("in_store");
  const [cart, setCart] = useState<CartLine[]>([]);
  // Unit ids from a restored cart that turned out to no longer be
  // available (sold, returned, or removed by someone else while this
  // page was closed) — struck through in the cart display rather than
  // silently dropped, so it's obvious something changed instead of the
  // line just vanishing.
  const [staleUnitIds, setStaleUnitIds] = useState<Set<number>>(new Set());

  // Admin-only credit sale — lets a trusted customer take items now and
  // settle later. Reuses the existing amount_paid < total mechanism (the
  // resulting balance_due already shows on their customer record), so
  // this toggle is really just "leave amount paid low on purpose" with a
  // clear, deliberate UI for it rather than looking like a mistake.
  const [isCreditSale, setIsCreditSale] = useState(false);
  const [creditAmountPaid, setCreditAmountPaid] = useState("0");
  // How the partial amount (if any) on an in-store credit sale was
  // actually collected — same reasoning as advancePaymentMethod for
  // online orders: without this, a Rs. 2000 cash payment on a Rs. 5000
  // credit sale would have nowhere to record which channel it came in on.
  const [creditPaymentMethod, setCreditPaymentMethod] = useState<"cash" | "card" | "bank_transfer">("cash");

  // Delivery details for online orders — partner, weight, and whether
  // delivery itself is free (the order total still needs settling
  // either way).
  const [deliveryPartner, setDeliveryPartner] = useState<DeliveryPartner | "">("");
  const [packageWeight, setPackageWeight] = useState("");
  const [isFreeDelivery, setIsFreeDelivery] = useState(false);
  // On-demand partners (Uber, PickMe Flash...): the fare is typed in
  // here rather than worked out from a weight tariff, and the person at
  // checkout says who bears it.
  const [deliveryFare, setDeliveryFare] = useState("");
  const [deliveryPaidBy, setDeliveryPaidBy] = useState<DeliveryPaidBy>("customer");
  // Billed or credited first, Flash booked later: leave the fare out and the
  // order waits (on hold) until it's entered from the Deliveries page.
  const [deliveryFareLater, setDeliveryFareLater] = useState(false);
  // A wholesale order earns no loyalty points. A customer marked as never
  // earning points is treated the same way (and the tick is locked on).
  const [isWholesale, setIsWholesale] = useState(false);
  const [advancePaid, setAdvancePaid] = useState("");
  // How the upfront amount (if any) was actually collected — needed to
  // correctly track cash-on-hand vs bank balance, same as an in-store sale.
  const [advancePaymentMethod, setAdvancePaymentMethod] = useState<"cash" | "card" | "bank_transfer">("cash");

  const [productQuery, setProductQuery] = useState("");
  const [productResults, setProductResults] = useState<InventoryUnit[]>([]);
  const [productSearchOpen, setProductSearchOpen] = useState(false);
  const [productSearchError, setProductSearchError] = useState<string | null>(null);
  const productBoxRef = useRef<HTMLDivElement>(null);
  const productInputRef = useRef<HTMLInputElement>(null);
  const [allAvailableUnits, setAllAvailableUnits] = useState<InventoryUnit[] | null>(null);

  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerSearchOpen, setCustomerSearchOpen] = useState(false);
  const [allCustomers, setAllCustomers] = useState<Customer[] | null>(null);
  const customerBoxRef = useRef<HTMLDivElement>(null);

  // Full new-customer modal: name, phone (required) + phone2 (optional),
  // address line 1/2, and city — matching a real intake form rather than
  // the earlier quick name+phone shortcut.
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [newCustomerPhone2, setNewCustomerPhone2] = useState("");
  const [newCustomerGender, setNewCustomerGender] = useState<CustomerGender>("unspecified");
  const [newCustomerAddr1, setNewCustomerAddr1] = useState("");
  const [newCustomerAddr2, setNewCustomerAddr2] = useState("");
  const [newCustomerCity, setNewCustomerCity] = useState("");
  const [addCustomerError, setAddCustomerError] = useState<string | null>(null);
  const [addCustomerSubmitting, setAddCustomerSubmitting] = useState(false);

  const [editingLineKey, setEditingLineKey] = useState<string | null>(null);
  const [editPriceValue, setEditPriceValue] = useState("");
  const [priceEditError, setPriceEditError] = useState<string | null>(null);

  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  // When cash tendered exceeds the total AND a real customer is
  // attached, this popup forces an explicit choice — give change back,
  // or keep the extra as store credit on their account. Never assumed.
  // A walk-in has nowhere to keep credit, so this never applies to them
  // — they just always get change, exactly as before.
  const [showOverpaymentChoice, setShowOverpaymentChoice] = useState(false);
  const [keepOverpaymentAsCredit, setKeepOverpaymentAsCredit] = useState<boolean | null>(null);

  // Address verification gate — shown before the final review modal for
  // online orders, so a missing or unconfirmed address is caught here
  // rather than after the item is already packed for shipping.
  const [showAddressCheck, setShowAddressCheck] = useState(false);
  const [customerAddresses, setCustomerAddresses] = useState<CustomerAddress[] | null>(null);
  const [addressCheckLoading, setAddressCheckLoading] = useState(false);
  const [newAddrLine1, setNewAddrLine1] = useState("");
  const [newAddrLine2, setNewAddrLine2] = useState("");
  const [newAddrCity, setNewAddrCity] = useState("");
  const [addressCheckError, setAddressCheckError] = useState<string | null>(null);

  const [showBrowser, setShowBrowser] = useState(false);
  const [browserCategory, setBrowserCategory] = useState("all");

  // Manual discount — either a percentage of the subtotal or a flat Rs.
  // amount, picked via a type toggle rather than one ambiguous field.
  const [discountType, setDiscountType] = useState<"percent" | "fixed">("fixed");
  const [discountValue, setDiscountValue] = useState("0");

  // Coupon — separate from the manual discount, validated against the
  // server's real coupon list before it's allowed to apply.
  const [couponCode, setCouponCode] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<Coupon | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponChecking, setCouponChecking] = useState(false);

  // Store credit from a past overpayment — offered automatically when
  // the selected customer has a balance, applied against this sale's
  // total if the person chooses to use it.
  const [useStoreCredit, setUseStoreCredit] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState("cash");
  // Cash tendered by the customer, so change due can be shown before the
  // sale is finalized — only meaningful when paymentMethod is "cash".
  const [amountPaid, setAmountPaid] = useState("");

  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  // "Sale details" (customer, discount, coupon, delivery, payment) fold away so the
  // cart can have the room. They open upward from the bar and close back down into
  // it. Remembered between sales, and they open by themselves when the sale needs
  // something from them (an online order, or a checkout that's missing a field).
  const [detailsOpen, setDetailsOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("mm_pos_details_open") === "1";
    } catch {
      return false;
    }
  });
  const [detailsSettled, setDetailsSettled] = useState(true); // false while the open/close animation runs
  useEffect(() => {
    setDetailsSettled(false);
    const t = setTimeout(() => setDetailsSettled(true), 220);
    return () => clearTimeout(t);
  }, [detailsOpen]);
  useEffect(() => {
    if (checkoutError) setDetailsOpen(true);
  }, [checkoutError]);
  useEffect(() => {
    if (saleType === "online") setDetailsOpen(true);
  }, [saleType]);
  // How tall the open details may be: whatever is left once the header, the strip and
  // the totals bar have their share, keeping about two cart rows on screen. null means
  // they fit as they are — then nothing scrolls inside them and dropdowns open freely.
  const panelRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const detailsContentRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const pinnedRef = useRef<HTMLDivElement>(null);
  const [detailsMaxHeight, setDetailsMaxHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const panel = panelRef.current;
      const content = detailsContentRef.current;
      if (!panel || !content) return;
      const fixed = (headerRef.current?.offsetHeight ?? 0) + (toggleRef.current?.offsetHeight ?? 0) + (pinnedRef.current?.offsetHeight ?? 0);
      const room = panel.clientHeight - fixed - 120;
      setDetailsMaxHeight(content.scrollHeight > room ? Math.max(room, 120) : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    [panelRef.current, headerRef.current, detailsContentRef.current, pinnedRef.current].forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);
  function toggleDetails() {
    const next = !detailsOpen;
    setDetailsOpen(next);
    try {
      localStorage.setItem("mm_pos_details_open", next ? "1" : "0");
    } catch {
      // remembering the choice is optional
    }
  }
  const [checkoutSuccess, setCheckoutSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // "Save as Quotation" — a price-confirmation bill sent to the
  // customer before anything is actually paid for; see beginQuotation.
  const [showQuotationModal, setShowQuotationModal] = useState(false);
  const [quotationValidDays, setQuotationValidDays] = useState("7");
  const [quotationError, setQuotationError] = useState<string | null>(null);
  const [savingQuotation, setSavingQuotation] = useState(false);
  // Set once a quotation has been saved — drives the "Get quotation"
  // print/WhatsApp options, same pattern as Sale Detail's receipt modal.
  const [savedQuotation, setSavedQuotation] = useState<Sale | null>(null);
  const [quotationReceiptError, setQuotationReceiptError] = useState<string | null>(null);
  // Set while a saved quotation is reopened here (from the Quotations
  // page): everything below then edits/finalizes THAT quotation —
  // "Quotation" updates it in place, "Checkout" turns it into the real
  // sale — rather than creating a new, unrelated record.
  const [editingQuotation, setEditingQuotation] = useState<{ id: number; invoice: string } | null>(null);
  const [quotationLoadError, setQuotationLoadError] = useState<string | null>(null);

  const subtotal = cart.reduce((sum, line) => sum + line.unit_price * line.units.length, 0);
  const totalCartUnits = cart.reduce((sum, line) => sum + line.units.length, 0);

  const manualDiscountAmount =
    discountType === "percent" ? Math.round((subtotal * (parseFloat(discountValue) || 0)) / 100) : parseFloat(discountValue) || 0;
  const couponDiscountAmount = appliedCoupon
    ? appliedCoupon.discount_type === "percent"
      ? Math.round((subtotal * appliedCoupon.discount_value) / 100)
      : appliedCoupon.discount_value
    : 0;
  const combinedDiscount = manualDiscountAmount + couponDiscountAmount;
  const paymentLabels: Record<string, string> = { cash: "Cash", card: "Card", bank_transfer: "Bank" };
  const detailsSummary = [
    selectedCustomer ? selectedCustomer.name : saleType === "online" ? "No customer yet" : "Walk-in",
    combinedDiscount > 0 ? `Discount Rs. ${combinedDiscount.toLocaleString()}` : null,
    saleType === "online"
      ? deliveryPartner
        ? partnerLabel(deliveryPartner)
        : null
      : isCreditSale
        ? "Credit"
        : (paymentLabels[paymentMethod] ?? paymentMethod),
  ]
    .filter(Boolean)
    .join(" · ");

  const total = Math.max(0, subtotal - combinedDiscount);
  const availableStoreCredit = selectedCustomer?.store_credit_balance ?? 0;
  const storeCreditApplied = useStoreCredit ? Math.min(availableStoreCredit, total) : 0;
  const remainingAfterCredit = Math.max(0, total - storeCreditApplied);
  const paidAmount = parseFloat(amountPaid) || 0;
  const changeDue = paymentMethod === "cash" && paidAmount > remainingAfterCredit ? paidAmount - remainingAfterCredit : 0;
  const cashPresets = [500, 1000, 2000, 5000, 10000, 20000];

  const loyaltyBlocked = selectedCustomer?.loyalty_blocked === 1;
  const noLoyalty = loyaltyBlocked || isWholesale;
  // Same look as the Free delivery / Credit ticks: a short label, with the
  // explanation in a hint. Locked on for a customer who never earns points.
  const wholesaleTick = (
    <PosTick
      checked={noLoyalty}
      disabled={loyaltyBlocked || !selectedCustomer}
      onChange={setIsWholesale}
      label="Wholesale"
      hint={selectedCustomer ? "A wholesale order — no loyalty points for this sale." : "Select a customer first — walk-ins don't earn points anyway."}
    />
  );
  const wholesaleNote =
    loyaltyBlocked && selectedCustomer ? (
      <p className="text-xs text-gray-400 -mt-2">
        {selectedCustomer.name} doesn't earn points{selectedCustomer.loyalty_block_reason ? ` — ${selectedCustomer.loyalty_block_reason}` : ""}.
      </p>
    ) : null;
  const { partners, activePartners } = useDeliveryPartners();
  const selectedPartner = partners.find((p) => p.code === deliveryPartner);
  const isOnDemand = selectedPartner?.kind === "on_demand";
  const fareAmount = parseFloat(deliveryFare) || 0;
  const onDemandFare: OnDemandFare = { fare: deliveryFare, paidBy: deliveryPaidBy, fareLater: deliveryFareLater };
  const fareChange = (patch: Partial<OnDemandFare>) => {
    if (patch.fare !== undefined) setDeliveryFare(patch.fare);
    if (patch.paidBy !== undefined) setDeliveryPaidBy(patch.paidBy);
    if (patch.fareLater !== undefined) setDeliveryFareLater(patch.fareLater);
  };
  // 'Free — we pay' waives it for the customer (we bear the fare);
  // 'customer pays us' charges it to them. 'Customer pays the rider' has
  // no fare for us to charge, and a fare still to come is charged once
  // it's known.
  const deliveryIsFree = isOnDemand ? deliveryPaidBy === "shop" : isFreeDelivery;
  const fareAwaited = isOnDemand && deliveryPaidBy !== "rider_direct" && deliveryFareLater;
  const deliveryFee = isOnDemand
    ? deliveryIsFree || deliveryPaidBy === "rider_direct" || fareAwaited
      ? 0
      : fareAmount
    : calculateDeliveryFee(parseFloat(packageWeight) || 0, isFreeDelivery, selectedPartner);
  const advanceAmount = parseFloat(advancePaid) || 0;
  // On a credit online order, the product price is tracked as balance
  // due (not collected at all today) — only the delivery fee is ever
  // COD, per the business rule that delivery is always paid at the door
  // regardless of credit status.
  const codAmount = isCreditSale ? deliveryFee : calculateCodAmount(total, advanceAmount, deliveryFee);

  const cartIds = new Set(cart.flatMap((l) => l.units.map((u) => u.id)));
  const browserUnits = (allAvailableUnits ?? []).filter((u) => !cartIds.has(u.id));
  // The Product catalog follows the search box: whatever is typed there narrows the
  // catalog too (same typo-tolerant matching as the dropdown), on top of the category chips.
  const cartIdsKey = Array.from(cartIds).join(",");
  const browserIndex = useMemo(() => createProductSearchIndex(browserUnits), [allAvailableUnits, cartIdsKey]);
  const browserQuery = productQuery.trim();
  const browserSearched = useMemo(() => (browserQuery ? searchProductUnits(browserIndex, browserQuery) : browserUnits), [browserIndex, browserQuery]);
  // Category chips show only categories that still have a match — plus the one that's selected, so it can always be un-picked.
  const browserCategories = Array.from(
    new Set([...(browserCategory !== "all" ? [browserCategory] : []), ...browserSearched.map((u) => (u.category ?? "").split(" / ")[0]).filter(Boolean)])
  ).sort();
  const browserFiltered = browserCategory === "all" ? browserSearched : browserSearched.filter((u) => (u.category ?? "").startsWith(browserCategory));
  const browserEmptyText = browserQuery
    ? `No available items match “${browserQuery}”${browserCategory !== "all" ? " in this category" : ""}`
    : "No available items in this category";
  function clearProductSearch() {
    setProductQuery("");
    setProductResults([]);
    setProductSearchOpen(false);
    setProductSearchError(null);
  }
  const browserFilterNote = browserQuery ? (
    <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-600">
      <span className="truncate">
        Filtered by “{browserQuery}” · {browserFiltered.length} item{browserFiltered.length === 1 ? "" : "s"}
      </span>
      <button type="button" onClick={clearProductSearch} aria-label="Clear the search" title="Clear the search" className="flex-shrink-0 text-gray-400 hover:text-gray-700">
        <X size={12} />
      </button>
    </div>
  ) : null;

  // "/" jumps straight into the product search — the most repeated action
  // on this page — from anywhere else on it, same convention as GitHub/Slack.
  useKeyboardShortcut("/", () => productInputRef.current?.focus());

  function startEditPrice(line: CartLine) {
    setEditingLineKey(cartLineKey(line.units[0]));
    setEditPriceValue(String(line.unit_price));
    setPriceEditError(null);
  }

  function saveEditPrice(lineKey: string) {
    const line = cart.find((l) => cartLineKey(l.units[0]) === lineKey);
    if (!line) return;
    const newPrice = parseFloat(editPriceValue);
    if (isNaN(newPrice) || newPrice < 0) {
      setPriceEditError("Enter a valid price");
      return;
    }
    const originalPrice = line.units[0].selling_price ?? 0;
    // Staff can only sell at or below the listed price; an admin may also
    // price above it (a special order, a corrected tag...).
    if (newPrice > originalPrice && !isAdmin) {
      setPriceEditError(`Only an admin can go above the original price (Rs. ${originalPrice.toLocaleString()})`);
      return;
    }
    setCart((c) => c.map((l) => (cartLineKey(l.units[0]) === lineKey ? { ...l, unit_price: newPrice } : l)));
    setEditingLineKey(null);
    setEditPriceValue("");
    setPriceEditError(null);
  }

  function cancelEditPrice() {
    setEditingLineKey(null);
    setEditPriceValue("");
    setPriceEditError(null);
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (productBoxRef.current && !productBoxRef.current.contains(e.target as Node)) {
        setProductSearchOpen(false);
      }
      if (customerBoxRef.current && !customerBoxRef.current.contains(e.target as Node)) {
        setCustomerSearchOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Restore an in-progress sale left over from before navigating away
  // (or an accidental refresh) — runs once, on mount. Every cart unit
  // is then checked against its real current status, since time may
  // have passed and another sale could have taken one of them; anything
  // no longer available is struck through rather than silently dropped.
  useEffect(() => {
    const quotationParam = searchParams.get("quotation");
    if (quotationParam) {
      loadQuotationIntoCart(quotationParam);
      return;
    }

    const draft = loadDraftSale();
    if (!draft) return;

    setSaleType(draft.saleType);
    setCart(draft.cart);
    setSelectedCustomer(draft.selectedCustomer);
    setIsCreditSale(draft.isCreditSale);
    setCreditAmountPaid(draft.creditAmountPaid);
    setCreditPaymentMethod(draft.creditPaymentMethod);
    setDeliveryPartner(draft.deliveryPartner as DeliveryPartner | "");
    setPackageWeight(draft.packageWeight);
    setIsFreeDelivery(draft.isFreeDelivery);
    setDeliveryFare(draft.deliveryFare ?? "");
    // (an older saved draft may carry a choice that no longer exists)
    setDeliveryPaidBy(draft.deliveryPaidBy === "shop" || draft.deliveryPaidBy === "rider_direct" ? draft.deliveryPaidBy : "customer");
    setDeliveryFareLater(draft.deliveryFareLater ?? false);
    setIsWholesale(draft.isWholesale ?? false);
    setAdvancePaid(draft.advancePaid);
    setAdvancePaymentMethod(draft.advancePaymentMethod);
    setDiscountType(draft.discountType);
    setDiscountValue(draft.discountValue);
    setCouponCode(draft.couponCode);
    setAppliedCoupon(draft.appliedCoupon);
    setUseStoreCredit(draft.useStoreCredit);
    setPaymentMethod(draft.paymentMethod);
    setEditingQuotation(draft.quotation ?? null);

    if (draft.cart.length > 0) {
      const allIds = draft.cart.flatMap((line) => line.units.map((u) => u.id));
      api
        .post<{ id: number; status: string }[]>("/inventory/check-status", { ids: allIds })
        .then((results) => {
          const stale = new Set(results.filter((r) => r.status !== "available").map((r) => r.id));
          if (stale.size > 0) setStaleUnitIds(stale);
        })
        .catch(() => {
          // if the check itself fails, the restored cart is still shown
          // as-is — checkout's own real validation is the final backstop
        });
    }
  }, []);

  // Save the in-progress sale on every relevant change, so leaving the
  // page (deliberately or by accident) never loses it. Deliberately
  // excludes ephemeral UI state (search boxes, which line is mid-edit,
  // the add-customer modal) — only the "resume this exact sale" fields.
  useEffect(() => {
    const draft: PosDraftSale = {
      saleType,
      cart,
      selectedCustomer,
      isCreditSale,
      creditAmountPaid,
      creditPaymentMethod,
      deliveryPartner,
      packageWeight,
      isFreeDelivery,
      deliveryFare,
      deliveryPaidBy,
      deliveryFareLater,
      isWholesale,
      advancePaid,
      advancePaymentMethod,
      discountType,
      discountValue,
      couponCode,
      appliedCoupon,
      useStoreCredit,
      paymentMethod,
      quotation: editingQuotation,
    };
    saveDraftSale(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    saleType,
    cart,
    selectedCustomer,
    isCreditSale,
    creditAmountPaid,
    creditPaymentMethod,
    deliveryPartner,
    packageWeight,
    isFreeDelivery,
    deliveryFare,
    deliveryPaidBy,
    deliveryFareLater,
    isWholesale,
    advancePaid,
    advancePaymentMethod,
    discountType,
    discountValue,
    couponCode,
    appliedCoupon,
    useStoreCredit,
    paymentMethod,
    editingQuotation,
  ]);

  // Reopen a saved quotation here (arrived from the Quotations page via
  // ?quotation=ID) so it can be adjusted and either re-saved or checked
  // out as a real sale. Items keep the price they were quoted at; each
  // unit is re-checked against real stock, since nothing was reserved
  // when the quote was saved and another sale may have taken one.
  async function loadQuotationIntoCart(idParam: string) {
    setSearchParams({}, { replace: true });
    setQuotationLoadError(null);
    try {
      const q = await api.get<Sale>(`/sales/${idParam}`);
      if (q.status !== "quotation") {
        setQuotationLoadError(`${q.invoice} isn't an open quotation anymore.`);
        return;
      }

      const lines = new Map<string, CartLine>();
      for (const item of q.items ?? []) {
        if (!item.inventory_id) continue;
        const unit: InventoryUnit = {
          id: item.inventory_id,
          product_id: item.product_id ?? 0,
          size: item.size ?? null,
          color: item.color ?? null,
          sku: item.sku ?? "",
          barcode: item.barcode ?? null,
          selling_price: item.original_selling_price ?? null,
          status: "available",
          created_at: "",
          product_title: item.product_title,
          brand: item.brand,
        };
        const key = cartLineKey(unit);
        const existing = lines.get(key);
        if (existing) existing.units.push(unit);
        else lines.set(key, { units: [unit], unit_price: item.unit_price });
      }
      const cartLines = Array.from(lines.values());

      setSaleType(q.sale_type);
      setCart(cartLines);
      setEditingQuotation({ id: q.id, invoice: q.invoice });
      setDiscountType("fixed");
      setDiscountValue(String(q.manual_discount));

      if (q.customer_id) {
        api
          .get<Customer>(`/customers/${q.customer_id}`)
          .then((c) => {
            setSelectedCustomer(c);
            setCustomerQuery("");
          })
          .catch(() => {});
      }

      if (q.coupon_code) {
        setCouponCode(q.coupon_code);
        try {
          const coupon = await api.get<Coupon>(`/coupons/validate/${encodeURIComponent(q.coupon_code)}`);
          setAppliedCoupon(coupon);
        } catch {
          // The quoted price still has to hold — keep the coupon's
          // discount as a plain manual discount instead of silently
          // raising the customer's total.
          setDiscountValue(String(q.manual_discount + q.coupon_discount));
          setCouponCode("");
          setCouponError(`Coupon ${q.coupon_code} is no longer valid — its Rs. ${q.coupon_discount.toLocaleString()} discount was kept as a manual discount to match the quoted price.`);
        }
      }

      const ids = cartLines.flatMap((line) => line.units.map((u) => u.id));
      if (ids.length > 0) {
        api
          .post<{ id: number; status: string }[]>("/inventory/check-status", { ids })
          .then((results) => {
            const stale = new Set(results.filter((r) => r.status !== "available").map((r) => r.id));
            if (stale.size > 0) setStaleUnitIds(stale);
          })
          .catch(() => {});
      }
    } catch (err) {
      setQuotationLoadError(err instanceof ApiRequestError ? err.message : "Failed to open this quotation");
    }
  }

  function exitQuotationEdit() {
    if (!confirm("Stop editing this quotation? The cart will be cleared — the quotation stays as it was last saved.")) return;
    setEditingQuotation(null);
    setCart([]);
    setStaleUnitIds(new Set());
    setSelectedCustomer(null);
    setCustomerQuery("");
    setDiscountType("fixed");
    setDiscountValue("0");
    setCouponCode("");
    setAppliedCoupon(null);
    setCouponError(null);
    setAmountPaid("");
    setAllAvailableUnits(null);
  }

  async function ensureUnitsLoaded() {
    if (allAvailableUnits) return allAvailableUnits;
    const units = await api.get<InventoryUnit[]>("/inventory?status=available");
    setAllAvailableUnits(units);
    return units;
  }

  function toggleBrowser() {
    setShowBrowser((v) => {
      const next = !v;
      if (next) ensureUnitsLoaded();
      return next;
    });
  }

  async function handleProductQueryChange(value: string) {
    setProductQuery(value);
    setProductSearchOpen(true);
    setProductSearchError(null);
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      setProductResults([]);
      return;
    }
    const units = await ensureUnitsLoaded();
    const alreadyInCart = new Set(cart.flatMap((l) => l.units.map((u) => u.id)));
    const availableForSearch = units.filter((u) => !alreadyInCart.has(u.id));
    const matches = searchProductUnits(createProductSearchIndex(availableForSearch), trimmed);
    setProductResults(matches);
  }

  async function handleProductEnter(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const trimmed = productQuery.trim().toLowerCase();
    if (!trimmed) return;
    const units = await ensureUnitsLoaded();
    const exact = units.find((u) => u.barcode?.toLowerCase() === trimmed || u.sku.toLowerCase() === trimmed);
    if (exact) {
      addToCart(exact);
      return;
    }
    if (productResults.length === 1) {
      addToCart(productResults[0]);
      return;
    }
    setProductSearchError("No exact match — pick one from the list below, or refine your search");
  }

  function addToCart(unit: InventoryUnit, keepSearch = false) {
    const key = cartLineKey(unit);
    const existingLine = cart.find((l) => cartLineKey(l.units[0]) === key);

    if (existingLine) {
      setCart((c) => c.map((l) => (cartLineKey(l.units[0]) === key ? { ...l, units: [...l.units, unit] } : l)));
    } else {
      setCart((c) => [...c, { units: [unit], unit_price: unit.selling_price ?? 0 }]);
    }

    if (keepSearch) {
      setProductResults((r) => r.filter((x) => x.id !== unit.id));
    } else {
      setProductQuery("");
      setProductResults([]);
      setProductSearchOpen(false);
    }
    setAllAvailableUnits((prev) => (prev ? prev.filter((u) => u.id !== unit.id) : prev));
  }

  function removeFromCart(lineKey: string) {
    const line = cart.find((l) => cartLineKey(l.units[0]) === lineKey);
    if (line && line.units.length === 1) {
      // Removing the last unit deletes the whole line — worth a quick
      // confirmation, unlike reducing 3 units down to 2.
      if (!confirm(`Remove ${line.units[0].product_title} from the cart?`)) return;
    }
    setCart((c) => {
      const removedUnit = c.find((l) => cartLineKey(l.units[0]) === lineKey)?.units.slice(-1)[0];
      if (removedUnit != null) {
        setStaleUnitIds((prev) => {
          if (!prev.has(removedUnit.id)) return prev;
          const next = new Set(prev);
          next.delete(removedUnit.id);
          return next;
        });
        // It's genuinely back in stock, not sold — put it back in the
        // available pool so the + stepper and search/browse can offer
        // it again instead of wrongly treating it as gone for the rest
        // of this session.
        setAllAvailableUnits((prev) => (prev ? [...prev, removedUnit] : prev));
      }
      return c.map((l) => (cartLineKey(l.units[0]) === lineKey ? { ...l, units: l.units.slice(0, -1) } : l)).filter((l) => l.units.length > 0);
    });
  }

  // How many more units of this exact product+color+size are still free
  // to add — same pool the search/browse panels already draw from, so
  // the + button follows the identical stock rule they enforce.
  function remainingAvailable(lineKey: string): number {
    const cartIds = new Set(cart.flatMap((l) => l.units.map((u) => u.id)));
    return (allAvailableUnits ?? []).filter((u) => cartLineKey(u) === lineKey && !cartIds.has(u.id)).length;
  }

  function incrementCartLine(lineKey: string) {
    const cartIds = new Set(cart.flatMap((l) => l.units.map((u) => u.id)));
    const nextUnit = (allAvailableUnits ?? []).find((u) => cartLineKey(u) === lineKey && !cartIds.has(u.id));
    if (!nextUnit) return;
    addToCart(nextUnit);
  }

  async function ensureCustomersLoaded() {
    if (allCustomers) return allCustomers;
    const customers = await api.get<Customer[]>("/customers");
    setAllCustomers(customers);
    return customers;
  }

  async function handleCustomerQueryChange(value: string) {
    setCustomerQuery(value);
    setCustomerSearchOpen(true);
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length < 2) {
      setCustomerResults([]);
      return;
    }
    const customers = await ensureCustomersLoaded();
    setCustomerResults(
      customers.filter(
        (c) =>
          c.name.toLowerCase().includes(trimmed) ||
          c.customer_code.toLowerCase().includes(trimmed) ||
          c.phone?.toLowerCase().includes(trimmed) ||
          c.phone2?.toLowerCase().includes(trimmed)
      )
    );
  }

  async function selectCustomer(c: Customer) {
    if (c.is_suspended === 1) {
      setCustomerSearchOpen(false);
      alert(`${c.name} is suspended${c.suspended_reason ? ` (${c.suspended_reason})` : ""} and can't be selected for a new sale. Reactivate them from the Customers page first if this was a mistake.`);
      return;
    }
    // Use the cached search result immediately so selection feels
    // instant, then replace it with a fresh fetch — the cached
    // allCustomers list can be stale for anyone who's been on this page
    // a while (a payment, a return credit, anything could have changed
    // their real balance since the list was first loaded this session).
    setSelectedCustomer(c);
    setCustomerQuery("");
    setCustomerResults([]);
    setCustomerSearchOpen(false);
    try {
      const fresh = await api.get<Customer>(`/customers/${c.id}`);
      if (fresh.is_suspended === 1) {
        // Suspended since the search results were shown — the fresh
        // fetch just caught it. Undo the selection rather than letting
        // it through.
        setSelectedCustomer(null);
        alert(`${fresh.name} was suspended just now and can't be selected for a new sale.`);
        return;
      }
      setSelectedCustomer(fresh);
    } catch {
      // If the refresh fails, the cached version already selected is
      // still a reasonable fallback — better than blocking selection
      // entirely over a network hiccup.
    }
  }

  function removeCustomer() {
    setSelectedCustomer(null);
    setIsCreditSale(false);
    setIsWholesale(false);
    setUseStoreCredit(false);
  }

  function openAddCustomer() {
    setShowAddCustomer(true);
    const trimmedQuery = customerQuery.trim();
    const looksLikePhone = trimmedQuery !== "" && !isNaN(Number(trimmedQuery));
    setNewCustomerName(looksLikePhone ? "" : trimmedQuery);
    setNewCustomerPhone(looksLikePhone ? normalizePhone(trimmedQuery) : "");
    setNewCustomerPhone2("");
    setNewCustomerGender("unspecified");
    setNewCustomerAddr1("");
    setNewCustomerAddr2("");
    setNewCustomerCity("");
    setAddCustomerError(null);
    setCustomerSearchOpen(false);
  }

  async function submitNewCustomer() {
    setAddCustomerError(null);
    if (!newCustomerName.trim()) {
      setAddCustomerError("Name is required");
      return;
    }
    if (!newCustomerPhone.trim()) {
      setAddCustomerError("At least one phone number is required");
      return;
    }
    const badPhone = phoneError(newCustomerPhone) ?? phoneError(newCustomerPhone2);
    if (badPhone) {
      setAddCustomerError(badPhone);
      return;
    }
    setAddCustomerSubmitting(true);
    try {
      const created = await api.post<Customer>("/customers", {
        name: newCustomerName.trim(),
        phone: normalizePhone(newCustomerPhone),
        phone2: normalizePhone(newCustomerPhone2) || undefined,
        gender: newCustomerGender,
      });

      if (newCustomerAddr1.trim() || newCustomerCity.trim()) {
        await api.post(`/customers/${created.id}/addresses`, {
          address_line1: newCustomerAddr1.trim() || undefined,
          address_line2: newCustomerAddr2.trim() || undefined,
          city: newCustomerCity.trim() || undefined,
          is_default: true,
        });
      }

      setSelectedCustomer(created);
      setAllCustomers((prev) => (prev ? [...prev, created] : prev));
      setShowAddCustomer(false);
      setNewCustomerName("");
      setNewCustomerPhone("");
      setNewCustomerPhone2("");
      setNewCustomerGender("unspecified");
      setNewCustomerAddr1("");
      setNewCustomerAddr2("");
      setNewCustomerCity("");
      setCustomerQuery("");
    } catch (err) {
      setAddCustomerError(err instanceof ApiRequestError ? err.message : "Failed to add customer");
    } finally {
      setAddCustomerSubmitting(false);
    }
  }

  function clearCart() {
    if (cart.length > 0 && confirm("Clear entire cart?")) {
      setCart([]);
      setDiscountValue("0");
      setCouponCode("");
      setAppliedCoupon(null);
      setCouponError(null);
      setAmountPaid("");
    }
  }

  async function applyCoupon() {
    const code = couponCode.trim();
    if (!code) return;
    setCouponError(null);
    setCouponChecking(true);
    try {
      const coupon = await api.get<Coupon>(`/coupons/validate/${encodeURIComponent(code)}`);
      setAppliedCoupon(coupon);
      setCheckoutSuccess(
        `Coupon applied: ${coupon.code} – ${coupon.discount_type === "percent" ? `${coupon.discount_value}% off` : `Rs. ${coupon.discount_value.toLocaleString()} off`}`
      );
    } catch (err) {
      setAppliedCoupon(null);
      setCouponError(err instanceof ApiRequestError ? err.message : "Failed to check that coupon");
    } finally {
      setCouponChecking(false);
    }
  }

  function removeCoupon() {
    setAppliedCoupon(null);
    setCouponCode("");
    setCouponError(null);
  }

  async function beginCheckout() {
    setCheckoutError(null);

    if (saleType === "online") {
      if (!selectedCustomer) {
        setCheckoutError(`Select or add a customer before completing an online order${isOnDemand ? "." : " — delivery needs their address."}`);
        return;
      }
      // Uber / PickMe-style delivery goes wherever the customer tells the
      // rider — no address or city to check, so straight to the review.
      if (isOnDemand) {
        setShowCheckoutModal(true);
        return;
      }
      // Fetch the freshest copy of their addresses rather than trusting
      // whatever was loaded when they were first selected — the whole
      // point is catching a stale or missing address before shipping.
      setAddressCheckLoading(true);
      try {
        const full = await api.get<Customer>(`/customers/${selectedCustomer.id}`);
        setCustomerAddresses(full.addresses ?? []);
        setNewAddrLine1("");
        setNewAddrLine2("");
        setNewAddrCity("");
        setAddressCheckError(null);
        setShowAddressCheck(true);
      } catch {
        setCheckoutError("Failed to load this customer's address — try again.");
      } finally {
        setAddressCheckLoading(false);
      }
      return;
    }

    setShowCheckoutModal(true);
  }

  async function confirmAddressAndProceed() {
    setAddressCheckError(null);
    const defaultAddr = customerAddresses?.find((a) => a.is_default) ?? customerAddresses?.[0];

    // No address on file at all — the new-address fields must be filled
    // in before proceeding, since delivery genuinely has nowhere to go.
    if (!defaultAddr) {
      if (!newAddrLine1.trim() && !newAddrCity.trim()) {
        setAddressCheckError("Enter at least an address line or city — this customer has no address on file.");
        return;
      }
      if (!selectedCustomer) return;
      try {
        await api.post(`/customers/${selectedCustomer.id}/addresses`, {
          address_line1: newAddrLine1.trim() || undefined,
          address_line2: newAddrLine2.trim() || undefined,
          city: newAddrCity.trim() || undefined,
          is_default: true,
        });
      } catch (err) {
        setAddressCheckError(err instanceof ApiRequestError ? err.message : "Failed to save this address");
        return;
      }
    }

    setShowAddressCheck(false);
    setShowCheckoutModal(true);
  }

  async function handleCheckout() {
    setCheckoutError(null);
    setCheckoutSuccess(null);

    if (cart.length === 0) {
      setCheckoutError("Cart is empty");
      return;
    }
    if (cart.some((line) => line.units.some((u) => staleUnitIds.has(u.id)))) {
      setCheckoutError("One or more items in the cart are no longer in stock — remove them before checking out.");
      return;
    }
    if (saleType === "online" && !selectedCustomer) {
      setCheckoutError(`Select or add a customer before completing an online order${isOnDemand ? "." : " — delivery needs their address."}`);
      setShowCheckoutModal(false);
      return;
    }
    if (saleType === "online" && !deliveryPartner) {
      setCheckoutError("Select a delivery partner for this online order.");
      return;
    }
    const fareError = saleType === "online" && isOnDemand ? onDemandFareError(onDemandFare, selectedPartner?.name ?? "this partner") : null;
    if (fareError) {
      setCheckoutError(fareError);
      return;
    }
    if (isCreditSale) {
      const creditPaid = parseFloat(creditAmountPaid) || 0;
      if (creditPaid > total) {
        setCheckoutError("Amount paid can't exceed the order total on a credit sale.");
        return;
      }
    } else if (saleType === "in_store" && paymentMethod === "cash" && !isCreditSale && paidAmount < remainingAfterCredit) {
      setCheckoutError("Cash tendered is less than the amount due");
      return;
    }

    // Cash tendered above what's due, WITH a real customer attached —
    // this needs an explicit choice (change back, or kept as credit)
    // before proceeding. A walk-in has nowhere to keep credit, so this
    // never applies to them; they just get change automatically, same
    // as always.
    const pendingCashExtra =
      !isCreditSale && saleType === "in_store" && paymentMethod === "cash" && paidAmount > remainingAfterCredit
        ? paidAmount - remainingAfterCredit
        : 0;
    if (pendingCashExtra > 0 && selectedCustomer && keepOverpaymentAsCredit === null) {
      setSubmitting(false);
      setShowOverpaymentChoice(true);
      return;
    }

    // What actually gets recorded as paid right now, against the
    // PRODUCT total (sales.amount_paid) — the delivery fee is tracked
    // separately on the delivery record's cod_amount and never touches
    // this figure:
    // - credit sale (in-store): whatever partial amount was given (0 by default)
    // - credit sale (online): always 0 — the whole product goes on credit,
    //   only the delivery fee is collected today
    // - online, not credit: any advance paid up front (the rest of product+delivery is COD)
    // - in-store, not credit: cash tendered, or the full total for card/bank transfer
    const finalAmountPaid =
      isCreditSale && saleType === "online"
        ? 0
        : isCreditSale
        ? parseFloat(creditAmountPaid) || 0
        : saleType === "online"
        ? advanceAmount
        : paymentMethod === "cash"
        ? paidAmount
        : remainingAfterCredit;

    setSubmitting(true);
    try {
      // "credit" as the stored payment_method only makes sense when
      // NOTHING was paid today — if a partial amount came in, the real
      // channel it arrived through (cash/card/bank) is what should be
      // recorded, since that's what actually needs reconciling in the
      // cash book. The credit/balance-due nature of the sale is still
      // fully captured by amount_paid < total, independent of this field.
      const effectivePaymentMethod =
        isCreditSale && saleType === "in_store" && (parseFloat(creditAmountPaid) || 0) > 0
          ? creditPaymentMethod
          : isCreditSale
          ? "credit"
          : saleType === "online"
          ? advancePaymentMethod
          : paymentMethod;

      const sale = await api.post<{ invoice: string }>("/sales", {
        customer_id: selectedCustomer?.id,
        salesperson: user?.name ?? user?.username,
        items: cart.flatMap((line) => line.units.map((u) => ({ inventory_id: u.id, unit_price: line.unit_price }))),
        manual_discount_type: discountType,
        manual_discount_value: parseFloat(discountValue) || 0,
        coupon_code: appliedCoupon?.code,
        amount_paid: finalAmountPaid,
        store_credit_applied: storeCreditApplied,
        payment_method: effectivePaymentMethod,
        amount_received: paymentMethod === "cash" && saleType === "in_store" && !isCreditSale ? paidAmount : undefined,
        keep_cash_overpayment_as_credit: keepOverpaymentAsCredit === true,
        sale_type: saleType,
        is_credit_order: isCreditSale,
        ...(selectedCustomer && isWholesale ? { is_wholesale: true } : {}),
        quotation_id: editingQuotation?.id,
        ...(saleType === "online"
          ? {
              delivery_partner: deliveryPartner,
              package_weight_kg: parseFloat(packageWeight) || undefined,
              is_free_delivery: deliveryIsFree,
              ...(isOnDemand ? onDemandPayload(onDemandFare) : {}),
            }
          : {}),
      });

      setCheckoutSuccess(`Sale complete — ${sale.invoice}${saleType === "online" ? ". A pending delivery was created automatically." : "."}`);
      clearDraftSale();
      setEditingQuotation(null);
      setStaleUnitIds(new Set());
      setCart([]);
      setSelectedCustomer(null);
      setCustomerQuery("");
      setDiscountType("fixed");
      setDiscountValue("0");
      setCouponCode("");
      setAppliedCoupon(null);
      setCouponError(null);
      setUseStoreCredit(false);
      setAmountPaid("");
      setKeepOverpaymentAsCredit(null);
      setAllAvailableUnits(null);
      setShowCheckoutModal(false);
      setIsCreditSale(false);
      setIsWholesale(false);
      setCreditAmountPaid("0");
      setCreditPaymentMethod("cash");
      setDeliveryPartner("");
      setPackageWeight("");
      setIsFreeDelivery(false);
      setDeliveryFare("");
      setDeliveryPaidBy("customer");
      setDeliveryFareLater(false);
      setAdvancePaid("");
      setAdvancePaymentMethod("cash");
    } catch (err) {
      setCheckoutError(err instanceof ApiRequestError ? err.message : "Checkout failed");
    } finally {
      setSubmitting(false);
    }
  }

  // "Save as Quotation" — a price-confirmation bill for the customer to
  // approve before anything is actually paid for. No delivery-partner or
  // payment details are collected here (nothing's being shipped or
  // charged yet) — just the items, customer, and discount/coupon already
  // on the cart, locked in at today's price for however many days this
  // quote stays valid.
  function beginQuotation() {
    setQuotationError(null);
    if (cart.length === 0) {
      setCheckoutError("Cart is empty");
      return;
    }
    if (cart.some((line) => line.units.some((u) => staleUnitIds.has(u.id)))) {
      setCheckoutError("One or more items in the cart are no longer in stock — remove them before saving a quotation.");
      return;
    }
    setQuotationValidDays("7");
    setShowQuotationModal(true);
  }

  async function handleSaveQuotation() {
    setQuotationError(null);
    const validDays = parseInt(quotationValidDays, 10);
    if (!validDays || validDays <= 0) {
      setQuotationError("Enter how many days this quote should stay valid for.");
      return;
    }

    setSavingQuotation(true);
    try {
      const payload = {
        customer_id: selectedCustomer?.id,
        salesperson: user?.name ?? user?.username,
        items: cart.flatMap((line) => line.units.map((u) => ({ inventory_id: u.id, unit_price: line.unit_price }))),
        manual_discount_type: discountType,
        manual_discount_value: parseFloat(discountValue) || 0,
        coupon_code: appliedCoupon?.code,
        sale_type: saleType,
        valid_days: validDays,
      };
      // Editing a reopened quotation updates that same record (same
      // number the customer may already have); otherwise it's a
      // brand-new one.
      const created = editingQuotation
        ? await api.put<{ id: number }>(`/sales/quotations/${editingQuotation.id}`, payload)
        : await api.post<{ id: number }>("/sales/quotations", payload);

      // Fetch the fully joined record (items, customer phone, etc.) so
      // the receipt/WhatsApp options below have everything they need —
      // same pattern Sale History's own "Get receipt" uses.
      const full = await api.get<Sale>(`/sales/${created.id}`);

      setShowQuotationModal(false);
      setSavedQuotation(full);
      setEditingQuotation(null);
      clearDraftSale();
      setStaleUnitIds(new Set());
      setCart([]);
      setSelectedCustomer(null);
      setCustomerQuery("");
      setDiscountType("fixed");
      setDiscountValue("0");
      setCouponCode("");
      setAppliedCoupon(null);
      setCouponError(null);
      setAllAvailableUnits(null);
    } catch (err) {
      setQuotationError(err instanceof ApiRequestError ? err.message : "Failed to save this quotation");
    } finally {
      setSavingQuotation(false);
    }
  }

  function quotationReceiptOptions(sale: Sale): ModalOption[] {
    return [
      {
        key: "a4",
        icon: <FileText size={16} className="text-gray-700" />,
        title: "A4 Quotation (PDF)",
        subtitle: "Full-page printable quote",
        onClick: () => downloadA4Pdf(sale),
      },
      {
        key: "thermal",
        icon: <Receipt size={16} className="text-gray-700" />,
        title: "80mm Receipt (PDF)",
        subtitle: "For thermal till printers",
        onClick: () => downloadThermalPdf(sale),
      },
      {
        key: "whatsapp",
        icon: <MessageCircle size={16} className="text-green-600" />,
        iconBgClass: "bg-green-50",
        title: "Send via WhatsApp",
        subtitle: "Text summary to customer's phone",
        onClick: () => {
          if (!sale.customer_phone) {
            setQuotationReceiptError("This customer has no saved phone number — add one on the Customers page first.");
            return;
          }
          setQuotationReceiptError(null);
          sendWhatsAppBill(sale, sale.customer_phone);
        },
      },
    ];
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col p-3 lg:p-4 gap-3 lg:gap-4 overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-3 lg:gap-4">
        <div ref={panelRef} className="flex-1 min-h-0 flex flex-col bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <div ref={headerRef} className="p-4 border-b border-gray-200 bg-white flex-shrink-0">
            <div className="flex flex-col gap-3 lg:grid lg:grid-cols-3 lg:items-center">
              <div className="flex items-center justify-between gap-3 min-w-0">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 bg-black rounded-full flex items-center justify-center flex-shrink-0">
                    <ShoppingCart size={18} className="text-white" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-lg font-bold text-gray-900 truncate">Current sale</h2>
                    <p className="text-xs text-gray-500">
                      {totalCartUnits} item{totalCartUnits !== 1 ? "s" : ""} in cart
                    </p>
                  </div>
                </div>
                <button
                  onClick={toggleBrowser}
                  className={`flex lg:hidden items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition flex-shrink-0 ${
                    showBrowser ? "bg-black text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  <Package size={14} />
                  Browse
                </button>
              </div>

              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={() => setSaleType("in_store")}
                  className={`flex-1 lg:flex-none px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                    saleType === "in_store" ? "bg-black text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  In-Store
                </button>
                <button
                  onClick={() => setSaleType("online")}
                  className={`flex-1 lg:flex-none px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                    saleType === "online" ? "bg-black text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  Online Order
                </button>
              </div>

              <div className="hidden lg:flex justify-end">
                <button
                  onClick={toggleBrowser}
                  className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-sm transition flex-shrink-0 ${
                    showBrowser ? "bg-black text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  <Package size={14} />
                  {showBrowser ? "Hide products" : "Browse products"}
                </button>
              </div>
            </div>

            {quotationLoadError && (
              <div className="mt-3">
                <ErrorText>{quotationLoadError}</ErrorText>
              </div>
            )}

            {editingQuotation && (
              <div className="mt-3 flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2.5">
                <p className="text-xs text-amber-800 min-w-0">
                  <strong>Editing quotation {editingQuotation.invoice}</strong> — add or adjust items, then{" "}
                  <strong>Update quote</strong> to save the changes, or <strong>Checkout</strong> to turn it into the real sale.
                </p>
                <button
                  onClick={exitQuotationEdit}
                  className="text-xs text-amber-700 hover:text-amber-900 underline flex-shrink-0"
                >
                  Stop editing
                </button>
              </div>
            )}

            <div className="mt-3 relative" ref={productBoxRef}>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                <input
                  ref={productInputRef}
                  type="text"
                  placeholder="Scan or search products..."
                  value={productQuery}
                  onChange={(e) => handleProductQueryChange(e.target.value)}
                  onFocus={() => productQuery && setProductSearchOpen(true)}
                  onKeyDown={handleProductEnter}
                  autoFocus
                  className="w-full border border-gray-300 rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none focus:border-black"
                />
              </div>

              {productSearchOpen && productQuery.trim() && (
                <div className="absolute z-20 mt-1.5 w-full bg-white border border-gray-200 rounded-xl shadow-lg max-h-80 overflow-y-auto">
                  {productResults.length === 0 ? (
                    <p className="text-xs text-gray-400 px-3.5 py-3">No available items match "{productQuery}".</p>
                  ) : (
                    productResults.slice(0, 10).map((u) => (
                      <button
                        key={u.id}
                        onClick={() => addToCart(u)}
                        className="w-full flex items-center justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-gray-50 transition-colors border-b border-gray-50 last:border-0"
                      >
                        <div className="min-w-0">
                          <p className="text-sm text-gray-900 truncate">{u.product_title}</p>
                          <p className="text-xs text-gray-400">
                            {u.color ?? "—"} / {u.size ?? "—"} · {u.sku}
                            {u.barcode ? ` · ${u.barcode}` : ""}
                          </p>
                        </div>
                        <span className="text-sm font-medium text-gray-900 flex-shrink-0">Rs. {(u.selling_price ?? 0).toLocaleString()}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            {productSearchError && <ErrorText>{productSearchError}</ErrorText>}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
          {cart.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center min-h-0 py-10 lg:py-0">
              <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mb-3">
                <ShoppingCart size={40} className="text-gray-400" />
              </div>
              <h3 className="text-base font-medium text-gray-900">Cart is empty</h3>
              <p className="text-sm text-gray-500 mt-1">Search for products or browse the catalog</p>
            </div>
          ) : (
            <div className="p-4">
              <div className="space-y-2">
                <div className="hidden lg:grid grid-cols-12 gap-3 px-4 py-2 bg-gray-50 rounded-lg text-xs font-medium text-gray-600">
                  <div className="col-span-5">Product</div>
                  <div className="col-span-1 text-center">Qty</div>
                  <div className="col-span-3">Price</div>
                  <div className="col-span-2">Line total</div>
                  <div className="col-span-1"></div>
                </div>

                {cart.map((line) => {
                  const sample = line.units[0];
                  const lineKey = cartLineKey(sample);
                  const originalPrice = sample.selling_price ?? 0;
                  // Only a reduced price shows the original struck through; a price above it (an admin's call) shows nothing extra.
                  const isDiscounted = line.unit_price < originalPrice;
                  const isEditing = editingLineKey === lineKey;
                  const qty = line.units.length;
                  const hasStaleUnit = line.units.some((u) => staleUnitIds.has(u.id));
                  const canAddMore = remainingAvailable(lineKey) > 0;
                  const stepper = (
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        onClick={() => removeFromCart(lineKey)}
                        className="w-5 h-5 flex items-center justify-center rounded-full border border-gray-300 text-gray-500 hover:border-gray-900 hover:text-gray-900 transition flex-shrink-0"
                        aria-label="Decrease quantity"
                      >
                        <Minus size={12} />
                      </button>
                      <span className="w-4 text-center text-xs font-semibold text-gray-700">{qty}</span>
                      <button
                        onClick={() => incrementCartLine(lineKey)}
                        disabled={!canAddMore}
                        title={canAddMore ? undefined : "No more in stock"}
                        className="w-5 h-5 flex items-center justify-center rounded-full border border-gray-300 text-gray-500 hover:border-gray-900 hover:text-gray-900 transition flex-shrink-0 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:border-gray-300 disabled:hover:text-gray-500"
                        aria-label="Increase quantity"
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                  );
                  return (
                    <div
                      key={lineKey}
                      className={`grid grid-cols-12 gap-2 lg:gap-3 items-center px-3 lg:px-4 py-2.5 border rounded-xl transition ${
                        hasStaleUnit
                          ? "bg-red-50/50 border-red-200"
                          : "bg-white border-gray-100 hover:shadow-sm"
                      }`}
                    >
                      <div className="col-span-9 lg:col-span-4 min-w-0 order-1 lg:order-none">
                        <p className={`font-medium text-sm truncate ${hasStaleUnit ? "text-gray-400 line-through" : "text-gray-900"}`}>
                          {sample.product_id ? <RefLink to={`/products/${sample.product_id}`}>{sample.product_title}</RefLink> : sample.product_title}
                        </p>
                        <p className={`text-xs mt-0.5 truncate ${hasStaleUnit ? "text-gray-400 line-through" : "text-gray-500"}`}>
                          {sample.color ?? "—"} / {sample.size ?? "—"} | SKU: {sample.sku}
                        </p>
                        {hasStaleUnit && (
                          <p className="text-xs text-red-600 mt-0.5 font-medium">No longer in stock — remove before checkout</p>
                        )}
                      </div>
                      <div className="col-span-3 lg:col-span-2 text-center order-2 lg:order-none flex items-center justify-center">
                        {stepper}
                      </div>
                      <div className={`${isEditing ? "col-span-12" : "col-span-5"} lg:col-span-3 order-4 lg:order-none`}>
                        {isEditing ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="number"
                              min="0"
                              value={editPriceValue}
                              onChange={(e) => setEditPriceValue(e.target.value)}
                              className="w-full border border-gray-300 rounded-lg px-2.5 py-1 text-sm focus:outline-none focus:border-black"
                              autoFocus
                            />
                            <button
                              onClick={() => saveEditPrice(lineKey)}
                              className="flex items-center justify-center w-7 h-7 bg-black hover:bg-gray-800 text-white rounded-lg transition flex-shrink-0"
                            >
                              <CheckCircle size={14} />
                            </button>
                            <button
                              onClick={cancelEditPrice}
                              className="flex items-center justify-center w-7 h-7 border border-gray-300 hover:bg-gray-100 text-gray-600 rounded-lg transition flex-shrink-0"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-gray-900 font-semibold text-sm">Rs. {line.unit_price.toLocaleString()}</p>
                              {isDiscounted && <p className="text-xs text-gray-400 line-through">Rs. {originalPrice.toLocaleString()}</p>}
                            </div>
                            <button onClick={() => startEditPrice(line)} className="text-gray-400 hover:text-gray-600 ml-1 flex-shrink-0">
                              <Edit2 size={12} />
                            </button>
                          </div>
                        )}
                        {priceEditError && isEditing && <p className="text-xs text-red-500 mt-1">{priceEditError}</p>}
                      </div>
                      <div className={`${isEditing ? "hidden lg:block" : "col-span-4"} lg:col-span-2 order-5 lg:order-none text-right lg:text-left`}>
                        <p className="text-gray-900 font-semibold text-sm">Rs. {(line.unit_price * qty).toLocaleString()}</p>
                      </div>
                      <div className="col-span-1 text-right hidden lg:block">
                        <button onClick={() => removeFromCart(lineKey)} className="text-gray-400 hover:text-red-500 transition">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          </div>

          {/* Sale details — sits right above the bar, so opening it grows the panel
              upward (the cart gives up the room) and closing it drops back down. On a
              short window it scrolls inside itself rather than push the buttons away. */}
          <div
            className="flex-shrink-0 grid transition-[grid-template-rows] duration-200 ease-out"
            style={{ gridTemplateRows: detailsOpen ? "1fr" : "0fr" }}
            aria-hidden={!detailsOpen}
          >
            <div
              id="pos-sale-details"
              style={detailsMaxHeight !== null ? { maxHeight: detailsMaxHeight } : undefined}
              className={`min-h-0 ${
                detailsOpen && detailsSettled ? (detailsMaxHeight !== null ? "overflow-y-auto" : "overflow-visible") : "overflow-hidden"
              } ${!detailsOpen && detailsSettled ? "invisible" : ""}`}
            >
          <div ref={detailsContentRef} className="border-t border-gray-200 bg-white p-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 lg:gap-6 items-start">
              <div className="space-y-3">
                <FormGroup>
                  <Label>Discount</Label>
                  <div className="flex gap-2">
                    <div className="w-24 flex-shrink-0">
                      <Dropdown
                        value={discountType}
                        onChange={(v) => setDiscountType(v as "percent" | "fixed")}
                        options={[
                          { value: "fixed", label: "LKR" },
                          { value: "percent", label: "%" },
                        ]}
                      />
                    </div>
                    <Input
                      type="number"
                      min="0"
                      max={discountType === "percent" ? 100 : undefined}
                      value={discountValue}
                      onChange={(e) => setDiscountValue(e.target.value)}
                      placeholder="0"
                    />
                  </div>
                  {manualDiscountAmount > 0 && (
                    <p className="text-xs text-gray-400 mt-1">
                      Discount applied: Rs. {manualDiscountAmount.toLocaleString()} off
                    </p>
                  )}
                </FormGroup>

                <FormGroup>
                  <Label>Coupon code</Label>
                  {appliedCoupon ? (
                    <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                      <span className="text-sm text-green-800 font-medium">
                        {appliedCoupon.code} —{" "}
                        {appliedCoupon.discount_type === "percent"
                          ? `${appliedCoupon.discount_value}% off`
                          : `Rs. ${appliedCoupon.discount_value.toLocaleString()} off`}
                      </span>
                      <button onClick={removeCoupon} className="text-xs text-red-500 hover:text-red-700">
                        Remove
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Input
                        value={couponCode}
                        onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), applyCoupon())}
                      />
                      <button
                        type="button"
                        onClick={applyCoupon}
                        disabled={!couponCode.trim() || couponChecking}
                        className="px-4 py-2 bg-black text-white rounded-xl text-sm font-medium hover:bg-gray-800 transition disabled:opacity-50 flex-shrink-0"
                      >
                        {couponChecking ? "Checking..." : "Apply"}
                      </button>
                    </div>
                  )}
                  {couponError && <ErrorText>{couponError}</ErrorText>}
                </FormGroup>

                <div>
                  <div className="flex items-center justify-between mb-1.5 h-5">
                    <div className="flex items-center gap-2">
                      <User size={14} className="text-gray-600" />
                      <span className="text-sm font-medium text-gray-700">
                        Customer
                        {saleType === "online" && (
                          <>
                            <span className="text-red-500"> *</span>
                            <HelpHint
                              text={
                                isOnDemand
                                  ? "A customer is required for online orders. No address is needed for Uber / PickMe-style delivery — the rider is told where to go."
                                  : "A customer is required for online orders, so delivery can use their saved address."
                              }
                            />
                          </>
                        )}
                      </span>
                    </div>
                    {selectedCustomer && (
                      <button onClick={removeCustomer} className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1">
                        <X size={12} /> Remove
                      </button>
                    )}
                  </div>

                  {!selectedCustomer ? (
                    <div className="relative" ref={customerBoxRef}>
                      <div className="relative">
                        <Phone size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                        <Input
                          className="pl-9 pr-9"
                          placeholder="Search by name or phone..."
                          value={customerQuery}
                          onChange={(e) => handleCustomerQueryChange(e.target.value)}
                          onFocus={() => customerQuery && setCustomerSearchOpen(true)}
                        />
                        <button
                          onClick={openAddCustomer}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700"
                          title="Add new customer"
                        >
                          <UserPlus size={16} />
                        </button>
                      </div>

                      {customerSearchOpen && customerQuery.trim().length >= 2 && (
                        <div className="absolute z-20 bottom-full left-0 right-0 mb-1.5 bg-white border border-gray-200 rounded-xl shadow-lg max-h-56 overflow-y-auto">
                          {customerResults.length > 0 ? (
                            <>
                              {customerResults.slice(0, 6).map((c) => (
                                <button
                                  key={c.id}
                                  onClick={() => selectCustomer(c)}
                                  className="w-full flex items-center justify-between gap-3 px-3.5 py-2 text-left hover:bg-gray-50 transition-colors border-b border-gray-50 last:border-0"
                                >
                                  <div className="min-w-0">
                                    <p className="text-sm text-gray-900 truncate">{c.name}</p>
                                    <p className="text-xs text-gray-400">{c.phone ?? c.customer_code}</p>
                                  </div>
                                  <span className="text-xs text-amber-600 flex-shrink-0">{c.loyalty_points} pts</span>
                                </button>
                              ))}
                              <button
                                onClick={openAddCustomer}
                                className="w-full flex items-center gap-1.5 px-3.5 py-2 text-left text-sm text-gray-900 font-medium hover:bg-gray-50 transition-colors border-t border-gray-100"
                              >
                                <UserPlus size={12} />
                                Add "{customerQuery}" as new customer
                              </button>
                            </>
                          ) : (
                            <div className="px-3.5 py-3">
                              <p className="text-xs text-gray-400 mb-2">No matching customers.</p>
                              <button
                                onClick={openAddCustomer}
                                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-black text-white rounded-xl text-sm hover:bg-gray-800 transition"
                              >
                                <UserPlus size={12} />
                                Add new customer
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="w-full border border-gray-300 rounded-lg bg-gray-50 px-3 py-1.5 flex items-center justify-between">
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <div className="w-7 h-7 bg-black rounded-full flex items-center justify-center flex-shrink-0">
                          <User size={12} className="text-white" />
                        </div>
                        <p className="font-medium text-gray-900 text-sm truncate">{selectedCustomer.name}</p>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                        <Star size={12} className="text-amber-400" />
                        <span className="text-sm font-semibold text-amber-700">{selectedCustomer.loyalty_points}</span>
                        {selectedCustomer.phone && (
                          <a
                            href={whatsappMessageLink(selectedCustomer.phone, loyaltyPointsMessage(selectedCustomer.name, selectedCustomer.loyalty_points))}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Send their loyalty points on WhatsApp"
                            aria-label="Send their loyalty points on WhatsApp"
                            className="ml-1.5 text-green-600 hover:text-green-700"
                          >
                            <MessageCircle size={14} />
                          </a>
                        )}
                      </div>
                    </div>
                  )}

                  {availableStoreCredit > 0 && (
                    <div className="mt-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                      <label className="flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
                        <input type="checkbox" checked={useStoreCredit} onChange={(e) => setUseStoreCredit(e.target.checked)} className="rounded" />
                        Use store credit — Rs. {availableStoreCredit.toLocaleString()} available
                      </label>
                      {useStoreCredit && (
                        <p className="text-xs text-gray-500 mt-1">Rs. {storeCreditApplied.toLocaleString()} will be applied to this sale.</p>
                      )}
                    </div>
                  )}
                </div>

                {saleType === "online" && (
                  <div className="border-t border-gray-100 pt-3">
                    <div className="grid grid-cols-2 gap-3">
                      <FormGroup>
                        <Label>Delivery partner</Label>
                        <Dropdown
                          value={deliveryPartner}
                          onChange={(v) => setDeliveryPartner(v as DeliveryPartner)}
                          placeholder="— Select —"
                          options={activePartners.map((p) => ({ value: p.code, label: p.name }))}
                        />
                      </FormGroup>

                      {isOnDemand ? (
                        <OnDemandFareInput value={onDemandFare} onChange={fareChange} partnerName={selectedPartner?.name ?? "This partner"} />
                      ) : (
                        <FormGroup>
                          <Label>Package weight (kg)</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.1"
                            value={packageWeight}
                            onChange={(e) => setPackageWeight(e.target.value)}
                            disabled={isFreeDelivery}
                          />
                        </FormGroup>
                      )}
                    </div>

                    {isOnDemand && <OnDemandPaidByPicker value={onDemandFare} onChange={fareChange} />}
                  </div>
                )}
              </div>

              <div className="space-y-3">
                {saleType === "online" ? (
                  <>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      {!isOnDemand && (
                        <PosTick
                          checked={isFreeDelivery}
                          onChange={setIsFreeDelivery}
                          label="Free delivery"
                          hint="The customer still pays for the order itself."
                        />
                      )}
                      {isAdmin && (
                        <PosTick
                          checked={isCreditSale}
                          onChange={(checked) => {
                            setIsCreditSale(checked);
                            if (checked) setAdvancePaid("0");
                          }}
                          label="Credit order"
                          hint="The product goes on credit — the delivery fee is still collected on delivery."
                        />
                      )}
                      {wholesaleTick}
                    </div>
                    {wholesaleNote}

                    {isCreditSale ? (
                      <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">
                        Product total (Rs. {total.toLocaleString()}) goes on {selectedCustomer ? selectedCustomer.name : "the customer"}'s
                        balance due. Only the delivery fee is collected as COD.
                      </div>
                    ) : (
                      <FormGroup>
                        <Label>
                          Amount paid now, if any (Rs.)
                          <HelpHint text="This applies against the full amount owed (product + delivery fee). Pay it all now and COD becomes Rs. 0; pay less and the difference — including the delivery fee — becomes COD." />
                        </Label>
                        <Input type="number" min="0" value={advancePaid} onChange={(e) => setAdvancePaid(e.target.value)} placeholder="0" />
                      </FormGroup>
                    )}

                    {!isCreditSale && (
                      <FormGroup>
                        <Label>How was that amount paid?</Label>
                        {/* Always shown so the form doesn't jump when an amount is typed — dimmed until there is one. */}
                        <div className={`grid grid-cols-3 gap-2 transition-opacity ${advanceAmount > 0 ? "" : "opacity-60"}`}>
                          <button
                            type="button"
                            onClick={() => setAdvancePaymentMethod("cash")}
                            className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition ${
                              advancePaymentMethod === "cash" ? "border-black bg-black text-white" : "border-gray-300 hover:border-gray-400"
                            }`}
                          >
                            <Wallet size={16} />
                            <span>Cash</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setAdvancePaymentMethod("card")}
                            className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition ${
                              advancePaymentMethod === "card" ? "border-black bg-black text-white" : "border-gray-300 hover:border-gray-400"
                            }`}
                          >
                            <CreditCard size={16} />
                            <span>Card</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setAdvancePaymentMethod("bank_transfer")}
                            className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition ${
                              advancePaymentMethod === "bank_transfer" ? "border-black bg-black text-white" : "border-gray-300 hover:border-gray-400"
                            }`}
                          >
                            <Smartphone size={16} />
                            <span>Bank</span>
                          </button>
                        </div>
                      </FormGroup>
                    )}

                    <div className="bg-gray-50 rounded-lg px-3 py-2 space-y-1">
                      <div className="flex justify-between text-xs text-gray-600">
                        <span>Product + delivery owed</span>
                        <span>Rs. {(total + deliveryFee).toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-xs text-gray-600">
                        <span>
                          {isOnDemand
                            ? `Delivery fare (${selectedPartner?.name}${
                                deliveryPaidBy === "rider_direct" ? " — customer pays the rider" : fareAwaited ? " — to be confirmed" : ""
                              })`
                            : `Delivery fee (${(selectedPartner?.base_fee ?? 450).toLocaleString()} first kg + ${(selectedPartner?.extra_kg_fee ?? 100).toLocaleString()}/extra kg)`}
                        </span>
                        <span>
                          {deliveryIsFree
                            ? "Waived"
                            : isOnDemand && deliveryPaidBy === "rider_direct"
                            ? "Not charged"
                            : fareAwaited
                            ? "On hold"
                            : `Rs. ${deliveryFee.toLocaleString()}`}
                        </span>
                      </div>
                      {isCreditSale ? (
                        <div className="flex justify-between text-xs text-amber-700">
                          <span>On credit (product)</span>
                          <span>Rs. {total.toLocaleString()}</span>
                        </div>
                      ) : (
                        advanceAmount > 0 && (
                          <div className="flex justify-between text-xs text-gray-600">
                            <span>Paid now</span>
                            <span>Rs. {advanceAmount.toLocaleString()}</span>
                          </div>
                        )
                      )}
                      <div className="flex justify-between text-sm font-semibold pt-1 border-t border-gray-200">
                        <span>COD to collect on delivery</span>
                        <span>Rs. {codAmount.toLocaleString()}</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      {isAdmin && (
                        <PosTick
                          checked={isCreditSale}
                          disabled={!selectedCustomer}
                          onChange={setIsCreditSale}
                          label="Credit sale"
                          hint="Settle later — tracked as balance due."
                        />
                      )}
                      {wholesaleTick}
                    </div>
                    {isAdmin && !selectedCustomer && (
                      <p className="text-xs text-gray-400 -mt-2">Select a customer first — credit isn't offered to walk-ins.</p>
                    )}
                    {wholesaleNote}

                    {isCreditSale ? (
                      <>
                        <FormGroup>
                          <Label>Amount paid now (Rs.) — 0 if fully on credit</Label>
                          <Input type="number" min="0" max={total} value={creditAmountPaid} onChange={(e) => setCreditAmountPaid(e.target.value)} />
                          <p className="text-xs text-gray-400 mt-1">
                            Remaining balance of Rs. {Math.max(0, total - (parseFloat(creditAmountPaid) || 0)).toLocaleString()} will show as owed
                            on {selectedCustomer ? selectedCustomer.name : "this customer's"} record.
                          </p>
                        </FormGroup>

                        {(parseFloat(creditAmountPaid) || 0) > 0 && (
                          <FormGroup>
                            <Label>How was that partial amount paid?</Label>
                            <div className="grid grid-cols-3 gap-2">
                              <button
                                type="button"
                                onClick={() => setCreditPaymentMethod("cash")}
                                className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition ${
                                  creditPaymentMethod === "cash" ? "border-black bg-black text-white" : "border-gray-300 hover:border-gray-400"
                                }`}
                              >
                                <Wallet size={16} />
                                <span>Cash</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setCreditPaymentMethod("card")}
                                className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition ${
                                  creditPaymentMethod === "card" ? "border-black bg-black text-white" : "border-gray-300 hover:border-gray-400"
                                }`}
                              >
                                <CreditCard size={16} />
                                <span>Card</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setCreditPaymentMethod("bank_transfer")}
                                className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition ${
                                  creditPaymentMethod === "bank_transfer" ? "border-black bg-black text-white" : "border-gray-300 hover:border-gray-400"
                                }`}
                              >
                                <Smartphone size={16} />
                                <span>Bank</span>
                              </button>
                            </div>
                          </FormGroup>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="grid grid-cols-3 gap-2">
                          <button
                            onClick={() => setPaymentMethod("cash")}
                            className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition ${
                              paymentMethod === "cash" ? "border-black bg-black text-white" : "border-gray-300 hover:border-gray-400"
                            }`}
                          >
                            <Wallet size={16} />
                            <span>Cash</span>
                          </button>
                          <button
                            onClick={() => {
                              setPaymentMethod("card");
                              setAmountPaid("");
                            }}
                            className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition ${
                              paymentMethod === "card" ? "border-black bg-black text-white" : "border-gray-300 hover:border-gray-400"
                            }`}
                          >
                            <CreditCard size={16} />
                            <span>Card</span>
                          </button>
                          <button
                            onClick={() => {
                              setPaymentMethod("bank_transfer");
                              setAmountPaid("");
                            }}
                            className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition ${
                              paymentMethod === "bank_transfer" ? "border-black bg-black text-white" : "border-gray-300 hover:border-gray-400"
                            }`}
                          >
                            <Smartphone size={16} />
                            <span>Bank</span>
                          </button>
                        </div>

                        {paymentMethod === "cash" && (
                          <div>
                            <div className="flex gap-2">
                              <input
                                type="number"
                                min="0"
                                step="1"
                                value={amountPaid}
                                onChange={(e) => setAmountPaid(e.target.value)}
                                placeholder="Cash received"
                                className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-black"
                              />
                              {changeDue > 0 && (
                                <div className="bg-green-100 rounded-lg px-3 py-1.5 text-sm text-green-700 font-medium whitespace-nowrap">
                                  Change: Rs. {changeDue.toLocaleString()}
                                </div>
                              )}
                            </div>
                            <div className="flex gap-1 mt-1.5 flex-wrap">
                              {cashPresets.map((amount) => (
                                <button
                                  key={amount}
                                  onClick={() => setAmountPaid(amount.toString())}
                                  className="px-2 py-0.5 border border-gray-300 rounded text-xs hover:bg-gray-100"
                                >
                                  {amount.toLocaleString()}
                                </button>
                              ))}
                              <button
                                onClick={() => setAmountPaid(remainingAfterCredit.toString())}
                                className="px-2 py-0.5 bg-black text-white rounded text-xs hover:bg-gray-800"
                              >
                                Exact
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}

              </div>
            </div>
          </div>
            </div>
          </div>

          <button
            ref={toggleRef}
            type="button"
            onClick={toggleDetails}
            aria-expanded={detailsOpen}
            aria-controls="pos-sale-details"
            title={detailsOpen ? "Hide sale details" : "Show sale details — customer, discount, payment"}
            className="flex-shrink-0 w-full flex items-center justify-between gap-3 px-4 py-2 border-t border-gray-200 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
          >
            <span className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-medium text-gray-900 flex-shrink-0">Sale details</span>
              <span className="truncate text-xs text-gray-500">{detailsSummary}</span>
            </span>
            <ChevronUp size={16} className={`flex-shrink-0 text-gray-500 transition-transform duration-200 ${detailsOpen ? "rotate-180" : ""}`} />
          </button>

          {/* Pinned to the bottom of the panel: what's owed, and the buttons —
              always on screen however long the cart or the form gets. */}
          <div ref={pinnedRef} className="border-t border-gray-200 bg-white px-4 py-3 flex-shrink-0 grid grid-cols-1 lg:grid-cols-2 gap-3 lg:gap-6 items-end">
                <div>
                  <Label>
                    Order summary
                    <HelpHint text="Discounts, coupons, and store credit are applied here first — the amount shown at the bottom is what's actually left to collect." />
                  </Label>
                  <div className="space-y-1.5 mt-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600">Subtotal</span>
                      <span className="font-medium">Rs. {subtotal.toLocaleString()}</span>
                    </div>
                    {combinedDiscount > 0 && (
                      <div className="flex justify-between text-sm text-green-600">
                        <span>Discounts & Coupons</span>
                        <span>- Rs. {combinedDiscount.toLocaleString()}</span>
                      </div>
                    )}
                    {storeCreditApplied > 0 && (
                      <div className="flex justify-between text-sm text-gray-600">
                        <span>Store credit applied</span>
                        <span>- Rs. {storeCreditApplied.toLocaleString()}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-lg font-bold pt-1.5 border-t border-gray-200">
                      <span>{storeCreditApplied > 0 ? "Amount due" : "Total"}</span>
                      <span>Rs. {(storeCreditApplied > 0 ? remainingAfterCredit : total).toLocaleString()}</span>
                    </div>
                  </div>
                </div>
            <div className="space-y-2">
                {checkoutError && <ErrorText>{checkoutError}</ErrorText>}
                {checkoutSuccess && <SuccessText>{checkoutSuccess}</SuccessText>}

                <div className="flex gap-2">
                  <button onClick={clearCart} className="px-4 py-2 border border-gray-300 rounded-xl hover:bg-gray-50 transition text-sm font-medium">
                    Clear
                  </button>
                  <button
                    onClick={beginQuotation}
                    disabled={cart.length === 0}
                    title="Save as a price quotation to send the customer before they pay"
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-xl hover:bg-gray-50 transition text-sm font-medium disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
                  >
                    <FileText size={14} />
                    {editingQuotation ? "Update quote" : "Quotation"}
                  </button>
                  <button
                    onClick={beginCheckout}
                    disabled={cart.length === 0 || addressCheckLoading}
                    className="flex-1 px-4 py-2 bg-black text-white rounded-xl hover:bg-gray-800 transition text-sm font-medium disabled:opacity-50"
                  >
                    {addressCheckLoading ? "Checking address..." : "Checkout"}
                  </button>
                </div>
            </div>
          </div>
        </div>

        <div
          className={`hidden lg:flex bg-white rounded-2xl shadow-sm border border-gray-200 flex-col overflow-hidden flex-shrink-0 transition-all duration-200 ${
            showBrowser ? "w-80 opacity-100" : "w-0 opacity-0 border-0"
          }`}
        >
          <div className="w-80 h-full flex flex-col">
            <div className="p-3.5 border-b border-gray-200 bg-gray-50 rounded-t-2xl flex-shrink-0">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-gray-900 text-sm">Product catalog</h3>
                <button onClick={toggleBrowser} className="text-gray-400 hover:text-gray-600">
                  <X size={16} />
                </button>
              </div>
              {browserFilterNote}
              <div className="flex gap-1.5 mt-2.5 overflow-x-auto pb-1">
                <button
                  onClick={() => setBrowserCategory("all")}
                  className={`px-2.5 py-1 rounded-lg text-xs whitespace-nowrap transition ${
                    browserCategory === "all" ? "bg-black text-white" : "bg-white text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  All
                </button>
                {browserCategories.slice(0, 8).map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setBrowserCategory(cat)}
                    className={`px-2.5 py-1 rounded-lg text-xs whitespace-nowrap transition ${
                      browserCategory === cat ? "bg-black text-white" : "bg-white text-gray-700 hover:bg-gray-100"
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5 min-h-0">
              {browserFiltered.length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-sm">{browserEmptyText}</div>
              ) : (
                browserFiltered.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => addToCart(u, true)}
                    className="w-full text-left p-2.5 border border-gray-100 rounded-xl hover:border-black hover:shadow-sm transition group"
                  >
                    <div className="flex justify-between items-start">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-900 text-sm truncate">{u.product_title}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {u.color ?? "—"} / {u.size ?? "—"}
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">SKU: {u.sku}</p>
                      </div>
                      <div className="text-right ml-2 flex-shrink-0">
                        <p className="font-bold text-gray-900 text-sm">Rs. {(u.selling_price ?? 0).toLocaleString()}</p>
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Mobile: product catalog opens as a full-screen sheet instead of a
          320px sidebar, which has no room to exist on a phone. */}
      {showBrowser && (
        <div className="lg:hidden fixed inset-0 z-40 bg-white flex flex-col">
          <div className="p-3.5 border-b border-gray-200 bg-gray-50 flex-shrink-0">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-gray-900 text-sm">Product catalog</h3>
              <button onClick={toggleBrowser} className="text-gray-400 hover:text-gray-600 p-1">
                <X size={20} />
              </button>
            </div>
            {browserFilterNote}
            <div className="flex gap-1.5 mt-2.5 overflow-x-auto pb-1">
              <button
                onClick={() => setBrowserCategory("all")}
                className={`px-2.5 py-1 rounded-lg text-xs whitespace-nowrap transition ${
                  browserCategory === "all" ? "bg-black text-white" : "bg-white text-gray-700 hover:bg-gray-100"
                }`}
              >
                All
              </button>
              {browserCategories.slice(0, 8).map((cat) => (
                <button
                  key={cat}
                  onClick={() => setBrowserCategory(cat)}
                  className={`px-2.5 py-1 rounded-lg text-xs whitespace-nowrap transition ${
                    browserCategory === cat ? "bg-black text-white" : "bg-white text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {browserFiltered.length === 0 ? (
              <div className="text-center py-8 text-gray-500 text-sm">{browserEmptyText}</div>
            ) : (
              browserFiltered.map((u) => (
                <button
                  key={u.id}
                  onClick={() => addToCart(u, true)}
                  className="w-full text-left p-3 border border-gray-100 rounded-xl active:bg-gray-50 transition"
                >
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 text-sm truncate">{u.product_title}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {u.color ?? "—"} / {u.size ?? "—"}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">SKU: {u.sku}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="font-bold text-gray-900 text-sm">Rs. {(u.selling_price ?? 0).toLocaleString()}</p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* NEW CUSTOMER MODAL — full intake form: name, phone (required) +
          phone2 (optional), address line 1/2, and city. */}
      {showAddCustomer && (
        <Modal
          size="2xl"
          onClose={() => setShowAddCustomer(false)}
          title="New customer"
          footer={
            <>
              <Button onClick={() => setShowAddCustomer(false)}>Cancel</Button>
              <Button variant="primary" disabled={addCustomerSubmitting} onClick={submitNewCustomer}>
                {addCustomerSubmitting ? "Saving..." : "Save & select"}
              </Button>
            </>
          }
        >
<div className="grid grid-cols-1 sm:grid-cols-[1.5fr_1fr] gap-5">
                <div className="space-y-3">
                  <FormGroup>
                    <Label>Name</Label>
                    <Input value={newCustomerName} onChange={(e) => setNewCustomerName(e.target.value)} autoFocus />
                  </FormGroup>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <FormGroup>
                      <Label>Phone</Label>
                      <PhoneInput value={newCustomerPhone} onChange={setNewCustomerPhone} />
                    </FormGroup>
                    <FormGroup>
                      <Label>Phone 2 (optional)</Label>
                      <PhoneInput value={newCustomerPhone2} onChange={setNewCustomerPhone2} />
                    </FormGroup>
                  </div>
                  <FormGroup>
                    <Label>Gender</Label>
                    <Dropdown
                      value={newCustomerGender}
                      onChange={(v) => setNewCustomerGender(v as CustomerGender)}
                      options={[
                        { value: "unspecified", label: "Unspecified" },
                        { value: "male", label: "Male" },
                        { value: "female", label: "Female" },
                      ]}
                    />
                  </FormGroup>
                  <FormGroup>
                    <Label>Address line 1</Label>
                    <Input value={newCustomerAddr1} onChange={(e) => setNewCustomerAddr1(e.target.value)} />
                  </FormGroup>
                  <FormGroup>
                    <Label>Address line 2</Label>
                    <Input value={newCustomerAddr2} onChange={(e) => setNewCustomerAddr2(e.target.value)} />
                  </FormGroup>
                  {addCustomerError && <ErrorText>{addCustomerError}</ErrorText>}
                </div>

                <div>
                  <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 h-fit">
                    <h4 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                      <UserRound size={16} className="text-gray-600" />
                      Customer Preview
                    </h4>
                    <div className="mb-4 pb-4 border-b border-gray-200">
                      <p className="text-base font-semibold text-gray-900">{newCustomerName.trim() || "New customer"}</p>
                      <p className="text-xs text-gray-400 mt-1">Preview updates as you type</p>
                    </div>
                    <div className="space-y-3 text-sm">
                      <div className="flex items-center gap-2">
                        <Phone size={14} className="text-gray-400" />
                        <span className="text-gray-700">{newCustomerPhone.trim() || "No primary phone"}</span>
                      </div>
                      {newCustomerPhone2.trim() && (
                        <div className="flex items-center gap-2">
                          <Phone size={14} className="text-gray-400" />
                          <span className="text-gray-700">{newCustomerPhone2.trim()}</span>
                        </div>
                      )}
                      <div className="flex items-start gap-2">
                        <MapPin size={14} className="text-gray-400 mt-0.5" />
                        <span className="text-gray-700">
                          {[newCustomerAddr1.trim(), newCustomerAddr2.trim(), newCustomerCity.trim()].filter(Boolean).join(", ") ||
                            "No address added"}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* City sits below the preview card, not in the field list
                      on the left — it's the last field there, so opening its
                      ~2,100-option dropdown gets cramped against the modal's
                      edge. This column stretches to match the taller left
                      column, so there's already clear room below for that
                      dropdown to open into without extra spacing. */}
                  <FormGroup>
                    <div className="mt-4">
                      <Label>City</Label>
                      <CityPicker value={newCustomerCity} onChange={setNewCustomerCity} />
                    </div>
                  </FormGroup>
                </div>
              </div>
        </Modal>
      )}

      {showAddressCheck &&
        (() => {
          const defaultAddr = customerAddresses?.find((a) => a.is_default) ?? customerAddresses?.[0];
          return (
            <Modal
              size="md"
              onClose={() => setShowAddressCheck(false)}
              title="Confirm delivery address"
              footer={
                <>
                  <Button onClick={() => setShowAddressCheck(false)}>Cancel</Button>
                  <Button variant="primary" onClick={confirmAddressAndProceed}>
                    {defaultAddr ? "Confirmed — continue" : "Save & continue"}
                  </Button>
                </>
              }
            >
              <div className="space-y-3">
                  {defaultAddr ? (
                    <>
                      <p className="text-xs text-gray-500">
                        Verify this is still correct with {selectedCustomer?.name} before shipping — a bad address caught now is a
                        phone call, not a return.
                      </p>
                      <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm">
                        <p className="font-medium text-gray-900">{selectedCustomer?.name}</p>
                        <p className="text-gray-700 mt-1">
                          {[defaultAddr.address_line1, defaultAddr.address_line2, defaultAddr.city].filter(Boolean).join(", ") || "—"}
                        </p>
                        {selectedCustomer?.phone && <p className="text-gray-500 mt-1">{selectedCustomer.phone}</p>}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                        <AlertTriangle size={12} className="text-amber-600 flex-shrink-0 mt-0.5" />
                        <p className="text-xs text-amber-800">
                          {selectedCustomer?.name} has no saved address. Add one now before this order can be shipped.
                        </p>
                      </div>
                      <FormGroup>
                        <Label>Address line 1</Label>
                        <Input value={newAddrLine1} onChange={(e) => setNewAddrLine1(e.target.value)} />
                      </FormGroup>
                      <FormGroup>
                        <Label>Address line 2</Label>
                        <Input value={newAddrLine2} onChange={(e) => setNewAddrLine2(e.target.value)} />
                      </FormGroup>
                      <FormGroup>
                        <Label>City</Label>
                        <CityPicker value={newAddrCity} onChange={setNewAddrCity} />
                      </FormGroup>
                    </>
                  )}
                  {addressCheckError && <ErrorText>{addressCheckError}</ErrorText>}
              </div>
            </Modal>
          );
        })()}

      {showCheckoutModal && (
        <Modal
          size="lg"
          onClose={() => setShowCheckoutModal(false)}
          title="Confirm sale"
          footer={
            <>
              <Button onClick={() => setShowCheckoutModal(false)}>Back</Button>
              <Button variant="primary" onClick={handleCheckout} disabled={submitting}>
                {submitting ? "Processing..." : "Confirm & complete"}
              </Button>
            </>
          }
        >
<div className="space-y-4">
              <div>
                <p className="text-xs text-gray-400 mb-1.5">
                  {saleType === "online" ? "Online order" : "In-store sale"} · {totalCartUnits} item{totalCartUnits !== 1 ? "s" : ""}
                </p>
                <div className="space-y-1.5">
                  {cart.map((line) => {
                    const sample = line.units[0];
                    const qty = line.units.length;
                    return (
                      <div key={cartLineKey(sample)} className="flex justify-between text-sm">
                        <span className="text-gray-700 truncate pr-2">
                          {sample.product_title}
                          <span className="text-gray-400">
                            {" "}
                            · {sample.color ?? "—"}/{sample.size ?? "—"}
                            {qty > 1 ? ` × ${qty}` : ""}
                          </span>
                        </span>
                        <span className="text-gray-900 font-medium flex-shrink-0">Rs. {(line.unit_price * qty).toLocaleString()}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="border-t border-gray-100 pt-3 space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Customer</span>
                  <span className="text-gray-900 font-medium">{selectedCustomer ? selectedCustomer.name : "Walk-in"}</span>
                </div>
                {selectedCustomer && noLoyalty && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Loyalty points</span>
                    <span className="text-gray-900 font-medium">None (wholesale)</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Payment</span>
                  <span className="text-gray-900 font-medium capitalize">
                    {isCreditSale
                      ? saleType === "online"
                        ? "Credit (product) + COD (delivery)"
                        : "Credit"
                      : saleType === "online"
                      ? advanceAmount > 0
                        ? codAmount > 0
                          ? `Partial payment (${advancePaymentMethod.replace("_", " ")}) + rest on delivery`
                          : `Paid in full (${advancePaymentMethod.replace("_", " ")})`
                        : "Pay in full on delivery (COD)"
                      : paymentMethod.replace("_", " ")}
                  </span>
                </div>
                {saleType === "online" && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Delivery partner</span>
                    <span className="text-gray-900 font-medium">
                      {partnerLabel(deliveryPartner)}
                    </span>
                  </div>
                )}
                {combinedDiscount > 0 && (
                  <div className="flex justify-between text-sm text-green-600">
                    <span>Discounts & Coupons{appliedCoupon ? ` (${appliedCoupon.code})` : ""}</span>
                    <span>- Rs. {combinedDiscount.toLocaleString()}</span>
                  </div>
                )}
              </div>

              <div className="border-t border-gray-100 pt-3 space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Subtotal</span>
                  <span>Rs. {subtotal.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-lg font-bold">
                  <span>Total</span>
                  <span>Rs. {total.toLocaleString()}</span>
                </div>
                {storeCreditApplied > 0 && (
                  <>
                    <div className="flex justify-between text-sm text-gray-600">
                      <span>Store credit applied</span>
                      <span>- Rs. {storeCreditApplied.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between text-sm font-semibold">
                      <span>Amount due</span>
                      <span>Rs. {remainingAfterCredit.toLocaleString()}</span>
                    </div>
                  </>
                )}
                {isCreditSale && (
                  <div className="flex justify-between text-sm text-amber-600 font-medium">
                    <span>Balance due (credit)</span>
                    <span>Rs. {Math.max(0, total - (parseFloat(creditAmountPaid) || 0)).toLocaleString()}</span>
                  </div>
                )}
                {saleType === "online" && (
                  <>
                    <div className="flex justify-between text-sm text-gray-500">
                      <span>Delivery fee</span>
                      <span>
                        {deliveryIsFree
                          ? "Free"
                          : isOnDemand && deliveryPaidBy === "rider_direct"
                          ? "Customer pays the rider"
                          : fareAwaited
                          ? "To be confirmed"
                          : `Rs. ${deliveryFee.toLocaleString()}`}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm font-semibold">
                      <span>COD to collect</span>
                      <span>Rs. {codAmount.toLocaleString()}</span>
                    </div>
                  </>
                )}
                {saleType === "in_store" && !isCreditSale && paymentMethod === "cash" && (
                  <>
                    <div className="flex justify-between text-sm text-gray-500">
                      <span>Cash tendered</span>
                      <span>Rs. {paidAmount.toLocaleString()}</span>
                    </div>
                    {changeDue > 0 && (
                      <div className="flex justify-between text-sm text-green-600 font-medium">
                        <span>Change due</span>
                        <span>Rs. {changeDue.toLocaleString()}</span>
                      </div>
                    )}
                  </>
                )}
              </div>

              {checkoutError && <ErrorText>{checkoutError}</ErrorText>}
            </div>
        </Modal>
      )}

      {showOverpaymentChoice && (
        <Modal
          size="sm"
          onClose={() => setShowOverpaymentChoice(false)}
          title="Extra cash received"
          footer={<Button onClick={() => setShowOverpaymentChoice(false)}>Cancel and adjust the amount instead</Button>}
        >
              <p className="text-sm text-gray-600 mb-1">
                {selectedCustomer?.name} paid Rs. {paidAmount.toLocaleString()}, which is Rs.{" "}
                {(paidAmount - remainingAfterCredit).toLocaleString()} more than the amount due.
              </p>
              <p className="text-xs text-gray-400 mb-4">What should happen to the extra?</p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => {
                    setKeepOverpaymentAsCredit(false);
                    setShowOverpaymentChoice(false);
                    setTimeout(() => handleCheckout(), 0);
                  }}
                  className="border border-gray-200 rounded-xl px-4 py-3 text-sm text-left hover:border-gray-400 transition"
                >
                  <span className="font-medium text-gray-900">Give change</span>
                  <div className="text-xs text-gray-400 mt-0.5">Hand back Rs. {(paidAmount - remainingAfterCredit).toLocaleString()} in cash</div>
                </button>
                <button
                  onClick={() => {
                    setKeepOverpaymentAsCredit(true);
                    setShowOverpaymentChoice(false);
                    setTimeout(() => handleCheckout(), 0);
                  }}
                  className="border border-gray-200 rounded-xl px-4 py-3 text-sm text-left hover:border-gray-400 transition"
                >
                  <span className="font-medium text-gray-900">Keep as store credit</span>
                  <div className="text-xs text-gray-400 mt-0.5">
                    Adds Rs. {(paidAmount - remainingAfterCredit).toLocaleString()} to {selectedCustomer?.name}'s account for later
                  </div>
                </button>
              </div>
        </Modal>
      )}

      {showQuotationModal && (
        <Modal
          size="md"
          onClose={() => setShowQuotationModal(false)}
          title={editingQuotation ? `Update quotation ${editingQuotation.invoice}` : "Save as quotation"}
          subtitle={`${totalCartUnits} item${totalCartUnits !== 1 ? "s" : ""} · Rs. ${total.toLocaleString()}${selectedCustomer ? ` · ${selectedCustomer.name}` : " · Walk-in"}`}
          footer={
            <>
              <Button onClick={() => setShowQuotationModal(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleSaveQuotation} disabled={savingQuotation}>
                {savingQuotation ? "Saving..." : editingQuotation ? "Update quotation" : "Save quotation"}
              </Button>
            </>
          }
        >
          <p className="text-xs text-gray-400 mb-4">
            Saves this cart as a price-confirmation bill, with nothing charged or reserved yet. Print or send it to the customer — once they confirm, pull it up again and convert it to a real sale to collect payment.
          </p>
              <FormGroup>
                <Label>Valid for (days)</Label>
                <div className="flex gap-1.5 flex-wrap mb-1.5">
                  {[3, 7, 14, 30].map((d) => (
                    <button
                      key={d}
                      onClick={() => setQuotationValidDays(String(d))}
                      className={`px-3 py-1 rounded-lg text-xs font-medium border transition ${
                        quotationValidDays === String(d) ? "bg-black text-white border-black" : "border-gray-300 text-gray-600 hover:border-gray-400"
                      }`}
                    >
                      {d} days
                    </button>
                  ))}
                </div>
                <Input
                  type="number"
                  min={1}
                  value={quotationValidDays}
                  onChange={(e) => setQuotationValidDays(e.target.value)}
                />
              </FormGroup>

              {quotationError && <ErrorText>{quotationError}</ErrorText>}
        </Modal>
      )}

      {savedQuotation && (
        <ReceiptOptionsModal
          heading="Quotation saved"
          subtitle={savedQuotation.invoice}
          options={quotationReceiptOptions(savedQuotation)}
          error={quotationReceiptError}
          onClose={() => {
            setSavedQuotation(null);
            setQuotationReceiptError(null);
          }}
        />
      )}
    </div>
  );
}
