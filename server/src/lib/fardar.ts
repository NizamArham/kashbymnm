import { ApiError } from "./errors";

// Thin client for Fardar Express Domestic's parcel API ("New Waybill API").
// Checked against their live endpoint: it answers 200 with JSON whose
// `status` is a STRING ("212"), not a number as their docs' sample
// suggests, and it validates the credentials before anything else — so
// the status is always compared as a number here. Requests are plain
// form data (their docs: query strings and JSON aren't accepted).

const DEFAULT_URL = "https://www.fdedomestic.com/api/parcel/new_api_v1.php";

export interface FardarParcelParams {
  order_id?: string;
  parcel_weight: number;
  parcel_description: string;
  recipient_name: string;
  recipient_contact_1: string;
  recipient_contact_2?: string;
  recipient_address: string;
  recipient_city: string;
  amount: number;
  exchange?: boolean;
}

// Their documented status codes, in words someone at the till can act on.
const STATUS_MESSAGES: Record<number, string> = {
  201: "Fardar says this client account is inactive.",
  202: "Fardar rejected the order reference.",
  203: "Fardar rejected the parcel weight.",
  204: "Fardar rejected the parcel description (empty or invalid).",
  205: "Fardar rejected the recipient's name.",
  206: "Fardar says the recipient's first phone number isn't valid.",
  207: "Fardar says the recipient's second phone number isn't valid.",
  208: "Fardar rejected the delivery address (empty or invalid).",
  209: "Fardar doesn't recognise the delivery city — check the spelling of the city on the customer's address.",
  210: "Fardar couldn't save the parcel — try again.",
  211: "Fardar says the API key is invalid — check FARDAR_API_KEY in server/.env.",
  212: "Fardar says the client is invalid or inactive — check FARDAR_CLIENT_ID and FARDAR_API_KEY in server/.env.",
  213: "Fardar rejected the exchange flag.",
  214: "Fardar is in maintenance mode right now — try again later.",
};

export class FardarRejection extends ApiError {
  fardarStatus: number;
  constructor(status: number) {
    super(400, STATUS_MESSAGES[status] ?? `Fardar rejected the parcel (status ${status}).`);
    this.fardarStatus = status;
  }
}

// The city picker saves a post office together with its postal code, and
// sometimes a district code too — "Bentota 80500", "Adampan(MB) 41160". Fardar
// matches on the place's NAME alone, so "Bentota 80500" is "a city we don't
// know". These two pick the parts apart; the code goes into the address line
// instead (Fardar's API has no postal-code field).
export function fardarCityName(saved: string): string {
  return saved
    .replace(/\s+\d{4,6}\s*$/, "") // the trailing postal code
    .replace(/\s*\(.*?\)\s*$/, "") // a district code such as (KG) or (MB)
    .trim();
}

export function postalCodeOf(saved: string): string | null {
  return /\s(\d{4,6})\s*$/.exec(saved)?.[1] ?? null;
}

function requireConfig(): { url: string; clientId: string; apiKey: string } {
  const clientId = process.env.FARDAR_CLIENT_ID;
  const apiKey = process.env.FARDAR_API_KEY;
  if (!clientId || !apiKey) {
    throw new ApiError(400, "Fardar isn't configured — add FARDAR_CLIENT_ID and FARDAR_API_KEY to server/.env, then restart the server.");
  }
  return { url: process.env.FARDAR_BASE_URL || DEFAULT_URL, clientId, apiKey };
}

async function postParcel(params: FardarParcelParams): Promise<string> {
  const { url, clientId, apiKey } = requireConfig();

  const form = new URLSearchParams();
  form.set("client_id", clientId);
  form.set("api_key", apiKey);
  if (params.order_id) form.set("order_id", params.order_id);
  form.set("parcel_weight", String(params.parcel_weight));
  form.set("parcel_description", params.parcel_description);
  form.set("recipient_name", params.recipient_name);
  form.set("recipient_contact_1", params.recipient_contact_1);
  if (params.recipient_contact_2) form.set("recipient_contact_2", params.recipient_contact_2);
  form.set("recipient_address", params.recipient_address);
  form.set("recipient_city", params.recipient_city);
  form.set("amount", String(params.amount));
  form.set("exchange", params.exchange ? "1" : "0");

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
  } catch {
    throw new ApiError(502, "Couldn't reach Fardar's server — check the internet connection and try again.");
  }

  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(502, "Fardar returned an unreadable response");
  }

  const status = Number(json?.status);
  if (status !== 200) throw new FardarRejection(status);

  const waybill = String(json?.waybill_no ?? "").trim();
  if (!waybill) throw new ApiError(502, "Fardar accepted the parcel but didn't return a waybill number");
  return waybill;
}

// What booking a parcel gave back: Fardar's waybill number, and which optional details Fardar refused and were left out so the parcel could still be
// booked (the order reference, and the recipient's second phone number).
export interface FardarBooking {
  waybill: string;
  droppedOrderReference: boolean;
  droppedSecondPhone: boolean;
}

// Creates the parcel on Fardar's side and returns their waybill number,
// which doubles as the tracking number. Two details are optional on their
// end, and the parcel is booked without whichever one they refuse rather than
// failing the whole booking:
//  - the order reference (202 — their docs don't say what format it must be,
//    and our invoice numbers have letters in them): sent again without it,
//    with the invoice number in the description so the parcel can still be
//    matched to the order;
//  - the recipient's second phone number (207): sent again with the first only.
// A first phone number they refuse (206) can't be left out, so that still stops.
export async function fardarCreateParcel(params: FardarParcelParams): Promise<FardarBooking> {
  let current = params;
  const booking = { droppedOrderReference: false, droppedSecondPhone: false };
  // At most one retry per optional detail.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return { waybill: await postParcel(current), ...booking };
    } catch (err) {
      if (!(err instanceof FardarRejection)) throw err;
      if (err.fardarStatus === 202 && current.order_id) {
        current = { ...current, order_id: undefined, parcel_description: `${current.order_id} — ${current.parcel_description}`.slice(0, 150) };
        booking.droppedOrderReference = true;
      } else if (err.fardarStatus === 207 && current.recipient_contact_2) {
        current = { ...current, recipient_contact_2: undefined };
        booking.droppedSecondPhone = true;
      } else {
        throw err;
      }
    }
  }
  throw new ApiError(502, "Fardar kept rejecting the parcel — try again");
}
