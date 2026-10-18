import { ReactNode } from "react";
import { Check, X } from "lucide-react";
import { Input, Label } from "./ui";

// What came back, item by item — as simple as it gets: a tick for good, a cross for bad (black and white like the rest of the app — the mark
// that is filled in is the answer), and a word on why if there is one to say. A bad item changes what
// is owed, so confirming one asks for an admin's password (unless an admin is the one confirming).
export type Condition = "good" | "bad";

export interface ArrivalState {
  condition: Record<number, Condition>;
  reason: Record<number, string>;
}

export const startGood = (ids: number[]): ArrivalState => ({ condition: Object.fromEntries(ids.map((id) => [id, "good" as Condition])), reason: {} });

export const allGood = (state: ArrivalState) => Object.values(state.condition).every((c) => c === "good");

export interface ArrivalItem {
  id: number;
  name: ReactNode;
  // Shown beside the name — usually the price.
  detail?: ReactNode;
  // What "bad" means for this item, shown under the row when it is picked.
  badNote?: string;
}

export default function ArrivalChoice({ items, state, onChange }: { items: ArrivalItem[]; state: ArrivalState; onChange: (next: ArrivalState) => void }) {
  const everythingGood = allGood(state);
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <Label>What came back?</Label>
        {items.length > 1 && !everythingGood && (
          <button type="button" onClick={() => onChange(startGood(items.map((i) => i.id)))} className="text-xs text-gray-500 underline hover:text-gray-800">
            All good
          </button>
        )}
      </div>
      <div className="space-y-2">
        {items.map((i) => {
          const chosen = state.condition[i.id] ?? "good";
          const bad = chosen === "bad";
          const set = (c: Condition) => onChange({ ...state, condition: { ...state.condition, [i.id]: c } });
          return (
            <div key={i.id} className={`rounded-xl border px-3.5 py-2.5 transition ${bad ? "border-gray-300 bg-gray-50" : "border-gray-200 bg-white"}`}>
              <div className="flex items-center gap-3">
                <p className="min-w-0 flex-1 text-sm text-gray-900">
                  {i.name} {i.detail && <span className="text-xs text-gray-400">{i.detail}</span>}
                </p>
                <span className="text-xs font-medium text-gray-900">{bad ? "Bad" : "Good"}</span>
                {/* Two round marks: a tick for fine, a cross for something wrong. */}
                <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Condition">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!bad}
                    aria-label="Good"
                    title="Good"
                    onClick={() => set("good")}
                    className={`flex h-8 w-8 items-center justify-center rounded-full border transition ${
                      !bad ? "border-black bg-black text-white" : "border-gray-200 bg-white text-gray-300 hover:border-gray-400 hover:text-gray-600"
                    }`}
                  >
                    <Check size={16} strokeWidth={2.5} />
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={bad}
                    aria-label="Bad"
                    title="Bad"
                    onClick={() => set("bad")}
                    className={`flex h-8 w-8 items-center justify-center rounded-full border transition ${
                      bad ? "border-black bg-black text-white" : "border-gray-200 bg-white text-gray-300 hover:border-gray-400 hover:text-gray-600"
                    }`}
                  >
                    <X size={16} strokeWidth={2.5} />
                  </button>
                </div>
              </div>
              {/* A reason only when something is wrong — and even then it's optional. */}
              {bad && (
                <>
                  <Input
                    className="mt-2.5"
                    autoFocus
                    placeholder="What's wrong with it? (optional)"
                    value={state.reason[i.id] ?? ""}
                    onChange={(e) => onChange({ ...state, reason: { ...state.reason, [i.id]: e.target.value } })}
                    aria-label="What's wrong with it? (optional)"
                  />
                  {i.badNote && <p className="mt-1.5 text-xs text-gray-500">{i.badNote}</p>}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The line shown when a bad item needs an admin's password and the person confirming isn't an admin.
export function PasswordNote({ show }: { show: boolean }) {
  if (!show) return null;
  return <p className="mt-3 text-xs text-gray-500">A bad item needs an admin's password — you'll be asked for it when you confirm.</p>;
}
