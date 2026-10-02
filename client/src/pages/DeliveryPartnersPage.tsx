import { useState } from "react";
import { Truck, Plus, Pencil, Bike } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { DeliveryPartnerInfo, useDeliveryPartners } from "../lib/delivery";
import {
  PageHeader,
  Card,
  Table,
  Th,
  Td,
  Badge,
  Button,
  Input,
  Label,
  FormGroup,
  ErrorText,
  EmptyState,
  HelpHint,
  RowCard,
  RowCardStats,
  RowCardStat,
} from "../components/ui";

type Kind = DeliveryPartnerInfo["kind"];

const KIND_OPTIONS: { value: Kind; label: string; hint: string }[] = [
  {
    value: "courier",
    label: "Courier company",
    hint: "CityPak, Fardar, DEX… Priced by weight, issues its own tracking numbers, and pays us the COD collected.",
  },
  {
    value: "on_demand",
    label: "On-demand (Uber, PickMe…)",
    hint: "A ride/dispatch app. The fare is typed in per order, the invoice number is used as the tracking barcode, and there's no COD settlement.",
  },
];

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl max-w-xl w-full max-h-[90vh] overflow-y-auto shadow-2xl p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-gray-900 mb-5">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function PartnerFormModal({
  partner,
  onClose,
  onSaved,
}: {
  partner: DeliveryPartnerInfo | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const editing = partner !== null;
  const [code, setCode] = useState(partner?.code ?? "");
  const [name, setName] = useState(partner?.name ?? "");
  const [kind, setKind] = useState<Kind>(partner?.kind ?? "courier");
  const [waybillCode, setWaybillCode] = useState(partner?.waybill_code ?? "");
  const [trackingUrl, setTrackingUrl] = useState(partner?.tracking_url_template ?? "");
  const [baseFee, setBaseFee] = useState(String(partner?.base_fee ?? 450));
  const [extraKgFee, setExtraKgFee] = useState(String(partner?.extra_kg_fee ?? 100));
  const [isActive, setIsActive] = useState(partner ? !!partner.is_active : true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setError(null);
    if (!name.trim()) {
      setError("Enter the partner's name.");
      return;
    }
    if (!editing && !/^[A-Za-z0-9]{2,8}$/.test(code.trim())) {
      setError("The code must be 2–8 letters or numbers, e.g. FDR.");
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        kind,
        waybill_code: waybillCode.trim() || undefined,
        tracking_url_template: trackingUrl.trim() || undefined,
        base_fee: parseFloat(baseFee) || 0,
        extra_kg_fee: parseFloat(extraKgFee) || 0,
        is_active: isActive,
      };
      if (editing) await api.put(`/delivery-partners/${partner!.code}`, body);
      else await api.post("/delivery-partners", { code: code.trim().toUpperCase(), ...body });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to save this delivery partner");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={editing ? `Edit ${partner!.name}` : "Add delivery partner"} onClose={onClose}>
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2">
          <FormGroup>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Fardar" autoFocus />
          </FormGroup>
        </div>
        <FormGroup>
          <Label>
            Code
            <HelpHint text="Short and permanent — it's stored on every delivery and used on the waybill (e.g. MNM X FDR). It can't be changed later." />
          </Label>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="FDR"
            maxLength={8}
            disabled={editing}
          />
        </FormGroup>
      </div>

      <FormGroup>
        <Label>Type</Label>
        <div className="grid grid-cols-1 gap-1.5">
          {KIND_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setKind(opt.value)}
              className={`text-left rounded-lg border px-3 py-2.5 transition ${
                kind === opt.value ? "border-black bg-black text-white" : "border-gray-300 hover:border-gray-400"
              }`}
            >
              <span className="text-sm font-medium block">{opt.label}</span>
              <span className={`text-xs ${kind === opt.value ? "text-gray-300" : "text-gray-500"}`}>{opt.hint}</span>
            </button>
          ))}
        </div>
      </FormGroup>

      <FormGroup>
        <Label>
          Waybill shop code
          <HelpHint text="Printed on the waybill label. Leave blank to use “MNM X” followed by the code." />
        </Label>
        <Input value={waybillCode} onChange={(e) => setWaybillCode(e.target.value)} placeholder={`MNM X ${code.trim().toUpperCase() || "CODE"}`} />
      </FormGroup>

      {kind === "courier" && (
        <>
          <FormGroup>
            <Label>
              Tracking link (optional)
              <HelpHint text="Where staff can follow a parcel. Put {tracking} where the tracking number goes." />
            </Label>
            <Input
              value={trackingUrl}
              onChange={(e) => setTrackingUrl(e.target.value)}
              placeholder="https://track.example.com/?id={tracking}"
            />
          </FormGroup>
          <div className="grid grid-cols-2 gap-4">
            <FormGroup>
              <Label>First kg (Rs.)</Label>
              <Input type="number" min="0" value={baseFee} onChange={(e) => setBaseFee(e.target.value)} />
            </FormGroup>
            <FormGroup>
              <Label>Each extra kg (Rs.)</Label>
              <Input type="number" min="0" value={extraKgFee} onChange={(e) => setExtraKgFee(e.target.value)} />
            </FormGroup>
          </div>
        </>
      )}

      {editing && (
        <label className="flex items-center gap-2 text-sm text-gray-700 mb-4 cursor-pointer">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="rounded" />
          Active — available when taking an online order
        </label>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      <div className="flex gap-2 mt-2">
        <button onClick={onClose} className="flex-1 border border-gray-200 rounded-xl py-2.5 text-sm font-medium hover:bg-gray-50 transition">
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 bg-black text-white rounded-xl py-2.5 text-sm font-medium hover:bg-gray-800 transition disabled:opacity-50"
        >
          {saving ? "Saving..." : editing ? "Save changes" : "Add partner"}
        </button>
      </div>
    </Modal>
  );
}

function pricingText(p: DeliveryPartnerInfo): string {
  if (p.kind === "on_demand") return "Fare typed in per order";
  return `Rs. ${p.base_fee.toLocaleString()} first kg + Rs. ${p.extra_kg_fee.toLocaleString()}/extra kg`;
}

export default function DeliveryPartnersPage() {
  const { partners, loaded, refresh } = useDeliveryPartners();
  const [editing, setEditing] = useState<DeliveryPartnerInfo | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggleActive(p: DeliveryPartnerInfo) {
    setError(null);
    try {
      await api.put(`/delivery-partners/${p.code}`, {
        name: p.name,
        kind: p.kind,
        waybill_code: p.waybill_code,
        tracking_url_template: p.tracking_url_template ?? undefined,
        base_fee: p.base_fee,
        extra_kg_fee: p.extra_kg_fee,
        is_active: !p.is_active,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to update this partner");
    }
  }

  return (
    <div>
      <PageHeader
        title="Delivery partners"
        subtitle="Who an online order can ship with. Switch a partner off to hide it from new orders — past deliveries keep its name."
        action={
          <Button variant="primary" onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5">
            <Plus size={14} />
            Add partner
          </Button>
        }
      />

      {error && <ErrorText>{error}</ErrorText>}

      {!loaded ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : partners.length === 0 ? (
        <EmptyState icon={Truck} title="No delivery partners yet" />
      ) : (
        <>
          <Card className="p-0 overflow-hidden hidden lg:block">
            <Table>
              <thead>
                <tr>
                  <Th>Partner</Th>
                  <Th>Code</Th>
                  <Th>Type</Th>
                  <Th>Waybill code</Th>
                  <Th>Pricing</Th>
                  <Th>Status</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {partners.map((p) => (
                  <tr key={p.code} className={p.is_active ? "" : "opacity-60"}>
                    <Td>
                      <span className="font-medium text-gray-900">{p.name}</span>
                    </Td>
                    <Td>{p.code}</Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5">
                        {p.kind === "on_demand" ? <Bike size={14} className="text-gray-400" /> : <Truck size={14} className="text-gray-400" />}
                        {p.kind === "on_demand" ? "On-demand" : "Courier"}
                      </span>
                    </Td>
                    <Td>{p.waybill_code}</Td>
                    <Td>{pricingText(p)}</Td>
                    <Td>
                      <Badge label={p.is_active ? "active" : "off"} tone={p.is_active ? "success" : "neutral"} />
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => toggleActive(p)}
                          className="px-2.5 py-1 rounded-lg text-xs text-gray-600 hover:bg-gray-100 transition"
                        >
                          {p.is_active ? "Turn off" : "Turn on"}
                        </button>
                        <button
                          onClick={() => setEditing(p)}
                          title="Edit"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
                        >
                          <Pencil size={15} />
                        </button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <div className="lg:hidden space-y-2.5">
            {partners.map((p) => (
              <RowCard key={p.code} className={p.is_active ? "" : "opacity-60"}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900">{p.name}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {p.code} · {p.kind === "on_demand" ? "On-demand" : "Courier"}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Badge label={p.is_active ? "active" : "off"} tone={p.is_active ? "success" : "neutral"} />
                    <button onClick={() => setEditing(p)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition">
                      <Pencil size={15} />
                    </button>
                  </div>
                </div>
                <RowCardStats>
                  <RowCardStat label="Waybill" value={p.waybill_code} />
                  <RowCardStat label="Pricing" value={pricingText(p)} />
                </RowCardStats>
                <button onClick={() => toggleActive(p)} className="mt-2 text-xs text-gray-500 underline">
                  {p.is_active ? "Turn off" : "Turn on"}
                </button>
              </RowCard>
            ))}
          </div>
        </>
      )}

      {adding && <PartnerFormModal partner={null} onClose={() => setAdding(false)} onSaved={async () => void (await refresh())} />}
      {editing && <PartnerFormModal partner={editing} onClose={() => setEditing(null)} onSaved={async () => void (await refresh())} />}
    </div>
  );
}
