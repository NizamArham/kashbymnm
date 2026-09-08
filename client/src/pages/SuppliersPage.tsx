import { useEffect, useState, FormEvent, Fragment } from "react";
import { Truck, ChevronDown, ChevronRight, Pencil, Plus, X } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Supplier } from "../lib/types";
import { PageHeader, Card, Input, Label, FormGroup, ErrorText, SuccessText, Button, Table, Th, Td, EmptyState } from "../components/ui";
import { CityPicker } from "../components/CityPicker";

function displayPhone(phone: string | null): string {
  if (!phone) return "—";
  const digits = phone.replace(/\D/g, "");
  return digits.length === 9 ? `0${digits}` : phone;
}

export default function SuppliersPage() {
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

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", phone: "", city: "", notes: "" });
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState<string | null>(null);

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
      await api.post("/suppliers", { name: name.trim(), phone: phone.trim() || undefined, city: city.trim() || undefined });
      setFormSuccess("Supplier added successfully!");
      setName("");
      setPhone("");
      setCity("");
      load();
      setTimeout(() => setShowAddModal(false), 900);
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? err.message : "Failed to add supplier");
    } finally {
      setSubmitting(false);
    }
  }

  function toggleExpand(s: Supplier) {
    if (expandedId === s.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(s.id);
    setIsEditing(false);
    setEditForm({ name: s.name, phone: s.phone ?? "", city: s.city ?? "", notes: s.notes ?? "" });
    setEditError(null);
    setEditSuccess(null);
  }

  function cancelEdit(s: Supplier) {
    setIsEditing(false);
    setEditForm({ name: s.name, phone: s.phone ?? "", city: s.city ?? "", notes: s.notes ?? "" });
    setEditError(null);
  }

  async function saveEdit(id: number) {
    setEditError(null);
    setEditSuccess(null);
    if (!editForm.name.trim()) {
      setEditError("Name is required");
      return;
    }
    try {
      await api.put(`/suppliers/${id}`, {
        name: editForm.name.trim(),
        phone: editForm.phone.trim() || undefined,
        city: editForm.city.trim() || undefined,
        notes: editForm.notes.trim() || undefined,
      });
      setEditSuccess("Saved.");
      setIsEditing(false);
      load();
    } catch (err) {
      setEditError(err instanceof ApiRequestError ? err.message : "Failed to update supplier");
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this supplier? This only works if they have no purchases or payments on record.")) return;
    try {
      await api.delete(`/suppliers/${id}`);
      setExpandedId(null);
      load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to delete supplier");
    }
  }

  return (
    <div>
      <PageHeader
        title="Suppliers"
        subtitle="Click a supplier to view and edit their details. Balance owed is calculated live from purchases minus payments."
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
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Add supplier</h2>
              <button onClick={() => setShowAddModal(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleAdd} className="p-5">
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
              <div className="flex gap-3 mt-2">
                <Button type="button" onClick={() => setShowAddModal(false)} className="flex-1">
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={submitting} className="flex-1">
                  {submitting ? "Adding..." : "Add supplier"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : suppliers.length === 0 ? (
        <EmptyState icon={Truck} title="No suppliers yet" />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th></Th>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>Phone</Th>
                <Th>City</Th>
                <Th>Balance owed</Th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => {
                const isExpanded = expandedId === s.id;
                return (
                  <Fragment key={s.id}>
                    <tr onClick={() => toggleExpand(s)} className="cursor-pointer hover:bg-gray-50">
                      <Td className="w-8">
                        {isExpanded ? <ChevronDown size={15} className="text-gray-400" /> : <ChevronRight size={15} className="text-gray-400" />}
                      </Td>
                      <Td>{s.supplier_code}</Td>
                      <Td className="font-medium">{s.name}</Td>
                      <Td>{displayPhone(s.phone)}</Td>
                      <Td>{s.city ?? "—"}</Td>
                      <Td>{s.balance_owed > 0 ? `Rs. ${s.balance_owed.toLocaleString()}` : "Settled"}</Td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <Td colSpan={6} className="bg-gray-50">
                          <div className="py-3">
                            <div className="bg-white border border-gray-200 rounded-xl p-4">
                              <div className="flex items-center justify-between mb-3">
                                <h3 className="text-sm font-semibold text-gray-900">Supplier details</h3>
                                {!isEditing && (
                                  <button
                                    onClick={() => setIsEditing(true)}
                                    className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1"
                                  >
                                    <Pencil size={12} />
                                    Edit
                                  </button>
                                )}
                              </div>

                              {isEditing ? (
                                <>
                                  <div className="grid grid-cols-2 gap-3">
                                    <FormGroup>
                                      <Label>Name</Label>
                                      <Input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
                                    </FormGroup>
                                    <FormGroup>
                                      <Label>Phone</Label>
                                      <Input value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} />
                                    </FormGroup>
                                  </div>
                                  <FormGroup>
                                    <Label>City</Label>
                                    <CityPicker value={editForm.city} onChange={(v) => setEditForm((f) => ({ ...f, city: v }))} />
                                  </FormGroup>
                                  <FormGroup>
                                    <Label>Notes</Label>
                                    <Input value={editForm.notes} onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))} />
                                  </FormGroup>
                                  {editError && <ErrorText>{editError}</ErrorText>}
                                  {editSuccess && <SuccessText>{editSuccess}</SuccessText>}
                                  <div className="flex gap-2 mt-2">
                                    <Button variant="primary" size="sm" onClick={() => saveEdit(s.id)}>
                                      Save changes
                                    </Button>
                                    <Button size="sm" onClick={() => cancelEdit(s)}>
                                      Cancel
                                    </Button>
                                    <Button variant="danger" size="sm" onClick={() => handleDelete(s.id)}>
                                      Delete supplier
                                    </Button>
                                  </div>
                                </>
                              ) : (
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                                  <div>
                                    <p className="text-xs text-gray-400">Name</p>
                                    <p className="text-gray-900">{s.name}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-gray-400">Phone</p>
                                    <p className="text-gray-900">{displayPhone(s.phone)}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-gray-400">City</p>
                                    <p className="text-gray-900">{s.city ?? "—"}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-gray-400">Notes</p>
                                    <p className="text-gray-900">{s.notes ?? "—"}</p>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </Td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
