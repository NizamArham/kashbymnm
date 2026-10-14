import { createContext, useCallback, useContext, useRef, useState, ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { api, ApiRequestError } from "../lib/api";
import { Modal, Button, FormGroup, Label, Input, ErrorText } from "./ui";

// "Admin approval at the till". Some things a cashier can't do alone (approve a return, void a sale,
// a big discount, free delivery...). Instead of signing out and an admin signing in, any admin can
// type their own password right here. It covers that ONE action — the password is sent with the one
// request, never kept — and the action is credited to the admin who approved it.
interface AdminApprovalContextValue {
  // Runs `action`. If the server says an admin has to approve it, asks for an admin's password and
  // runs it once more with that password. A cancelled prompt throws the original error.
  runWithApproval: <T>(action: (approval?: string) => Promise<T>) => Promise<T>;
}

const AdminApprovalContext = createContext<AdminApprovalContextValue | undefined>(undefined);

export function useAdminApproval(): AdminApprovalContextValue {
  const ctx = useContext(AdminApprovalContext);
  if (!ctx) throw new Error("useAdminApproval must be used within AdminApprovalProvider");
  return ctx;
}

export function AdminApprovalProvider({ children }: { children: ReactNode }) {
  const [asking, setAsking] = useState<{ reason: string } | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const settle = useRef<((password: string | null) => void) | null>(null);

  const askForPassword = useCallback((reason: string) => {
    setPassword("");
    setError(null);
    setAsking({ reason });
    return new Promise<string | null>((resolve) => {
      settle.current = resolve;
    });
  }, []);

  function finish(result: string | null) {
    settle.current?.(result);
    settle.current = null;
    setAsking(null);
    setPassword("");
    setError(null);
  }

  async function confirm() {
    if (!password) {
      setError("Enter an admin's password");
      return;
    }
    setError(null);
    setChecking(true);
    try {
      // Checked here first so a wrong password is said right away, in the prompt, instead of
      // failing the action behind it.
      await api.post("/auth/verify-admin", { password });
      finish(password);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't check that password");
      setPassword("");
    } finally {
      setChecking(false);
    }
  }

  const runWithApproval = useCallback(
    async <T,>(action: (approval?: string) => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (err) {
        if (!(err instanceof ApiRequestError) || err.code !== "needs_approval") throw err;
        const approval = await askForPassword(err.message);
        if (approval === null) throw err;
        return await action(approval);
      }
    },
    [askForPassword]
  );

  return (
    <AdminApprovalContext.Provider value={{ runWithApproval }}>
      {children}
      {asking && (
        <Modal
          size="sm"
          stacked
          onClose={() => finish(null)}
          title={
            <span className="inline-flex items-center gap-2">
              <ShieldCheck size={18} className="text-gray-500" />
              Admin approval needed
            </span>
          }
          subtitle={asking.reason}
          footer={
            <>
              <Button onClick={() => finish(null)}>Cancel</Button>
              <Button variant="primary" onClick={confirm} disabled={checking}>
                {checking ? "Checking..." : "Approve"}
              </Button>
            </>
          }
        >
          <FormGroup>
            <Label>Admin password</Label>
            <Input
              type="password"
              autoFocus
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
            />
          </FormGroup>
          <p className="text-xs text-gray-400 -mt-1">Any admin's password works. It approves this one action only.</p>
          {error && <ErrorText>{error}</ErrorText>}
        </Modal>
      )}
    </AdminApprovalContext.Provider>
  );
}
