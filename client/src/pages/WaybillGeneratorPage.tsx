import { useState, useRef, useEffect, RefObject } from "react";
import { Printer, Download } from "lucide-react";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import JsBarcode from "jsbarcode";
import { WaybillLabel, WaybillLabelData } from "../components/WaybillLabel";
import { DELIVERY_PARTNERS, DeliveryPartner, waybillShopCode } from "../lib/delivery";
import { PageHeader, Card, Input, Label, FormGroup, ErrorText, Dropdown, TabToggle } from "../components/ui";
import { CityPicker } from "../components/CityPicker";

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
  const [deliveryPartner, setDeliveryPartner] = useState<DeliveryPartner>("D2D");

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
  const cityName =
    cityParts.length > 1 && /^\d+$/.test(cityParts[cityParts.length - 1]) ? cityParts.slice(0, -1).join(" ") : city;

  const labelData: WaybillLabelData = {
    shopCode: waybillShopCode(deliveryPartner),
    date: formatLabelDate(new Date()),
    customerName,
    addressLines: [addr1, addr2, addr3].filter(Boolean),
    city: cityName,
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

  async function captureLabel(): Promise<HTMLCanvasElement> {
    if (!labelRef.current) throw new Error("Label not ready");
    return html2canvas(labelRef.current, { scale: 3, useCORS: true, backgroundColor: "#ffffff" });
  }

  async function handleSavePdf() {
    if (!validateStep2()) return;
    setProcessing(true);
    try {
      const canvas = await captureLabel();
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: [105, 148] });

      const pageWidth = 105;
      const pageHeight = 148;
      const canvasRatio = canvas.width / canvas.height;
      const pageRatio = pageWidth / pageHeight;

      let drawWidth = pageWidth;
      let drawHeight = pageHeight;
      if (canvasRatio > pageRatio) {
        drawHeight = pageWidth / canvasRatio;
      } else {
        drawWidth = pageHeight * canvasRatio;
      }
      const offsetX = (pageWidth - drawWidth) / 2;
      const offsetY = (pageHeight - drawHeight) / 2;

      pdf.addImage(imgData, "PNG", offsetX, offsetY, drawWidth, drawHeight);
      pdf.save(`M&M_Waybill_${trackingNumber}.pdf`);
    } catch {
      setError("Failed to generate the PDF — try again");
    } finally {
      setProcessing(false);
    }
  }

  async function handlePrint() {
    if (!validateStep2()) return;
    setProcessing(true);
    try {
      const canvas = await captureLabel();
      const imgData = canvas.toDataURL("image/png");
      const printWindow = window.open("", "_blank");
      if (!printWindow) {
        setError("Pop-up blocked — allow pop-ups to print, or use Save as PDF instead");
        setProcessing(false);
        return;
      }
      printWindow.document.write(
        `<html><head><title>Waybill</title><style>@page{size:105mm 148mm;margin:0}body{margin:0;width:105mm;height:148mm}img{width:105mm;height:148mm;object-fit:contain;display:block}</style></head><body><img src="${imgData}" onload="window.print();window.close();" /></body></html>`
      );
      printWindow.document.close();
    } catch {
      setError("Failed to prepare printing — try again");
    } finally {
      setProcessing(false);
    }
  }

  function resetAll() {
    setStep("receiver");
    setCustomerName("");
    setAddr1("");
    setAddr2("");
    setAddr3("");
    setCity("");
    setPhone1("");
    setPhone2("");
    setDeliveryPartner("D2D");
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
        subtitle="Type in the details manually to generate a courier waybill — for orders not yet in the system."
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
                <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
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
                  <Input value={phone1} onChange={(e) => setPhone1(e.target.value)} />
                </FormGroup>
                <FormGroup>
                  <Label>Contact No 2 (optional)</Label>
                  <Input value={phone2} onChange={(e) => setPhone2(e.target.value)} />
                </FormGroup>
              </div>
              <FormGroup>
                <Label>Delivery Partner (sets the shop code prefix)</Label>
                <Dropdown
                  value={deliveryPartner}
                  onChange={(v) => setDeliveryPartner(v as DeliveryPartner)}
                  options={DELIVERY_PARTNERS.map((p) => ({ value: p.value, label: `${p.label} — ${p.waybillCode}` }))}
                />
              </FormGroup>
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
                <Input value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="e.g. 0.5" />
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

        <div className="flex justify-center">
          <div style={{ transformOrigin: "top center" }}>
            <WaybillLabel ref={labelRef} barcodeRef={barcodeRef as RefObject<SVGSVGElement>} data={labelData} />
          </div>
        </div>
      </div>
    </div>
  );
}
