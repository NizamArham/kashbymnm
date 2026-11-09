import { useEffect, useMemo, useState } from "react";
import { Package } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { formatDate } from "../lib/dates";
import { useAdminApproval } from "../components/AdminApproval";
import { useToast } from "../components/Feedback";
import { PageLoader } from "../components/Loader";
import { Badge, Button, Card, Dropdown, EmptyState, ErrorText, FormGroup, Input, Label, Modal, PageHeader, RefLink } from "../components/ui";

// Pieces sold at the till that weren't in stock. Each one stays here until it's settled with its supplier — paid for, or (when the
// customer gave it back) returned to them. They are grouped by supplier, identical pieces are one line, and a supplier is settled in
// one go: nothing has to be closed before the day ends.
interface OpenItem {
  id: number;
  sku: string;
  size: string | null;
  color: string | null;
  status: string;
  cost_price: number | null;
  selling_price: number | null;
  product_title: string;
  purchase_code: string;
  supplier_id: number;
  supplier_name: string;
  sale_id: number | null;
  invoice: string | null;
  sale_date: string | null;
}

// Identical pieces (same name, colour, size, cost, price and whether the customer still has it) shown as one line.
interface Line {
  key: string;
  title: string;
  variant: string;
  back: boolean; // the customer gave it back — it is with us again
  cost: number;
  price: number;
  ids: number[];
  invoices: { id: number | null; invoice: string }[];
  date: string | null;
}

interface Group {
  supplierId: number;
  name: string;
  lines: Line[];
}

type Settling = { kind: "paid" | "returned"; group: Group; lines: Line[] } | null;

const money = (n: number) => `Rs. ${n.toLocaleString()}`;
const sum = (lines: Line[], pick: (l: Line) => number) => lines.reduce((total, l) => total + pick(l) * l.ids.length, 0);
const count = (lines: Line[]) => lines.reduce((total, l) => total + l.ids.length, 0);
const pieces = (n: number) => `${n} piece${n === 1 ? "" : "s"}`;

function groupBySupplier(items: OpenItem[]): Group[] {
  const groups = new Map<number, Group>();
  for (const item of items) {
    let group = groups.get(item.supplier_id);
    if (!group) groups.set(item.supplier_id, (group = { supplierId: item.supplier_id, name: item.supplier_name, lines: [] }));
    const back = item.status === "removed";
    const variant = [item.color, item.size].filter(Boolean).join(" / ");
    const key = [item.product_title, variant, item.cost_price ?? 0, item.selling_price ?? 0, back ? "back" : "kept"].join("|");
    let line = group.lines.find((l) => l.key === key);
    if (!line) {
      line = { key, title: item.product_title, variant, back, cost: item.cost_price ?? 0, price: item.selling_price ?? 0, ids: [], invoices: [], date: item.sale_date };
      group.lines.push(line);
    }
    line.ids.push(item.id);
    if (item.invoice && !line.invoices.some((i) => i.invoice === item.invoice)) line.invoices.push({ id: item.sale_id, invoice: item.invoice });
    if (item.sale_date && (!line.date || item.sale_date < line.date)) line.date = item.sale_date;
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export default function BorrowedItemsPage() {
  const { runWithApproval } = useAdminApproval();
  const toast = useToast();
  const [items, setItems] = useState<OpenItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set()); // line keys, qualified by supplier
  const [settling, setSettling] = useState<Settling>(null);
  const [method, setMethod] = useState<"cash" | "card">("cash");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);

  async function load() {
    try {
      setItems(await api.get<OpenItem[]>("/manual-items/open"));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : "Couldn't load the list");
    }
  }

  useEffect(() => {
    load();
  }, []);

  const groups = useMemo(() => (items ? groupBySupplier(items) : []), [items]);
  const tickKey = (g: Group, l: Line) => `${g.supplierId}|${l.key}`;

  function toggle(g: Group, l: Line) {
    setTicked((prev) => {
      const next = new Set(prev);
      const k = tickKey(g, l);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function clearTicks(g: Group) {
    setTicked((prev) => new Set([...prev].filter((k) => !k.startsWith(`${g.supplierId}|`))));
  }

  function start(kind: "paid" | "returned", group: Group, lines: Line[]) {
    setSettling({ kind, group, lines });
    setMethod("cash");
    setNote("");
    setSettleError(null);
  }

  async function confirm() {
    if (!settling) return;
    setBusy(true);
    setSettleError(null);
    const ids = settling.lines.flatMap((l) => l.ids);
    try {
      await runWithApproval((approval) =>
        api.post(
          "/manual-items/settle-many",
          { ids, resolution: settling.kind, payment_method: settling.kind === "paid" ? method : undefined, note: note.trim() || undefined },
          { approval }
        )
      );
      toast.success(
        settling.kind === "paid"
          ? `Paid ${settling.group.name} ${money(sum(settling.lines, (l) => l.cost))} for ${pieces(ids.length)}`
          : `${pieces(ids.length)} returned to ${settling.group.name}`
      );
      clearTicks(settling.group);
      setSettling(null);
      await load();
    } catch (err) {
      setSettleError(err instanceof ApiRequestError ? err.message : "Couldn't save that — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4 lg:p-6 max-w-5xl">
      <PageHeader
        title="Not in stock"
        subtitle="Pieces sold before they were in stock. Settle each supplier: pay for the pieces the customers kept, or return the ones that came back."
      />

      {loadError && <ErrorText>{loadError}</ErrorText>}
      {!items && !loadError && <PageLoader />}

      {items && groups.length === 0 && (
        <EmptyState icon={Package} title="Nothing to settle" subtitle="Every piece sold without being in stock has been paid for or returned." />
      )}

      <div className="space-y-4">
        {groups.map((group) => {
          const kept = group.lines.filter((l) => !l.back);
          const back = group.lines.filter((l) => l.back);
          const owed = sum(kept, (l) => l.cost);
          const chosen = group.lines.filter((l) => ticked.has(tickKey(group, l)));
          const chosenOnlyBack = chosen.length > 0 && chosen.every((l) => l.back);
          return (
            <Card key={group.supplierId} className="!p-0 overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 lg:px-5 py-4 border-b border-gray-100">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-gray-900">
                    <RefLink to={`/suppliers/${group.supplierId}`}>{group.name}</RefLink>
                  </h2>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {pieces(count(group.lines))}
                    {owed > 0 && (
                      <>
                        {" · you owe "}
                        <span className="font-medium text-gray-900">{money(owed)}</span>
                        {" for what the customers kept"}
                      </>
                    )}
                    {back.length > 0 && ` · ${count(back)} back with us`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {chosen.length > 0 ? (
                    <>
                      <button type="button" onClick={() => clearTicks(group)} className="text-sm text-gray-500 hover:text-gray-900 px-2 py-1">
                        Clear
                      </button>
                      {chosenOnlyBack && (
                        <Button onClick={() => start("returned", group, chosen)}>Return {pieces(count(chosen))}</Button>
                      )}
                      <Button variant="primary" onClick={() => start("paid", group, chosen)}>
                        Pay {pieces(count(chosen))} · {money(sum(chosen, (l) => l.cost))}
                      </Button>
                    </>
                  ) : (
                    owed > 0 && (
                      <Button variant="primary" onClick={() => start("paid", group, kept)}>
                        Pay all · {money(owed)}
                      </Button>
                    )
                  )}
                </div>
              </div>

              <ul className="divide-y divide-gray-100">
                {group.lines.map((line) => {
                  const on = ticked.has(tickKey(group, line));
                  return (
                    <li key={line.key} className={`flex items-start gap-3 px-4 lg:px-5 py-3 ${on ? "bg-gray-50" : ""}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggle(group, line)}
                        aria-label={`Select ${line.title}`}
                        className="mt-1 h-4 w-4 accent-black flex-shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-900">
                          {line.title}
                          {line.variant && <span className="font-normal text-gray-500"> · {line.variant}</span>}
                          <span className="font-semibold text-gray-900"> × {line.ids.length}</span>
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Cost {money(line.cost)} each · sold for {money(line.price)}
                          {line.date ? ` · ${formatDate(line.date)}` : ""}
                          {line.invoices.length > 0 && " · "}
                          {line.invoices.slice(0, 3).map((inv, i) => (
                            <span key={inv.invoice}>
                              {i > 0 && ", "}
                              {inv.id ? <RefLink to={`/sales/${inv.id}`}>{inv.invoice}</RefLink> : inv.invoice}
                            </span>
                          ))}
                          {line.invoices.length > 3 && ` +${line.invoices.length - 3} more`}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                        <span className="text-sm font-medium text-gray-900 tabular-nums">{money(line.cost * line.ids.length)}</span>
                        {line.back ? (
                          <>
                            <Badge label="Back with us" />
                            <button
                              type="button"
                              onClick={() => start("returned", group, [line])}
                              className="text-xs font-medium text-gray-700 underline underline-offset-2 hover:text-gray-900"
                            >
                              Return to supplier
                            </button>
                          </>
                        ) : (
                          <Badge label="With customer" />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          );
        })}
      </div>

      {settling && (
        <Modal
          title={settling.kind === "paid" ? `Pay ${settling.group.name}` : `Return to ${settling.group.name}`}
          subtitle={
            settling.kind === "paid"
              ? `${pieces(count(settling.lines))} · ${money(sum(settling.lines, (l) => l.cost))}`
              : `${pieces(count(settling.lines))} go back to the supplier`
          }
          onClose={() => !busy && setSettling(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button onClick={() => setSettling(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" onClick={confirm} disabled={busy}>
                {busy ? "Saving..." : settling.kind === "paid" ? `Record payment · ${money(sum(settling.lines, (l) => l.cost))}` : "Record return"}
              </Button>
            </div>
          }
        >
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 mb-4">
            {settling.lines.map((l) => (
              <li key={l.key} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 text-gray-900">
                  {l.title}
                  {l.variant && <span className="text-gray-500"> · {l.variant}</span>}
                  <span className="font-medium"> × {l.ids.length}</span>
                </span>
                <span className="text-gray-700 tabular-nums flex-shrink-0">{money(l.cost * l.ids.length)}</span>
              </li>
            ))}
          </ul>
          <div className="space-y-3">
            {settling.kind === "paid" && (
              <FormGroup>
                <Label>How was the supplier paid?</Label>
                <Dropdown
                  value={method}
                  onChange={(v) => setMethod(v as "cash" | "card")}
                  options={[
                    { value: "cash", label: "Cash" },
                    { value: "card", label: "Card" },
                  ]}
                />
              </FormGroup>
            )}
            <FormGroup>
              <Label>Note (optional)</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </FormGroup>
            {settleError && <ErrorText>{settleError}</ErrorText>}
          </div>
        </Modal>
      )}
    </div>
  );
}
