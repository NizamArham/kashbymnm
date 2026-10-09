import { FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Banknote, Check, CircleDollarSign, FileText, History, Pencil, Trash2, Truck } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { CourierReconciliationData, CourierReconciliationOrder, CourierSummary } from "../lib/types";
import { useDeliveryPartners, partnerLabel } from "../lib/delivery";
import CourierChargeModal from "../components/CourierChargeModal";
import CourierBalanceModal from "../components/CourierBalanceModal";
import { Button, Card, DatePicker, Dropdown, ErrorText, FormGroup, HelpHint, Input, Label, PageHeader, RefLink, Table, TabToggle, Td, Th } from "../components/ui";

const money = (value: number) => `Rs. ${value.toLocaleString()}`;
const signed = (value: number) => `${value > 0 ? "+" : "−"} ${money(Math.abs(value))}`;

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// A charge only counts once the courier has the parcel back or delivered.
const countsTowardBalance = (order: CourierReconciliationOrder) => order.delivery_status === "delivered" || order.delivery_status === "returned";

type View = "week" | "check";
type ReceivedAs = "" | "cash" | "bank_transfer";

// CityPak and Fardar pay into the bank; our own rider hands the cash over. Any other
// courier has no habit to assume, so it starts empty and has to be chosen.
function defaultReceivedAs(partnerCode: string): ReceivedAs {
  if (partnerCode === "CPAK" || partnerCode === "FDR") return "bank_transfer";
  if (partnerCode === "D2D") return "cash";
  return "";
}

export default function CourierReconciliationPage() {
  const navigate = useNavigate();
  const { partners } = useDeliveryPartners();
  const [data, setData] = useState<CourierReconciliationData>({ summary: [], settlements: [], adjustments: [], orders: [] });
  const [partner, setPartner] = useState("CPAK");
  const [weekStart, setWeekStart] = useState("");
  const [weekEnd, setWeekEnd] = useState("");
  const [amount, setAmount] = useState("");
  const [receivedAs, setReceivedAs] = useState<ReceivedAs>(defaultReceivedAs("CPAK"));
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<View>("week");
  const [editingOrder, setEditingOrder] = useState<CourierReconciliationOrder | null>(null);
  const [correcting, setCorrecting] = useState<CourierSummary | null>(null);

  async function load() {
    try {
      setData(await api.get<CourierReconciliationData>("/courier-reconciliation"));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load reconciliation");
    }
  }
  useEffect(() => {
    load();
  }, []);

  // Defaults the settlement period to "since the last one I recorded for
  // this courier, up to today" — so the common case is just typing the
  // amount, while the period still gets logged for checking against
  // their own weekly report later. Only recomputes when the courier or
  // the settlement history changes, so it won't fight manual edits.
  useEffect(() => {
    const priorEnds = data.settlements.filter((s) => s.courier_partner === partner).map((s) => s.week_end);
    const lastEnd = priorEnds.length > 0 ? priorEnds.reduce((latest, end) => (end > latest ? end : latest)) : null;
    setWeekStart(lastEnd ? addDaysIso(lastEnd, 1) : "");
    setWeekEnd(todayIso());
  }, [partner, data.settlements]);

  // Picking another courier resets how it's usually paid — only on a change of
  // courier, so a choice made by hand isn't undone when the history reloads.
  useEffect(() => {
    setReceivedAs(defaultReceivedAs(partner));
  }, [partner]);

  // A fixed last-7-days glance — no date picker or download here, that's what
  // the full history page is for.
  const recentOrders = useMemo(() => {
    const start = addDaysIso(todayIso(), -6);
    return data.orders.filter((order) => order.sale_date.slice(0, 10) >= start);
  }, [data.orders]);

  // Every delivered/returned order whose charge is still the system's estimate,
  // whatever its date — these are the numbers that could be wrong.
  const needsChecking = useMemo(() => data.orders.filter((order) => countsTowardBalance(order) && !order.charge_confirmed), [data.orders]);
  const shownOrders = view === "check" ? needsChecking : recentOrders;

  async function addSettlement(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!weekStart || !weekEnd || !amount) {
      setError("Week dates and amount received are required.");
      return;
    }
    if (!receivedAs) {
      setError("Choose how it was received — bank transfer or cash.");
      return;
    }
    setSaving(true);
    try {
      await api.post("/courier-reconciliation/settlements", {
        courier_partner: partner,
        week_start: weekStart,
        week_end: weekEnd,
        amount_received: Number(amount),
        payment_method: receivedAs,
        notes: notes.trim() || undefined,
      });
      setAmount("");
      setNotes("");
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to record settlement");
    } finally {
      setSaving(false);
    }
  }

  async function confirmCharges(orders: CourierReconciliationOrder[]) {
    setError(null);
    try {
      await api.post("/courier-reconciliation/orders/confirm", { ids: orders.map((o) => o.id) });
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't confirm — try again");
    }
  }

  async function undoAdjustment(id: number) {
    if (!window.confirm("Undo this correction? The balance goes back to what the orders and settlements say.")) return;
    setError(null);
    try {
      await api.delete(`/courier-reconciliation/adjustments/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't undo — try again");
    }
  }

  return (
    <div>
      <PageHeader
        title="Settlements"
        subtitle="Track COD collected, courier charges, weekly settlements, and carry-forward balances."
        action={
          <Button onClick={() => navigate("/couriers/history")} className="inline-flex items-center gap-1.5">
            <History size={14} />
            Order history
          </Button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
        {data.summary.map((item) => (
          <Card key={item.courier_partner} className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-gray-900">{partnerLabel(item.courier_partner)}</p>
              <Truck size={16} className="text-gray-400" />
            </div>
            <p className="text-xs text-gray-400 mt-3">{item.balance > 0 ? "Balance due" : item.balance < 0 ? "Credit — you owe them" : "Settled"}</p>
            <p className="text-2xl font-bold text-gray-900 tabular-nums">{money(Math.abs(item.balance))}</p>
            <dl className="mt-2.5 space-y-0.5 text-xs text-gray-400">
              <div className="flex justify-between">
                <dt>Expected net owed</dt>
                <dd className="tabular-nums">{money(item.expected_net)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Already received</dt>
                <dd className="tabular-nums">− {money(item.settled_total)}</dd>
              </div>
              {item.adjustments_total !== 0 && (
                <div className="flex justify-between text-gray-600">
                  <dt>Corrections</dt>
                  <dd className="tabular-nums">{signed(item.adjustments_total)}</dd>
                </div>
              )}
            </dl>
            <div className="mt-3 flex items-center justify-between gap-2">
              <Button size="sm" onClick={() => setCorrecting(item)} title="Fix this balance if it doesn't match the courier's statement">
                Correct balance
              </Button>
              {item.estimated_orders > 0 && (
                <button
                  type="button"
                  onClick={() => setView("check")}
                  className="text-xs text-gray-500 hover:text-gray-900 underline decoration-dotted"
                  title="These charges are the system's estimate, not yet checked against the courier's bill"
                >
                  {item.estimated_orders} estimated charge{item.estimated_orders === 1 ? "" : "s"}
                </button>
              )}
            </div>
          </Card>
        ))}
        {data.summary.length === 0 && (
          <Card className="p-4 md:col-span-3">
            <p className="text-sm text-gray-400">No dispatched courier orders yet.</p>
          </Card>
        )}
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      <div className="grid grid-cols-1 xl:grid-cols-[1.5fr_1fr] gap-5">
        <Card className="p-0 overflow-hidden">
          <div className="p-4 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
            <h2 className="font-semibold text-gray-900">
              Courier orders
              <HelpHint text="Each charge starts as the tariff's estimate for the weight entered at dispatch. Tap a charge to enter what the courier really billed (and the real weight), or confirm the estimate if it was right. 'Needs checking' lists every delivered or returned order that is still an estimate. For older orders or a downloadable report per courier, use Order history." />
            </h2>
            <div className="flex items-center gap-3">
              <TabToggle<View>
                value={view}
                onChange={setView}
                options={[
                  { value: "week", label: "This week" },
                  { value: "check", label: `Needs checking (${needsChecking.length})` },
                ]}
              />
              <button onClick={() => navigate("/couriers/history")} className="text-xs text-gray-500 hover:text-gray-800 underline">
                View full history
              </button>
            </div>
          </div>

          {view === "check" && needsChecking.length > 0 && (
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between gap-3 flex-wrap">
              <p className="text-xs text-gray-600 max-w-md">
                These charges are still the system's estimate. Open one to enter what the courier really billed — or confirm them all if the courier's bill matches.
              </p>
              <Button
                size="sm"
                onClick={() => {
                  if (window.confirm(`Mark all ${needsChecking.length} charges as correct?`)) confirmCharges(needsChecking);
                }}
                className="inline-flex items-center gap-1.5"
              >
                <Check size={14} />
                Confirm all {needsChecking.length}
              </Button>
            </div>
          )}

          {shownOrders.length === 0 ? (
            <p className="p-5 text-sm text-gray-400">{view === "check" ? "Every charge has been checked." : "No courier orders in the last 7 days."}</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Order</Th>
                  <Th>Courier</Th>
                  <Th>Status</Th>
                  <Th>COD</Th>
                  {/* Every row in "Needs checking" is still an estimate, so the column says so once, here, instead of a badge on each row. */}
                  <Th>{view === "check" ? "Estimate charge" : "Charge"}</Th>
                  <Th>Net</Th>
                  <Th>{null}</Th>
                </tr>
              </thead>
              <tbody>
                {shownOrders.map((order) => {
                  const totalCharge = order.courier_charge + order.return_charge;
                  const weight = order.actual_weight_kg ?? order.package_weight_kg;
                  return (
                    <tr key={order.id}>
                      <Td>
                        <span className="font-medium">
                          <RefLink to={`/sales/${order.sale_id}`}>{order.invoice}</RefLink>
                        </span>
                        <span className="block text-xs text-gray-400">{order.customer_name ?? "Walk-in"}</span>
                      </Td>
                      <Td>{partnerLabel(order.courier_partner)}</Td>
                      <Td>
                        <span className="inline-flex items-center gap-1 text-xs capitalize">
                          <Check size={12} className={order.delivery_status === "delivered" ? "text-gray-900" : "text-gray-300"} />
                          {order.delivery_status}
                        </span>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {order.delivery_status === "delivered" ? money(order.cod_amount) : <span className="line-through text-gray-400">{money(order.cod_amount)}</span>}
                      </Td>
                      <Td className="whitespace-nowrap">
                        <button
                          onClick={() => setEditingOrder(order)}
                          className="text-gray-900 hover:text-black underline decoration-dotted tabular-nums"
                          title="Enter what the courier really charged"
                        >
                          {money(totalCharge)}
                        </button>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-400">
                          {order.charge_confirmed ? (
                            <span className="inline-flex items-center gap-0.5 text-gray-500">
                              <Check size={12} />
                              confirmed
                            </span>
                          ) : null}
                          {weight ? <span>{weight} kg</span> : null}
                        </div>
                        {order.charge_confirmed === 1 && order.estimated_charge !== null && order.estimated_charge !== order.courier_charge && (
                          <div className="text-[11px] text-gray-400">estimate was {money(order.estimated_charge)}</div>
                        )}
                      </Td>
                      <Td className="font-semibold tabular-nums whitespace-nowrap">{money((order.delivery_status === "delivered" ? order.cod_amount : 0) - totalCharge)}</Td>
                      <Td className="text-right">
                        {/* Plain icons, no border — the same look as the edit pencil in the Cash Book. */}
                        <div className="inline-flex items-center justify-end gap-3">
                          {countsTowardBalance(order) && !order.charge_confirmed && (
                            <button
                              type="button"
                              onClick={() => confirmCharges([order])}
                              className="text-gray-400 hover:text-gray-800 transition"
                              title="The estimate is right"
                              aria-label="The estimate is right"
                            >
                              <Check size={14} />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setEditingOrder(order)}
                            className="text-gray-400 hover:text-gray-800 transition"
                            title="Enter the real charge / weight"
                            aria-label="Enter the real charge / weight"
                          >
                            <Pencil size={14} />
                          </button>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Banknote size={18} className="text-gray-600" />
            <div>
              <h2 className="font-semibold text-gray-900">
                Record settlement
                <HelpHint text="The period defaults to since your last recorded settlement, up to today — adjust it only if it needs to match their report exactly." />
              </h2>
            </div>
          </div>
          <form onSubmit={addSettlement} className="space-y-3">
            <FormGroup>
              <Label>Courier partner</Label>
              <Dropdown
                value={partner}
                onChange={setPartner}
                options={partners.filter((p) => p.kind === "courier").map((p) => ({ value: p.code, label: p.name }))}
              />
            </FormGroup>
            <div className="grid grid-cols-2 gap-3">
              <FormGroup>
                <Label>Week starts</Label>
                <DatePicker value={weekStart} onChange={setWeekStart} />
              </FormGroup>
              <FormGroup>
                <Label>Week ends</Label>
                <DatePicker value={weekEnd} onChange={setWeekEnd} />
              </FormGroup>
            </div>
            <FormGroup>
              <Label>Amount received (Rs.)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                className="text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </FormGroup>
            <FormGroup>
              <Label>
                Received as
                <HelpHint text="Where the money landed. The Cash Book uses it to tell the bank balance from cash in hand, so it has to be set." />
              </Label>
              <TabToggle<ReceivedAs>
                value={receivedAs}
                onChange={setReceivedAs}
                options={[
                  { value: "bank_transfer", label: "Bank transfer" },
                  { value: "cash", label: "Cash" },
                ]}
              />
            </FormGroup>
            <FormGroup>
              <Label>Notes</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </FormGroup>
            <Button type="submit" variant="primary" disabled={saving}>
              <CircleDollarSign size={14} /> {saving ? "Saving..." : "Record settlement"}
            </Button>
          </form>

          <div className="mt-5 pt-4 border-t border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900 mb-2">
              <FileText size={14} className="inline mr-1" /> Settlement history
            </h3>
            {data.settlements.slice(0, 6).map((settlement) => (
              <div key={settlement.id} className="flex justify-between py-2 text-xs border-b border-gray-50">
                <span>
                  {partnerLabel(settlement.courier_partner)}
                  <span className="block text-gray-400">
                    {settlement.week_start} to {settlement.week_end}
                  </span>
                </span>
                <span className="font-medium">{money(settlement.amount_received)}</span>
              </div>
            ))}
          </div>

          {data.adjustments.length > 0 && (
            <div className="mt-5 pt-4 border-t border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Balance corrections</h3>
              {data.adjustments.slice(0, 6).map((adjustment) => (
                <div key={adjustment.id} className="flex items-start justify-between gap-3 py-2 text-xs border-b border-gray-50">
                  <span className="min-w-0">
                    {partnerLabel(adjustment.courier_partner)}
                    <span className="block text-gray-500 truncate" title={adjustment.reason}>
                      {adjustment.reason}
                    </span>
                    <span className="block text-gray-400">
                      {adjustment.created_at.slice(0, 10)}
                      {adjustment.staff_name ? ` · ${adjustment.staff_name}` : ""}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 flex-shrink-0">
                    <span className="font-medium tabular-nums">{signed(adjustment.amount)}</span>
                    <button onClick={() => undoAdjustment(adjustment.id)} className="text-gray-400 hover:text-red-600" title="Undo this correction" aria-label="Undo this correction">
                      <Trash2 size={12} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {editingOrder && <CourierChargeModal order={editingOrder} onClose={() => setEditingOrder(null)} onSaved={load} />}
      {correcting && <CourierBalanceModal courier={correcting} onClose={() => setCorrecting(null)} onSaved={load} />}
    </div>
  );
}
