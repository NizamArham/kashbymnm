import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Star } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Customer } from "../lib/types";
import { PageHeader, Card, Table, Th, Td, EmptyState, ErrorText, RefLink } from "../components/ui";

interface LoyaltyEntry {
  points: number;
  reason: "sale" | "bonus_grant" | "manual_adjustment" | "redemption";
  notes: string | null;
  created_at: string;
  sale_id: number | null;
  sale_invoice: string | null;
}

function reasonLabel(reason: LoyaltyEntry["reason"]): string {
  if (reason === "sale") return "Earned from sale";
  if (reason === "redemption") return "Redeemed for store credit";
  if (reason === "bonus_grant") return "Bonus grant";
  return "Adjustment";
}

export default function CustomerLoyaltyHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [entries, setEntries] = useState<LoyaltyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [customerResult, ledgerResult] = await Promise.all([
          api.get<Customer>(`/customers/${id}`),
          api.get<LoyaltyEntry[]>(`/customers/${id}/loyalty-ledger`),
        ]);
        if (cancelled) return;
        setCustomer(customerResult);
        setEntries(ledgerResult);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiRequestError ? err.message : "Failed to load loyalty points history");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Newest first is how the API already returns it — displaying as-is.
  const displayEntries = entries;

  return (
    <div>
      <button
        onClick={() => navigate(-1)}
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-3"
      >
        <ArrowLeft size={14} />
        Back
      </button>

      <PageHeader
        title={customer ? `${customer.name}'s loyalty points history` : "Loyalty points history"}
        subtitle={customer ? `${entries.length} transaction${entries.length === 1 ? "" : "s"} · ${customer.loyalty_points} points now` : undefined}
      />

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : entries.length === 0 ? (
        <EmptyState icon={Star} title="No points activity yet" subtitle="Loyalty points earned or redeemed will show up here." />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Description</Th>
                <Th>Points</Th>
              </tr>
            </thead>
            <tbody>
              {displayEntries.map((entry, i) => (
                <tr key={i} className={i % 2 === 1 ? "bg-gray-50/60" : ""}>
                  <Td>{entry.created_at.slice(0, 10)}</Td>
                  <Td>
                    {entry.sale_id && entry.sale_invoice ? (
                      <>
                        {reasonLabel(entry.reason)}{" "}
                        <RefLink to={`/sales/${entry.sale_id}`}>{entry.sale_invoice}</RefLink>
                      </>
                    ) : (
                      <>
                        {reasonLabel(entry.reason)}
                        {entry.notes ? <span className="text-gray-400"> — {entry.notes}</span> : null}
                      </>
                    )}
                  </Td>
                  <Td className={`font-medium ${entry.points >= 0 ? "text-green-600" : "text-gray-700"}`}>
                    {entry.points >= 0 ? "+" : ""}
                    {entry.points}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
