// Who pays the courier's charge for collecting what comes back — the same three choices wherever it is asked (an exchange by
// delivery, a return by courier).
export const SHARE_OPTIONS: { pct: number; label: string; hint: string }[] = [
  { pct: 0, label: "We pay", hint: "Our mistake — wrong item or a defect" },
  { pct: 50, label: "Half and half", hint: "The customer pays half, we pay half" },
  { pct: 100, label: "Customer pays", hint: "The customer pays all of it" },
];
