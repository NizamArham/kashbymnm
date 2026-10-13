import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Trash2 } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { CourierPaymentRecords } from "../lib/types";
import { partnerLabel, useDeliveryPartners } from "../lib/delivery";
import { useSortableData } from "../lib/useSortableData";
import { Badge, Card, DateRangePicker, Dropdown, ErrorText, HelpHint, PageHeader, SortHeader, TabToggle, Table, Td, Th } from "../components/ui";

const money = (value: number) => `Rs. ${value.toLocaleString()}`;
const signed = (value: number) => `${value > 0 ? "+" : "−"} ${money(Math.abs(value))}`;

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function monthAgoIso(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function shortDate(iso: string): string {
  const d = new Date(iso.slice(0, 10) + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

type Kind = "settlement" | "correction";
type KindFilter = "all" | Kind;
type SortKey = "date" | "courier" | "type" | "amount";

interface PaymentRow {
  key: string;
  kind: Kind;
  id: number;
  date: string; // YYYY-MM-DD
  sortStamp: string; // date + time where there is one, so same-day rows keep their order
  courier: string;
  title: string;
  detail: string | null;
  receivedAs: string | null;
  amount: number;
}

const METHOD_LABEL: Record<string, string> = { bank_transfer: "Bank transfer", cash: "Cash", card: "Card", cheque: "Cheque" };

// Every settlement a courier has paid over and every balance correction, for the whole
// history — the Couriers page only shows the latest of each. Defaults to the past month.
export default function CourierPaymentRecordsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { partners } = useDeliveryPartners();
  const [records, setRecords] = useState<CourierPaymentRecords>({ settlements: [], adjustments: [] });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>(params.get("show") === "corrections" ? "correction" : "all");
  const [courier, setCourier] = useState("");
  const [startDate, setStartDate] = useState<string | null>(() => monthAgoIso());
  const [endDate, setEndDate] = useState<string | null>(() => todayIso());

  async function load() {
    try {
      setRecords(await api.get<CourierPaymentRecords>("/courier-reconciliation/payments"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't load the payment records");
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function undoCorrection(id: number) {
    if (!window.confirm("Undo this correction? The balance goes back to what the orders and settlements say.")) return;
    try {
      await api.delete(`/courier-reconciliation/adjustments/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't undo — try again");
    }
  }

  const rows = useMemo<PaymentRow[]>(() => {
    const settlementRows: PaymentRow[] = records.settlements.map((s) => ({
      key: `s${s.id}`,
      kind: "settlement",
      id: s.id,
      date: s.received_date.slice(0, 10),
      sortStamp: s.received_date,
      courier: s.courier_partner,
      title: `${shortDate(s.week_start)} – ${shortDate(s.week_end)}`,
      detail: s.notes,
      receivedAs: s.payment_method ? METHOD_LABEL[s.payment_method] ?? s.payment_method : null,
      amount: s.amount_received,
    }));
    const correctionRows: PaymentRow[] = records.adjustments.map((a) => ({
      key: `a${a.id}`,
      kind: "correction",
      id: a.id,
      date: a.created_at.slice(0, 10),
      sortStamp: a.created_at,
      courier: a.courier_partner,
      title: a.reason,
      detail: a.staff_name ? `by ${a.staff_name}` : null,
      receivedAs: null,
      amount: a.amount,
    }));
    return [...settlementRows, ...correctionRows];
  }, [records]);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (kind !== "all" && r.kind !== kind) return false;
        if (courier && r.courier !== courier) return false;
        if (startDate && endDate && (r.date < startDate || r.date > endDate)) return false;
        return true;
      }),
    [rows, kind, courier, startDate, endDate]
  );

  const { sorted, sortKey, sortDir, toggleSort } = useSortableData<PaymentRow, SortKey>(
    filtered,
    (r, key) => (key === "date" ? r.sortStamp : key === "courier" ? partnerLabel(r.courier) : key === "type" ? r.kind : r.amount),
    "date",
    "desc"
  );

  const received = filtered.filter((r) => r.kind === "settlement").reduce((sum, r) => sum + r.amount, 0);
  const receivedCount = filtered.filter((r) => r.kind === "settlement").length;
  const corrections = filtered.filter((r) => r.kind === "correction").reduce((sum, r) => sum + r.amount, 0);
  const correctionCount = filtered.filter((r) => r.kind === "correction").length;

  const courierOptions = [{ value: "", label: "All couriers" }, ...partners.filter((p) => p.kind === "courier").map((p) => ({ value: p.code, label: p.name }))];
  const isPastMonth = startDate === monthAgoIso() && endDate === todayIso();

  return (
    <div>
      <button onClick={() => navigate("/couriers")} className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-3">
        <ArrowLeft size={14} />
        Couriers
      </button>

      <PageHeader title="Payment records" subtitle="What each courier has paid you, and every correction made to their balance." />

      {error && <ErrorText>{error}</ErrorText>}

      {/* No overflow-hidden on this card: the date picker and courier list open below their buttons and would be cut off by a short table. */}
      <Card className="p-0">
        <div className="p-4 border-b border-gray-100 space-y-3">
          <div className="flex flex-col items-start lg:flex-row lg:items-center lg:justify-between gap-3">
            <TabToggle<KindFilter>
              value={kind}
              onChange={setKind}
              options={[
                { value: "all", label: "All" },
                { value: "settlement", label: "Settlements" },
                { value: "correction", label: "Corrections" },
              ]}
            />
            <div className="flex flex-col items-start sm:flex-row sm:items-center gap-2 sm:flex-wrap">
              <div className="w-44">
                <Dropdown value={courier} onChange={setCourier} options={courierOptions} />
              </div>
              <DateRangePicker
                startDate={startDate}
                endDate={endDate}
                onChange={(s, e) => {
                  setStartDate(s);
                  setEndDate(e);
                }}
              />
              {!isPastMonth && (
                <button
                  onClick={() => {
                    setStartDate(monthAgoIso());
                    setEndDate(todayIso());
                  }}
                  className="text-xs text-gray-400 hover:text-gray-700 underline"
                >
                  Past month
                </button>
              )}
              {(startDate || endDate) && (
                <button
                  onClick={() => {
                    setStartDate(null);
                    setEndDate(null);
                  }}
                  className="text-xs text-gray-400 hover:text-gray-700 underline"
                >
                  Show everything
                </button>
              )}
            </div>
          </div>
          <p className="text-xs text-gray-500">
            {kind !== "correction" && (
              <>
                <span className="font-medium text-gray-900">{money(received)}</span> received in {receivedCount} settlement{receivedCount === 1 ? "" : "s"}
              </>
            )}
            {kind === "all" && correctionCount > 0 && " · "}
            {kind !== "settlement" && correctionCount > 0 && (
              <>
                <span className="font-medium text-gray-900">{signed(corrections)}</span> in {correctionCount} correction{correctionCount === 1 ? "" : "s"}
              </>
            )}
            {kind === "correction" && correctionCount === 0 && "No corrections in this range"}
            <HelpHint text="A correction doesn't move any money — it only fixes what the courier is shown as owing, with a reason. Undo one here if it was a mistake." />
          </p>
        </div>

        {!loaded ? (
          <p className="p-5 text-sm text-gray-400">Loading…</p>
        ) : sorted.length === 0 ? (
          <p className="p-5 text-sm text-gray-400">
            {rows.length === 0 ? "No payments or corrections recorded yet." : "Nothing in this date range — widen it, or choose Show everything."}
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <SortHeader<SortKey> label="Date" sortKey="date" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortHeader<SortKey> label="Courier" sortKey="courier" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortHeader<SortKey> label="Type" sortKey="type" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <Th>Details</Th>
                {kind !== "correction" && <Th>Received as</Th>}
                <SortHeader<SortKey> label="Amount" sortKey="amount" activeKey={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
                <Th>{null}</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.key}>
                  <Td className="whitespace-nowrap">{shortDate(r.date)}</Td>
                  <Td>{partnerLabel(r.courier)}</Td>
                  <Td>
                    <Badge label={r.kind === "settlement" ? "Settlement" : "Correction"} />
                  </Td>
                  <Td className="max-w-sm">
                    <span className="block text-gray-900">{r.title}</span>
                    {r.detail && <span className="block text-xs text-gray-400">{r.detail}</span>}
                  </Td>
                  {kind !== "correction" && (
                    <Td className="whitespace-nowrap text-gray-600">{r.kind === "settlement" ? r.receivedAs ?? <span className="text-gray-300">Not recorded</span> : <span className="text-gray-300">—</span>}</Td>
                  )}
                  <Td className="text-right font-semibold tabular-nums whitespace-nowrap">{r.kind === "settlement" ? money(r.amount) : signed(r.amount)}</Td>
                  <Td className="text-right">
                    {r.kind === "correction" && (
                      <button
                        onClick={() => undoCorrection(r.id)}
                        className="text-gray-400 hover:text-red-600 transition"
                        title="Undo this correction"
                        aria-label="Undo this correction"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
