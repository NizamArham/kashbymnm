import { useState, useEffect } from "react";
import { api, ApiRequestError } from "../lib/api";
import { BusinessInfo } from "../lib/types";
import { PageHeader, Card, Input, Label, FormGroup, ErrorText, SuccessText, Button } from "../components/ui";

export default function GeneralSettingsPage() {
  const [form, setForm] = useState({
    business_name: "",
    address_line1: "",
    address_line2: "",
    city: "",
    phone: "",
    email: "",
    bank_name: "",
    bank_account_no: "",
    bank_account_name: "",
    notes: "",
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<BusinessInfo | null>("/business-info")
      .then((info) => {
        if (info) {
          setForm({
            business_name: info.business_name ?? "",
            address_line1: info.address_line1 ?? "",
            address_line2: info.address_line2 ?? "",
            city: info.city ?? "",
            phone: info.phone ?? "",
            email: info.email ?? "",
            bank_name: info.bank_name ?? "",
            bank_account_no: info.bank_account_no ?? "",
            bank_account_name: info.bank_account_name ?? "",
            notes: info.notes ?? "",
          });
        }
      })
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Failed to load business info"))
      .finally(() => setLoading(false));
  }, []);

  function update(field: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSave() {
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      await api.put("/business-info", {
        business_name: form.business_name.trim() || undefined,
        address_line1: form.address_line1.trim() || undefined,
        address_line2: form.address_line2.trim() || undefined,
        city: form.city.trim() || undefined,
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
        bank_name: form.bank_name.trim() || undefined,
        bank_account_no: form.bank_account_no.trim() || undefined,
        bank_account_name: form.bank_account_name.trim() || undefined,
        notes: form.notes.trim() || undefined,
      });
      setSuccess("Business info saved.");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to save business info");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader title="General settings" subtitle="Business details used on receipts, waybills, and invoices." />

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : (
        <Card className="max-w-2xl">
          <h2 className="text-base font-semibold text-gray-900 mb-3">Business info</h2>
          <FormGroup>
            <Label>Business name</Label>
            <Input value={form.business_name} onChange={(e) => update("business_name", e.target.value)} />
          </FormGroup>
          <div className="grid grid-cols-2 gap-3">
            <FormGroup>
              <Label>Address line 1</Label>
              <Input value={form.address_line1} onChange={(e) => update("address_line1", e.target.value)} />
            </FormGroup>
            <FormGroup>
              <Label>Address line 2</Label>
              <Input value={form.address_line2} onChange={(e) => update("address_line2", e.target.value)} />
            </FormGroup>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <FormGroup>
              <Label>City</Label>
              <Input value={form.city} onChange={(e) => update("city", e.target.value)} />
            </FormGroup>
            <FormGroup>
              <Label>Phone</Label>
              <Input value={form.phone} onChange={(e) => update("phone", e.target.value)} />
            </FormGroup>
            <FormGroup>
              <Label>Email</Label>
              <Input value={form.email} onChange={(e) => update("email", e.target.value)} />
            </FormGroup>
          </div>

          <h2 className="text-base font-semibold text-gray-900 mb-3 mt-4">Bank details</h2>
          <div className="grid grid-cols-3 gap-3">
            <FormGroup>
              <Label>Bank name</Label>
              <Input value={form.bank_name} onChange={(e) => update("bank_name", e.target.value)} />
            </FormGroup>
            <FormGroup>
              <Label>Account number</Label>
              <Input value={form.bank_account_no} onChange={(e) => update("bank_account_no", e.target.value)} />
            </FormGroup>
            <FormGroup>
              <Label>Account name</Label>
              <Input value={form.bank_account_name} onChange={(e) => update("bank_account_name", e.target.value)} />
            </FormGroup>
          </div>

          <FormGroup>
            <Label>Notes</Label>
            <Input value={form.notes} onChange={(e) => update("notes", e.target.value)} placeholder="Optional" />
          </FormGroup>

          {error && <ErrorText>{error}</ErrorText>}
          {success && <SuccessText>{success}</SuccessText>}

          <Button variant="primary" onClick={handleSave} disabled={saving} className="mt-2">
            {saving ? "Saving..." : "Save changes"}
          </Button>

          <p className="text-xs text-gray-400 mt-4">More settings (tax, invoice numbering, etc.) will be added here over time.</p>
        </Card>
      )}
    </div>
  );
}
