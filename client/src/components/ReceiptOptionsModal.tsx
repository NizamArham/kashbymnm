import { useState } from "react";
import { X, FileText, Receipt as ReceiptIcon, MessageCircle, AlertTriangle } from "lucide-react";
import { Sale } from "../lib/types";
import { downloadA4Pdf, downloadThermalPdf, sendWhatsAppBill } from "../lib/receipts";

export default function ReceiptOptionsModal({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);

  function handleWhatsApp() {
    if (!sale.customer_phone) {
      setError("This customer has no saved phone number — add one on the Customers page first.");
      return;
    }
    setError(null);
    sendWhatsAppBill(sale, sale.customer_phone);
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-sm w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="p-5 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Get receipt</h3>
            <p className="text-xs text-gray-400">{sale.invoice}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-2.5">
          <button
            onClick={() => downloadA4Pdf(sale)}
            className="w-full flex items-center gap-3 px-4 py-3 border border-gray-200 rounded-xl hover:border-black hover:shadow-sm transition text-left"
          >
            <div className="w-9 h-9 bg-gray-100 rounded-lg flex items-center justify-center flex-shrink-0">
              <FileText size={17} className="text-gray-700" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">A4 Invoice (PDF)</p>
              <p className="text-xs text-gray-400">Full-page printable invoice</p>
            </div>
          </button>

          <button
            onClick={() => downloadThermalPdf(sale)}
            className="w-full flex items-center gap-3 px-4 py-3 border border-gray-200 rounded-xl hover:border-black hover:shadow-sm transition text-left"
          >
            <div className="w-9 h-9 bg-gray-100 rounded-lg flex items-center justify-center flex-shrink-0">
              <ReceiptIcon size={17} className="text-gray-700" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">80mm Receipt (PDF)</p>
              <p className="text-xs text-gray-400">For thermal till printers</p>
            </div>
          </button>

          <button
            onClick={handleWhatsApp}
            className="w-full flex items-center gap-3 px-4 py-3 border border-gray-200 rounded-xl hover:border-black hover:shadow-sm transition text-left"
          >
            <div className="w-9 h-9 bg-green-50 rounded-lg flex items-center justify-center flex-shrink-0">
              <MessageCircle size={17} className="text-green-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">Send via WhatsApp</p>
              <p className="text-xs text-gray-400">Text summary to customer's phone</p>
            </div>
          </button>

          {error && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-1">
              <AlertTriangle size={13} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">{error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
