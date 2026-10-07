import { ApiError } from "./errors";

// Phone numbers are saved in one of two shapes (the client's lib/phone.ts
// builds the same ones):
//   Sri Lanka      — the 9 digits without the leading 0, e.g. 701290648
//   anywhere else  — "+" and the full international number, e.g. +447911123456
// Anything that arrives in another shape (0701290648, +94 70 129 0648,
// 0094…) is tidied into one of those; a number that can't be one of them is
// refused rather than saved wrong.

// Longest first, so "880" is tried before anything shorter could swallow it.
const KNOWN_CODES = ["880", "960", "965", "966", "968", "971", "973", "974", "91", "92", "94", "44", "49", "60", "61", "64", "65", "81", "33", "39", "1"];

const SRI_LANKA_ERROR = (n: number) => `A Sri Lankan phone number is 9 digits without the leading 0 (like 701290648) — this one has ${n}.`;

export function normalizePhone(raw: string | null | undefined): string | undefined {
  const text = (raw ?? "").trim();
  const digits = text.replace(/\D/g, "");
  if (!digits) return undefined;

  const international = text.startsWith("+") ? digits : text.startsWith("00") ? digits.slice(2) : null;

  if (international === null) {
    let national = digits.replace(/^0+/, "");
    if (national.length === 11 && national.startsWith("94")) national = national.slice(2);
    if (national.length !== 9) throw new ApiError(400, SRI_LANKA_ERROR(national.length));
    return national;
  }

  const code = KNOWN_CODES.find((c) => international.startsWith(c));
  if (code === "94") {
    const national = international.slice(2).replace(/^0+/, "");
    if (national.length !== 9) throw new ApiError(400, SRI_LANKA_ERROR(national.length));
    return national;
  }
  const national = code ? international.slice(code.length).replace(/^0+/, "") : international;
  const total = (code?.length ?? 0) + national.length;
  if (total < 8 || total > 15) {
    throw new ApiError(400, "That phone number doesn't look right — an international number has 8 to 15 digits including the country code.");
  }
  return `+${code ?? ""}${national}`;
}
