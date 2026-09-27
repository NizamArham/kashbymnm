import { useState, useEffect } from "react";
import { Building2, MapPin, Phone, Mail, Globe, Landmark, Pencil } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { BusinessInfo } from "../lib/types";
import { PageHeader, Card, Input, Label, FormGroup, ErrorText, SuccessText, Button } from "../components/ui";

type FormState = {
  business_name: string;
  address_line1: string;
  address_line2: string;
  city: string;
  phone: string;
  email: string;
  website: string;
  bank_name: string;
  bank_account_no: string;
  bank_account_name: string;
  notes: string;
};

const EMPTY_FORM: FormState = {
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
};

export default function GeneralSettingsPage() {
  const [saved, setSaved] = useState<FormState>(EMPTY_FORM);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<BusinessInfo | null>("/business-info")
      .then((info) => {
        if (info) {
          const loaded: FormState = {
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
          };
          setSaved(loaded);
          setForm(loaded);
        }
      })
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Failed to load business info"))
      .finally(() => setLoading(false));
  }, []);

  function update(field: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function startEdit() {
    setForm(saved);
    setError(null);
    setSuccess(null);
    setIsEditing(true);
  }

  function cancelEdit() {
    setForm(saved);
    setError(null);
    setIsEditing(false);
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
      setSaved(form);
      setSuccess("Business info saved.");
      setIsEditing(false);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to save business info");
    } finally {
      setSaving(false);
    }
  }

  const address = [saved.address_line1, saved.address_line2, saved.city].filter(Boolean).join(", ");

  return (
    <div>
      <PageHeader title="General settings" subtitle="Business details used on receipts, waybills, and invoices." />

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : !isEditing ? (
        <Card className="max-w-2xl">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <div className="w-12 h-12 rounded-xl bg-gray-900 text-white flex items-center justify-center flex-shrink-0">
                <Building2 size={22} />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{saved.business_name || "Business name not set"}</h2>
                {address && (
                  <p className="text-sm text-gray-500 flex items-start gap-1 mt-0.5">
                    <MapPin size={13} className="mt-0.5 flex-shrink-0" />
                    {address}
                  </p>
                )}
              </div>
            </div>
            <button
              onClick={startEdit}
              className="text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100 flex-shrink-0"
            >
              <Pencil size={12} />
              Edit
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4 pt-4 border-t border-gray-100 text-sm">
            <div className="flex items-center gap-2">
              <Phone size={14} className="text-gray-400 flex-shrink-0" />
              <span className="text-gray-900">{saved.phone || "—"}</span>
            </div>
            <div className="flex items-center gap-2">
              <Mail size={14} className="text-gray-400 flex-shrink-0" />
              <span className="text-gray-900">{saved.email || "—"}</span>
            </div>
            <div className="flex items-center gap-2">
              <Globe size={14} className="text-gray-400 flex-shrink-0" />
              <span className="text-gray-900">{saved.website || "—"}</span>
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-xs text-gray-400 mb-2 flex items-center gap-1">
              <Landmark size={13} />
              Bank details
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-xs text-gray-400">Bank</p>
                <p className="text-gray-900">{saved.bank_name || "—"}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Account number</p>
                <p className="text-gray-900">{saved.bank_account_no || "—"}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Account name</p>
                <p className="text-gray-900">{saved.bank_account_name || "—"}</p>
              </div>
            </div>
          </div>

          {saved.notes && <p className="text-xs text-gray-400 mt-4 pt-4 border-t border-gray-100">{saved.notes}</p>}

          {success && <SuccessText>{success}</SuccessText>}
        </Card>
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

          <div className="flex justify-end gap-2 mt-2">
            <Button onClick={cancelEdit} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
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
