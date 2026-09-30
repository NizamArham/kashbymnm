import { useEffect, useState, ReactNode } from "react";
import { Plus, Ticket, Gift, Pencil, Trash2, Shuffle, X, Clock, CheckCircle2 } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Coupon, GiftVoucher } from "../lib/types";
import {
  PageHeader,
  Card,
  Table,
  Th,
  Td,
  SortHeader,
  Badge,
  Button,
  Input,
  Label,
  FormGroup,
  Dropdown,
  DatePicker,
  EmptyState,
  ErrorText,
  TabToggle,
} from "../components/ui";
import { useSortableData } from "../lib/useSortableData";

type PromoTab = "coupons" | "vouchers";
type CouponSortKey = "code" | "reward" | "status" | "expires";
type VoucherSortKey = "code" | "value" | "status" | "expires";

// No ambiguous-looking characters (0/O, 1/I) — these get read off a
// screen or a printed slip, so avoiding lookalikes matters more than a
// bigger alphabet.
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(prefix: string): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return `${prefix}-${s.slice(0, 4)}-${s.slice(4, 8)}`;
}

function isExpired(expiresAt: string | null): boolean {
  return !!expiresAt && new Date(expiresAt) < new Date();
}

function daysUntil(expiresAt: string): number {
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function ExpiryBadge({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return <Badge label="No expiry" tone="neutral" />;
  return <Badge label={isExpired(expiresAt) ? `Expired ${expiresAt.slice(0, 10)}` : expiresAt.slice(0, 10)} tone={isExpired(expiresAt) ? "danger" : "neutral"} />;
}

// Shared, roomier modal shell — replaces the old cramped max-w-sm popup
// with something that actually has space to lay fields out in pairs.
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl border border-gray-200 shadow-xl p-7 w-full max-w-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function PromotionsPage() {
  const [tab, setTab] = useState<PromoTab>("coupons");

  return (
    <div>
      <PageHeader
        title="Promotions"
        subtitle="Coupon codes and gift vouchers — create, edit, or retire them here."
        action={
          <TabToggle
            value={tab}
            onChange={setTab}
            options={[
              { value: "coupons", label: "Coupons" },
              { value: "vouchers", label: "Gift Vouchers" },
            ]}
          />
        }
      />

      {tab === "coupons" ? <CouponsTab /> : <VouchersTab />}
    </div>
  );
}

// ============================================================ Coupons ====

function CouponsTab() {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  function load() {
    setLoading(true);
    api
      .get<Coupon[]>("/coupons")
      .then(setCoupons)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Failed to load coupons"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleDelete(c: Coupon) {
    if (!confirm(`Delete coupon ${c.code}? This can't be undone.`)) return;
    setDeletingId(c.id);
    try {
      await api.delete(`/coupons/${c.id}`);
      load();
    } catch (err) {
      alert(err instanceof ApiRequestError ? err.message : "Failed to delete coupon");
    } finally {
      setDeletingId(null);
    }
  }

  const { sorted, sortKey, sortDir, toggleSort } = useSortableData<Coupon, CouponSortKey>(
    coupons,
    (c, key) => {
      switch (key) {
        case "code":
          return c.code;
        case "reward":
          return c.discount_type === "percent" ? c.discount_value : c.discount_value + 100000; // fixed-Rs rewards sort after all percent rewards
        case "status":
          return c.is_active ? 0 : 1;
        case "expires":
          return c.expires_at ?? "9999-99-99";
      }
    },
    "code"
  );

  return (
    <>
      <div className="flex justify-end mb-4">
        <Button variant="primary" onClick={() => setShowCreate(true)} className="inline-flex items-center gap-1.5">
          <Plus size={14} />
          New coupon
        </Button>
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : coupons.length === 0 ? (
        <EmptyState icon={Ticket} title="No coupons yet" subtitle="Create one to offer a discount at checkout." />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <SortHeader<CouponSortKey> label="Code" sortKey="code" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortHeader<CouponSortKey> label="Reward" sortKey="reward" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortHeader<CouponSortKey> label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortHeader<CouponSortKey> label="Expires" sortKey="expires" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <Td className="font-mono font-medium">{c.code}</Td>
                  <Td>{c.discount_type === "percent" ? `${c.discount_value}% off` : `Rs. ${c.discount_value.toLocaleString()} off`}</Td>
                  <Td>
                    {!c.is_active ? (
                      <Badge label="Inactive" tone="neutral" />
                    ) : isExpired(c.expires_at) ? (
                      <Badge label="Expired" tone="danger" />
                    ) : (
                      <Badge label="Active" tone="success" />
                    )}
                  </Td>
                  <Td>
                    <ExpiryBadge expiresAt={c.expires_at} />
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setEditing(c)} className="text-gray-400 hover:text-gray-700" title="Edit">
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(c)}
                        disabled={deletingId === c.id}
                        className="text-gray-400 hover:text-red-600"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {showCreate && <CouponFormModal onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
      {editing && <CouponFormModal coupon={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </>
  );
}

function CouponFormModal({ coupon, onClose, onSaved }: { coupon?: Coupon; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!coupon;
  const [code, setCode] = useState(coupon?.code ?? "");
  const [discountType, setDiscountType] = useState<"percent" | "fixed">(coupon?.discount_type ?? "percent");
  const [discountValue, setDiscountValue] = useState(coupon ? String(coupon.discount_value) : "");
  const [isActive, setIsActive] = useState(coupon ? coupon.is_active === 1 : true);
  const [neverExpires, setNeverExpires] = useState(coupon ? !coupon.expires_at : true);
  const [expiresAt, setExpiresAt] = useState<string | null>(coupon?.expires_at ?? null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    const value = parseFloat(discountValue);
    if (!value || value <= 0) {
      setError("Enter a valid reward amount");
      return;
    }
    if (discountType === "percent" && value > 100) {
      setError("A percentage discount can't exceed 100");
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        code,
        discount_type: discountType,
        discount_value: value,
        is_active: isActive,
        expires_at: neverExpires ? undefined : expiresAt ?? undefined,
      };
      if (isEdit) {
        await api.put(`/coupons/${coupon.id}`, payload);
      } else {
        await api.post("/coupons", payload);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to save coupon");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={isEdit ? "Edit coupon" : "New coupon"} onClose={onClose}>
      <p className="text-xs text-gray-400 mb-4 -mt-2">
        Shared by text, social media, or however you like — the code alone is what a customer needs, so it's live the moment you create it.
      </p>

      <FormGroup>
        <Label>Code</Label>
        {isEdit ? (
          <p className="font-mono text-sm bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5">{code}</p>
        ) : (
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            className="font-mono"
            placeholder="e.g. BLACKFRIDAY, XMAS2026, WELCOME10"
            autoFocus
          />
        )}
      </FormGroup>

      <div className="grid grid-cols-2 gap-4">
        <FormGroup>
          <Label>Reward type</Label>
          <Dropdown
            value={discountType}
            onChange={(v) => setDiscountType(v as "percent" | "fixed")}
            options={[
              { value: "percent", label: "% off" },
              { value: "fixed", label: "Rs. off" },
            ]}
          />
        </FormGroup>
        <FormGroup>
          <Label>{discountType === "percent" ? "Percent" : "Amount (Rs.)"}</Label>
          <Input type="number" min="0" value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} />
        </FormGroup>
      </div>

      <div className="grid grid-cols-2 gap-4 items-start">
        <FormGroup>
          <label className="flex items-center gap-2 text-sm text-gray-700 mt-2.5">
            <input type="checkbox" checked={neverExpires} onChange={(e) => setNeverExpires(e.target.checked)} className="rounded" />
            Never expires
          </label>
        </FormGroup>
        {!neverExpires && (
          <FormGroup>
            <Label>Expires on</Label>
            <DatePicker value={expiresAt} onChange={setExpiresAt} placeholder="Select expiry date" />
          </FormGroup>
        )}
      </div>

      {isEdit && (
        <FormGroup>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="rounded" />
            Active
          </label>
        </FormGroup>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      <div className="flex gap-2 mt-4">
        <Button variant="primary" disabled={submitting} onClick={handleSubmit}>
          {submitting ? "Saving..." : isEdit ? "Save changes" : "Create coupon"}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}

// ======================================================= Gift Vouchers ====

// A voucher's real lifecycle isn't just active/inactive — it's dormant
// (printed but not yet sold), then active once a POS sale activates it
// and starts the expiry clock, then either used up or expired from
// there. is_enabled is a separate admin override on top of all of that
// (e.g. a lost or stolen voucher).
type VoucherStatus = "disabled" | "pending" | "used_up" | "expired" | "active";

function voucherStatus(v: GiftVoucher): VoucherStatus {
  if (!v.is_enabled) return "disabled";
  if (!v.activated_at) return "pending";
  if (v.remaining_value <= 0) return "used_up";
  if (isExpired(v.expires_at)) return "expired";
  return "active";
}

const VOUCHER_STATUS_META: Record<VoucherStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  disabled: { label: "Disabled", tone: "neutral" },
  pending: { label: "Not yet sold", tone: "warning" },
  used_up: { label: "Used up", tone: "neutral" },
  expired: { label: "Expired", tone: "danger" },
  active: { label: "Active", tone: "success" },
};

const VOUCHER_STATUS_ORDER: Record<VoucherStatus, number> = { active: 0, pending: 1, expired: 2, used_up: 3, disabled: 4 };

// Presets cover the common cases; "Custom" reveals a plain number input
// for anything else.
const DURATION_PRESETS = [7, 30, 45, 90, 365];

function VouchersTab() {
  const [vouchers, setVouchers] = useState<GiftVoucher[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<GiftVoucher | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  function load() {
    setLoading(true);
    api
      .get<GiftVoucher[]>("/gift-vouchers")
      .then(setVouchers)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Failed to load gift vouchers"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleDelete(v: GiftVoucher) {
    if (!confirm(`Delete gift voucher ${v.code}? This can't be undone.`)) return;
    setDeletingId(v.id);
    try {
      await api.delete(`/gift-vouchers/${v.id}`);
      load();
    } catch (err) {
      alert(err instanceof ApiRequestError ? err.message : "Failed to delete gift voucher");
    } finally {
      setDeletingId(null);
    }
  }

  const { sorted, sortKey, sortDir, toggleSort } = useSortableData<GiftVoucher, VoucherSortKey>(
    vouchers,
    (v, key) => {
      switch (key) {
        case "code":
          return v.code;
        case "value":
          return v.remaining_value;
        case "status":
          return VOUCHER_STATUS_ORDER[voucherStatus(v)];
        case "expires":
          return v.expires_at ?? "9999-99-99";
      }
    },
    "code"
  );

  return (
    <>
      <div className="flex justify-end mb-4">
        <Button variant="primary" onClick={() => setShowCreate(true)} className="inline-flex items-center gap-1.5">
          <Plus size={14} />
          New gift voucher
        </Button>
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : vouchers.length === 0 ? (
        <EmptyState icon={Gift} title="No gift vouchers yet" subtitle="Issue one to give a customer a fixed Rs. balance to spend." />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <SortHeader<VoucherSortKey> label="Code" sortKey="code" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortHeader<VoucherSortKey> label="Balance" sortKey="value" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortHeader<VoucherSortKey> label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortHeader<VoucherSortKey> label="Expires" sortKey="expires" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <Th>Notes</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((v) => {
                const status = voucherStatus(v);
                const meta = VOUCHER_STATUS_META[status];
                return (
                  <tr key={v.id} className="hover:bg-gray-50">
                    <Td className="font-mono font-medium">{v.code}</Td>
                    <Td>
                      Rs. {v.remaining_value.toLocaleString()}
                      {v.remaining_value !== v.initial_value && (
                        <span className="text-xs text-gray-400"> / Rs. {v.initial_value.toLocaleString()}</span>
                      )}
                    </Td>
                    <Td>
                      <Badge label={meta.label} tone={meta.tone} />
                    </Td>
                    <Td>
                      {!v.activated_at ? (
                        <span className="text-xs text-gray-400">{v.validity_days} days, once sold</span>
                      ) : (
                        <ExpiryBadge expiresAt={v.expires_at} />
                      )}
                    </Td>
                    <Td className="text-gray-500 text-xs max-w-[160px] truncate">{v.notes ?? "—"}</Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <button onClick={() => setEditing(v)} className="text-gray-400 hover:text-gray-700" title="Edit">
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => handleDelete(v)}
                          disabled={deletingId === v.id}
                          className="text-gray-400 hover:text-red-600"
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}

      {showCreate && <VoucherFormModal onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
      {editing && <VoucherFormModal voucher={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </>
  );
}

function DurationPicker({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  const matchesPreset = DURATION_PRESETS.includes(days);
  const [customOpen, setCustomOpen] = useState(!matchesPreset);

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {DURATION_PRESETS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => {
              setCustomOpen(false);
              onChange(d);
            }}
            className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
              !customOpen && days === d ? "bg-black text-white border-black" : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
            }`}
          >
            {d === 365 ? "1 year" : `${d} days`}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCustomOpen(true)}
          className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
            customOpen ? "bg-black text-white border-black" : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
          }`}
        >
          Custom
        </button>
      </div>
      {customOpen && (
        <div className="mt-2 flex items-center gap-2">
          <Input
            type="number"
            min="1"
            value={days || ""}
            onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
            className="max-w-[120px]"
          />
          <span className="text-sm text-gray-500">days</span>
        </div>
      )}
    </div>
  );
}

function VoucherFormModal({ voucher, onClose, onSaved }: { voucher?: GiftVoucher; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!voucher;
  const [code, setCode] = useState(voucher?.code ?? randomCode("GIFT"));
  const [initialValue, setInitialValue] = useState(voucher ? String(voucher.initial_value) : "");
  const [remainingValue, setRemainingValue] = useState(voucher ? String(voucher.remaining_value) : "");
  const [validityDays, setValidityDays] = useState(voucher?.validity_days ?? 30);
  const [isEnabled, setIsEnabled] = useState(voucher ? voucher.is_enabled === 1 : true);
  const [notes, setNotes] = useState(voucher?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    if (!validityDays || validityDays <= 0) {
      setError("Enter a valid number of days");
      return;
    }
    setSubmitting(true);
    try {
      if (isEdit) {
        const remaining = parseFloat(remainingValue);
        if (isNaN(remaining) || remaining < 0) {
          setError("Enter a valid remaining balance");
          setSubmitting(false);
          return;
        }
        await api.put(`/gift-vouchers/${voucher.id}`, {
          remaining_value: remaining,
          validity_days: validityDays,
          is_enabled: isEnabled,
          notes: notes.trim() || undefined,
        });
      } else {
        const value = parseFloat(initialValue);
        if (!value || value <= 0) {
          setError("Enter a valid voucher value");
          setSubmitting(false);
          return;
        }
        await api.post("/gift-vouchers", {
          code,
          initial_value: value,
          validity_days: validityDays,
          notes: notes.trim() || undefined,
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to save gift voucher");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={isEdit ? "Edit gift voucher" : "New gift voucher"} onClose={onClose}>
      {!isEdit && (
        <p className="text-xs text-gray-400 mb-4 -mt-2">
          Printed with its own barcode, like a cheque book — it sits dormant until a customer actually buys it at POS. That sale is what
          activates it and starts the expiry countdown, so pick a duration below rather than a fixed date.
        </p>
      )}

      <FormGroup>
        <Label>Code</Label>
        {isEdit ? (
          <p className="font-mono text-sm bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5">{code}</p>
        ) : (
          <div className="flex gap-2">
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="font-mono" />
            <Button type="button" onClick={() => setCode(randomCode("GIFT"))} title="Generate a random code">
              <Shuffle size={14} />
            </Button>
          </div>
        )}
      </FormGroup>

      {isEdit ? (
        <div className="grid grid-cols-2 gap-4">
          <FormGroup>
            <Label>Original value (Rs.)</Label>
            <p className="text-sm bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-gray-500">
              {voucher.initial_value.toLocaleString()}
            </p>
          </FormGroup>
          <FormGroup>
            <Label>Remaining (Rs.)</Label>
            <Input type="number" min="0" value={remainingValue} onChange={(e) => setRemainingValue(e.target.value)} />
          </FormGroup>
        </div>
      ) : (
        <FormGroup>
          <Label>Value (Rs.)</Label>
          <Input type="number" min="0" value={initialValue} onChange={(e) => setInitialValue(e.target.value)} />
        </FormGroup>
      )}

      {isEdit && (
        <div className="mb-4 p-3.5 bg-gray-50 rounded-xl border border-gray-100 flex items-center gap-2.5 text-sm">
          {voucher.activated_at ? (
            <>
              <CheckCircle2 size={15} className="text-green-600 flex-shrink-0" />
              <span className="text-gray-700">
                Sold {voucher.activated_at.slice(0, 10)} — expires{" "}
                {voucher.expires_at ? `${voucher.expires_at.slice(0, 10)} (${daysUntil(voucher.expires_at)} days left)` : "—"}
              </span>
            </>
          ) : (
            <>
              <Clock size={15} className="text-amber-600 flex-shrink-0" />
              <span className="text-gray-700">Not yet sold — the countdown below only starts once it's sold at POS.</span>
            </>
          )}
        </div>
      )}

      <FormGroup>
        <Label>Validity {isEdit && voucher.activated_at ? "(extends or shortens the current expiry)" : "once sold"}</Label>
        <DurationPicker days={validityDays} onChange={setValidityDays} />
      </FormGroup>

      <FormGroup>
        <Label>Notes (optional)</Label>
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. printed batch, who it's for" />
      </FormGroup>

      {isEdit && (
        <FormGroup>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isEnabled} onChange={(e) => setIsEnabled(e.target.checked)} className="rounded" />
            Enabled
          </label>
        </FormGroup>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      <div className="flex gap-2 mt-4">
        <Button variant="primary" disabled={submitting} onClick={handleSubmit}>
          {submitting ? "Saving..." : isEdit ? "Save changes" : "Issue voucher"}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}
