import { useState, useRef, useEffect, RefObject } from "react";
import { X, Printer, Download, MapPin, Check, Plus, Truck } from "lucide-react";
import JsBarcode from "jsbarcode";
import { Delivery, BusinessInfo, Customer, CustomerAddress } from "../lib/types";
import { waybillShopCode, useDeliveryPartners, partnerLabel, waybillItemsDescription, COURIER_API } from "../lib/delivery";
import { WaybillLabel, WaybillLabelData } from "./WaybillLabel";
import { generateWaybillLabelPdf } from "../lib/waybillLabelPdf";
import { applyBusinessInfoToReturnAddress } from "../lib/businessInfo";
import { api, ApiRequestError } from "../lib/api";
import { Input, Label, FormGroup, ErrorText, Badge } from "./ui";
import ChangePartnerModal from "./ChangePartnerModal";
import { CityPicker } from "./CityPicker";
import { previewPdf } from "../lib/pdfPreview";

function formatLabelDate(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

export default function PackWaybillModal({
  delivery,
  onClose,
  onPacked,
  onPartnerChanged,
}: {
  delivery: Delivery;
  onClose: () => void;
  onPacked: (trackingNumber: string) => void;
  // Called after the courier is changed from inside this modal, so the
  // parent can reload the order and reopen this on the updated details.
  onPartnerChanged?: () => void | Promise<void>;
}) {
  const [changingPartner, setChangingPartner] = useState(false);
  const [trackingNumber, setTrackingNumber] = useState(delivery.tracking_number ?? "");
  const [pcs, setPcs] = useState("1");
  const [weight, setWeight] = useState(delivery.package_weight_kg ? String(delivery.package_weight_kg) : "");
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  // An on-demand app (Uber, PickMe Flash...) has no courier portal and
  // issues no tracking numbers, so the invoice number — a unique,
  // scannable code — stands in as the tracking ID/barcode.
  const { partners } = useDeliveryPartners();
  const isOnDemand = partners.find((p) => p.code === delivery.delivery_partner)?.kind === "on_demand";
  useEffect(() => {
    if (isOnDemand && !trackingNumber && delivery.invoice) setTrackingNumber(delivery.invoice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnDemand]);

  // CityPak and Fardar can be booked through their APIs — everyone else
  // (D2D/DEX...) still needs the tracking number created on their own
  // portal and typed in below.
  const courierApi = delivery.delivery_partner ? COURIER_API[delivery.delivery_partner] : undefined;
  const [creatingShipment, setCreatingShipment] = useState(false);
  const [shipmentError, setShipmentError] = useState<string | null>(null);

  async function createShipment() {
    if (!courierApi) return;
    setShipmentError(null);
    setCreatingShipment(true);
    try {
      const result = await api.post<{ tracking_number: string }>(`/deliveries/${delivery.id}/${courierApi.endpoint}`);
      setTrackingNumber(result.tracking_number);
    } catch (err) {
      setShipmentError(err instanceof ApiRequestError ? err.message : `Failed to create the shipment with ${courierApi.name}`);
    } finally {
      setCreatingShipment(false);
    }
  }

  // Return-section footer — editable per waybill, defaulting to the
  // shop's usual details but adjustable if a specific order needs to
  // return somewhere else.
  const [returnBusinessName, setReturnBusinessName] = useState("M&M Clothing");
  const [returnAddress, setReturnAddress] = useState("78/2 Anderson Rd, Dehiwala,\nSri Lanka.");
  const [returnPhone, setReturnPhone] = useState("+94 70-5500174");
  const [returnWebsite, setReturnWebsite] = useState("www.mnmclothing.lk");

  const labelRef = useRef<HTMLDivElement>(null);
  const barcodeRef = useRef<SVGSVGElement>(null);

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

  // The order's address is fixed at checkout time (whichever one was the
  // customer's default back then). If they later call and ask to ship to
  // a different saved address, this is the last point before the label
  // is printed — so it needs to be switchable right here, not just back
  // at the one-time "Confirm address" step (which may already be done).
  const [customerAddresses, setCustomerAddresses] = useState<CustomerAddress[] | null>(null);
  const [activeAddressId, setActiveAddressId] = useState<number | null>(delivery.address_id);
  const [activeAddress, setActiveAddress] = useState({
    address_line1: delivery.address_line1 ?? "",
    address_line2: delivery.address_line2 ?? "",
    city: delivery.city ?? "",
  });
  const [switchingAddress, setSwitchingAddress] = useState(false);

  useEffect(() => {
    if (!delivery.customer_id) return;
    api
      .get<Customer>(`/customers/${delivery.customer_id}`)
      .then((c) => setCustomerAddresses(c.addresses ?? []))
      .catch(() => {
        // Can't offer other addresses to switch to, but the order's own
        // address still shows fine — not worth surfacing as an error.
      });
  }, [delivery.customer_id]);

  async function switchToAddress(address: CustomerAddress) {
    if (address.id === activeAddressId || switchingAddress) return;
    setSwitchingAddress(true);
    setError(null);
    try {
      await api.put(`/deliveries/${delivery.id}/address`, { address_id: address.id });
      // Also makes it the customer's new default — otherwise this fix
      // only lasts for this one waybill instead of sticking for next time.
      if (address.is_default !== 1 && delivery.customer_id) {
        await api.put(`/customers/${delivery.customer_id}/addresses/${address.id}`, { is_default: true });
        setCustomerAddresses((prev) => prev?.map((a) => ({ ...a, is_default: a.id === address.id ? 1 : 0 })) ?? null);
      }
      setActiveAddressId(address.id);
      setActiveAddress({
        address_line1: address.address_line1 ?? "",
        address_line2: address.address_line2 ?? "",
        city: address.city ?? "",
      });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to switch the delivery address");
    } finally {
      setSwitchingAddress(false);
    }
  }

  // Adding a brand-new address right here, instead of needing a separate
  // trip to the customer's own page first — the new one becomes their
  // default and this order ships to it immediately.
  const [addingAddress, setAddingAddress] = useState(false);
  const [newAddrLine1, setNewAddrLine1] = useState("");
  const [newAddrLine2, setNewAddrLine2] = useState("");
  const [newAddrCity, setNewAddrCity] = useState("");
  const [addAddressError, setAddAddressError] = useState<string | null>(null);
  const [savingNewAddress, setSavingNewAddress] = useState(false);

  function openAddAddress() {
    setAddingAddress(true);
    setNewAddrLine1("");
    setNewAddrLine2("");
    setNewAddrCity("");
    setAddAddressError(null);
  }

  async function submitNewAddress() {
    if (!delivery.customer_id) return;
    if (!newAddrLine1.trim() && !newAddrCity.trim()) {
      setAddAddressError("Enter at least an address line or city");
      return;
    }
    setAddAddressError(null);
    setSavingNewAddress(true);
    try {
      const created = await api.post<CustomerAddress>(`/customers/${delivery.customer_id}/addresses`, {
        address_line1: newAddrLine1.trim() || undefined,
        address_line2: newAddrLine2.trim() || undefined,
        city: newAddrCity.trim() || undefined,
        is_default: true,
      });
      setCustomerAddresses((prev) => [...(prev ?? []).map((a) => ({ ...a, is_default: 0 })), created]);
      await switchToAddress(created);
      setAddingAddress(false);
    } catch (err) {
      setAddAddressError(err instanceof ApiRequestError ? err.message : "Failed to add the new address");
    } finally {
      setSavingNewAddress(false);
    }
  }

  const addressLines = [activeAddress.address_line1, activeAddress.address_line2].filter(Boolean) as string[];
  // The COD amount was already computed and stored by POS at order time
  // (order total minus what was paid, plus delivery fee) — the waybill
  // reflects that real figure rather than recalculating a fresh guess.
  const codAmount = delivery.cod_amount ?? 0;
  const paymentType: "Prepaid" | "COD" = codAmount > 0 ? "COD" : "Prepaid";

  const labelData: WaybillLabelData = {
    shopCode: waybillShopCode(delivery.delivery_partner),
    date: formatLabelDate(new Date()),
    customerName: delivery.customer_name ?? "",
    addressLines,
    city: activeAddress.city,
    phones: [delivery.customer_phone ?? ""],
    orderRef: delivery.invoice ?? "",
    pcs: parseInt(pcs, 10) || 1,
    weight,
    paymentType,
    codAmount,
    description: waybillItemsDescription(delivery.items),
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

  function validate(): boolean {
    if (!trackingNumber.trim()) {
      setError("Enter the tracking number you received from the courier");
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
    setError(null);
    return true;
  }

  async function handleSavePdf() {
    if (!validate()) return;
    setProcessing(true);
    try {
      const pdf = generateWaybillLabelPdf(labelData);
      // The order is only marked packed once the waybill is really taken —
      // downloaded or printed from the preview — so closing the preview
      // without it leaves everything as it was.
      const packedAs = trackingNumber.trim();
      previewPdf(pdf, `M&M_Waybill_${trackingNumber}.pdf`, { onSaved: () => onPacked(packedAs) });
    } catch {
      setError("Failed to generate the PDF — try again");
    } finally {
      setProcessing(false);
    }
  }

  async function handlePrint() {
    if (!validate()) return;
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
      onPacked(trackingNumber.trim());
    } catch {
      setError("Failed to prepare printing — try again");
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="p-5 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Generate waybill</h3>
            <p className="text-xs text-gray-400">
              {delivery.invoice} —{" "}
              {courierApi
                ? `create the shipment with ${courierApi.name} below, or paste in a tracking number manually`
                : isOnDemand
                ? "no courier portal for this partner — the invoice number is used as the tracking barcode"
                : "feed this into the courier portal, then paste back the tracking number"}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Courier: <strong className="text-gray-900">{partnerLabel(delivery.delivery_partner)}</strong>
              {onPartnerChanged && (
                <button
                  type="button"
                  onClick={() => setChangingPartner(true)}
                  className="ml-2 text-gray-500 hover:text-gray-900 underline decoration-dotted"
                >
                  change
                </button>
              )}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-6 overflow-hidden">
          <div className="overflow-y-auto p-5">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">Only these need typing</h4>

            {courierApi && (
              <div className="mb-3">
                <button
                  type="button"
                  onClick={createShipment}
                  disabled={creatingShipment}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-gray-900 text-white rounded-xl text-sm font-medium hover:bg-gray-800 transition disabled:opacity-50"
                >
                  <Truck size={14} />
                  {creatingShipment ? "Creating shipment..." : `Create shipment with ${courierApi.name}`}
                </button>
                {shipmentError && <ErrorText>{shipmentError}</ErrorText>}
              </div>
            )}

            <FormGroup>
              <Label>
                {isOnDemand
                  ? "Tracking ID (invoice number, used as the barcode)"
                  : `Tracking number ${courierApi ? "(or type it in manually)" : "(from courier portal)"}`}
              </Label>
              <Input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} autoFocus />
            </FormGroup>
            <div className="grid grid-cols-2 gap-3">
              <FormGroup>
                <Label>Pieces</Label>
                <Input type="number" min="1" value={pcs} onChange={(e) => setPcs(e.target.value.replace(/[^0-9]/g, ""))} />
              </FormGroup>
              <FormGroup>
                <Label>Weight (kg)</Label>
                <Input value={weight} onChange={(e) => setWeight(e.target.value)} />
              </FormGroup>
            </div>

            <div className="bg-gray-50 rounded-lg px-3 py-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Payment</span>
                <span className="font-medium text-gray-900">{paymentType === "COD" ? "Cash on Delivery" : "Prepaid"}</span>
              </div>
              {paymentType === "COD" && (
                <div className="flex justify-between mt-1">
                  <span className="text-gray-500">COD to collect</span>
                  <span className="font-semibold text-gray-900">Rs. {codAmount.toLocaleString()}</span>
                </div>
              )}
              {delivery.delivery_paid_by && (
                <div className="flex justify-between mt-1">
                  <span className="text-gray-500">Delivery fare</span>
                  <span className="font-medium text-gray-900">
                    Rs. {(delivery.actual_fare ?? 0).toLocaleString()} ·{" "}
                    {delivery.delivery_paid_by === "customer"
                      ? "customer pays"
                      : delivery.delivery_paid_by === "shop"
                      ? "free — we pay"
                      : "we paid upfront (on the bill)"}
                  </span>
                </div>
              )}
            </div>

            <div className="mt-4 pt-4 border-t border-gray-100 text-xs text-gray-500 space-y-1">
              <p>Everything else is pulled from the order automatically:</p>
              <p>
                <strong>{delivery.customer_name ?? "—"}</strong>, {addressLines.join(", ") || "no address"}, {activeAddress.city || "—"}
              </p>
              <p>{delivery.customer_phone ?? "no phone on file"}</p>
            </div>

            {customerAddresses && delivery.customer_id && (
              <div className="mt-3 pt-3 border-t border-gray-100">
                <p className="text-xs font-medium text-gray-700 mb-2">Ship to a different saved address</p>
                <div className="space-y-1.5">
                  {customerAddresses.map((a) => {
                    const isActive = a.id === activeAddressId;
                    return (
                      <button
                        key={a.id}
                        onClick={() => switchToAddress(a)}
                        disabled={switchingAddress}
                        className={`w-full flex items-center justify-between gap-2 text-left px-3 py-2 rounded-lg border text-xs transition-colors disabled:opacity-50 ${
                          isActive ? "border-black bg-gray-50" : "border-gray-200 hover:bg-gray-50"
                        }`}
                      >
                        <span className="flex items-start gap-1.5 min-w-0">
                          <MapPin size={12} className="text-gray-400 flex-shrink-0 mt-0.5" />
                          <span className="min-w-0 text-gray-800">
                            {[a.address_line1, a.address_line2, a.city].filter(Boolean).join(", ") || "No address text"}
                          </span>
                        </span>
                        <span className="flex items-center gap-1.5 flex-shrink-0">
                          {a.is_default === 1 && <Badge label="Default" tone="neutral" />}
                          {isActive && <Check size={12} className="text-black" />}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {addingAddress ? (
                  <div className="mt-2 p-3 border border-gray-200 rounded-lg space-y-2">
                    <FormGroup>
                      <Label>Address line 1</Label>
                      <Input value={newAddrLine1} onChange={(e) => setNewAddrLine1(e.target.value)} />
                    </FormGroup>
                    <FormGroup>
                      <Label>Address line 2 (optional)</Label>
                      <Input value={newAddrLine2} onChange={(e) => setNewAddrLine2(e.target.value)} />
                    </FormGroup>
                    <FormGroup>
                      <CityPicker value={newAddrCity} onChange={setNewAddrCity} />
                    </FormGroup>
                    {addAddressError && <ErrorText>{addAddressError}</ErrorText>}
                    <div className="flex gap-2">
                      <button
                        onClick={() => setAddingAddress(false)}
                        className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-xs font-medium hover:bg-gray-50 transition"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={submitNewAddress}
                        disabled={savingNewAddress}
                        className="flex-1 px-3 py-1.5 bg-black text-white rounded-xl text-xs font-medium hover:bg-gray-800 transition disabled:opacity-50"
                      >
                        {savingNewAddress ? "Saving..." : "Save & use this"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={openAddAddress}
                    className="mt-1.5 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-dashed border-gray-300 text-xs font-medium text-gray-600 hover:bg-gray-50 transition"
                  >
                    <Plus size={12} />
                    Add new address
                  </button>
                )}
              </div>
            )}

            {error && <ErrorText>{error}</ErrorText>}
          </div>

          <div className="flex justify-center items-start p-5">
            <div style={{ width: "calc(105mm * 0.72)", height: "calc(148mm * 0.72)" }}>
              <div
                style={{
                  display: "inline-block",
                  transform: "scale(0.72)",
                  transformOrigin: "top left",
                  border: "1px solid #d1d5db",
                  borderRadius: 10,
                  overflow: "hidden",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
                }}
              >
                <WaybillLabel ref={labelRef} barcodeRef={barcodeRef as RefObject<SVGSVGElement>} data={labelData} />
              </div>
            </div>
          </div>
        </div>

        <div className="p-5 border-t border-gray-100 flex gap-3 flex-shrink-0">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl hover:bg-gray-50 transition font-medium text-sm">
            Cancel
          </button>
          <button
            onClick={handlePrint}
            disabled={processing}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-gray-300 rounded-xl hover:bg-gray-50 transition font-medium text-sm disabled:opacity-50"
          >
            <Printer size={14} />
            Print
          </button>
          <button
            onClick={handleSavePdf}
            disabled={processing}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-black text-white rounded-xl hover:bg-gray-800 transition font-medium text-sm disabled:opacity-50"
          >
            <Download size={14} />
            {processing ? "Working..." : "Save as PDF"}
          </button>
        </div>
      </div>

      {changingPartner && onPartnerChanged && (
        <ChangePartnerModal delivery={delivery} onClose={() => setChangingPartner(false)} onChanged={onPartnerChanged} />
      )}
    </div>
  );
}
