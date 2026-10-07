import { useState } from "react";
import { Dropdown, DropdownOption, Input } from "./ui";
import { COUNTRIES, DEFAULT_COUNTRY, OTHER_COUNTRY, buildPhone, cleanNational, parsePhone, phoneError } from "../lib/phone";

const OPTIONS: DropdownOption[] = [
  ...COUNTRIES.map((c) => ({ value: c.code, label: `+${c.code}`, sublabel: c.name })),
  { value: OTHER_COUNTRY, label: "Other", sublabel: "type the full number with its country code" },
];

// A phone number box with a country picker beside it (+94 Sri Lanka unless
// changed). The value in and out is the number as it's saved — see lib/phone.ts —
// so a Sri Lankan number is just its 9 digits: a leading 0 is ignored as it's
// typed, more than 9 digits can't be entered, and a pasted +94… / 94… / 0…
// number lands in the right place. A pasted number with another country's +code
// switches the picker to that country.
export default function PhoneInput({
  value,
  onChange,
  id,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (saved: string) => void;
  id?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const parsed = parsePhone(value);
  // The picked country is remembered while the box is still empty (nothing in
  // `value` to read it back from); once there's a number, the number decides.
  const [pickedCode, setPickedCode] = useState(DEFAULT_COUNTRY);
  const [touched, setTouched] = useState(false);
  const code = parsed.national ? parsed.code : pickedCode;
  const invalid = touched && phoneError(value) !== null;

  function pick(next: string) {
    setPickedCode(next);
    onChange(buildPhone(next, cleanNational(next, parsed.national)));
  }

  function type(raw: string) {
    if (/^\s*(\+|00)/.test(raw)) {
      const p = parsePhone(raw);
      setPickedCode(p.code);
      onChange(buildPhone(p.code, p.national));
      return;
    }
    onChange(buildPhone(code, cleanNational(code, raw)));
  }

  return (
    <div className="flex gap-2">
      <div className="w-[5.5rem] flex-shrink-0">
        <Dropdown value={code} onChange={pick} options={OPTIONS} menuClassName="min-w-[16rem]" />
      </div>
      <Input
        id={id}
        type="tel"
        inputMode="numeric"
        autoComplete="off"
        autoFocus={autoFocus}
        value={parsed.national}
        onChange={(e) => type(e.target.value)}
        onBlur={() => setTouched(true)}
        placeholder={placeholder ?? (code === DEFAULT_COUNTRY ? "7XXXXXXXX" : code === OTHER_COUNTRY ? "Country code + number" : "Phone number")}
        className={invalid ? "!border-red-300" : ""}
        title={code === DEFAULT_COUNTRY ? "9 digits, without the leading 0" : undefined}
      />
    </div>
  );
}
