import { useEffect, useState, FormEvent } from "react";
import { Landmark } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { CashBookEntry } from "../lib/types";
import { PageHeader, Card, StatCard, Input, Select, Label, FormGroup, ErrorText, Button, Table, Th, Td, EmptyState } from "../components/ui";

export default function CashBookPage() {
  const [entries, setEntries] = useState<CashBookEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState<"income" | "expense">("expense");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setEntries(await api.get<CashBookEntry[]>("/cash-book"));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load cash book");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!amount || parseFloat(amount) <= 0) {
      setFormError("Enter a valid amount");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/cash-book", { type, category: "other", amount: parseFloat(amount), notes: notes.trim() || undefined });
      setAmount("");
      setNotes("");
      load();
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? err.message : "Failed to add entry");
    } finally {
      setSubmitting(false);
    }
  }

  const currentBalance = entries[0]?.running_balance ?? 0;

  // Cash-on-hand vs bank/card totals — the whole point of tracking the
  // method is being able to answer "how much physical cash do we have"
  // separately from "how much is in the bank account".
  const methodTotals = entries.reduce((acc, e) => {
    const method = e.payment_method ?? "unspecified";
    const signedAmount = e.type === "income" ? e.amount : -e.amount;
    acc[method] = (acc[method] ?? 0) + signedAmount;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div>
      <PageHeader title="Cash book" subtitle="Sales, supplier payments, and courier payments are logged here automatically." />

      <div className="flex flex-wrap gap-3 mb-5">
        <StatCard label="Current balance" value={`Rs. ${currentBalance.toLocaleString()}`} />
        {Object.entries(methodTotals).map(([method, total]) => (
          <StatCard key={method} label={method.replace("_", " ")} value={`Rs. ${total.toLocaleString()}`} />
        ))}
      </div>

      <Card className="max-w-lg mb-5">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Add manual entry</h2>
        <p className="text-xs text-gray-400 mb-3">For anything with no other source — rent, utilities, misc income.</p>
        <form onSubmit={handleAdd}>
          <div className="grid grid-cols-2 gap-3">
            <FormGroup>
              <Label>Type</Label>
              <Select value={type} onChange={(e) => setType(e.target.value as "income" | "expense")}>
                <option value="expense">Expense</option>
                <option value="income">Income</option>
              </Select>
            </FormGroup>
            <FormGroup>
              <Label>Amount (Rs.)</Label>
              <Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FormGroup>
          </div>
          <FormGroup>
            <Label>Notes</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormGroup>
          {formError && <ErrorText>{formError}</ErrorText>}
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? "Adding..." : "Add entry"}
          </Button>
        </form>
      </Card>

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : entries.length === 0 ? (
        <EmptyState icon={Landmark} title="No cash book entries yet" />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Type</Th>
                <Th>Category</Th>
                <Th>Method</Th>
                <Th>Amount</Th>
                <Th>Running balance</Th>
                <Th>Notes</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-gray-50">
                  <Td>{entry.entry_date.slice(0, 16).replace("T", " ")}</Td>
                  <Td className={entry.type === "income" ? "text-green-600" : "text-red-500"}>
                    {entry.type === "income" ? "+" : "-"} {entry.type}
                  </Td>
                  <Td className="capitalize">{entry.category}</Td>
                  <Td className="capitalize">{entry.payment_method?.replace("_", " ") ?? "—"}</Td>
                  <Td>Rs. {entry.amount.toLocaleString()}</Td>
                  <Td>Rs. {entry.running_balance.toLocaleString()}</Td>
                  <Td>{entry.notes ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
