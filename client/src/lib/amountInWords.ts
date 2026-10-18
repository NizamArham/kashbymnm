// A money amount in words, the way a bank cheque or slip words it: "Three Hundred And Forty Five Only".

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

export function amountInWords(amount: number): string {
  const rupees = Math.floor(amount);
  const cents = Math.round((amount - rupees) * 100);
  let words = numberToWords(rupees);
  if (cents > 0) words += ` And ${numberToWords(cents)} Cents`;
  return `${words} Only`;
}
