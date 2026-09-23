import { BusinessInfo } from "./types";

// The waybill's return-address footer defaults from the shop's own
// General Settings record, instead of being hardcoded in each place
// that prints a waybill — so moving locations or changing the phone
// number only ever needs editing in one place. It's still per-waybill
// editable after this (an order can genuinely need a different return
// address), this just sets the starting point.
export function applyBusinessInfoToReturnAddress(
  info: BusinessInfo,
  setName: (v: string) => void,
  setAddress: (v: string) => void,
  setPhone: (v: string) => void,
  setWebsite: (v: string) => void
) {
  if (info.business_name) setName(info.business_name);
  const addressParts = [info.address_line1, info.address_line2, info.city].filter(Boolean);
  if (addressParts.length > 0) setAddress(`${addressParts.join(", ")},\nSri Lanka.`);
  if (info.phone) setPhone(info.phone);
  if (info.website) setWebsite(info.website);
}
