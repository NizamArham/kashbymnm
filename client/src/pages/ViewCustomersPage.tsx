import { useEffect, useState, useMemo, Fragment } from "react";
import { Users, Search, MessageCircle, Pencil, Plus, Star, X, ChevronDown, ChevronRight } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Customer, CustomerAddress } from "../lib/types";
import { PageHeader, Card, Table, Th, Td, Input, Button, EmptyState, ErrorText, SuccessText, Label, FormGroup } from "../components/ui";
import { CityPicker } from "../components/CityPicker";

function whatsappLink(phone: string): string {
  const digitsOnly = phone.replace(/\D/g, "").replace(/^0/, "");
  return `https://wa.me/94${digitsOnly}`;
}

export default function ViewCustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", phone: "", phone2: "" });
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState<string | null>(null);

  const [showAddAddress, setShowAddAddress] = useState(false);
  const [newAddr, setNewAddr] = useState({ address_line1: "", address_line2: "", city: "" });
  const [addrError, setAddrError] = useState<string | null>(null);

  const [editingAddressId, setEditingAddressId] = useState<number | null>(null);
  const [editAddr, setEditAddr] = useState({ address_line1: "", address_line2: "", city: "" });
  const [editAddrError, setEditAddrError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setCustomers(await api.get<Customer[]>("/customers"));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load customers");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleExpand(c: Customer) {
    if (expandedId === c.id) {
      setExpandedId(null);
      setExpandedDetail(null);
      setIsEditing(false);
      setShowAddAddress(false);
      return;
    }
    setExpandedId(c.id);
    setIsEditing(false);
    setShowAddAddress(false);
    setEditError(null);
    setEditSuccess(null);
    const full = await api.get<Customer>(`/customers/${c.id}`);
    setExpandedDetail(full);
    setEditForm({ name: full.name, phone: full.phone ?? "", phone2: full.phone2 ?? "" });
  }

  async function refreshExpanded(id: number) {
    const full = await api.get<Customer>(`/customers/${id}`);
    setExpandedDetail(full);
  }

  function cancelEdit() {
    if (!expandedDetail) return;
    setIsEditing(false);
    setEditForm({ name: expandedDetail.name, phone: expandedDetail.phone ?? "", phone2: expandedDetail.phone2 ?? "" });
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
      await api.put(`/customers/${id}`, {
        name: editForm.name.trim(),
        phone: editForm.phone.trim() || undefined,
        phone2: editForm.phone2.trim() || undefined,
      });
      setEditSuccess("Saved.");
      setIsEditing(false);
      refreshExpanded(id);
      load();
    } catch (err) {
      setEditError(err instanceof ApiRequestError ? err.message : "Failed to update customer");
    }
  }

  async function addAddress(customerId: number) {
    setAddrError(null);
    if (!newAddr.address_line1.trim() && !newAddr.city.trim()) {
      setAddrError("Enter at least an address line or city");
      return;
    }
    try {
      await api.post(`/customers/${customerId}/addresses`, {
        address_line1: newAddr.address_line1.trim() || undefined,
        address_line2: newAddr.address_line2.trim() || undefined,
        city: newAddr.city.trim() || undefined,
        is_default: false,
      });
      setNewAddr({ address_line1: "", address_line2: "", city: "" });
      setShowAddAddress(false);
      refreshExpanded(customerId);
    } catch (err) {
      setAddrError(err instanceof ApiRequestError ? err.message : "Failed to add address");
    }
  }

  async function makeDefault(customerId: number, address: CustomerAddress) {
    try {
      await api.put(`/customers/${customerId}/addresses/${address.id}`, { is_default: true });
      refreshExpanded(customerId);
    } catch {
      // minor action — no need for a full error banner if it fails
    }
  }

  function startEditAddress(a: CustomerAddress) {
    setEditingAddressId(a.id);
    setEditAddr({ address_line1: a.address_line1 ?? "", address_line2: a.address_line2 ?? "", city: a.city ?? "" });
    setEditAddrError(null);
  }

  function cancelEditAddress() {
    setEditingAddressId(null);
    setEditAddrError(null);
  }

  async function saveEditAddress(customerId: number, addressId: number) {
    setEditAddrError(null);
    if (!editAddr.address_line1.trim() && !editAddr.city.trim()) {
      setEditAddrError("Enter at least an address line or city");
      return;
    }
    try {
      await api.put(`/customers/${customerId}/addresses/${addressId}`, {
        address_line1: editAddr.address_line1.trim() || undefined,
        address_line2: editAddr.address_line2.trim() || undefined,
        city: editAddr.city.trim() || undefined,
      });
      setEditingAddressId(null);
      refreshExpanded(customerId);
    } catch (err) {
      setEditAddrError(err instanceof ApiRequestError ? err.message : "Failed to update address");
    }
  }

  async function deleteAddress(customerId: number, addressId: number) {
    if (!confirm("Delete this address?")) return;
    try {
      await api.delete(`/customers/${customerId}/addresses/${addressId}`);
      refreshExpanded(customerId);
    } catch (err) {
      setEditAddrError(err instanceof ApiRequestError ? err.message : "Failed to delete address — it may be in use on a delivery.");
    }
  }

  const filteredCustomers = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(trimmed) ||
        c.customer_code.toLowerCase().includes(trimmed) ||
        c.phone?.toLowerCase().includes(trimmed) ||
        c.phone2?.toLowerCase().includes(trimmed)
    );
  }, [customers, query]);

  return (
    <div>
      <PageHeader title="Customers" subtitle="Search to check if a customer already exists, or click a row for details." />

      <Card className="mb-5">
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
            <Search size={16} className="text-gray-400" />
          </div>
          <Input className="pl-10" placeholder="Search by name, code, or phone..." value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </Card>

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : filteredCustomers.length === 0 ? (
        <EmptyState icon={Users} title={query ? "No matching customers" : "No customers yet"} />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th></Th>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>Phone</Th>
                <Th>Loyalty points</Th>
                <Th>Balance due</Th>
                <Th>Last order</Th>
              </tr>
            </thead>
            <tbody>
              {filteredCustomers.map((c) => {
                const isExpanded = expandedId === c.id;
                return (
                  <Fragment key={c.id}>
                    <tr onClick={() => toggleExpand(c)} className="cursor-pointer hover:bg-gray-50">
                      <Td className="w-8">
                        {isExpanded ? <ChevronDown size={15} className="text-gray-400" /> : <ChevronRight size={15} className="text-gray-400" />}
                      </Td>
                      <Td>{c.customer_code}</Td>
                      <Td className="font-medium">{c.name}</Td>
                      <Td>{c.phone ?? "—"}</Td>
                      <Td>
                        <span className="inline-flex items-center gap-1">
                          <Star size={12} className="text-amber-400" />
                          {c.loyalty_points}
                        </span>
                      </Td>
                      <Td>{c.balance_due > 0 ? `Rs. ${c.balance_due.toLocaleString()}` : "—"}</Td>
                      <Td>{c.last_order_date ? c.last_order_date.slice(0, 10) : "—"}</Td>
                    </tr>

                    {isExpanded && expandedDetail && (
                      <tr>
                        <Td colSpan={7} className="bg-gray-50">
                          <div className="py-3 px-1">
                            <div className="flex items-center justify-between mb-4">
                              <div>
                                <h2 className="text-base font-semibold text-gray-900">{expandedDetail.name}</h2>
                                <p className="text-xs text-gray-400">{expandedDetail.customer_code}</p>
                              </div>
                              <button onClick={() => setExpandedId(null)} className="text-gray-400 hover:text-gray-600">
                                <X size={18} />
                              </button>
                            </div>

                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5 text-sm">
                              <div>
                                <p className="text-xs text-gray-400">Loyalty points</p>
                                <p className="text-gray-900 font-medium">{expandedDetail.loyalty_points}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400">Balance due</p>
                                <p className="text-gray-900 font-medium">
                                  {expandedDetail.balance_due > 0 ? `Rs. ${expandedDetail.balance_due.toLocaleString()}` : "Settled"}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400">Last order</p>
                                <p className="text-gray-900 font-medium">
                                  {expandedDetail.last_order_date ? expandedDetail.last_order_date.slice(0, 10) : "No orders yet"}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400">Message</p>
                                {expandedDetail.phone ? (
                                  <a
                                    href={whatsappLink(expandedDetail.phone)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1.5 text-green-600 hover:text-green-700 font-medium"
                                  >
                                    <MessageCircle size={15} />
                                    WhatsApp
                                  </a>
                                ) : (
                                  <p className="text-gray-300">No phone</p>
                                )}
                              </div>
                            </div>

                            <div className="border-t border-gray-200 pt-4 mb-4">
                              <div className="flex items-center justify-between mb-2">
                                <h3 className="text-sm font-semibold text-gray-900">Contact details</h3>
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
                                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                    <FormGroup>
                                      <Label>Name</Label>
                                      <Input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
                                    </FormGroup>
                                    <FormGroup>
                                      <Label>Phone</Label>
                                      <Input value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} />
                                    </FormGroup>
                                    <FormGroup>
                                      <Label>Phone 2</Label>
                                      <Input value={editForm.phone2} onChange={(e) => setEditForm((f) => ({ ...f, phone2: e.target.value }))} />
                                    </FormGroup>
                                  </div>
                                  {editError && <ErrorText>{editError}</ErrorText>}
                                  {editSuccess && <SuccessText>{editSuccess}</SuccessText>}
                                  <div className="flex gap-2 mt-2">
                                    <Button size="sm" variant="primary" onClick={() => saveEdit(expandedDetail.id)}>
                                      Save
                                    </Button>
                                    <Button size="sm" onClick={cancelEdit}>
                                      Cancel
                                    </Button>
                                  </div>
                                </>
                              ) : (
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                                  <div>
                                    <p className="text-xs text-gray-400">Name</p>
                                    <p className="text-gray-900">{expandedDetail.name}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-gray-400">Phone</p>
                                    <p className="text-gray-900">{expandedDetail.phone ?? "—"}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-gray-400">Phone 2</p>
                                    <p className="text-gray-900">{expandedDetail.phone2 ?? "—"}</p>
                                  </div>
                                </div>
                              )}
                            </div>

                            <div className="border-t border-gray-200 pt-4">
                              <div className="flex items-center justify-between mb-2">
                                <h3 className="text-sm font-semibold text-gray-900">Saved addresses</h3>
                                {!showAddAddress && (
                                  <button
                                    onClick={() => setShowAddAddress(true)}
                                    className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1"
                                  >
                                    <Plus size={12} />
                                    Add address
                                  </button>
                                )}
                              </div>

                              {(!expandedDetail.addresses || expandedDetail.addresses.length === 0) && !showAddAddress ? (
                                <p className="text-xs text-gray-400">No saved addresses.</p>
                              ) : (
                                <div className="space-y-2">
                                  {expandedDetail.addresses?.map((a) =>
                                    editingAddressId === a.id ? (
                                      <div key={a.id} className="bg-white border border-gray-200 rounded-xl p-3">
                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                          <FormGroup>
                                            <Label>Address line 1</Label>
                                            <Input
                                              value={editAddr.address_line1}
                                              onChange={(e) => setEditAddr((f) => ({ ...f, address_line1: e.target.value }))}
                                            />
                                          </FormGroup>
                                          <FormGroup>
                                            <Label>Address line 2</Label>
                                            <Input
                                              value={editAddr.address_line2}
                                              onChange={(e) => setEditAddr((f) => ({ ...f, address_line2: e.target.value }))}
                                            />
                                          </FormGroup>
                                          <FormGroup>
                                            <Label>City</Label>
                                            <CityPicker value={editAddr.city} onChange={(v) => setEditAddr((f) => ({ ...f, city: v }))} />
                                          </FormGroup>
                                        </div>
                                        {editAddrError && <ErrorText>{editAddrError}</ErrorText>}
                                        <div className="flex gap-2 mt-2">
                                          <Button size="sm" variant="primary" onClick={() => saveEditAddress(expandedDetail.id, a.id)}>
                                            Save
                                          </Button>
                                          <Button size="sm" onClick={cancelEditAddress}>
                                            Cancel
                                          </Button>
                                        </div>
                                      </div>
                                    ) : (
                                      <div key={a.id} className="flex items-center justify-between bg-white border border-gray-100 rounded-lg px-3 py-2 text-sm">
                                        <span className="text-gray-700">
                                          {[a.address_line1, a.address_line2, a.city].filter(Boolean).join(", ") || "—"}
                                        </span>
                                        <div className="flex items-center gap-3 flex-shrink-0">
                                          {a.is_default ? (
                                            <span className="text-xs text-green-600 font-medium">Default</span>
                                          ) : (
                                            <button onClick={() => makeDefault(expandedDetail.id, a)} className="text-xs text-gray-400 hover:text-gray-700">
                                              Make default
                                            </button>
                                          )}
                                          <button onClick={() => startEditAddress(a)} className="text-xs text-gray-400 hover:text-gray-700">
                                            Edit
                                          </button>
                                          <button onClick={() => deleteAddress(expandedDetail.id, a.id)} className="text-xs text-red-400 hover:text-red-600">
                                            Delete
                                          </button>
                                        </div>
                                      </div>
                                    )
                                  )}
                                </div>
                              )}

                              {showAddAddress && (
                                <div className="mt-3 bg-white border border-gray-200 rounded-xl p-3">
                                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                    <FormGroup>
                                      <Label>Address line 1</Label>
                                      <Input value={newAddr.address_line1} onChange={(e) => setNewAddr((f) => ({ ...f, address_line1: e.target.value }))} />
                                    </FormGroup>
                                    <FormGroup>
                                      <Label>Address line 2</Label>
                                      <Input value={newAddr.address_line2} onChange={(e) => setNewAddr((f) => ({ ...f, address_line2: e.target.value }))} />
                                    </FormGroup>
                                    <FormGroup>
                                      <Label>City</Label>
                                      <CityPicker value={newAddr.city} onChange={(v) => setNewAddr((f) => ({ ...f, city: v }))} />
                                    </FormGroup>
                                  </div>
                                  {addrError && <ErrorText>{addrError}</ErrorText>}
                                  <div className="flex gap-2 mt-2">
                                    <Button size="sm" variant="primary" onClick={() => addAddress(expandedDetail.id)}>
                                      Save address
                                    </Button>
                                    <Button size="sm" onClick={() => setShowAddAddress(false)}>
                                      Cancel
                                    </Button>
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
