import { useEffect, useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { SHARE_OPTIONS } from "../lib/pickupShare";
import { Button, Card, Dropdown, ErrorText, FormGroup, Label, SuccessText } from "./ui";

// The same three choices, worded the same way, as everywhere else the delivery charge is split.
const OPTIONS = SHARE_OPTIONS.map((o) => ({ value: String(o.pct), label: o.label, sublabel: o.hint }));

// Who pays the delivery charge of a courier return, by default. The inspection report starts from this — by the reason the customer gave —
// and whoever files the report can change it for that one case. An admin sets the defaults.
export default function ReturnSplitSettings() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [ourFault, setOurFault] = useState("0");
  const [customerChoice, setCustomerChoice] = useState("100");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .get<{ our_fault: number; customer_choice: number }>("/app-settings/courier-return-split")
      .then((d) => {
        setOurFault(String(d.our_fault));
        setCustomerChoice(String(d.customer_choice));
      })
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Couldn't load the settings"))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.put("/app-settings/courier-return-split", { our_fault: Number(ourFault), customer_choice: Number(customerChoice) });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="max-w-2xl">
      <h2 className="text-lg font-semibold text-gray-900">Courier returns — the delivery charge</h2>
      <p className="mb-4 mt-1 text-sm text-gray-500">
        When a returned parcel is inspected, who pays what we paid the courier? These are where the report starts; it can be changed for any one return.
      </p>
      {!loading && (
        <>
          <FormGroup>
            <Label>Our fault — a defect, or not as described</Label>
            <Dropdown value={ourFault} onChange={setOurFault} options={OPTIONS} disabled={!isAdmin} />
          </FormGroup>
          <FormGroup>
            <Label>The customer's choice — wrong size or colour, changed their mind</Label>
            <Dropdown value={customerChoice} onChange={setCustomerChoice} options={OPTIONS} disabled={!isAdmin} />
            <p className="mt-1 text-xs text-gray-500">Half and half is a fair goodwill choice if you'd rather share it.</p>
          </FormGroup>
          {error && <ErrorText>{error}</ErrorText>}
          {saved && <SuccessText>Saved.</SuccessText>}
          {isAdmin ? (
            <Button variant="primary" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          ) : (
            <p className="text-xs text-gray-500">Only an admin can change these.</p>
          )}
        </>
      )}
    </Card>
  );
}
