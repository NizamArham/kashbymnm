import { ReactNode } from "react";
import { Label } from "./ui";

// What became of an item that was supposed to come back to the shop. "OK" needs no one's say-so; "Damaged" and "Missing item" change what
// is owed, so confirming them asks for an admin's password (unless an admin is the one confirming).
export type Outcome = "clean" | "damaged" | "not_returned";

export const OUTCOME_LABEL: Record<Outcome, string> = { clean: "OK", damaged: "Damaged", not_returned: "Missing item" };

export const allOk = (outcomes: Record<number, Outcome>) => Object.values(outcomes).every((o) => o === "clean");

export interface ArrivalItem {
  id: number;
  name: ReactNode;
  // Shown beside the name — usually the price.
  detail?: ReactNode;
  // What it means for this item if it turns out to be missing (shown under the row when that is picked).
  missingNote?: string;
}

export default function ArrivalChoice({
  items,
  outcomes,
  onChange,
}: {
  items: ArrivalItem[];
  outcomes: Record<number, Outcome>;
  onChange: (next: Record<number, Outcome>) => void;
}) {
  const everythingOk = allOk(outcomes);
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <Label>What came back?</Label>
        {items.length > 1 && !everythingOk && (
          <button
            type="button"
            onClick={() => onChange(Object.fromEntries(items.map((i) => [i.id, "clean" as Outcome])))}
            className="text-xs text-gray-500 underline hover:text-gray-800"
          >
            All OK
          </button>
        )}
      </div>
      <div className="space-y-2">
        {items.map((i) => {
          const chosen = outcomes[i.id] ?? "clean";
          return (
            <div key={i.id} className="rounded-xl border border-gray-200 px-3 py-2.5">
              <p className="text-sm text-gray-900">
                {i.name} {i.detail && <span className="text-xs text-gray-400">{i.detail}</span>}
              </p>
              <div className="mt-2 grid grid-cols-3 gap-1.5">
                {(Object.keys(OUTCOME_LABEL) as Outcome[]).map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => onChange({ ...outcomes, [i.id]: o })}
                    className={`rounded-lg border px-2 py-1.5 text-sm font-medium transition ${
                      chosen === o ? "border-black bg-black text-white" : "border-gray-200 bg-white text-gray-600 hover:border-gray-400"
                    }`}
                  >
                    {OUTCOME_LABEL[o]}
                  </button>
                ))}
              </div>
              {chosen === "clean" && <p className="mt-1.5 text-xs text-gray-400">Goes back on the shelf.</p>}
              {chosen === "damaged" && <p className="mt-1.5 text-xs text-gray-400">Recorded as damaged — it isn't put back for sale.</p>}
              {chosen === "not_returned" && <p className="mt-1.5 text-xs text-gray-400">{i.missingNote ?? "Nothing came back for this one."}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The line shown when a choice needs an admin's password and the person confirming isn't an admin.
export function PasswordNote({ show }: { show: boolean }) {
  if (!show) return null;
  return <p className="mt-3 text-xs text-gray-500">A damaged or missing item needs an admin's password — you'll be asked for it when you confirm.</p>;
}
