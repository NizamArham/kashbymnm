export function normalizeSriLankanPhone(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  if (!digits) return undefined;
  if (digits.startsWith("94") && digits.length === 11) return digits.slice(2);
  return digits.startsWith("0") ? digits.slice(1) : digits;
}