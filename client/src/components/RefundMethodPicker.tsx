import { useCallback, useEffect, useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { Button, ErrorText, FormGroup, Input, Label } from "./ui";

export interface BankAccount {
  id: number;
  bank_name: string;
  account_name: string;
  account_number: string;
  branch?: string | null;
  is_default: number;
}

// The customer's saved bank accounts, for a refund by bank transfer. Loaded once there is a customer and `enabled` (nothing is fetched
// for a cash refund or a walk-in). `defaultId` is their default account, or the first, as a string ready for the radio buttons.
// `reload` reads them again (after one was added).
export function useCustomerBankAccounts(customerId: number | null | undefined, enabled = true) {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled || !customerId) {
      setAccounts([]);
      return;
    }
    let live = true;
    api
      .get<{ bank_accounts?: BankAccount[] }>(`/customers/${customerId}`)
      .then((c) => live && setAccounts(c.bank_accounts ?? []))
      .catch(() => live && setAccounts([])); // the picker just shows "no account on file"
    return () => {
      live = false;
    };
  }, [customerId, enabled, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const defaultId = String(accounts.find((a) => a.is_default === 1)?.id ?? accounts[0]?.id ?? "");
  return { accounts, defaultId, reload };
}

// How a refund is paid: cash from the till, or a transfer to one of the customer's saved accounts (which the shop makes itself).
// With a `customerId` the bank details can be added right here when none are on file yet.
export default function RefundMethodPicker({
  method,
  onMethod,
  accounts,
  accountId,
  onAccount,
  name,
  customerId,
  onAdded,
}: {
  method: "cash" | "bank_transfer";
  onMethod: (m: "cash" | "bank_transfer") => void;
  accounts: BankAccount[];
  accountId: string;
  onAccount: (id: string) => void;
  // Radio group name — unique per picker on the page.
  name: string;
  // Lets the bank details be added here; `onAdded` is told which account was saved (so the list can be re-read and it picked).
  customerId?: number | null;
  onAdded?: (account: BankAccount) => void;
}) {
  const [adding, setAdding] = useState(false);
  const noAccounts = accounts.length === 0;
  return (
    <FormGroup>
      <Label>Refund by</Label>
      <div className="mb-2 flex gap-2">
        {(["cash", "bank_transfer"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onMethod(m)}
            className={`flex-1 rounded-xl border py-2 text-sm font-medium transition ${
              method === m ? "border-black bg-black text-white" : "border-gray-200 bg-white text-gray-600 hover:border-gray-400"
            }`}
          >
            {m === "cash" ? "Cash" : "Bank transfer"}
          </button>
        ))}
      </div>
      {method === "bank_transfer" && (
        <>
          {noAccounts && !(customerId && onAdded) && (
            <p className="text-xs text-amber-600">No bank account on file for this customer — add one on the Customers page, or refund in cash.</p>
          )}
          {noAccounts && customerId && onAdded && !adding && <p className="mb-1.5 text-xs text-amber-600">No bank details on file for this customer yet.</p>}
          {accounts.length > 0 && (
            <div className="space-y-1.5">
              {accounts.map((a) => (
                <label
                  key={a.id}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                    String(a.id) === accountId ? "border-black bg-gray-50" : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <input type="radio" name={name} checked={String(a.id) === accountId} onChange={() => onAccount(String(a.id))} className="mt-0.5" />
                  <span>
                    <span className="font-medium text-gray-900">
                      {a.bank_name} {a.is_default === 1 && <span className="text-xs font-normal text-green-600">(default)</span>}
                    </span>
                    <span className="block text-xs text-gray-500">
                      {a.account_name} — {a.account_number}
                      {a.branch ? ` — ${a.branch}` : ""}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {customerId && onAdded && !adding && (
            <button type="button" onClick={() => setAdding(true)} className="mt-1.5 text-xs text-gray-600 underline hover:text-gray-900">
              + Add bank details
            </button>
          )}
          {customerId && onAdded && adding && (
            <AddBankAccount
              customerId={customerId}
              makeDefault={noAccounts}
              onCancel={() => setAdding(false)}
              onSaved={(account) => {
                setAdding(false);
                onAdded(account);
              }}
            />
          )}
        </>
      )}
    </FormGroup>
  );
}

// The customer's bank details, saved to their record (so they're there next time too).
function AddBankAccount({ customerId, makeDefault, onCancel, onSaved }: { customerId: number; makeDefault: boolean; onCancel: () => void; onSaved: (a: BankAccount) => void }) {
  const [bank, setBank] = useState("");
  const [holder, setHolder] = useState("");
  const [number, setNumber] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [bank, holder, number]);

  async function save() {
    if (!bank.trim() || !holder.trim() || !number.trim()) {
      setError("Bank, account holder and account number are all needed.");
      return;
    }
    setBusy(true);
    try {
      const created = await api.post<BankAccount>(`/customers/${customerId}/bank-accounts`, {
        bank_name: bank.trim(),
        account_name: holder.trim(),
        account_number: number.trim(),
        ...(branch.trim() ? { branch: branch.trim() } : {}),
        is_default: makeDefault,
      });
      onSaved(created);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't save the bank details");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-2 rounded-xl border border-gray-200 bg-gray-50/70 p-3">
      <div className="grid grid-cols-2 gap-2">
        <Input placeholder="Bank" value={bank} onChange={(e) => setBank(e.target.value)} />
        <Input placeholder="Branch (optional)" value={branch} onChange={(e) => setBranch(e.target.value)} />
      </div>
      <Input placeholder="Account holder name" value={holder} onChange={(e) => setHolder(e.target.value)} />
      <Input placeholder="Account number" value={number} onChange={(e) => setNumber(e.target.value)} />
      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save bank details"}
        </Button>
        <Button size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
