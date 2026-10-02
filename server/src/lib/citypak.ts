import { ApiError } from "./errors";

// Thin client for CityPak's "Falcon" customer API. Verified directly
// against their staging environment while building this — the create-
// order response shape here is what CityPak's API actually returns,
// not what their own docs show (the docs' example has a JSON syntax
// error, and the track endpoint's docs say "is_success" where the real
// response says "success").

export interface CitypakOrderParams {
  reference: string;
  from_name: string;
  from_address_line_1: string;
  from_address_line_2?: string;
  from_address_line_4: string; // city
  from_contact_name: string;
  from_contact_1: string;
  to_name: string;
  to_address_line_1: string;
  to_address_line_2?: string;
  to_address_line_4: string; // city
  to_contact_name: string;
  to_contact_1: string;
  to_contact_2?: string;
  description?: string;
  weight_g: number;
  cash_on_delivery_amount: number;
  number_of_pieces: number;
}

export interface CitypakOrderResult {
  order_id: number;
  tracking_number: string;
  delivery_facility_code: string | null;
}

export interface CitypakTrackingEvent {
  date: string;
  time: string;
  status_type: string;
  status_code: string;
  description: string;
  location: string;
}

export interface CitypakTrackingResult {
  tracking_number: string;
  reference: string;
  is_delivered: boolean;
  receiver_name: string;
  tracking_history: CitypakTrackingEvent[];
}

function requireConfig(): { baseUrl: string; token: string } {
  const baseUrl = process.env.CITYPAK_BASE_URL;
  const token = process.env.CITYPAK_API_TOKEN;
  if (!baseUrl || !token) {
    throw new ApiError(400, "CityPak isn't configured — add CITYPAK_BASE_URL and CITYPAK_API_TOKEN to server/.env, then restart the server.");
  }
  return { baseUrl, token };
}

export async function citypakCreateOrder(params: CitypakOrderParams): Promise<CitypakOrderResult> {
  const { baseUrl, token } = requireConfig();

  const body = { token, ...params };

  // ── DEBUG: show exactly what we're sending ─────────────────────────
  // The city field on CityPak's API is address_line_4 (for both from
  // and to). If the caller is putting the city into a different field,
  // or leaving line_4 empty, this log will show it immediately.
  // Also flags any non-ASCII characters — CityPak rejects those via
  // a regex ([^\x00-\x7F]+) but only reports a generic error.
  const nonAsciiFields = Object.entries(body).filter(
    ([, v]) => typeof v === "string" && /[^\x00-\x7F]/.test(v)
  );
  console.log("── CityPak create-order request ──");
  console.log("URL:", `${baseUrl}/customer_api/v1/orders`);
  // The API token is deliberately left out of the log.
  console.log("Body:", JSON.stringify({ ...body, token: "(hidden)" }, null, 2));
  if (nonAsciiFields.length) {
    console.log("⚠ Non-ASCII characters found in:", nonAsciiFields.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", "));
  }
  // ───────────────────────────────────────────────────────────────────

  const res = await fetch(`${baseUrl}/customer_api/v1/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(502, "CityPak returned an unreadable response");
  }

  // ── DEBUG: show exactly what CityPak sent back ─────────────────────
  // CityPak returns 200 for both success and failure, with a "success"
  // boolean inside the JSON. The `message` and `data` fields carry the
  // real reason for a rejection — logging the raw body here means we
  // never have to guess why an order was refused.
  console.log("── CityPak create-order response ──");
  console.log("HTTP status:", res.status);
  console.log("Body:", JSON.stringify(json, null, 2));
  // ───────────────────────────────────────────────────────────────────

  if (!json?.success) {
    throw new ApiError(400, json?.message || "CityPak rejected the order");
  }

  const item = json.data?.items?.[0];
  if (!item?.tracking_number) {
    throw new ApiError(502, "CityPak accepted the order but didn't return a tracking number");
  }

  return {
    order_id: json.data.order_id,
    tracking_number: item.tracking_number,
    delivery_facility_code: item.delivery_facility_code || null,
  };
}

export async function citypakTrackOrder(trackingNumber: string): Promise<CitypakTrackingResult> {
  const { baseUrl, token } = requireConfig();

  const res = await fetch(`${baseUrl}/customer_api/v1/track?tracking_number=${encodeURIComponent(trackingNumber)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(502, "CityPak returned an unreadable response");
  }
  if (!json?.success) {
    throw new ApiError(res.status === 404 ? 404 : 400, json?.message || "Tracking lookup failed");
  }

  return {
    tracking_number: json.data.tracking_number,
    reference: json.data.reference,
    is_delivered: !!json.data.is_delivered,
    receiver_name: json.data.receiver_name || "",
    tracking_history: json.data.tracking_history || [],
  };
}