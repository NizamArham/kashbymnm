import { ChangeEvent, useLayoutEffect, useRef } from "react";
import { cleanMoney, formatMoneyInput } from "./numberInput";

// Props for a text box that holds a money amount: shown with thousands commas as it is typed ("120,000"), while the value kept in
// state is the plain digits ("120000"). The cursor stays after the same digit it was after, so editing the middle of a number
// doesn't throw it to the end. Spread the result onto an <input>:  <input {...useMoneyField(amount, setAmount)} />
export function useMoneyField(raw: string, setRaw: (raw: string) => void) {
  const ref = useRef<HTMLInputElement | null>(null);
  const digitsBeforeCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const want = digitsBeforeCaret.current;
    if (!el || want === null) return;
    digitsBeforeCaret.current = null;
    let pos = 0;
    if (want > 0) {
      let seen = 0;
      pos = el.value.length;
      for (let i = 0; i < el.value.length; i++) {
        if (/[\d.]/.test(el.value[i])) {
          seen++;
          if (seen === want) {
            pos = i + 1;
            break;
          }
        }
      }
    }
    el.setSelectionRange(pos, pos);
  });

  return {
    ref,
    type: "text" as const,
    inputMode: "decimal" as const,
    autoComplete: "off",
    value: formatMoneyInput(raw),
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      const el = e.target;
      digitsBeforeCaret.current = el.value.slice(0, el.selectionStart ?? el.value.length).replace(/[^\d.]/g, "").length;
      setRaw(cleanMoney(el.value));
    },
  };
}
