import { FormEvent, useEffect, useMemo, useState } from "react";
import { Banknote, CheckCircle2, CircleDollarSign, FileText, Truck } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { CourierReconciliationOrder, CourierSettlement } from "../lib/types";
import { Button, Card, DatePicker, Dropdown, ErrorText, FormGroup, Input, Label, PageHeader, Table, Td, Th } from "../components/ui";

type Summary = { courier_partner: string; cod_collected: number; courier_charges: number; expected_net: number; delivered_orders: number };
type ReconciliationData = { summary: Summary[]; settlements: CourierSettlement[]; orders: CourierReconciliationOrder[] };
const labels: Record<string, string> = { CPAK: "CityPak", DEX: "DEX", D2D: "Own delivery" };
const money = (value: number) => `Rs. ${value.toLocaleString()}`;

export default function CourierReconciliationPage() {
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

  const balances = useMemo(() => data.summary.map((summary) => {
    const settled = data.settlements.filter((item) => item.courier_partner === summary.courier_partner).reduce((total, item) => total + item.amount_received, 0);
    return { ...summary, balance: summary.expected_net - settled };
  }), [data]);

  async function saveCharge(order: CourierReconciliationOrder) {
    const value = window.prompt("Courier charge (Rs.)", String(order.courier_charge));
    if (value === null) return;
    const charge = Number(value);
    if (!Number.isFinite(charge) || charge < 0) return;
    await api.post(`/courier-reconciliation/orders/${order.id}`, { courier_charge: charge });
    load();
  }

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
    <PageHeader title="Settlements" subtitle="Track COD collected, courier charges, weekly settlements, and carry-forward balances." />
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
      {balances.map((item) => <Card key={item.courier_partner} className="p-4"><div className="flex items-center justify-between"><p className="text-sm font-semibold text-gray-900">{labels[item.courier_partner] ?? item.courier_partner}</p><Truck size={17} className="text-gray-400" /></div><p className="text-xs text-gray-400 mt-3">Expected net owed</p><p className="text-xl font-bold text-gray-900">{money(item.expected_net)}</p><div className={`mt-2 text-xs font-medium ${item.balance >= 0 ? "text-amber-600" : "text-green-600"}`}>{item.balance >= 0 ? `Carry-forward due: ${money(item.balance)}` : `Credit / advance: ${money(Math.abs(item.balance))}`}</div></Card>)}
      {balances.length === 0 && <Card className="p-4 md:col-span-3"><p className="text-sm text-gray-400">No dispatched courier orders yet.</p></Card>}
    </div>
    <div className="grid grid-cols-1 xl:grid-cols-[1.5fr_1fr] gap-5">
      <Card className="p-0 overflow-hidden"><div className="p-4 border-b border-gray-100"><h2 className="font-semibold text-gray-900">Courier orders</h2><p className="text-xs text-gray-400 mt-1">Delivered COD orders become collectible; charges are deducted before settlement.</p></div>{data.orders.length === 0 ? <p className="p-5 text-sm text-gray-400">Dispatch an online order to start reconciliation.</p> : <Table><thead><tr><Th>Order</Th><Th>Courier</Th><Th>Status</Th><Th>COD</Th><Th>Charge</Th><Th>Net</Th></tr></thead><tbody>{data.orders.map((order) => <tr key={order.id}><Td><span className="font-medium">{order.invoice}</span><span className="block text-xs text-gray-400">{order.customer_name ?? "Walk-in"}</span></Td><Td>{labels[order.courier_partner] ?? order.courier_partner}</Td><Td><span className="inline-flex items-center gap-1 text-xs capitalize"><CheckCircle2 size={12} className={order.delivery_status === "delivered" ? "text-green-600" : "text-gray-400"} />{order.delivery_status}</span></Td><Td>{money(order.cod_amount)}</Td><Td><button onClick={() => saveCharge(order)} className="text-gray-700 hover:text-black underline decoration-dotted">{money(order.courier_charge)}</button></Td><Td className="font-semibold">{money(order.cod_amount - order.courier_charge)}</Td></tr>)}</tbody></Table>}</Card>
      <Card><div className="flex items-center gap-2 mb-4"><Banknote size={18} className="text-gray-600" /><div><h2 className="font-semibold text-gray-900">Record weekly settlement</h2><p className="text-xs text-gray-400">Enter the lump sum received from a courier.</p></div></div><form onSubmit={addSettlement} className="space-y-3"><FormGroup><Label>Courier partner</Label><select value={partner} onChange={(e) => setPartner(e.target.value)} className="w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm"><option value="CPAK">CityPak</option><option value="DEX">DEX</option><option value="D2D">Own delivery</option></select></FormGroup><div className="grid grid-cols-2 gap-3"><FormGroup><Label>Week starts</Label><DatePicker value={weekStart} onChange={setWeekStart} /></FormGroup><FormGroup><Label>Week ends</Label><DatePicker value={weekEnd} onChange={setWeekEnd} /></FormGroup></div><FormGroup><Label>Amount received (Rs.)</Label><Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 25000" /></FormGroup><FormGroup><Label>Notes</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Bank reference or settlement note" /></FormGroup>{error && <ErrorText>{error}</ErrorText>}<Button type="submit" variant="primary" disabled={saving}><CircleDollarSign size={15} /> {saving ? "Saving..." : "Record settlement"}</Button></form><div className="mt-5 pt-4 border-t border-gray-100"><h3 className="text-sm font-semibold text-gray-900 mb-2"><FileText size={14} className="inline mr-1" /> Settlement history</h3>{data.settlements.slice(0, 6).map((settlement) => <div key={settlement.id} className="flex justify-between py-2 text-xs border-b border-gray-50"><span>{labels[settlement.courier_partner] ?? settlement.courier_partner}<span className="block text-gray-400">{settlement.week_start} to {settlement.week_end}</span></span><span className="font-medium">{money(settlement.amount_received)}</span></div>)}</div></Card>
    </div>
  </div>;
}
