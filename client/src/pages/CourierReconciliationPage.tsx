import { FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Banknote, CheckCircle2, CircleDollarSign, FileText, History, Truck } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { CourierReconciliationOrder, CourierSettlement } from "../lib/types";
import { useDeliveryPartners, partnerLabel } from "../lib/delivery";
import { Button, Card, DatePicker, Dropdown, ErrorText, FormGroup, HelpHint, Input, Label, PageHeader, Table, Td, Th, RefLink } from "../components/ui";

type Summary = { courier_partner: string; cod_collected: number; courier_charges: number; expected_net: number; delivered_orders: number };
type ReconciliationData = { summary: Summary[]; settlements: CourierSettlement[]; orders: CourierReconciliationOrder[] };
const money = (value: number) => `Rs. ${value.toLocaleString()}`;

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function CourierReconciliationPage() {
  const navigate = useNavigate();
  const { partners } = useDeliveryPartners();
  const [data, setData] = useState<ReconciliationData>({ summary: [], settlements: [], orders: [] });
  const [partner, setPartner] = useState("CPAK");
  const [weekStart, setWeekStart] = useState("");
  const [weekEnd, setWeekEnd] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    try { setData(await api.get<ReconciliationData>("/courier-reconciliation")); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : "Failed to load reconciliation"); }
  }
  useEffect(() => { load(); }, []);

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

  const balances = useMemo(() => data.summary.map((summary) => {
    const settled = data.settlements.filter((item) => item.courier_partner === summary.courier_partner).reduce((total, item) => total + item.amount_received, 0);
    return { ...summary, balance: summary.expected_net - settled };
  }), [data]);

  // A fixed last-7-days glance, right where the balances are — no date
  // picker or download here, that's what the full history page is for.
  const recentOrders = useMemo(() => {
    const start = addDaysIso(todayIso(), -6);
    return data.orders.filter((order) => order.sale_date.slice(0, 10) >= start);
  }, [data.orders]);

  async function addSettlement(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!weekStart || !weekEnd || !amount) { setError("Week dates and amount received are required."); return; }
    setSaving(true);
    try {
      await api.post("/courier-reconciliation/settlements", { courier_partner: partner, week_start: weekStart, week_end: weekEnd, amount_received: Number(amount), notes: notes.trim() || undefined });
      setAmount(""); setNotes(""); load();
    } catch (err) { setError(err instanceof ApiRequestError ? err.message : "Failed to record settlement"); }
    finally { setSaving(false); }
  }

  return <div>
    <PageHeader
      title="Settlements"
      subtitle="Track COD collected, courier charges, weekly settlements, and carry-forward balances."
      action={<Button onClick={() => navigate("/couriers/history")} className="inline-flex items-center gap-1.5"><History size={14} />Order history</Button>}
    />
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
      {balances.map((item) => <Card key={item.courier_partner} className="p-4"><div className="flex items-center justify-between"><p className="text-sm font-semibold text-gray-900">{partnerLabel(item.courier_partner)}</p><Truck size={16} className="text-gray-400" /></div><p className="text-xs text-gray-400 mt-3">{item.balance >= 0 ? "Balance due" : "Credit"}</p><p className={`text-2xl font-bold ${item.balance >= 0 ? "text-amber-600" : "text-black-600"}`}>{money(Math.abs(item.balance))}</p><div className="mt-2 text-xs text-gray-400">Expected net owed: {money(item.expected_net)}</div></Card>)}
      {balances.length === 0 && <Card className="p-4 md:col-span-3"><p className="text-sm text-gray-400">No dispatched courier orders yet.</p></Card>}
    </div>
    <div className="grid grid-cols-1 xl:grid-cols-[1.5fr_1fr] gap-5">
      <Card className="p-0 overflow-hidden">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          <h2 className="font-semibold text-gray-900">This week's orders<HelpHint text="A quick glance at the last 7 days. For older orders, date filtering, or a downloadable report per courier, use Order history above." /></h2>
          <button onClick={() => navigate("/couriers/history")} className="text-xs text-gray-500 hover:text-gray-800 underline">View full history</button>
        </div>
        {recentOrders.length === 0 ? <p className="p-5 text-sm text-gray-400">No courier orders in the last 7 days.</p> : <Table><thead><tr><Th>Order</Th><Th>Courier</Th><Th>Status</Th><Th>COD</Th><Th>Charge</Th><Th>Net</Th></tr></thead><tbody>{recentOrders.map((order) => <tr key={order.id}><Td><span className="font-medium"><RefLink to={`/sales/${order.sale_id}`}>{order.invoice}</RefLink></span><span className="block text-xs text-gray-400">{order.customer_name ?? "Walk-in"}</span></Td><Td>{partnerLabel(order.courier_partner)}</Td><Td><span className="inline-flex items-center gap-1 text-xs capitalize"><CheckCircle2 size={12} className={order.delivery_status === "delivered" ? "text-green-600" : "text-gray-400"} />{order.delivery_status}</span></Td><Td>{order.delivery_status === "delivered" ? money(order.cod_amount) : <span className="line-through text-gray-400">{money(order.cod_amount)}</span>}</Td><Td>{money(order.courier_charge + order.return_charge)}</Td><Td className="font-semibold">{money((order.delivery_status === "delivered" ? order.cod_amount : 0) - order.courier_charge - order.return_charge)}</Td></tr>)}</tbody></Table>}
      </Card>
      <Card><div className="flex items-center gap-2 mb-4"><Banknote size={18} className="text-gray-600" /><div><h2 className="font-semibold text-gray-900">Record settlement<HelpHint text="The period defaults to since your last recorded settlement, up to today — adjust it only if it needs to match their report exactly." /></h2></div></div><form onSubmit={addSettlement} className="space-y-3"><FormGroup><Label>Courier partner</Label><Dropdown value={partner} onChange={setPartner} options={partners.filter((p) => p.kind === "courier").map((p) => ({ value: p.code, label: p.name }))} /></FormGroup><div className="grid grid-cols-2 gap-3"><FormGroup><Label>Week starts</Label><DatePicker value={weekStart} onChange={setWeekStart} /></FormGroup><FormGroup><Label>Week ends</Label><DatePicker value={weekEnd} onChange={setWeekEnd} /></FormGroup></div><FormGroup><Label>Amount received (Rs.)</Label><Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" className="text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" /></FormGroup><FormGroup><Label>Notes</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></FormGroup>{error && <ErrorText>{error}</ErrorText>}<Button type="submit" variant="primary" disabled={saving}><CircleDollarSign size={14} /> {saving ? "Saving..." : "Record settlement"}</Button></form><div className="mt-5 pt-4 border-t border-gray-100"><h3 className="text-sm font-semibold text-gray-900 mb-2"><FileText size={14} className="inline mr-1" /> Settlement history</h3>{data.settlements.slice(0, 6).map((settlement) => <div key={settlement.id} className="flex justify-between py-2 text-xs border-b border-gray-50"><span>{partnerLabel(settlement.courier_partner)}<span className="block text-gray-400">{settlement.week_start} to {settlement.week_end}</span></span><span className="font-medium">{money(settlement.amount_received)}</span></div>)}</div></Card>
    </div>
  </div>;
}
