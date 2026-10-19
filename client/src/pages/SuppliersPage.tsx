import { useEffect, useState, FormEvent } from "react";
import { PageLoader } from "../components/Loader";
import { useNavigate } from "react-router-dom";
import { Truck, ChevronDown, ChevronRight, ChevronUp, Plus } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Supplier } from "../lib/types";
import { PageHeader, Card, Input, Label, FormGroup, ErrorText, SuccessText, Button, Table, Th, Td, SortHeader, EmptyState, HelpHint, Modal, RowCard, RowCardStats, RowCardStat } from "../components/ui";
import { CityPicker } from "../components/CityPicker";
import { useSortableData } from "../lib/useSortableData";

type SupplierSortKey = "priority" | "code" | "name" | "phone" | "city" | "balance";

// All the suppliers at a glance, with what you owe each. A supplier's details, purchases, payments and bank accounts are on their own
// page — click a row to open it.
export default function SuppliersPage() {
  const navigate = useNavigate();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAddModal, setShowAddModal] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setSuppliers(await api.get<Supplier[]>("/suppliers"));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load suppliers");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Default order (sortKey "priority"), most actionable first:
  //   1. Owing  — you still owe this supplier money (balance_owed > 0)
  //   2. Settled — nothing outstanding
  // Clicking any column header overrides this with a plain sort on
  // that column, same as every other sortable table.
  function tier(s: Supplier): number {
    return (s.balance_owed ?? 0) > 0 ? 0 : 1;
  }

  const { sorted: sortedSuppliers, sortKey, sortDir, toggleSort } = useSortableData<Supplier, SupplierSortKey>(
    suppliers,
    (s, key) => {
      switch (key) {
        case "priority":
          return tier(s);
        case "code":
          return s.supplier_code.toLowerCase();
        case "name":
          return s.name.toLowerCase();
        case "phone":
          return (s.phone ?? "").toLowerCase();
        case "city":
          return (s.city ?? "").toLowerCase();
        case "balance":
          return s.balance_owed ?? 0;
      }
    },
    "priority"
  );

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);
    if (!name.trim()) {
      setFormError("Supplier name is required");
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.post<Supplier>("/suppliers", { name: name.trim(), phone: phone.trim() || undefined, city: city.trim() || undefined });
      setFormSuccess("Supplier added successfully!");
      setName("");
      setPhone("");
      setCity("");
      // Straight onto the new supplier's page, where their bank accounts and notes can be filled in.
      setTimeout(() => navigate(`/suppliers/${created.id}`), 700);
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? err.message : "Failed to add supplier");
    } finally {
      setSubmitting(false);
    }
  }

  const totalOwed = suppliers.reduce((sum, s) => sum + (s.balance_owed ?? 0), 0);
  const owingCount = suppliers.filter((s) => (s.balance_owed ?? 0) > 0).length;

  return (
    <div>
      <PageHeader
        title="Suppliers"
        subtitle="Click any supplier to open their page."
        action={
          <button
            onClick={() => {
              setShowAddModal(true);
              setFormError(null);
              setFormSuccess(null);
            }}
            className="flex items-center gap-2 px-4 py-2.5 bg-black text-white rounded-xl text-sm font-medium hover:bg-gray-800 transition"
          >
            <Plus size={16} />
            Add supplier
          </button>
        }
      />

      {showAddModal && (
        <form onSubmit={handleAdd}>
          <Modal
            size="md"
            onClose={() => setShowAddModal(false)}
            title="Add supplier"
            footer={
              <>
                <Button type="button" onClick={() => setShowAddModal(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={submitting}>
                  {submitting ? "Adding..." : "Add supplier"}
                </Button>
              </>
            }
          >
            <FormGroup>
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </FormGroup>
            <FormGroup>
              <Label>Contact</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" />
            </FormGroup>
            <FormGroup>
              <Label>Location</Label>
              <CityPicker value={city} onChange={setCity} />
            </FormGroup>
            {formError && <ErrorText>{formError}</ErrorText>}
            {formSuccess && <SuccessText>{formSuccess}</SuccessText>}
          </Modal>
        </form>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <PageLoader />
      ) : suppliers.length === 0 ? (
        <EmptyState icon={Truck} title="No suppliers yet" actions={[{ label: "Add supplier", primary: true, onClick: () => setShowAddModal(true) }]} />
      ) : (
        <>
          <p className="text-xs text-gray-500 mb-3">
            {owingCount > 0
              ? `${owingCount} supplier${owingCount === 1 ? "" : "s"} awaiting payment — Rs. ${totalOwed.toLocaleString()} total`
              : "All suppliers settled"}
          </p>

          {/* Desktop / tablet-landscape */}
          <Card className="p-0 overflow-clip hidden lg:block">
            <Table>
              <thead>
                <tr>
                  <SortHeader<SupplierSortKey> label="Code" sortKey="code" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                  <SortHeader<SupplierSortKey> label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                  <SortHeader<SupplierSortKey> label="Phone" sortKey="phone" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                  <SortHeader<SupplierSortKey> label="City" sortKey="city" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                  <Th align="right">
                    <button
                      onClick={() => toggleSort("balance")}
                      className={`inline-flex flex-row-reverse items-center gap-1 hover:text-gray-700 transition-colors ${sortKey === "balance" ? "text-gray-900" : ""}`}
                    >
                      Balance owed
                      {sortKey === "balance" ? (sortDir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : null}
                    </button>
                    <HelpHint text="Calculated live from purchases minus payments made." />
                  </Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {sortedSuppliers.map((s) => {
                  const owes = (s.balance_owed ?? 0) > 0;
                  return (
                    <tr key={s.id} onClick={() => navigate(`/suppliers/${s.id}`)} className="cursor-pointer hover:bg-gray-50">
                      <Td>{s.supplier_code}</Td>
                      <Td className="font-medium">{s.name}</Td>
                      <Td>{s.phone ?? "—"}</Td>
                      <Td>{s.city ?? "—"}</Td>
                      <Td align="right" className={owes ? "font-medium" : "text-gray-500"}>
                        {owes ? `Rs. ${s.balance_owed.toLocaleString()}` : "Settled"}
                      </Td>
                      <Td className="w-8">
                        <ChevronRight size={14} className="text-gray-300" />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>

          {/* Phone / tablet-portrait */}
          <div className="lg:hidden space-y-2.5">
            {sortedSuppliers.map((s) => {
              const owes = (s.balance_owed ?? 0) > 0;
              return (
                <RowCard key={s.id} onClick={() => navigate(`/suppliers/${s.id}`)}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 leading-snug">{s.name}</p>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {s.supplier_code}
                        {s.phone ? ` · ${s.phone}` : ""}
                        {s.city ? ` · ${s.city}` : ""}
                      </p>
                    </div>
                    <ChevronRight size={16} className="mt-0.5 flex-shrink-0 text-gray-300" />
                  </div>
                  <RowCardStats>
                    <RowCardStat label="Balance owed" value={owes ? `Rs. ${s.balance_owed.toLocaleString()}` : <span className="font-normal text-gray-500">Settled</span>} />
                  </RowCardStats>
                </RowCard>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
