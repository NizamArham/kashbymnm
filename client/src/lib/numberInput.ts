// Digits with at most one decimal point — for a plain text box (so no
// number-spinner arrows) where a money amount or weight is typed.
export function cleanDecimal(raw: string): string {
  const digits = raw.replace(/[^\d.]/g, "");
  const [whole, ...rest] = digits.split(".");
  return rest.length > 0 ? `${whole}.${rest.join("")}` : whole;
}

// A typed money amount: digits with at most one decimal point and at most two
// decimal places (cents), commas from a formatted box ignored.
export function cleanMoney(raw: string): string {
  const cleaned = cleanDecimal(raw.replace(/,/g, ""));
  const dot = cleaned.indexOf(".");
  return dot === -1 ? cleaned : `${cleaned.slice(0, dot)}.${cleaned.slice(dot + 1, dot + 3)}`;
}

// A typed money amount shown with thousands commas ("120000" -> "120,000"), keeping a typed decimal point and cents exactly as
// entered ("1,250." stays "1,250." until the cents arrive). The value kept in state stays the plain digits (see cleanMoney).
export function formatMoneyInput(raw: string): string {
  if (!raw) return "";
  const [whole, cents] = raw.split(".");
  const wholeText = whole ? parseInt(whole, 10).toLocaleString("en-US") : "0";
  return cents === undefined ? wholeText : `${wholeText}.${cents}`;
}
