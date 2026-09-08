import { useState, useEffect, useRef, KeyboardEvent } from "react";
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
  Wallet,
  CreditCard,
  Smartphone,
  CheckCircle,
  Edit2,
} from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { InventoryUnit, Customer, SaleType, CustomerAddress, Coupon } from "../lib/types";
import { Input, Label, FormGroup, ErrorText, SuccessText, Button, Dropdown } from "../components/ui";
import { CityPicker } from "../components/CityPicker";
import { useAuth } from "../context/AuthContext";
import { DELIVERY_PARTNERS, DeliveryPartner, calculateDeliveryFee, calculateCodAmount } from "../lib/delivery";

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

export default function PosPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [saleType, setSaleType] = useState<SaleType>("in_store");
  const [cart, setCart] = useState<CartLine[]>([]);

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
  const [advancePaid, setAdvancePaid] = useState("");
  // How the upfront amount (if any) was actually collected — needed to
  // correctly track cash-on-hand vs bank balance, same as an in-store sale.
  const [advancePaymentMethod, setAdvancePaymentMethod] = useState<"cash" | "card" | "bank_transfer">("cash");

  const [productQuery, setProductQuery] = useState("");
  const [productResults, setProductResults] = useState<InventoryUnit[]>([]);
  const [productSearchOpen, setProductSearchOpen] = useState(false);
  const [productSearchError, setProductSearchError] = useState<string | null>(null);
  const productBoxRef = useRef<HTMLDivElement>(null);
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
  const [newCustomerAddr1, setNewCustomerAddr1] = useState("");
  const [newCustomerAddr2, setNewCustomerAddr2] = useState("");
  const [newCustomerCity, setNewCustomerCity] = useState("");
  const [addCustomerError, setAddCustomerError] = useState<string | null>(null);
  const [addCustomerSubmitting, setAddCustomerSubmitting] = useState(false);

  const [editingLineKey, setEditingLineKey] = useState<string | null>(null);
  const [editPriceValue, setEditPriceValue] = useState("");
  const [priceEditError, setPriceEditError] = useState<string | null>(null);

  const [showCheckoutModal, setShowCheckoutModal] = useState(false);

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
  const [paymentMethod, setPaymentMethod] = useState("cash");
  // Cash tendered by the customer, so change due can be shown before the
  // sale is finalized — only meaningful when paymentMethod is "cash".
  const [amountPaid, setAmountPaid] = useState("");

  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutSuccess, setCheckoutSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  const total = Math.max(0, subtotal - combinedDiscount);
  const paidAmount = parseFloat(amountPaid) || 0;
  const changeDue = paymentMethod === "cash" && paidAmount > total ? paidAmount - total : 0;
  const cashPresets = [500, 1000, 2000, 5000, 10000, 20000];

  const deliveryFee = calculateDeliveryFee(parseFloat(packageWeight) || 0, isFreeDelivery);
  const advanceAmount = parseFloat(advancePaid) || 0;
  // On a credit online order, the product price is tracked as balance
  // due (not collected at all today) — only the delivery fee is ever
  // COD, per the business rule that delivery is always paid at the door
  // regardless of credit status.
  const codAmount = isCreditSale ? deliveryFee : calculateCodAmount(total, advanceAmount, deliveryFee);

  const cartIds = new Set(cart.flatMap((l) => l.units.map((u) => u.id)));
  const browserUnits = (allAvailableUnits ?? []).filter((u) => !cartIds.has(u.id));
  const browserCategories = Array.from(new Set(browserUnits.map((u) => (u.category ?? "").split(" / ")[0]).filter(Boolean))).sort();
  const browserFiltered = browserCategory === "all" ? browserUnits : browserUnits.filter((u) => (u.category ?? "").startsWith(browserCategory));

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
    if (newPrice > originalPrice) {
      setPriceEditError(`Cannot exceed the original price (Rs. ${originalPrice.toLocaleString()})`);
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
    const matches = units.filter(
      (u) =>
        !alreadyInCart.has(u.id) &&
        ((u.product_title ?? "").toLowerCase().includes(trimmed) ||
          (u.brand ?? "").toLowerCase().includes(trimmed) ||
          u.sku.toLowerCase().includes(trimmed) ||
          (u.barcode ?? "").toLowerCase().includes(trimmed))
    );
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

  function addToCart(unit: InventoryUnit) {
    const key = cartLineKey(unit);
    const existingLine = cart.find((l) => cartLineKey(l.units[0]) === key);

    if (existingLine) {
      setCart((c) => c.map((l) => (cartLineKey(l.units[0]) === key ? { ...l, units: [...l.units, unit] } : l)));
    } else {
      setCart((c) => [...c, { units: [unit], unit_price: unit.selling_price ?? 0 }]);
    }

    setProductQuery("");
    setProductResults([]);
    setProductSearchOpen(false);
    setAllAvailableUnits((prev) => (prev ? prev.filter((u) => u.id !== unit.id) : prev));
  }

  function removeFromCart(lineKey: string) {
    const line = cart.find((l) => cartLineKey(l.units[0]) === lineKey);
    if (line && line.units.length === 1) {
      // Removing the last unit deletes the whole line — worth a quick
      // confirmation, unlike reducing 3 units down to 2.
      if (!confirm(`Remove ${line.units[0].product_title} from the cart?`)) return;
    }
    setCart((c) =>
      c.map((l) => (cartLineKey(l.units[0]) === lineKey ? { ...l, units: l.units.slice(0, -1) } : l)).filter((l) => l.units.length > 0)
    );
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

  function selectCustomer(c: Customer) {
    setSelectedCustomer(c);
    setCustomerQuery("");
    setCustomerResults([]);
    setCustomerSearchOpen(false);
  }

  function removeCustomer() {
    setSelectedCustomer(null);
    setIsCreditSale(false);
  }

  function openAddCustomer() {
    setShowAddCustomer(true);
    const trimmedQuery = customerQuery.trim();
    const looksLikePhone = trimmedQuery !== "" && !isNaN(Number(trimmedQuery));
    setNewCustomerName(looksLikePhone ? "" : trimmedQuery);
    setNewCustomerPhone(looksLikePhone ? trimmedQuery : "");
    setNewCustomerPhone2("");
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
    setAddCustomerSubmitting(true);
    try {
      const created = await api.post<Customer>("/customers", {
        name: newCustomerName.trim(),
        phone: newCustomerPhone.trim(),
        phone2: newCustomerPhone2.trim() || undefined,
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
        setCheckoutError("Select or add a customer before completing an online order — delivery needs their address.");
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
    if (saleType === "online" && !selectedCustomer) {
      setCheckoutError("Select or add a customer before completing an online order — delivery needs their address.");
      setShowCheckoutModal(false);
      return;
    }
    if (saleType === "online" && !deliveryPartner) {
      setCheckoutError("Select a delivery partner for this online order.");
      return;
    }
    if (isCreditSale) {
      const creditPaid = parseFloat(creditAmountPaid) || 0;
      if (creditPaid > total) {
        setCheckoutError("Amount paid can't exceed the order total on a credit sale.");
        return;
      }
    } else if (saleType === "in_store" && paymentMethod === "cash" && paidAmount < total) {
      setCheckoutError("Cash tendered is less than the total due");
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
        : total;

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
        items: cart.flatMap((line) => line.units.map((u) => ({ inventory_id: u.id, unit_price: line.unit_price }))),
        manual_discount_type: discountType,
        manual_discount_value: parseFloat(discountValue) || 0,
        coupon_code: appliedCoupon?.code,
        amount_paid: finalAmountPaid,
        payment_method: effectivePaymentMethod,
        amount_received: paymentMethod === "cash" && saleType === "in_store" && !isCreditSale ? paidAmount : undefined,
        sale_type: saleType,
        is_credit_order: isCreditSale,
        ...(saleType === "online"
          ? {
              delivery_partner: deliveryPartner,
              package_weight_kg: parseFloat(packageWeight) || undefined,
              is_free_delivery: isFreeDelivery,
            }
          : {}),
      });

      setCheckoutSuccess(`Sale complete — ${sale.invoice}${saleType === "online" ? ". A pending delivery was created automatically." : "."}`);
      setCart([]);
      setSelectedCustomer(null);
      setCustomerQuery("");
      setDiscountType("fixed");
      setDiscountValue("0");
      setCouponCode("");
      setAppliedCoupon(null);
      setCouponError(null);
      setAmountPaid("");
      setAllAvailableUnits(null);
      setShowCheckoutModal(false);
      setIsCreditSale(false);
      setCreditAmountPaid("0");
      setCreditPaymentMethod("cash");
      setDeliveryPartner("");
      setPackageWeight("");
      setIsFreeDelivery(false);
      setAdvancePaid("");
      setAdvancePaymentMethod("cash");
    } catch (err) {
      setCheckoutError(err instanceof ApiRequestError ? err.message : "Checkout failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="h-screen flex flex-col p-4 gap-4 overflow-hidden">
      <div className="flex-1 flex gap-4 min-h-0">
        <div className="flex-1 flex flex-col bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden min-h-0">
          <div className="p-4 border-b border-gray-200 bg-white flex-shrink-0">
            <div className="grid grid-cols-3 items-center gap-3">
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

              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={() => setSaleType("in_store")}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                    saleType === "in_store" ? "bg-black text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  In-Store
                </button>
                <button
                  onClick={() => setSaleType("online")}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                    saleType === "online" ? "bg-black text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  Online Order
                </button>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={toggleBrowser}
                  className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-sm transition flex-shrink-0 ${
                    showBrowser ? "bg-black text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  <Package size={15} />
                  {showBrowser ? "Hide products" : "Browse products"}
                </button>
              </div>
            </div>

            <div className="mt-3 relative" ref={productBoxRef}>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={17} />
                <input
                  type="text"
                  placeholder="Search or scan by product name, SKU, or barcode... (Press Enter to add)"
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

          {cart.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center min-h-0">
              <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mb-3">
                <ShoppingCart size={40} className="text-gray-400" />
              </div>
              <h3 className="text-base font-medium text-gray-900">Cart is empty</h3>
              <p className="text-sm text-gray-500 mt-1">Search for products or browse the catalog</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-4 min-h-0">
              <div className="space-y-2">
                <div className="grid grid-cols-12 gap-3 px-4 py-2 bg-gray-50 rounded-lg text-xs font-medium text-gray-600">
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
                  const isDiscounted = line.unit_price !== originalPrice;
                  const isEditing = editingLineKey === lineKey;
                  const qty = line.units.length;
                  return (
                    <div
                      key={lineKey}
                      className="grid grid-cols-12 gap-3 items-center px-4 py-2.5 bg-white border border-gray-100 rounded-xl hover:shadow-sm transition"
                    >
                      <div className="col-span-5 min-w-0">
                        <p className="font-medium text-gray-900 text-sm truncate">{sample.product_title}</p>
                        <p className="text-xs text-gray-500 mt-0.5 truncate">
                          {sample.color ?? "—"} / {sample.size ?? "—"} | SKU: {sample.sku}
                        </p>
                      </div>
                      <div className="col-span-1 text-center">
                        <span className="inline-flex items-center justify-center w-6 h-6 bg-gray-100 rounded-full text-xs font-semibold text-gray-700">
                          {qty}
                        </span>
                      </div>
                      <div className="col-span-3">
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
                              <Edit2 size={13} />
                            </button>
                          </div>
                        )}
                        {priceEditError && isEditing && <p className="text-xs text-red-500 mt-1">{priceEditError}</p>}
                      </div>
                      <div className="col-span-2">
                        <p className="text-gray-900 font-semibold text-sm">Rs. {(line.unit_price * qty).toLocaleString()}</p>
                      </div>
                      <div className="col-span-1 text-right">
                        <button onClick={() => removeFromCart(lineKey)} className="text-gray-400 hover:text-red-500 transition">
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="border-t border-gray-200 bg-white p-4 flex-shrink-0">
            <div className="grid grid-cols-2 gap-6 items-start">
              <div className="space-y-3">
                <FormGroup>
                  <Label>Discount</Label>
                  <div className="flex gap-2">
                    <div className="flex rounded-lg border border-gray-300 overflow-hidden flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => setDiscountType("fixed")}
                        className={`px-2.5 py-1.5 text-xs font-medium transition ${
                          discountType === "fixed" ? "bg-black text-white" : "bg-white text-gray-600 hover:bg-gray-50"
                        }`}
                      >
                        LKR
                      </button>
                      <button
                        type="button"
                        onClick={() => setDiscountType("percent")}
                        className={`px-2.5 py-1.5 text-xs font-medium transition border-l border-gray-300 ${
                          discountType === "percent" ? "bg-black text-white" : "bg-white text-gray-600 hover:bg-gray-50"
                        }`}
                      >
                        %
                      </button>
                    </div>
                    <Input
                      type="number"
                      min="0"
                      max={discountType === "percent" ? 100 : undefined}
                      value={discountValue}
                      onChange={(e) => setDiscountValue(e.target.value)}
                      placeholder={discountType === "percent" ? "e.g. 10" : "e.g. 500"}
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
                        placeholder="e.g. WELCOME10"
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
                      <User size={15} className="text-gray-600" />
                      <span className="text-sm font-medium text-gray-700">
                        Customer{saleType === "online" && <span className="text-red-500"> *</span>}
                      </span>
                    </div>
                    {selectedCustomer && (
                      <button onClick={removeCustomer} className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1">
                        <X size={11} /> Remove
                      </button>
                    )}
                  </div>

                  {!selectedCustomer ? (
                    <div className="relative" ref={customerBoxRef}>
                      <div className="relative">
                        <Phone size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
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
                                <UserPlus size={13} />
                                Add "{customerQuery}" as new customer
                              </button>
                            </>
                          ) : (
                            <div className="px-3.5 py-3">
                              <p className="text-xs text-gray-400 mb-2">No matching customers.</p>
                              <button
                                onClick={openAddCustomer}
                                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-black text-white rounded-lg text-sm hover:bg-gray-800 transition"
                              >
                                <UserPlus size={13} />
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
                          <User size={13} className="text-white" />
                        </div>
                        <p className="font-medium text-gray-900 text-sm truncate">{selectedCustomer.name}</p>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                        <Star size={13} className="text-amber-400" />
                        <span className="text-sm font-semibold text-amber-700">{selectedCustomer.loyalty_points}</span>
                      </div>
                    </div>
                  )}

                  {saleType === "online" && !selectedCustomer && (
                    <div className="mt-2 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
                      <AlertTriangle size={12} className="text-amber-600 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-800">A customer is required for online orders, so delivery can use their saved address.</p>
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
                          options={DELIVERY_PARTNERS.map((p) => ({ value: p.value, label: p.label }))}
                        />
                      </FormGroup>

                      <FormGroup>
                        <Label>Package weight (kg)</Label>
                        <Input
                          type="number"
                          min="0"
                          step="0.1"
                          value={packageWeight}
                          onChange={(e) => setPackageWeight(e.target.value)}
                          disabled={isFreeDelivery}
                          placeholder="e.g. 1.5"
                        />
                      </FormGroup>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div>
                  <Label>Order summary</Label>
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
                    <div className="flex justify-between text-lg font-bold pt-1.5 border-t border-gray-200">
                      <span>Total</span>
                      <span>Rs. {total.toLocaleString()}</span>
                    </div>
                  </div>
                </div>

                {saleType === "online" ? (
                  <>
                    <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                      <input type="checkbox" checked={isFreeDelivery} onChange={(e) => setIsFreeDelivery(e.target.checked)} className="rounded" />
                      Free delivery (customer still pays for the order itself)
                    </label>

                    {isAdmin && (
                      <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isCreditSale}
                          onChange={(e) => {
                            setIsCreditSale(e.target.checked);
                            if (e.target.checked) setAdvancePaid("0");
                          }}
                          className="rounded"
                        />
                        Credit order (product on credit — delivery fee is still collected on delivery)
                      </label>
                    )}

                    {isCreditSale ? (
                      <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">
                        Product total (Rs. {total.toLocaleString()}) goes on {selectedCustomer ? selectedCustomer.name : "the customer"}'s
                        balance due. Only the delivery fee is collected as COD.
                      </div>
                    ) : (
                      <FormGroup>
                        <Label>Amount paid now, if any (Rs.)</Label>
                        <Input type="number" min="0" value={advancePaid} onChange={(e) => setAdvancePaid(e.target.value)} placeholder="0" />
                        <p className="text-xs text-gray-400 mt-1">
                          This applies against the full amount owed (product + delivery fee). Pay it all now and COD becomes Rs. 0; pay
                          less and the difference — including the delivery fee — becomes COD.
                        </p>
                      </FormGroup>
                    )}

                    {advanceAmount > 0 && !isCreditSale && (
                      <FormGroup>
                        <Label>How was that amount paid?</Label>
                        <div className="grid grid-cols-3 gap-2">
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
                        <span>Delivery fee (450 first kg + 100/extra kg)</span>
                        <span>{isFreeDelivery ? "Waived" : `Rs. ${deliveryFee.toLocaleString()}`}</span>
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
                    {isAdmin && (
                      <label
                        className={`flex items-center gap-2 text-sm cursor-pointer ${selectedCustomer ? "text-gray-700" : "text-gray-400"}`}
                      >
                        <input
                          type="checkbox"
                          checked={isCreditSale}
                          disabled={!selectedCustomer}
                          onChange={(e) => setIsCreditSale(e.target.checked)}
                          className="rounded"
                        />
                        Credit sale (settle later — tracked as balance due)
                      </label>
                    )}
                    {isAdmin && !selectedCustomer && (
                      <p className="text-xs text-gray-400 -mt-2">Select a customer first — credit isn't offered to walk-ins.</p>
                    )}

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
                                onClick={() => setAmountPaid(total.toString())}
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

                {checkoutError && <ErrorText>{checkoutError}</ErrorText>}
                {checkoutSuccess && <SuccessText>{checkoutSuccess}</SuccessText>}

                <div className="flex gap-2">
                  <button onClick={clearCart} className="flex-1 px-4 py-2 border border-gray-300 rounded-xl hover:bg-gray-50 transition text-sm font-medium">
                    Clear
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
        </div>

        <div
          className={`bg-white rounded-2xl shadow-sm border border-gray-200 flex flex-col overflow-hidden flex-shrink-0 transition-all duration-200 ${
            showBrowser ? "w-80 opacity-100" : "w-0 opacity-0 border-0"
          }`}
        >
          <div className="w-80 h-full flex flex-col">
            <div className="p-3.5 border-b border-gray-200 bg-gray-50 rounded-t-2xl flex-shrink-0">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-gray-900 text-sm">Product catalog</h3>
                <button onClick={toggleBrowser} className="text-gray-400 hover:text-gray-600">
                  <X size={17} />
                </button>
              </div>
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
                <div className="text-center py-8 text-gray-500 text-sm">No available items in this category</div>
              ) : (
                browserFiltered.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => addToCart(u)}
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

      {/* NEW CUSTOMER MODAL — full intake form: name, phone (required) +
          phone2 (optional), address line 1/2, and city. */}
      {showAddCustomer && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full max-h-[90vh] flex flex-col shadow-2xl">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
              <h3 className="text-base font-semibold text-gray-900">New customer</h3>
              <button onClick={() => setShowAddCustomer(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              <FormGroup>
                <Label>Name</Label>
                <Input value={newCustomerName} onChange={(e) => setNewCustomerName(e.target.value)} autoFocus />
              </FormGroup>
              <div className="grid grid-cols-2 gap-3">
                <FormGroup>
                  <Label>Phone</Label>
                  <Input value={newCustomerPhone} onChange={(e) => setNewCustomerPhone(e.target.value)} placeholder="Required" />
                </FormGroup>
                <FormGroup>
                  <Label>Phone 2 (optional)</Label>
                  <Input value={newCustomerPhone2} onChange={(e) => setNewCustomerPhone2(e.target.value)} />
                </FormGroup>
              </div>
              <FormGroup>
                <Label>Address line 1</Label>
                <Input value={newCustomerAddr1} onChange={(e) => setNewCustomerAddr1(e.target.value)} />
              </FormGroup>
              <FormGroup>
                <Label>Address line 2</Label>
                <Input value={newCustomerAddr2} onChange={(e) => setNewCustomerAddr2(e.target.value)} />
              </FormGroup>
              <FormGroup>
                <Label>City</Label>
                <CityPicker value={newCustomerCity} onChange={setNewCustomerCity} />
              </FormGroup>
              {addCustomerError && <ErrorText>{addCustomerError}</ErrorText>}
            </div>

            <div className="p-5 border-t border-gray-100 flex gap-3 flex-shrink-0">
              <button
                onClick={() => setShowAddCustomer(false)}
                className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl hover:bg-gray-50 transition font-medium text-sm"
              >
                Cancel
              </button>
              <Button variant="primary" disabled={addCustomerSubmitting} onClick={submitNewCustomer} className="flex-1">
                {addCustomerSubmitting ? "Saving..." : "Save & select"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showAddressCheck &&
        (() => {
          const defaultAddr = customerAddresses?.find((a) => a.is_default) ?? customerAddresses?.[0];
          return (
            <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
              <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl">
                <div className="p-5 border-b border-gray-100 flex items-center justify-between">
                  <h3 className="text-base font-semibold text-gray-900">Confirm delivery address</h3>
                  <button onClick={() => setShowAddressCheck(false)} className="text-gray-400 hover:text-gray-600">
                    <X size={18} />
                  </button>
                </div>
                <div className="p-5 space-y-3">
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
                        <AlertTriangle size={13} className="text-amber-600 flex-shrink-0 mt-0.5" />
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
                <div className="p-5 border-t border-gray-100 flex gap-3">
                  <button
                    onClick={() => setShowAddressCheck(false)}
                    className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl hover:bg-gray-50 transition font-medium text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmAddressAndProceed}
                    className="flex-1 px-4 py-2.5 bg-black text-white rounded-xl hover:bg-gray-800 transition font-medium text-sm"
                  >
                    {defaultAddr ? "Confirmed — continue" : "Save & continue"}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      {showCheckoutModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] flex flex-col shadow-2xl">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
              <h3 className="text-base font-semibold text-gray-900">Confirm sale</h3>
              <button onClick={() => setShowCheckoutModal(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
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
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Payment</span>
                  <span className="text-gray-900 font-medium capitalize">
                    {isCreditSale
                      ? saleType === "online"
                        ? "Credit (product) + COD (delivery)"
                        : "Credit"
                      : saleType === "online"
                      ? advanceAmount > 0
                        ? `Partial payment (${advancePaymentMethod.replace("_", " ")}) + rest on delivery`
                        : "Pay in full on delivery (COD)"
                      : paymentMethod.replace("_", " ")}
                  </span>
                </div>
                {saleType === "online" && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Delivery partner</span>
                    <span className="text-gray-900 font-medium">
                      {DELIVERY_PARTNERS.find((p) => p.value === deliveryPartner)?.label ?? "—"}
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
                      <span>{isFreeDelivery ? "Free" : `Rs. ${deliveryFee.toLocaleString()}`}</span>
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

            <div className="p-5 border-t border-gray-100 flex gap-3 flex-shrink-0">
              <button
                onClick={() => setShowCheckoutModal(false)}
                className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl hover:bg-gray-50 transition font-medium text-sm"
              >
                Back
              </button>
              <button
                onClick={handleCheckout}
                disabled={submitting}
                className="flex-1 px-4 py-2.5 bg-black text-white rounded-xl hover:bg-gray-800 transition font-medium text-sm disabled:opacity-50"
              >
                {submitting ? "Processing..." : "Confirm & complete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
