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
    website: "",
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
            website: info.website ?? "",
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
        website: form.website.trim() || undefined,
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
          <FormGroup>
            <Label>Website</Label>
            <Input value={form.website} onChange={(e) => update("website", e.target.value)} />
          </FormGroup>

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
            <Label>Notes (optional)</Label>
            <Input value={form.notes} onChange={(e) => update("notes", e.target.value)} />
          </FormGroup>

          {error && <ErrorText>{error}</ErrorText>}
          {success && <SuccessText>{success}</SuccessText>}

          <Button variant="primary" onClick={handleSave} disabled={saving} className="mt-2">
            {saving ? "Saving..." : "Save changes"}
          </Button>

          <p className="text-xs text-gray-400 mt-4">More settings (tax, invoice numbering, etc.) will be added here over time.</p>
        </Card>
      )}

      <Card className="max-w-2xl mt-4">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Invoice code reference</h2>
        <p className="text-xs text-gray-500 mb-3">
          What each invoice prefix means, and how the number after it is built — kept here since it's easy to forget.
        </p>
        <div className="grid grid-cols-1 gap-1.5 text-sm">
          <div className="flex justify-between border-b border-gray-100 pb-1.5">
            <span className="font-medium text-gray-900">STR</span>
            <span className="text-gray-600">In-store, paid now (cash / card / bank)</span>
          </div>
          <div className="flex justify-between border-b border-gray-100 pb-1.5">
            <span className="font-medium text-gray-900">SCR</span>
            <span className="text-gray-600">In-store, credit (balance due)</span>
          </div>
          <div className="flex justify-between border-b border-gray-100 pb-1.5">
            <span className="font-medium text-gray-900">OCD</span>
            <span className="text-gray-600">Online, cash on delivery</span>
          </div>
          <div className="flex justify-between border-b border-gray-100 pb-1.5">
            <span className="font-medium text-gray-900">OCR</span>
            <span className="text-gray-600">Online, credit (delivery fee still COD)</span>
          </div>
          <div className="flex justify-between pb-1.5">
            <span className="font-medium text-gray-900">OPS</span>
            <span className="text-gray-600">Online, fully paid upfront</span>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-3">
          After the prefix: 3 digits for the sale's date (month−1)×30 + day, then a fixed "X", then a running number
          shared across every prefix, starting at 0240 and never resetting — e.g. STR261X0240 was created on day 261
          of that scheme, and whichever sale came next (any prefix) became ...0241.
        </p>
      </Card>
    </div>
  );
}
