// Phone numbers are saved in one of two shapes, so every existing Sri Lankan
// record keeps working exactly as it is:
//   Sri Lanka      — the 9 digits without the leading 0, e.g. 701290648
//   anywhere else  — "+" and the full international number, e.g. +447911123456
// (WhatsApp, couriers and the receipts all read these two shapes.)

export interface Country {
  code: string; // dialling code, no "+"
  name: string;
}

export const DEFAULT_COUNTRY = "94";
export const OTHER_COUNTRY = "other";

// Sri Lanka first (it's the default), then the places customers and family
// abroad are most likely to be calling from. "Other" covers anything else —
// the full number, country code included, is typed in.
export const COUNTRIES: Country[] = [
  { code: "94", name: "Sri Lanka" },
  { code: "91", name: "India" },
  { code: "960", name: "Maldives" },
  { code: "971", name: "United Arab Emirates" },
  { code: "966", name: "Saudi Arabia" },
  { code: "974", name: "Qatar" },
  { code: "965", name: "Kuwait" },
  { code: "968", name: "Oman" },
  { code: "973", name: "Bahrain" },
  { code: "44", name: "United Kingdom" },
  { code: "1", name: "United States / Canada" },
  { code: "61", name: "Australia" },
  { code: "64", name: "New Zealand" },
  { code: "65", name: "Singapore" },
  { code: "60", name: "Malaysia" },
  { code: "92", name: "Pakistan" },
  { code: "880", name: "Bangladesh" },
  { code: "39", name: "Italy" },
  { code: "49", name: "Germany" },
  { code: "33", name: "France" },
  { code: "81", name: "Japan" },
];

const SRI_LANKA_DIGITS = 9;
const MAX_INTERNATIONAL_DIGITS = 15; // the international standard, country code included

export interface ParsedPhone {
  code: string; // a COUNTRIES code, or OTHER_COUNTRY
  national: string; // digits after the country code, no leading 0
}

// Tidies the digits typed after a country code: a leading 0 (the "trunk"
// prefix people dial at home) is dropped, a Sri Lankan number is cut to its
// 9 digits, and a pasted 94-prefixed Sri Lankan number loses the 94.
export function cleanNational(code: string, digits: string): string {
  let d = digits.replace(/\D/g, "").replace(/^0+/, "");
  if (code === DEFAULT_COUNTRY) {
    if (d.length === 11 && d.startsWith("94")) d = d.slice(2);
    return d.slice(0, SRI_LANKA_DIGITS);
  }
  const room = code === OTHER_COUNTRY ? MAX_INTERNATIONAL_DIGITS : MAX_INTERNATIONAL_DIGITS - code.length;
  return d.slice(0, room);
}

function countryOf(internationalDigits: string): Country | undefined {
  return COUNTRIES.filter((c) => internationalDigits.startsWith(c.code)).sort((a, b) => b.code.length - a.code.length)[0];
}

// Reads a saved or typed number back into country + digits. Anything with a
// "+" (or 00) in front is international; anything else is taken to be a
// number in `fallbackCode`'s country, as typed.
export function parsePhone(raw: string | null | undefined, fallbackCode: string = DEFAULT_COUNTRY): ParsedPhone {
  const text = (raw ?? "").trim();
  const digits = text.replace(/\D/g, "");
  if (!digits) return { code: fallbackCode, national: "" };

  if (text.startsWith("+") || text.startsWith("00")) {
    const international = text.startsWith("+") ? digits : digits.slice(2);
    const country = countryOf(international);
    if (country) return { code: country.code, national: cleanNational(country.code, international.slice(country.code.length)) };
    return { code: OTHER_COUNTRY, national: cleanNational(OTHER_COUNTRY, international) };
  }
  return { code: fallbackCode, national: cleanNational(fallbackCode, digits) };
}

// The saved form of a country + digits ("" while no digits are typed yet).
export function buildPhone(code: string, national: string): string {
  if (!national) return "";
  if (code === DEFAULT_COUNTRY) return national;
  return code === OTHER_COUNTRY ? `+${national}` : `+${code}${national}`;
}

// Anything typed or pasted, in whatever shape, as the saved form.
export function normalizePhone(raw: string | null | undefined): string {
  const { code, national } = parsePhone(raw);
  return buildPhone(code, national);
}

// Why a number can't be saved, or null when it's fine (or empty — whether a
// number is required is up to the form).
export function phoneError(raw: string | null | undefined): string | null {
  const { code, national } = parsePhone(raw);
  if (!national) return null;
  if (code === DEFAULT_COUNTRY) {
    return national.length === SRI_LANKA_DIGITS
      ? null
      : `A Sri Lankan number is 9 digits without the leading 0 (like 701290648) — this has ${national.length}.`;
  }
  const total = (code === OTHER_COUNTRY ? 0 : code.length) + national.length;
  return total >= 8 ? null : "That number looks too short — check it includes the country code and all digits.";
}

// What goes after wa.me/ — the full international number, digits only.
// Saved Sri Lankan numbers get 94 put in front; international ones already
// carry their code.
export function whatsappNumber(stored: string): string {
  const text = stored.trim();
  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+")) return digits;
  return `94${digits.replace(/^0/, "")}`;
}
