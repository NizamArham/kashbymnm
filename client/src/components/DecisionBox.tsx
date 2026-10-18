import { ReactNode, useState } from "react";
import { APPROVE_REASON_PRESETS, DECLINE_REASON_PRESETS } from "../lib/returnReasons";
import { Button, ErrorText, FormGroup, Label, ReasonDropdown, TabToggle } from "./ui";

// The one approve / decline form every kind of return request is decided with (an in-store return, a courier return, a delivery
// exchange), so deciding looks and works the same whatever came in. The caller does the actual work: `onApprove` / `onDecline` run its
// API call (asking for an admin's password if the person at the screen isn't one) and throw if it fails — the message is shown here.
export default function DecisionBox({
  reasonRequired = false,
  approveExtras,
  onApprove,
  onDecline,
  approveLabel = "Approve",
  declineLabel = "Decline",
}: {
  // Approving needs a written reason — for a no-returns (final sale) product.
  reasonRequired?: boolean;
  // Extra fields that belong to approving only (how a refund is paid, say).
  approveExtras?: ReactNode;
  onApprove: (reason: string) => Promise<void>;
  onDecline: (reason: string) => Promise<void>;
  // The two choices' names — "Approve" / "Decline" unless it reads better otherwise (an inspection report is approved or sent back).
  approveLabel?: string;
  declineLabel?: string;
}) {
  const [mode, setMode] = useState<"approve" | "decline">("approve");
  const [approveReason, setApproveReason] = useState("");
  const [declineReason, setDeclineReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <TabToggle
        value={mode}
        onChange={(m) => {
          setMode(m);
          setError(null);
        }}
        options={[
          { value: "approve", label: approveLabel },
          { value: "decline", label: declineLabel },
        ]}
      />
      <div className="mt-3 max-w-md rounded-xl border border-gray-200 bg-white p-3.5">
        {mode === "approve" ? (
          <>
            {approveExtras}
            <FormGroup>
              <Label>Reason{reasonRequired ? " (required)" : " (optional)"}</Label>
              <ReasonDropdown value={approveReason} onChange={setApproveReason} presets={APPROVE_REASON_PRESETS} />
            </FormGroup>
            {error && <ErrorText>{error}</ErrorText>}
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              className="mt-1"
              onClick={() => {
                if (reasonRequired && !approveReason.trim()) {
                  setError("A reason is required — this is a no-returns product.");
                  return;
                }
                run(() => onApprove(approveReason.trim()));
              }}
            >
              {busy ? "Saving…" : approveLabel}
            </Button>
          </>
        ) : (
          <>
            <FormGroup>
              <Label>Reason (required)</Label>
              <ReasonDropdown value={declineReason} onChange={setDeclineReason} presets={DECLINE_REASON_PRESETS} />
            </FormGroup>
            {error && <ErrorText>{error}</ErrorText>}
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              className="mt-1"
              onClick={() => {
                if (!declineReason.trim()) {
                  setError(`A reason is required — say why.`);
                  return;
                }
                run(() => onDecline(declineReason.trim()));
              }}
            >
              {busy ? "Saving…" : declineLabel}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
