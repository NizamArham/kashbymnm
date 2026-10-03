import { useState } from "react";
import { X, RotateCcw, Landmark } from "lucide-react";
import { ChequeInfo } from "../lib/types";
import { Badge, BadgeTone } from "./ui";

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

// "Three Hundred And Forty Five" — the "And" only shows up between a
// hundreds digit and whatever tens/ones follow it, matching how a bank
// cheque is actually worded.
function threeDigitsToWords(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const remainder = n % 100;
  if (hundreds > 0) {
    parts.push(ONES[hundreds], "Hundred");
    if (remainder > 0) parts.push("And");
  }
  if (remainder >= 20) {
    parts.push(TENS[Math.floor(remainder / 10)]);
    if (remainder % 10 > 0) parts.push(ONES[remainder % 10]);
  } else if (remainder > 0) {
    parts.push(ONES[remainder]);
  }
  return parts.join(" ");
}

function numberToWords(n: number): string {
  if (n === 0) return "Zero";
  const groups: [number, string][] = [
    [1_000_000_000, "Billion"],
    [1_000_000, "Million"],
    [1_000, "Thousand"],
  ];
  const parts: string[] = [];
  let remaining = Math.floor(n);
  for (const [value, label] of groups) {
    if (remaining >= value) {
      parts.push(threeDigitsToWords(Math.floor(remaining / value)), label);
      remaining %= value;
    }
  }
  if (remaining > 0) parts.push(threeDigitsToWords(remaining));
  return parts.join(" ");
}

function amountInWords(amount: number): string {
  const rupees = Math.floor(amount);
  const cents = Math.round((amount - rupees) * 100);
  let words = numberToWords(rupees);
  if (cents > 0) words += ` And ${numberToWords(cents)} Cents`;
  return `${words} Only`;
}

// Deterministic, no DOM measurement needed — greedily fills line 1 up to
// a character budget, the rest goes to line 2 (truncated as a last
// resort for an absurdly long amount). Approximate by nature since the
// font is proportional, but that's fine for a decorative ruled line.
function splitIntoTwoLines(text: string, maxLineChars: number): [string, string] {
  const words = text.split(" ");
  let line1 = "";
  let i = 0;
  for (; i < words.length; i++) {
    const candidate = line1 ? `${line1} ${words[i]}` : words[i];
    if (candidate.length > maxLineChars && line1) break;
    line1 = candidate;
  }
  const line2 = words.slice(i).join(" ");
  return [line1, line2];
}

function formatDateDigits(dateStr: string): string[] {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return Array(8).fill("-");
  const dd = String(d.getDate()).padStart(2, "0").split("");
  const mm = String(d.getMonth() + 1).padStart(2, "0").split("");
  const yyyy = String(d.getFullYear()).split("");
  return [...dd, ...mm, ...yyyy];
}
const DATE_LABELS = ["D", "D", "M", "M", "Y", "Y", "Y", "Y"];

function formatDateDisplay(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const STATUS_LABELS: Record<string, string> = {
  in_hand: "In hand",
  given_to_supplier: "Given to supplier",
  deposited: "Deposited",
  cleared: "Cleared",
  bounced: "Bounced",
  pending: "Pending",
};

function statusTone(status: string): BadgeTone {
  if (status === "cleared") return "success";
  if (status === "bounced") return "danger";
  return "warning";
}

// The one plain crossing mark — two straight parallel diagonal lines,
// no box, no "A/C Payee Only" text. Only shown when the cheque record
// actually says it was crossed; there's more than one real style of
// crossing (general, special, restrictive), but this is the simple
// generic one for now, added back in when there's a real need for the
// others.
function CrossingMark() {
  // Both lines share the same direction (82, -32) — genuinely parallel,
  // just offset from one another — instead of two lines drawn at
  // different angles that only looked like a crossing from a distance.
  return (
    <svg className="absolute top-0 left-0 w-14 h-11 sm:w-16 sm:h-12 pointer-events-none" viewBox="0 0 100 70" fill="none">
      <line x1="0" y1="32" x2="82" y2="0" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="10" y1="52" x2="92" y2="20" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export default function ChequePreviewModal({
  cheque,
  supplierName,
  businessName,
  onClose,
}: {
  cheque: ChequeInfo;
  supplierName: string;
  businessName: string;
  onClose: () => void;
}) {
  const [flipped, setFlipped] = useState(false);

  const dateDigits = formatDateDigits(cheque.cheque_date);
  // Exactly who the cheque was made out to — "Cash" is the honest
  // default, not a named party we'd otherwise have to guess at.
  const payeeName = cheque.payee_name?.trim() || "Cash";
  const accountName = cheque.source === "issued" ? businessName : cheque.from_customer_name ?? "Customer";
  const isCrossed = !!cheque.is_crossed;
  const [wordsLine1, wordsLine2] = splitIntoTwoLines(amountInWords(cheque.amount), 42);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-2xl w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* The cheque number and bank are already printed on the cheque
            face itself right below — repeating them as a bold title here
            was pure duplication. One slim status-and-controls row is all
            the chrome this needs. */}
        <div className="px-5 py-3.5 flex items-center justify-between">
          <Badge label={STATUS_LABELS[cheque.status] ?? cheque.status} tone={statusTone(cheque.status)} />
          <div className="flex items-center gap-4">
            <button
              onClick={() => setFlipped((f) => !f)}
              className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800"
            >
              <RotateCcw size={12} />
              {flipped ? "View front" : "View back"}
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="p-5 pt-0">
          <div style={{ perspective: "1800px" }}>
            <div
              className="relative w-full min-h-[372px] sm:min-h-[306px] transition-transform duration-500"
              style={{ transformStyle: "preserve-3d", transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)" }}
            >
              {/* FRONT — flat white paper, thin border, plain black ink.
                  Matches the placement on real Sri Lankan cheques: bank
                  name, date boxes, Pay + Or Bearer, two ruled Rupees
                  lines + Rs box, account name, "please do not write
                  below this line", then the cheque number at the very
                  bottom. No crossing mark (none of the reference cheques
                  had one, and we have no real is_crossed field to back
                  it with) and no fabricated branch/routing/account
                  numbers on the bottom line — just the real cheque
                  number we actually have. */}
              <div
                className="absolute inset-0 w-full h-full rounded-md border border-gray-300 bg-white px-4 py-3 sm:px-6 sm:py-4 flex flex-col overflow-hidden"
                style={{ backfaceVisibility: "hidden" }}
              >
                {/* Faint printed guard pattern — real cheques have this
                    security texture. Neutral gray, not tinted, and
                    barely visible so it never competes with the text. */}
                <div
                  className="absolute inset-0 pointer-events-none opacity-40"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(0deg, rgba(0,0,0,0.02) 0 1px, transparent 1px 7px), repeating-linear-gradient(90deg, rgba(0,0,0,0.02) 0 1px, transparent 1px 7px)",
                  }}
                />

                {isCrossed && <CrossingMark />}

                <div
                  className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-3"
                >
                  <div className="min-w-0 flex items-center gap-1.5">
                    <Landmark size={16} className="text-gray-700 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-base sm:text-lg font-semibold text-gray-900 tracking-wide truncate">
                        {cheque.bank_name}
                      </p>
                      {cheque.branch && <p className="text-[10px] text-gray-400 truncate">{cheque.branch}</p>}
                    </div>
                  </div>
                  <div className="flex-shrink-0 sm:text-right">
                    <div className="flex">
                      {dateDigits.map((digit, i) => (
                        <div key={i} className="flex flex-col items-center">
                          <div
                            className={`w-6 h-7 sm:w-7 sm:h-8 border-y border-r ${i === 0 ? "border-l" : ""} border-gray-300 bg-white flex items-center justify-center text-[10px] sm:text-xs font-mono text-gray-800`}
                          >
                            {digit}
                          </div>
                          <span className="text-[7px] text-gray-400 mt-0.5">{DATE_LABELS[i]}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-3 sm:mt-4 flex items-baseline gap-2 border-b border-gray-400 pb-1 flex-shrink-0">
                  <span className="text-xs text-gray-500 flex-shrink-0">Pay</span>
                  <span className="flex-1 min-w-0 text-sm sm:text-base font-semibold text-gray-900 italic truncate">
                    {payeeName ? `**${payeeName}**` : ""}
                  </span>
                  <span className="text-[9px] text-gray-400 flex-shrink-0 uppercase tracking-wide">Or Bearer</span>
                </div>

                <div className="mt-3 sm:mt-4 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4 flex-shrink-0">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 border-b border-gray-400 pb-1">
                      <span className="text-xs text-gray-500 flex-shrink-0">Rupees</span>
                      <span className="text-xs sm:text-sm text-gray-800 italic truncate">
                        {wordsLine2 ? `**${wordsLine1}` : `**${wordsLine1}**`}
                      </span>
                    </div>
                    <div className="mt-2 border-b border-gray-400 pb-1 h-[18px] sm:h-5">
                      {wordsLine2 && (
                        <span className="text-xs sm:text-sm text-gray-800 italic truncate block">{wordsLine2}**</span>
                      )}
                    </div>
                  </div>
                  <div className="flex-shrink-0">
                    <p className="text-xs text-gray-500 mb-1">Rs</p>
                    <div className="w-full sm:w-44 h-[52px] border border-gray-300 rounded-sm flex items-center justify-center px-2 py-1">
                      <span className="text-sm sm:text-base font-mono font-semibold text-gray-900 text-center leading-tight">
                        <span className="whitespace-nowrap">**</span>
                        <span className="break-words">
                          {cheque.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </span>
                        <span className="whitespace-nowrap">**</span>
                      </span>
                    </div>
                  </div>
                </div>

                {/* Account name — bottom-left, the same spot every one of
                    the reference photos prints the account holder. */}
                <div className="mt-3 sm:mt-4 flex-shrink-0">
                  <p className="text-sm sm:text-base text-gray-800 truncate max-w-[70%]">{accountName}</p>
                </div>

                <div className="mt-auto pt-2 flex-shrink-0">
                  <p className="text-[8px] text-gray-400 text-center uppercase tracking-wide mb-1.5">
                    Please do not write below this line
                  </p>
                  <div className="border-t border-gray-400 pt-1.5">
                    <p className="text-center font-mono text-[11px] tracking-[0.3em] text-gray-500">
                      {cheque.cheque_number}
                    </p>
                  </div>
                </div>
              </div>

              {/* BACK — same flat, plain, monochrome treatment: clean
                  label/value rows, no color, no fabricated bank codes.
                  Same guard-pattern texture as the front so both sides
                  read as one physical object, not two different styles. */}
              <div
                className="absolute inset-0 w-full h-full rounded-md border border-gray-300 bg-gray-50 px-4 py-3 sm:px-6 sm:py-4 flex flex-col overflow-hidden"
                style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
              >
                <div
                  className="absolute inset-0 pointer-events-none opacity-40"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(0deg, rgba(0,0,0,0.02) 0 1px, transparent 1px 7px), repeating-linear-gradient(90deg, rgba(0,0,0,0.02) 0 1px, transparent 1px 7px)",
                  }}
                />

                <p className="relative text-[10px] uppercase tracking-wider text-gray-400 mb-2">Endorsement history</p>

                {cheque.source === "transferred" ? (
                  <div className="flex-1 flex flex-col justify-center gap-3">
                    <div className="flex items-center justify-between border-b border-gray-200 pb-2.5">
                      <div className="min-w-0">
                        <p className="text-[9px] text-gray-400 uppercase tracking-wide">Received from</p>
                        <p className="text-sm text-gray-900 font-medium truncate">
                          {cheque.from_customer_name}
                          {cheque.from_customer_code && (
                            <span className="text-gray-400 font-normal"> ({cheque.from_customer_code})</span>
                          )}
                        </p>
                      </div>
                      {cheque.date_received && (
                        <p className="text-xs text-gray-500 flex-shrink-0 ml-3">{formatDateDisplay(cheque.date_received)}</p>
                      )}
                    </div>

                    <div className="flex items-center justify-between border-b border-gray-200 pb-2.5">
                      <div className="min-w-0">
                        <p className="text-[9px] text-gray-400 uppercase tracking-wide">Given to</p>
                        <p className="text-sm text-gray-900 font-medium truncate">{supplierName}</p>
                      </div>
                      {cheque.transfer_date && (
                        <p className="text-xs text-gray-500 flex-shrink-0 ml-3">{formatDateDisplay(cheque.transfer_date)}</p>
                      )}
                    </div>

                    <div className="text-center">
                      <p className="text-[9px] text-gray-400 uppercase tracking-wide">Endorsement</p>
                      <p className="text-xs text-gray-600 italic mt-0.5">
                        Pay to {supplierName} only — {businessName}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col justify-center gap-3">
                    <div className="flex items-center justify-between border-b border-gray-200 pb-2.5">
                      <div className="min-w-0">
                        <p className="text-[9px] text-gray-400 uppercase tracking-wide">Issued by</p>
                        <p className="text-sm text-gray-900 font-medium truncate">{businessName}</p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="text-[9px] text-gray-400 uppercase tracking-wide">Given to</p>
                        <p className="text-sm text-gray-900 font-medium truncate">{supplierName}</p>
                      </div>
                      <p className="text-xs text-gray-500 flex-shrink-0 ml-3">{formatDateDisplay(cheque.cheque_date)}</p>
                    </div>
                    <p className="text-center text-[10px] text-gray-400 mt-1">
                      Written directly to this supplier — no prior holder.
                    </p>
                  </div>
                )}

                <div className="mt-auto pt-2 border-t border-gray-300 flex-shrink-0">
                  <p className="text-center font-mono text-[11px] tracking-[0.3em] text-gray-400">
                    {cheque.cheque_number}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
