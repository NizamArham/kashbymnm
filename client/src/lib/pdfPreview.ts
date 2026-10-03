import type jsPDF from "jspdf";

// Every PDF button in the app (reports, invoices, waybills, balance slips)
// opens its PDF here first instead of saving it straight to Downloads — so
// a stray click just opens a preview you close, and nothing is saved until
// you press Download. The window itself is <PdfPreviewHost />, mounted
// once in App.

export interface PdfPreviewState {
  url: string;
  filename: string;
  doc: jsPDF;
  // Called when the PDF is actually downloaded or printed from the preview
  // (e.g. marking a waybill as packed only once you really take it).
  onSaved?: () => void;
}

let current: PdfPreviewState | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function previewPdf(doc: jsPDF, filename: string, opts?: { onSaved?: () => void }) {
  if (current) URL.revokeObjectURL(current.url);
  current = { url: URL.createObjectURL(doc.output("blob")), filename, doc, onSaved: opts?.onSaved };
  emit();
}

export function closePdfPreview() {
  if (!current) return;
  URL.revokeObjectURL(current.url);
  current = null;
  emit();
}

export function subscribePdfPreview(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPdfPreview(): PdfPreviewState | null {
  return current;
}
