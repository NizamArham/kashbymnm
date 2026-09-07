import { useState, useEffect, FormEvent } from "react";
import { AlertTriangle, MapPin, Phone, UserRound } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { PageHeader, Card, Input, Label, FormGroup, ErrorText, SuccessText, Button } from "../components/ui";
import { CityPicker } from "../components/CityPicker";

export default function AddCustomerPage() {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [phone2, setPhone2] = useState("");
  const [addLine1, setAddLine1] = useState("");
  const [addLine2, setAddLine2] = useState("");
  const [city, setCity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Warns if the phone number being entered already belongs to an
  // existing customer, so the same person doesn't get added twice under
  // slightly different name spellings.
  const [duplicateWarning, setDuplicateWarning] = useState<{ name: string; customer_code: string } | null>(null);

  useEffect(() => {
    const trimmed = phone.trim();
    if (!trimmed) {
      setDuplicateWarning(null);
      return;
    }
    const timeout = setTimeout(async () => {
      try {
        const result = await api.get<{ exists: boolean; customer: { name: string; customer_code: string } | null }>(
          `/customers/check-phone?phone=${encodeURIComponent(trimmed)}`
        );
        setDuplicateWarning(result.exists && result.customer ? result.customer : null);
      } catch {
        // non-critical check
      }
    }, 400);
    return () => clearTimeout(timeout);
  }, [phone]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!name.trim()) {
      setError("Customer name is required");
      return;
    }
    if (duplicateWarning) {
      setError(`This phone number already belongs to ${duplicateWarning.name} (${duplicateWarning.customer_code}). Use the existing customer instead.`);
      return;
    }

    setSubmitting(true);
    try {
      const customer = await api.post<{ id: number; customer_code: string }>("/customers", {
        name: name.trim(),
        phone: phone.trim() || undefined,
        phone2: phone2.trim() || undefined,
      });

      if (addLine1.trim() || city.trim()) {
        await api.post(`/customers/${customer.id}/addresses`, {
          address_line1: addLine1.trim() || undefined,
          address_line2: addLine2.trim() || undefined,
          city: city.trim() || undefined,
          is_default: true,
        });
      }

      setSuccess(`Customer added (${customer.customer_code}).`);
      setName("");
      setPhone("");
      setPhone2("");
      setAddLine1("");
      setAddLine2("");
      setCity("");
      setDuplicateWarning(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to add customer");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader title="Add customer" subtitle="A saved address here becomes their default delivery address." />

      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-5">
          <Card>
          <FormGroup>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </FormGroup>
          <FormGroup>
            <Label>Phone</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            {duplicateWarning && (
              <div className="mt-2 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <AlertTriangle size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800">
                  This number already belongs to <strong>{duplicateWarning.name}</strong> ({duplicateWarning.customer_code}). Check
                  before adding a duplicate.
                </p>
              </div>
            )}
          </FormGroup>
          <FormGroup>
            <Label>Phone 2 (optional)</Label>
            <Input value={phone2} onChange={(e) => setPhone2(e.target.value)} />
          </FormGroup>

          <h3 className="text-sm font-semibold text-gray-900 mt-5 mb-3">Address (optional)</h3>
          <FormGroup>
            <Label>Address line 1</Label>
            <Input value={addLine1} onChange={(e) => setAddLine1(e.target.value)} />
          </FormGroup>
          <FormGroup>
            <Label>Address line 2</Label>
            <Input value={addLine2} onChange={(e) => setAddLine2(e.target.value)} />
          </FormGroup>
          <FormGroup>
            <Label>City</Label>
            <CityPicker value={city} onChange={setCity} dropUp />
          </FormGroup>

          {error && <ErrorText>{error}</ErrorText>}
          {success && <SuccessText>{success}</SuccessText>}

            <Button type="submit" variant="primary" disabled={submitting} className="mt-2">
              {submitting ? "Adding..." : "Add customer"}
            </Button>
          </Card>

          <Card className="h-fit lg:sticky lg:top-6">
            <h2 className="text-base font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <UserRound size={18} className="text-gray-600" />
              Customer preview
            </h2>
            <div className="mb-4 pb-4 border-b border-gray-100">
              <p className="text-lg font-semibold text-gray-900">{name.trim() || "New customer"}</p>
              <p className="text-xs text-gray-400 mt-1">Preview updates as you type</p>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Phone size={15} className="text-gray-400" />
                <span className="text-gray-700">{phone.trim() || "No primary phone"}</span>
              </div>
              {phone2.trim() && (
                <div className="flex items-center gap-2">
                  <Phone size={15} className="text-gray-400" />
                  <span className="text-gray-700">{phone2.trim()}</span>
                </div>
              )}
              <div className="flex items-start gap-2">
                <MapPin size={15} className="text-gray-400 mt-0.5" />
                <span className="text-gray-700">
                  {[addLine1.trim(), addLine2.trim(), city.trim()].filter(Boolean).join(", ") || "No address added"}
                </span>
              </div>
            </div>
          </Card>
        </div>
      </form>
    </div>
  );
}
