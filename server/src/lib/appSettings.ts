import { db } from "../db/connection";

// Small shop-wide settings an admin can change without touching code: a key and a JSON value. Additive lazy migration, like the other modules.
db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown) {
  db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
}

// Who pays the delivery charge of a courier return, by default — what the inspection report starts from (it can be changed per case).
// 0 = we do, 50 = half and half, 100 = the customer. "Our fault" is a defect or a wrong description; "customer's choice" is a wrong size,
// a different colour or a change of mind.
export interface ReturnSplitDefaults {
  our_fault: number;
  customer_choice: number;
}
export const RETURN_SPLIT_KEY = "courier_return_split_defaults";
export const RETURN_SPLIT_FALLBACK: ReturnSplitDefaults = { our_fault: 0, customer_choice: 100 };
