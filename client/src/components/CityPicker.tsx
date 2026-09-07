import { useMemo } from "react";
import { cities } from "../lib/cities";
import { Dropdown } from "./ui";

// A searchable picker over all ~2,100 Sri Lanka post offices. The value
// saved (and shown once selected) is "City Name PostalCode" combined —
// e.g. "Diyatalawa 90250" — so the postal code travels with the address
// as one field rather than needing a separate column to manage.
export function CityPicker({
  value,
  onChange,
  placeholder = "— Search for a city —",
}: {
  value: string;
  onChange: (cityWithCode: string) => void;
  placeholder?: string;
}) {
  const options = useMemo(
    () => cities.map((c) => ({ value: `${c.name} ${c.code}`, label: c.name, sublabel: c.code })),
    []
  );

  return <Dropdown value={value} onChange={onChange} options={options} placeholder={placeholder} searchable />;
}
