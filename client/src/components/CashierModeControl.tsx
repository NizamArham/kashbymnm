import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { ArrowLeftRight } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { ApiRequestError } from "../lib/api";
import { Modal, Button, FormGroup, Label, Input, ErrorText } from "./ui";

// The sidebar button that lets an admin work the till as an ordinary cashier, and the way back.
// Cashier mode is a real staff-level session (the server refuses admin actions in it), so getting
// back to admin takes the admin's own password.
export default function CashierModeControl({ onDone }: { onDone?: () => void }) {
  const { user, enterCashierMode, exitCashierMode } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askingPassword, setAskingPassword] = useState(false);
  const [password, setPassword] = useState("");

  const inCashierMode = !!user?.cashier_mode;
  // A plain staff login has no admin to go back to, so it gets no button.
  if (!inCashierMode && user?.role !== "admin") return null;

  async function handleEnter() {
    setError(null);
    setBusy(true);
    try {
      await enterCashierMode();
      onDone?.();
      navigate("/pos", { replace: true });
    } catch (err) {
      alert(err instanceof ApiRequestError ? err.message : "Couldn't switch to cashier mode");
    } finally {
      setBusy(false);
    }
  }

  async function handleExit() {
    if (!password) {
      setError("Enter your admin password");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await exitCashierMode(password);
      setAskingPassword(false);
      setPassword("");
      onDone?.();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't go back to admin");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  function closeModal() {
    setAskingPassword(false);
    setPassword("");
    setError(null);
  }

  return (
    <>
      {/* Just the icon, sitting beside Logout, as tall as it. */}
      <button
        onClick={inCashierMode ? () => setAskingPassword(true) : handleEnter}
        disabled={busy}
        title={inCashierMode ? "Back to admin (needs your password)" : "Cashier mode: work the till without the admin screens"}
        aria-label={inCashierMode ? "Back to admin" : "Switch to cashier mode"}
        className="flex-shrink-0 flex items-center justify-center px-2.5 lg:px-3 bg-black border border-gray-700 text-gray-300 rounded-lg hover:bg-gray-800 hover:text-white transition disabled:opacity-60"
      >
        {/* Swap arrows: it swaps you between the admin view and the cashier view, either way. */}
        <ArrowLeftRight size={16} />
      </button>

      {/* On the page itself, not inside the sidebar: the sidebar slides with a transform, which would
          trap a full-screen overlay inside its own narrow column. */}
      {askingPassword &&
        createPortal(
          <Modal
            size="sm"
            onClose={closeModal}
            title="Back to admin"
            subtitle="Enter your admin password to see the admin screens again."
            footer={
              <>
                <Button onClick={closeModal}>Stay in cashier mode</Button>
                <Button variant="primary" onClick={handleExit} disabled={busy}>
                  {busy ? "Checking..." : "Back to admin"}
                </Button>
              </>
            }
          >
            <FormGroup>
              <Label>Password</Label>
              <Input
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleExit();
                }}
              />
            </FormGroup>
            {error && <ErrorText>{error}</ErrorText>}
          </Modal>,
        document.body
      )}
    </>
  );
}
