import { useState, useRef, useEffect, RefObject } from "react";
import { X, Printer, Download } from "lucide-react";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import JsBarcode from "jsbarcode";
import { Delivery } from "../lib/types";
import { waybillShopCode } from "../lib/delivery";
import { WaybillLabel, WaybillLabelData } from "./WaybillLabel";
import { Input, Label, FormGroup, ErrorText } from "./ui";

function formatLabelDate(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

export default function PackWaybillModal({
  delivery,
  onClose,
  onPacked,
}: {
  delivery: Delivery;
  onClose: () => void;
  onPacked: (trackingNumber: string) => void;
}) {
  const [trackingNumber, setTrackingNumber] = useState("");
  const [pcs, setPcs] = useState("1");
  const [weight, setWeight] = useState(delivery.package_weight_kg ? String(delivery.package_weight_kg) : "");
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  // Return-section footer — editable per waybill, defaulting to the
  // shop's usual details but adjustable if a specific order needs to
  // return somewhere else.
  const [returnBusinessName, setReturnBusinessName] = useState("M&M Clothing");
  const [returnAddress, setReturnAddress] = useState("78/2 Anderson Rd, Dehiwala,\nSri Lanka.");
  const [returnPhone, setReturnPhone] = useState("+94 70-5500174");
  const [returnWebsite, setReturnWebsite] = useState("www.mnmclothing.lk");

  const labelRef = useRef<HTMLDivElement>(null);
  const barcodeRef = useRef<SVGSVGElement>(null);

  const addressLines = [delivery.address_line1, delivery.address_line2].filter(Boolean) as string[];
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
    city: delivery.city ?? "",
    phones: [delivery.customer_phone ?? ""],
    orderRef: delivery.invoice ?? "",
    pcs: parseInt(pcs, 10) || 1,
    weight,
    paymentType,
    codAmount,
    description: delivery.items?.map((i) => `${i.product_title ?? "Item"} x${i.quantity}`).join(", ") ?? "",
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

  async function captureLabel(): Promise<HTMLCanvasElement> {
    if (!labelRef.current) throw new Error("Label not ready");
    return html2canvas(labelRef.current, { scale: 3, useCORS: true, backgroundColor: "#ffffff" });
  }

  async function handleSavePdf() {
    if (!validate()) return;
    setProcessing(true);
    try {
      const canvas = await captureLabel();
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: [105, 148] });

      // Fit the captured image to the page while preserving its real
      // aspect ratio — forcing an exact 105x148 stretch is what was
      // distorting/cutting the label when the captured canvas didn't
      // come out at precisely that ratio.
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
      onPacked(trackingNumber.trim());
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
            <p className="text-xs text-gray-400">{delivery.invoice} — feed this into the courier portal, then paste back the tracking number</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h4 className="text-sm font-semibold text-gray-900 mb-3">Only these need typing</h4>
            <FormGroup>
              <Label>Tracking number (from courier portal)</Label>
              <Input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} autoFocus />
            </FormGroup>
            <div className="grid grid-cols-2 gap-3">
              <FormGroup>
                <Label>Pieces</Label>
                <Input type="number" min="1" value={pcs} onChange={(e) => setPcs(e.target.value.replace(/[^0-9]/g, ""))} />
              </FormGroup>
              <FormGroup>
                <Label>Weight (kg)</Label>
                <Input value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="e.g. 0.5" />
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
            </div>

            <details className="mt-4 border-t border-gray-100 pt-4">
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

            <div className="mt-4 pt-4 border-t border-gray-100 text-xs text-gray-500 space-y-1">
              <p>Everything else is pulled from the order automatically:</p>
              <p>
                <strong>{delivery.customer_name ?? "—"}</strong>, {addressLines.join(", ") || "no address"}, {delivery.city ?? "—"}
              </p>
              <p>{delivery.customer_phone ?? "no phone on file"}</p>
            </div>

            {error && <ErrorText>{error}</ErrorText>}
          </div>

          <div className="flex justify-center overflow-auto">
            <div style={{ transformOrigin: "top center" }}>
              <WaybillLabel ref={labelRef} barcodeRef={barcodeRef as RefObject<SVGSVGElement>} data={labelData} />
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
            <Printer size={15} />
            Print
          </button>
          <button
            onClick={handleSavePdf}
            disabled={processing}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-black text-white rounded-xl hover:bg-gray-800 transition font-medium text-sm disabled:opacity-50"
          >
            <Download size={15} />
            {processing ? "Working..." : "Save as PDF"}
          </button>
        </div>
      </div>
    </div>
  );
}
