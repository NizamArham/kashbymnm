import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Download, Printer, X, Check } from "lucide-react";
import { closePdfPreview, getPdfPreview, subscribePdfPreview } from "../lib/pdfPreview";

// The one PDF preview window for the whole app (see lib/pdfPreview.ts).
export default function PdfPreviewHost() {
  const preview = useSyncExternalStore(subscribePdfPreview, getPdfPreview);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [downloaded, setDownloaded] = useState(false);

  useEffect(() => {
    setDownloaded(false);
  }, [preview?.url]);

  useEffect(() => {
    if (!preview) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closePdfPreview();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  if (!preview) return null;

  function handleDownload() {
    if (!preview) return;
    preview.doc.save(preview.filename);
    preview.onSaved?.();
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 2500);
  }

  function handlePrint() {
    if (!preview) return;
    try {
      frameRef.current?.contentWindow?.focus();
      frameRef.current?.contentWindow?.print();
    } catch {
      // The browser wouldn't print from the frame — open the PDF in its own
      // tab, where its own print button works.
      window.open(preview.url, "_blank");
    }
    preview.onSaved?.();
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" onClick={closePdfPreview}>
      <div
        className="flex h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="PDF preview"
      >
        <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-gray-900">{preview.filename}</p>
            <p className="text-xs text-gray-400">Preview — nothing is saved until you press Download</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
            >
              <Printer size={14} />
              Print
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center gap-1.5 rounded-xl bg-black px-3.5 py-2 text-sm font-medium text-white transition hover:bg-gray-800"
            >
              {downloaded ? <Check size={14} /> : <Download size={14} />}
              {downloaded ? "Downloaded" : "Download"}
            </button>
            <button
              type="button"
              onClick={closePdfPreview}
              aria-label="Close preview"
              title="Close (Esc)"
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <iframe
          ref={frameRef}
          key={preview.url}
          title={preview.filename}
          src={`${preview.url}#toolbar=0&navpanes=0&view=FitH`}
          className="w-full flex-1 bg-gray-100"
        />
      </div>
    </div>
  );
}
