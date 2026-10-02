import { forwardRef } from "react";
import { NAME_LOGO_PNG_BASE64, NAME_LOGO_ASPECT_RATIO } from "../lib/logoAsset";

export interface WaybillLabelData {
  shopCode: string;
  date: string; // pre-formatted, e.g. "6 Sep 2026"
  customerName: string;
  addressLines: string[]; // already split into up to 3 lines
  city: string;
  cityPostalCode?: string;
  phones: string[]; // up to 2, already filtered for blanks
  orderRef: string;
  pcs: number;
  weight: string; // e.g. "0.5"
  paymentType: "Prepaid" | "COD";
  codAmount: number;
  description: string;
  trackingNumber: string;
  // Return-section footer — editable per waybill rather than hardcoded,
  // since a shop's return address/phone/site can change over time.
  returnBusinessName: string;
  returnAddressLines: string[];
  returnPhone: string;
  returnWebsite: string;
}

// Renders the exact A6 label layout from the reference design (index.html
// / style.css) as real React DOM, so html2canvas can capture it pixel-for
// -pixel for the PDF/print output. The barcode <svg> is targeted via
// barcodeRef (not a hardcoded id) so JsBarcode always draws onto exactly
// the node that was actually rendered for this instance, never a stale
// or unrelated element sharing the same id elsewhere in the page.
export const WaybillLabel = forwardRef<
  HTMLDivElement,
  { data: WaybillLabelData; barcodeRef: React.RefObject<SVGSVGElement>; onShopCodeClick?: () => void }
>(function WaybillLabel({ data, barcodeRef, onShopCodeClick }, ref) {
  const addressText = data.addressLines.filter(Boolean).join("\n") || "Address line 1";
  const addressTextWithComma = addressText ? `${addressText},` : addressText;
  const cityLine = data.city ? (data.cityPostalCode ? `${data.city} [${data.cityPostalCode}].` : `${data.city}.`) : "City";
  const phonesText = data.phones.filter(Boolean).join(" / ") || "Telephone Number";

  return (
    <div
      ref={ref}
      style={{
        width: "105mm",
        height: "148mm",
        background: "#ffffff",
        padding: "12px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        overflow: "hidden",
        fontFamily: "Arial, sans-serif",
        color: "#000",
      }}
    >
      {/* TOP PART */}
      <div className="label-top">
        <div className="preview-header-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif' }}>
          <div
            className="preview-shopcode-row"
            onClick={onShopCodeClick}
            title={onShopCodeClick ? "Tap to change delivery partner" : undefined}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: "1.3rem",
              fontWeight: "bold",
              cursor: onShopCodeClick ? "pointer" : undefined,
              borderRadius: 6,
              padding: onShopCodeClick ? "2px 6px" : undefined,
              marginLeft: onShopCodeClick ? -6 : undefined,
              outline: onShopCodeClick ? "1px dashed #bbb" : undefined,
            }}
          >
            <span style={{ fontSize: "1.6rem", fontWeight: 600 }}>[</span>
            <span>{data.shopCode || "SHOP CODE"}</span>
            <span style={{ fontSize: "1.6rem", fontWeight: 600 }}>]</span>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif', fontStyle: "italic", fontWeight: 700, fontSize: "1.3rem" }}>{data.date}</div>
          </div>
        </div>
        <div style={{ width: "100%", height: 2, background: "#000" }} />

        <div className="receiver-section" style={{ width: "100%", marginTop: 6, fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif' }}>
          <div style={{ display: "inline-block", fontSize: 13.5, fontWeight: "bold", padding: "4px 10px 4px 8px", marginBottom: 5, backgroundColor: "#000", color: "#f0f0f0" }}>
            DELIVER [ TO ]
          </div>
          <div className="receiver-info">
            <p style={{ margin: 0, fontSize: "1.27rem", fontWeight: 700 }}>{data.customerName || "Customer Name"}</p>
            <p
              style={{
                margin: "0.1rem 0 0 0",
                fontSize: "1rem",
                fontWeight: 400,
                lineHeight: 1.35,
                whiteSpace: "pre-line",
                // A plain max-height clip instead of the -webkit-line-clamp
                // trick — html2canvas (used for the PDF/print capture)
                // doesn't compute that display:-webkit-box hack reliably
                // and renders it as corrupted, ghosted text.
                maxHeight: "66px",
                overflow: "hidden",
              }}
            >
              {addressTextWithComma}
            </p>
            <p style={{ margin: "0.1rem 0 0 0", fontSize: "1rem", fontWeight: 400, lineHeight: 1.05 }}>{cityLine}</p>
            <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.95rem", fontWeight: 400, lineHeight: 1.1 }}>{phonesText}</p>
          </div>
        </div>
      </div>

      {/* MIDDLE PART */}
      <div className="label-middle">
        <div style={{ height: 2, background: "#000", margin: "4px 0" }} />
        <div className="delivery-section" style={{ fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif', margin: "4px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 6, fontSize: "1.07rem" }}>
            <div style={{ fontWeight: 600, textTransform: "uppercase" }}>Delivery Instruction</div>
            {data.paymentType === "COD" && data.codAmount > 0 && (
              <div style={{ background: "black", color: "white", padding: "0px 10px", textAlign: "center", display: "flex", flexDirection: "row", justifyContent: "center" }}>
                <strong style={{ fontSize: "1.3rem", lineHeight: 1.2 }}>{Math.round(data.codAmount).toLocaleString("en-US")}</strong>
                <span style={{ fontSize: "0.97rem", marginLeft: 4 }}>LKR</span>
              </div>
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 6, fontSize: "1.07rem" }}>
            <div style={{ fontWeight: "bold" }}>Ref: {data.orderRef || "—"}</div>
            <div style={{ fontWeight: 500 }}>1 of {data.pcs || 1} pcs</div>
            <div style={{ fontWeight: 600 }}>{data.weight ? `${data.weight} Kg` : "0.0 Kg"}</div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
            <div
              style={{
                flex: 1,
                fontSize: "0.92rem",
                lineHeight: 1.3,
                whiteSpace: "pre-line",
                // Same plain max-height clip as the address block above —
                // -webkit-line-clamp renders corrupted in html2canvas.
                maxHeight: "40px",
                overflow: "hidden",
              }}
            >
              {data.description || "—"}
            </div>
          </div>
        </div>
      </div>

      {/* BOTTOM PART */}
      <div className="label-bottom">
        <div style={{ height: 2, background: "#000", margin: "4px 0" }} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 80 }}>
          <div style={{ width: "100%", display: "flex", justifyContent: "center", marginBottom: 5 }}>
            <svg ref={barcodeRef} style={{ width: "100%", maxWidth: 380, height: 60 }} />
          </div>
          <div style={{ fontSize: "1.07rem", fontWeight: 600, textAlign: "center", color: "#000", marginTop: 3 }}>
            {data.trackingNumber || "Tracking No:"}
          </div>
        </div>
        <div style={{ height: 2, background: "#000", margin: "4px 0" }} />
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "inline-block", alignSelf: "flex-start", padding: "4px 10px 4px 8px", fontSize: 13.5, fontWeight: "bold", marginBottom: 5, backgroundColor: "#000", color: "#f0f0f0" }}>
            In case of non-delivery, [ Return ]
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", width: "100%", marginTop: 3 }}>
            <div style={{ maxWidth: "64%", fontSize: "0.85rem", lineHeight: 1.25, fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif' }}>
              <span style={{ fontSize: "1.07rem", fontWeight: 500 }}>{data.returnBusinessName || "M&M Clothing"}</span>
              <br />
              {data.returnAddressLines.filter(Boolean).map((line, i) => (
                <span key={i}>
                  {line}
                  <br />
                </span>
              ))}
              {[data.returnPhone].filter(Boolean).join(" / ")}
              {data.returnPhone && <br />}
              {data.returnWebsite}
            </div>
            <img
              src={NAME_LOGO_PNG_BASE64}
              alt="M&M Clothing"
              style={{ width: 125, height: 125 / NAME_LOGO_ASPECT_RATIO, objectFit: "contain", flexShrink: 0 }}
            />
          </div>
        </div>
      </div>
    </div>
  );
});
