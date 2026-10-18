import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from "react";
import { AlertCircle, Check, Info, X } from "lucide-react";
import { Input, Modal } from "./ui";

// The app's own answers to "are you sure?" and "that worked / that failed", in place of the browser's confirm() / alert() / prompt()
// boxes. One provider, two hooks:
//
//   const { confirm, askReason, notice } = useConfirm();
//   if (!(await confirm({ title: "Delete this cheque?", message: "This can't be undone.", confirmLabel: "Delete", danger: true }))) return;
//   const reason = await askReason({ title: "Void invoice X?", reasonLabel: "Reason (optional)" }); // null = cancelled, "" = no reason given
//
//   const toast = useToast();
//   toast.success("Marked as paid", { action: { label: "Undo", onClick: undo } });
//   toast.error("Couldn't open the slip");

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  // Deleting, voiding, throwing something away: the confirm button is red and Cancel is what Enter picks.
  danger?: boolean;
}
interface ReasonOptions extends ConfirmOptions {
  reasonLabel?: string;
  required?: boolean;
}
interface NoticeOptions {
  title: string;
  message?: ReactNode;
  okLabel?: string;
}

type Pending =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: "reason"; opts: ReasonOptions; resolve: (reason: string | null) => void }
  | { kind: "notice"; opts: NoticeOptions; resolve: () => void };

interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}
interface ToastItem {
  id: number;
  tone: "success" | "error" | "info";
  message: string;
  action?: ToastAction;
}

interface FeedbackValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  askReason: (opts: ReasonOptions) => Promise<string | null>;
  notice: (opts: NoticeOptions) => Promise<void>;
  toast: { success: (message: string, o?: { action?: ToastAction }) => void; error: (message: string) => void; info: (message: string, o?: { action?: ToastAction }) => void };
}

const FeedbackContext = createContext<FeedbackValue | undefined>(undefined);

export function useConfirm() {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error("useConfirm must be used within FeedbackProvider");
  return { confirm: ctx.confirm, askReason: ctx.askReason, notice: ctx.notice };
}

export function useToast() {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error("useToast must be used within FeedbackProvider");
  return ctx.toast;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  // ---- confirm / reason / notice (one at a time: asking again settles the one still open as "no")
  const settleOpen = useCallback((p: Pending | null) => {
    if (!p) return;
    if (p.kind === "confirm") p.resolve(false);
    else if (p.kind === "reason") p.resolve(null);
    else p.resolve();
  }, []);
  const ask = useCallback(
    (next: Pending) => {
      setPending((open) => {
        settleOpen(open);
        return next;
      });
      setReason("");
      setReasonError(null);
    },
    [settleOpen]
  );
  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => ask({ kind: "confirm", opts, resolve })), [ask]);
  const askReason = useCallback((opts: ReasonOptions) => new Promise<string | null>((resolve) => ask({ kind: "reason", opts, resolve })), [ask]);
  const notice = useCallback((opts: NoticeOptions) => new Promise<void>((resolve) => ask({ kind: "notice", opts, resolve })), [ask]);

  function close(answer: "yes" | "no") {
    const p = pending;
    if (!p) return;
    if (p.kind === "reason" && answer === "yes" && p.opts.required && !reason.trim()) {
      setReasonError("A reason is required");
      return;
    }
    setPending(null);
    if (p.kind === "confirm") p.resolve(answer === "yes");
    else if (p.kind === "reason") p.resolve(answer === "yes" ? reason.trim() : null);
    else p.resolve();
  }

  // ---- toasts
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (tone: ToastItem["tone"], message: string, action?: ToastAction) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-2), { id, tone, message, action }]);
      // A message you can act on stays a little longer; an error stays long enough to read.
      window.setTimeout(() => dismiss(id), action ? 10000 : tone === "error" ? 8000 : 5000);
    },
    [dismiss]
  );
  const toast = useMemo(
    () => ({
      success: (message: string, o?: { action?: ToastAction }) => push("success", message, o?.action),
      error: (message: string) => push("error", message),
      info: (message: string, o?: { action?: ToastAction }) => push("info", message, o?.action),
    }),
    [push]
  );

  const value = useMemo<FeedbackValue>(() => ({ confirm, askReason, notice, toast }), [confirm, askReason, notice, toast]);

  const opts = pending?.opts;
  const isDanger = pending?.kind !== "notice" && !!(opts as ConfirmOptions | undefined)?.danger;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!pending || pending.kind === "reason") return; // a reason box has its own focus: the text field
    // A safe default: Enter confirms an ordinary question, but cancels a destructive one.
    const t = window.setTimeout(() => (isDanger ? cancelRef.current : okRef.current)?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [pending, isDanger]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}

      {pending && (
        <Modal
          size="sm"
          title={pending.opts.title}
          onClose={() => close("no")}
          footer={
            pending.kind === "notice" ? (
              <button
                ref={okRef}
                type="button"
                onClick={() => close("yes")}
                className="rounded-xl bg-black px-4 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
              >
                {pending.opts.okLabel ?? "OK"}
              </button>
            ) : (
              <>
                <button
                  ref={cancelRef}
                  type="button"
                  onClick={() => close("no")}
                  className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition-all duration-200 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300"
                >
                  {pending.opts.cancelLabel ?? "Cancel"}
                </button>
                <button
                  ref={okRef}
                  type="button"
                  onClick={() => close("yes")}
                  className={`rounded-xl px-4 py-2.5 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 ${
                    isDanger ? "bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-300" : "bg-black text-white hover:bg-gray-800 focus-visible:ring-gray-400"
                  }`}
                >
                  {pending.opts.confirmLabel ?? "Confirm"}
                </button>
              </>
            )
          }
        >
          {pending.opts.message && <div className="whitespace-pre-line text-sm leading-relaxed text-gray-600">{pending.opts.message}</div>}
          {pending.kind === "reason" && (
            <div className={pending.opts.message ? "mt-4" : ""}>
              <label className="mb-1.5 block text-xs font-medium text-gray-500" htmlFor="feedback-reason">
                {pending.opts.reasonLabel ?? "Reason"}
              </label>
              <Input
                id="feedback-reason"
                autoFocus
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setReasonError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") close("yes");
                }}
              />
              {reasonError && <p className="mt-1.5 text-xs text-red-500">{reasonError}</p>}
            </div>
          )}
        </Modal>
      )}

      {/* Toasts: short, at the top, out of the way of the till's buttons at the bottom. */}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-[120] flex flex-col items-center gap-2 px-4" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex max-w-md items-center gap-3 rounded-xl bg-gray-900 py-2.5 pl-3.5 pr-2.5 text-sm text-white shadow-lg"
          >
            {t.tone === "success" ? (
              <Check size={15} className="flex-shrink-0 text-emerald-400" />
            ) : t.tone === "error" ? (
              <AlertCircle size={15} className="flex-shrink-0 text-red-400" />
            ) : (
              <Info size={15} className="flex-shrink-0 text-gray-300" />
            )}
            <span className="min-w-0">{t.message}</span>
            {t.action && (
              <button
                type="button"
                onClick={async () => {
                  dismiss(t.id);
                  await t.action!.onClick();
                }}
                className="flex-shrink-0 rounded-lg px-2 py-1 text-sm font-semibold text-white underline underline-offset-2 hover:bg-white/10"
              >
                {t.action.label}
              </button>
            )}
            <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="flex-shrink-0 rounded-lg p-1 text-gray-400 hover:bg-white/10 hover:text-white">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </FeedbackContext.Provider>
  );
}
