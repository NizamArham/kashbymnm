import { useState, useRef, useEffect, RefObject } from "react";
import { Printer, Download, User } from "lucide-react";
import JsBarcode from "jsbarcode";
import { WaybillLabel, WaybillLabelData } from "../components/WaybillLabel";
import { generateWaybillLabelPdf } from "../lib/waybillLabelPdf";
import { useDeliveryPartners, waybillShopCode } from "../lib/delivery";
import { PageHeader, Card, Input, Label, FormGroup, ErrorText, Dropdown, TabToggle } from "../components/ui";
import { CityPicker } from "../components/CityPicker";
import { api } from "../lib/api";
import { Customer, BusinessInfo } from "../lib/types";
import { applyBusinessInfoToReturnAddress } from "../lib/businessInfo";
import { useKeyboardShortcut } from "../lib/useKeyboardShortcut";

function formatLabelDate(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

type Step = "receiver" | "package";

export default function WaybillGeneratorPage() {
  const [step, setStep] = useState<Step>("receiver");

  const [customerName, setCustomerName] = useState("");
  const [addr1, setAddr1] = useState("");
  const [addr2, setAddr2] = useState("");
  const [addr3, setAddr3] = useState("");
  const [city, setCity] = useState("");
  const [phone1, setPhone1] = useState("");
  const [phone2, setPhone2] = useState("");

  // The shop code shown in the label's "[ ... ]" header — picked by
  // tapping directly on that part of the preview, rather than a separate
  // form field, since it's really just a property of the label itself.
  const { activePartners } = useDeliveryPartners();
  const [shopCode, setShopCode] = useState(waybillShopCode("D2D"));
  const [shopCodePickerOpen, setShopCodePickerOpen] = useState(false);
  const [customShopCodeInput, setCustomShopCodeInput] = useState("");
  const shopCodePickerRef = useRef<HTMLDivElement>(null);

  // Typing a name into the Customer Name field doubles as a search over
  // existing customers — picking a match autofills the fields below. It's
  // just a shortcut for manual entry, not a link that's saved anywhere,
  // since a waybill generated here isn't tied back to a customer record.
  const [allCustomers, setAllCustomers] = useState<Customer[] | null>(null);
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [customerSearchOpen, setCustomerSearchOpen] = useState(false);
  const [customerNoAddressNotice, setCustomerNoAddressNotice] = useState(false);
  const customerBoxRef = useRef<HTMLDivElement>(null);

  // Typing a phone number that matches an existing customer doesn't
  // autofill silently — manual waybills are usually made precisely
  // because this shipment needs a different address than what's on file,
  // so we ask before overwriting anything the person already typed.
  const [phoneMatchCustomer, setPhoneMatchCustomer] = useState<Customer | null>(null);
  const [dismissedPhoneMatch, setDismissedPhoneMatch] = useState<string | null>(null);

  const [orderRef, setOrderRef] = useState("");
  const [pcs, setPcs] = useState("1");
  const [weight, setWeight] = useState("");
  const [paymentType, setPaymentType] = useState<"Prepaid" | "COD">("Prepaid");
  const [codAmount, setCodAmount] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [description, setDescription] = useState("");

  const [returnBusinessName, setReturnBusinessName] = useState("M&M Clothing");
  const [returnAddress, setReturnAddress] = useState("78/2 Anderson Rd, Dehiwala,\nSri Lanka.");
  const [returnPhone, setReturnPhone] = useState("+94 70-5500174");
  const [returnWebsite, setReturnWebsite] = useState("www.mnmclothing.lk");

  const [stepError, setStepError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const labelRef = useRef<HTMLDivElement>(null);
  const barcodeRef = useRef<SVGSVGElement>(null);

  const codAmountNum = parseFloat(codAmount) || 0;
  // CityPicker's value is "City Name PostalCode" combined — strip only
  // the trailing code token for display, since some real city names
  // (e.g. "Colombo 1") legitimately contain a number of their own that
  // a naive "first digit" split would wrongly cut off too.
  const cityParts = city.trim().split(" ");
  const cityHasPostalCode = cityParts.length > 1 && /^\d+$/.test(cityParts[cityParts.length - 1]);
  const cityName = cityHasPostalCode ? cityParts.slice(0, -1).join(" ") : city;
  const cityPostalCode = cityHasPostalCode ? cityParts[cityParts.length - 1] : "";

  const labelData: WaybillLabelData = {
    shopCode,
    date: formatLabelDate(new Date()),
    customerName,
    addressLines: [addr1, addr2, addr3].filter(Boolean),
    city: cityName,
    cityPostalCode,
    phones: [phone1, phone2].filter(Boolean),
    orderRef,
    pcs: parseInt(pcs, 10) || 1,
    weight,
    paymentType,
    codAmount: codAmountNum,
    description,
    trackingNumber,
    returnBusinessName,
    returnAddressLines: returnAddress.split("\n"),
    returnPhone,
    returnWebsite,
  };

  useEffect(() => {
    if (!trackingNumber || !barcodeRef.current) return;
    try {
      JsBarcode(barcodeRef.current, trackingNumber, {
        format: "CODE128",
        width: 2,
        height: 80,
        displayValue: false,
        margin: 10,
      });
    } catch {
      // an invalid tracking number for CODE128 just leaves the barcode
      // blank rather than blocking the person over it
    }
  }, [trackingNumber]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (customerBoxRef.current && !customerBoxRef.current.contains(e.target as Node)) {
        setCustomerSearchOpen(false);
      }
      if (shopCodePickerRef.current && !shopCodePickerRef.current.contains(e.target as Node)) {
        setShopCodePickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    api
      .get<BusinessInfo | null>("/business-info")
      .then((info) => {
        if (info) applyBusinessInfoToReturnAddress(info, setReturnBusinessName, setReturnAddress, setReturnPhone, setReturnWebsite);
      })
      .catch(() => {
        // No business info saved yet (or the request failed) — the
        // hardcoded defaults above stay as a reasonable fallback.
      });
  }, []);

  function selectShopCode(code: string) {
    setShopCode(code);
    setShopCodePickerOpen(false);
    setCustomShopCodeInput("");
  }

  function applyCustomShopCode() {
    const trimmed = customShopCodeInput.trim();
    if (!trimmed) return;
    setShopCode(trimmed);
    setShopCodePickerOpen(false);
    setCustomShopCodeInput("");
  }

  async function ensureCustomersLoaded() {
    if (allCustomers) return allCustomers;
    const customers = await api.get<Customer[]>("/customers");
    setAllCustomers(customers);
    return customers;
  }

  async function handleCustomerNameChange(value: string) {
    setCustomerName(value);
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

  async function loadCustomerDetails(c: Customer) {
    setCustomerNoAddressNotice(false);
    setCustomerName(c.name);
    setPhone1(c.phone ?? "");
    setPhone2(c.phone2 ?? "");

    try {
      const full = await api.get<Customer>(`/customers/${c.id}`);
      const addresses = full.addresses ?? [];
      const defaultAddr = addresses.find((a) => a.is_default) ?? addresses[0];
      if (defaultAddr) {
        // A saved address is often just 1-2 free-text lines with commas
        // packed inside (e.g. "101, Main Street") — split on every comma
        // so each part lands in its own box instead of piling up in one.
        const parts = [defaultAddr.address_line1, defaultAddr.address_line2]
          .filter((v): v is string => !!v && v.trim() !== "")
          .flatMap((line) => line.split(",").map((s) => s.trim()).filter(Boolean));
        setAddr1(parts[0] ?? "");
        setAddr2(parts[1] ?? "");
        setAddr3(parts.slice(2).join(", "));
        setCity(defaultAddr.city ?? "");
      } else {
        setCustomerNoAddressNotice(true);
      }
    } catch {
      setCustomerNoAddressNotice(true);
    }
  }

  async function pickCustomer(c: Customer) {
    setCustomerResults([]);
    setCustomerSearchOpen(false);
    setPhoneMatchCustomer(null);
    await loadCustomerDetails(c);
  }

  async function handlePhone1Blur() {
    const trimmed = phone1.trim();
    if (trimmed.length < 7 || trimmed === dismissedPhoneMatch) return;
    const customers = await ensureCustomersLoaded();
    const match = customers.find((c) => c.phone === trimmed || c.phone2 === trimmed);
    if (match && match.name !== customerName) {
      setPhoneMatchCustomer(match);
    }
  }

  async function confirmLoadPhoneMatch() {
    if (!phoneMatchCustomer) return;
    await loadCustomerDetails(phoneMatchCustomer);
    setPhoneMatchCustomer(null);
  }

  function dismissPhoneMatch() {
    setDismissedPhoneMatch(phone1.trim());
    setPhoneMatchCustomer(null);
  }

  function validateStep1(): boolean {
    if (!customerName.trim()) {
      setStepError("Customer name is required");
      return false;
    }
    if (!addr1.trim()) {
      setStepError("Address line 1 is required");
      return false;
    }
    if (!city) {
      setStepError("Select a city");
      return false;
    }
    if (!phone1.trim()) {
      setStepError("Contact number 1 is required");
      return false;
    }
    setStepError(null);
    return true;
  }

  function validateStep2(): boolean {
    if (!orderRef.trim()) {
      setError("Order reference is required");
      return false;
    }
    if (!pcs || parseInt(pcs, 10) < 1) {
      setError("Enter the number of pieces");
      return false;
    }
    if (!weight.trim()) {
      setError("Enter the package weight");
      return false;
    }
    if (!trackingNumber.trim()) {
      setError("Enter the tracking number you received from the courier");
      return false;
    }
    setError(null);
    return true;
  }

  async function handleSavePdf() {
    if (!validateStep2()) return;
    setProcessing(true);
    try {
      const pdf = generateWaybillLabelPdf(labelData);
      pdf.save(`M&M_Waybill_${trackingNumber}.pdf`);
    } catch {
      setError("Failed to generate the PDF — try again");
    } finally {
      setProcessing(false);
    }
  }

  useKeyboardShortcut("d", handleSavePdf, { ctrlOrCmd: true, shift: true, enabled: step === "package" && !processing });

  async function handlePrint() {
    if (!validateStep2()) return;
    setProcessing(true);
    try {
      const pdf = generateWaybillLabelPdf(labelData);
      pdf.autoPrint();
      const blobUrl = pdf.output("bloburl");
      const printWindow = window.open(blobUrl as unknown as string, "_blank");
      if (!printWindow) {
        setError("Pop-up blocked — allow pop-ups to print, or use Save as PDF instead");
        setProcessing(false);
        return;
      }
    } catch {
      setError("Failed to prepare printing — try again");
    } finally {
      setProcessing(false);
    }
  }

  function resetAll() {
    if (!confirm("Start over? This clears everything you've entered on this waybill.")) return;
    setStep("receiver");
    setCustomerName("");
    setAddr1("");
    setAddr2("");
    setAddr3("");
    setCity("");
    setPhone1("");
    setPhone2("");
    setShopCode(waybillShopCode("D2D"));
    setShopCodePickerOpen(false);
    setCustomShopCodeInput("");
    setCustomerNoAddressNotice(false);
    setCustomerResults([]);
    setCustomerSearchOpen(false);
    setPhoneMatchCustomer(null);
    setDismissedPhoneMatch(null);
    setOrderRef("");
    setPcs("1");
    setWeight("");
    setPaymentType("Prepaid");
    setCodAmount("");
    setTrackingNumber("");
    setDescription("");
    setStepError(null);
    setError(null);
  }

  return (
    <div>
      <PageHeader
        title="Waybill Generator"
        subtitle="Generate a courier waybill for an order not yet in the system."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <div className="flex items-center justify-between mb-4">
            <TabToggle
              value={step}
              onChange={(v) => setStep(v as Step)}
              options={[
                { value: "receiver", label: "Receiver Details" },
                { value: "package", label: "Package Details" },
              ]}
            />
            <button onClick={resetAll} className="text-xs text-gray-400 hover:text-gray-700 underline">
              Start over
            </button>
          </div>

          {step === "receiver" ? (
            <>
              <FormGroup>
                <Label>Customer Name</Label>
                <div className="relative" ref={customerBoxRef}>
                  <Input
                    value={customerName}
                    onChange={(e) => handleCustomerNameChange(e.target.value)}
                    onFocus={() => customerName.trim().length >= 2 && setCustomerSearchOpen(true)}
                    placeholder="Search customers..."
                  />
                  {customerSearchOpen && customerName.trim().length >= 2 && customerResults.length > 0 && (
                    <div className="absolute z-20 top-full left-0 right-0 mt-1.5 bg-white border border-gray-200 rounded-xl shadow-lg max-h-56 overflow-y-auto">
                      {customerResults.slice(0, 6).map((c) => (
                        <button
                          key={c.id}
                          onClick={() => pickCustomer(c)}
                          className="w-full flex items-center justify-between gap-3 px-3.5 py-2 text-left hover:bg-gray-50 transition-colors border-b border-gray-50 last:border-0"
                        >
                          <div className="min-w-0">
                            <p className="text-sm text-gray-900 truncate">{c.name}</p>
                            <p className="text-xs text-gray-400">{c.phone ?? c.customer_code}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {customerNoAddressNotice && (
                  <p className="text-xs text-amber-600 mt-1.5">This customer has no saved address — fill it in manually below.</p>
                )}
              </FormGroup>
              <FormGroup>
                <Label>Address Line 1</Label>
                <Input value={addr1} onChange={(e) => setAddr1(e.target.value)} />
              </FormGroup>
              <FormGroup>
                <Label>Address Line 2 (optional)</Label>
                <Input value={addr2} onChange={(e) => setAddr2(e.target.value)} />
              </FormGroup>
              <FormGroup>
                <Label>Address Line 3 (optional)</Label>
                <Input value={addr3} onChange={(e) => setAddr3(e.target.value)} />
              </FormGroup>
              <FormGroup>
                <CityPicker value={city} onChange={setCity} />
              </FormGroup>
              <div className="grid grid-cols-2 gap-3">
                <FormGroup>
                  <Label>Contact No 1</Label>
                  <Input
                    value={phone1}
                    onChange={(e) => {
                      setPhone1(e.target.value);
                      setPhoneMatchCustomer(null);
                    }}
                    onBlur={handlePhone1Blur}
                  />
                </FormGroup>
                <FormGroup>
                  <Label>Contact No 2 (optional)</Label>
                  <Input value={phone2} onChange={(e) => setPhone2(e.target.value)} />
                </FormGroup>
              </div>
              {phoneMatchCustomer && (
                <div className="bg-blue-50 border border-blue-200 rounded-xl px-3.5 py-2.5 flex items-start gap-2.5">
                  <User size={15} className="text-blue-600 flex-shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-blue-900">
                      This number matches an existing customer — <span className="font-medium">{phoneMatchCustomer.name}</span>. Load their saved name &amp; address?
                    </p>
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={confirmLoadPhoneMatch}
                        className="px-3 py-1 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition"
                      >
                        Load saved details
                      </button>
                      <button
                        onClick={dismissPhoneMatch}
                        className="px-3 py-1 border border-blue-300 text-blue-700 rounded-lg text-xs font-medium hover:bg-blue-100 transition"
                      >
                        No, keep as is
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {stepError && <ErrorText>{stepError}</ErrorText>}
              <div className="flex justify-end mt-2">
                <button
                  onClick={() => validateStep1() && setStep("package")}
                  className="px-5 py-2.5 bg-black text-white rounded-full text-sm font-medium hover:bg-gray-800 transition"
                >
                  Next →
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <FormGroup>
                  <Label>Order Ref</Label>
                  <Input value={orderRef} onChange={(e) => setOrderRef(e.target.value)} />
                </FormGroup>
                <FormGroup>
                  <Label>No. of Pcs</Label>
                  <Input type="number" min="1" value={pcs} onChange={(e) => setPcs(e.target.value.replace(/[^0-9]/g, ""))} />
                </FormGroup>
              </div>
              <FormGroup>
                <Label>Weight (kg)</Label>
                <Input value={weight} onChange={(e) => setWeight(e.target.value)} />
              </FormGroup>
              <div className="grid grid-cols-2 gap-3">
                <FormGroup>
                  <Label>Payment Type</Label>
                  <Dropdown
                    value={paymentType}
                    onChange={(v) => {
                      setPaymentType(v as "Prepaid" | "COD");
                      if (v !== "COD") setCodAmount("");
                    }}
                    options={[
                      { value: "Prepaid", label: "Prepaid" },
                      { value: "COD", label: "Cash on Delivery" },
                    ]}
                  />
                </FormGroup>
                <FormGroup>
                  <Label>COD Amount (LKR)</Label>
                  <Input
                    type="number"
                    min="0"
                    value={codAmount}
                    onChange={(e) => setCodAmount(e.target.value)}
                    disabled={paymentType !== "COD"}
                  />
                </FormGroup>
              </div>
              <FormGroup>
                <Label>Tracking No (from courier portal)</Label>
                <Input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} />
              </FormGroup>
              <FormGroup>
                <Label>Product Description (optional)</Label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  maxLength={150}
                  className="w-full border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-gray-400"
                />
              </FormGroup>

              <details className="mt-2 border-t border-gray-100 pt-4">
                <summary className="text-sm font-medium text-gray-700 cursor-pointer">Return address (if non-delivery)</summary>
                <div className="mt-3 space-y-2">
                  <FormGroup>
                    <Label>Business name</Label>
                    <Input value={returnBusinessName} onChange={(e) => setReturnBusinessName(e.target.value)} />
                  </FormGroup>
                  <FormGroup>
                    <Label>Address (one line per row)</Label>
                    <textarea
                      value={returnAddress}
                      onChange={(e) => setReturnAddress(e.target.value)}
                      rows={2}
                      className="w-full border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-gray-400"
                    />
                  </FormGroup>
                  <div className="grid grid-cols-2 gap-3">
                    <FormGroup>
                      <Label>Phone</Label>
                      <Input value={returnPhone} onChange={(e) => setReturnPhone(e.target.value)} />
                    </FormGroup>
                    <FormGroup>
                      <Label>Website</Label>
                      <Input value={returnWebsite} onChange={(e) => setReturnWebsite(e.target.value)} />
                    </FormGroup>
                  </div>
                </div>
              </details>

              {error && <ErrorText>{error}</ErrorText>}

              <div className="flex justify-between gap-3 mt-4">
                <button
                  onClick={() => setStep("receiver")}
                  className="px-5 py-2.5 border-2 border-black rounded-full text-sm font-medium hover:bg-gray-50 transition"
                >
                  ← Back
                </button>
                <div className="flex gap-3">
                  <button
                    onClick={handlePrint}
                    disabled={processing}
                    className="flex items-center gap-2 px-5 py-2.5 border border-gray-300 rounded-full text-sm font-medium hover:bg-gray-50 transition disabled:opacity-50"
                  >
                    <Printer size={15} />
                    Print
                  </button>
                  <button
                    onClick={handleSavePdf}
                    disabled={processing}
                    title="Save as PDF (Ctrl/Cmd+Shift+D)"
                    className="flex items-center gap-2 px-5 py-2.5 bg-black text-white rounded-full text-sm font-medium hover:bg-gray-800 transition disabled:opacity-50"
                  >
                    <Download size={15} />
                    {processing ? "Working..." : "Save as PDF"}
                  </button>
                </div>
              </div>
            </>
          )}
        </Card>

        {/* justify-start, not center: this label has a fixed real-world
            print width, so once the column is narrower than that (e.g.
            around 1024-1280px window widths, right where the sidebar
            first switches on), centering would overflow evenly on BOTH
            sides — clipping the start of every line with no way to
            scroll back to it. Flush-left with overflow-x-auto always
            keeps the readable left edge in view; only the less-critical
            trailing content needs a scroll. */}
        <div className="flex justify-start items-start overflow-x-auto">
          <div ref={shopCodePickerRef} style={{ position: "relative", display: "inline-block" }}>
            <div
              style={{
                display: "inline-block",
                transformOrigin: "top center",
                border: "1px solid #d1d5db",
                borderRadius: 10,
                overflow: "hidden",
                boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
              }}
            >
              <WaybillLabel
                ref={labelRef}
                barcodeRef={barcodeRef as RefObject<SVGSVGElement>}
                data={labelData}
                onShopCodeClick={() => setShopCodePickerOpen((o) => !o)}
              />
            </div>

            {shopCodePickerOpen && (
              <div
                className="bg-white border border-gray-200 rounded-xl shadow-lg"
                style={{ position: "absolute", top: 40, left: 8, width: 280, zIndex: 30 }}
              >
                <p className="text-xs text-gray-400 px-3 pt-2.5 pb-1">Delivery partner</p>
                {activePartners.map((p) => (
                  <button
                    key={p.code}
                    onClick={() => selectShopCode(p.waybill_code)}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 transition-colors ${
                      shopCode === p.waybill_code ? "bg-gray-50 font-medium" : ""
                    }`}
                  >
                    <span>{p.name}</span>
                    <span className="text-xs text-gray-400">{p.waybill_code}</span>
                  </button>
                ))}
                <div className="border-t border-gray-100 px-3 py-2">
                  <p className="text-xs text-gray-400 mb-1.5">Custom</p>
                  <div className="flex gap-1.5">
                    <Input
                      value={customShopCodeInput}
                      onChange={(e) => setCustomShopCodeInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && applyCustomShopCode()}
                      placeholder="Shop code"
                      className="text-sm"
                    />
                    <button
                      onClick={applyCustomShopCode}
                      className="px-3 py-1.5 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 transition flex-shrink-0"
                    >
                      Use
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
