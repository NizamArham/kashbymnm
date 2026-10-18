import { ReactNode, useState } from "react";
import { ApiRequestError } from "../lib/api";
import { Button, ErrorText, FormGroup, Input, Label, Modal } from "./ui";

// "Are you sure?" with an optional word on why — the second look before something is called off. `onConfirm` does the work (asking for an
// admin's password if needed) and throws if it fails; the message is shown here.
export default function CancelReasonModal({
  title,
  children,
  confirmLabel = "Yes, cancel it",
  keepLabel = "No, keep it",
  busyLabel = "Cancelling…",
  stacked = false,
  onConfirm,
  onClose,
}: {
  title: ReactNode;
  // What cancelling means, in plain words.
  children: ReactNode;
  confirmLabel?: string;
  keepLabel?: string;
  busyLabel?: string;
  // Opened on top of another dialog.
  stacked?: boolean;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError(err instanceof ApiRequestError || err instanceof Error ? err.message : "That didn't work — try again");
      setBusy(false);
    }
  }

  return (
    <Modal
      size="md"
      stacked={stacked}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {keepLabel}
          </Button>
          <Button variant="danger" onClick={go} disabled={busy}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="mb-4 text-sm text-gray-600">{children}</div>
      <FormGroup>
        <Label>Why? (optional)</Label>
        <Input placeholder="A few words, if you like" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !busy && go()} />
      </FormGroup>
      {error && <ErrorText>{error}</ErrorText>}
    </Modal>
  );
}
