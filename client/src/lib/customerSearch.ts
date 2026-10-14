import { api } from "./api";
import { Customer } from "./types";

// A cashier finds a customer by typing part of their name or phone number (a customer code in full): at least
// 3 characters, at most 5 people back, and only an exact full name / number / code shows a whole phone number.
// There is no list to browse — the server enforces it (GET /api/customers?find=…). Admins search the whole list.
export const CASHIER_SEARCH_MIN_CHARS = 3;

export function findCustomers(text: string): Promise<Customer[]> {
  return api.get<Customer[]>(`/customers?find=${encodeURIComponent(text.trim())}`);
}
