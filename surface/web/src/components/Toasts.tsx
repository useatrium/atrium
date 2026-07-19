// Last-resort error surface. Anything that throws in an event handler or
// rejects unhandled lands here as a visible toast — a failure the user
// triggered must never be silent (e.g. crypto.randomUUID missing on
// insecure origins made Send a no-op with only a console error).

import { useEffect, useState } from 'react';

interface Toast {
  id: number;
  message: string;
  tone: 'error' | 'action';
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
}

let nextId = 1;
const listeners = new Set<(t: Toast) => void>();

/** Imperative error toast — callable from non-React modules. */
export function showErrorToast(message: string): void {
  const toast: Toast = { id: nextId++, message, tone: 'error' };
  for (const l of listeners) l(toast);
}

/** Brief confirmation with one recovery action, such as undoing an archive. */
export function showActionToast(message: string, actionLabel: string, onAction: () => void | Promise<void>): void {
  const toast: Toast = { id: nextId++, message, tone: 'action', actionLabel, onAction };
  for (const l of listeners) l(toast);
}

const TOAST_MS = 6000;
const MAX_VISIBLE = 3;

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const push = (t: Toast) => {
      setToasts((prev) => {
        // Collapse duplicate spam (e.g. a failing handler clicked repeatedly).
        if (prev.some((x) => x.message === t.message)) return prev;
        return [...prev.slice(-(MAX_VISIBLE - 1)), t];
      });
      setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), TOAST_MS);
    };
    listeners.add(push);

    const onError = (e: ErrorEvent) => {
      showErrorToast(`Something went wrong: ${e.message || 'unknown error'}`);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
      showErrorToast(`Something went wrong: ${msg || 'unknown error'}`);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      listeners.delete(push);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return (
    <div
      aria-live="assertive"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-toast flex flex-col items-center gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex max-w-md items-start gap-3 rounded-md border px-3 py-2 text-left text-xs shadow-lg ${
            t.tone === 'error'
              ? 'border-danger-border/60 bg-danger-tint/95 text-danger-text-strong'
              : 'border-edge-strong bg-surface-overlay text-fg-body'
          }`}
        >
          <span className="min-w-0 flex-1">{t.message}</span>
          {t.actionLabel && t.onAction && (
            <button
              type="button"
              onClick={() => {
                setToasts((prev) => prev.filter((x) => x.id !== t.id));
                void Promise.resolve(t.onAction?.());
              }}
              className="shrink-0 rounded px-1 font-semibold text-accent-text-strong hover:bg-accent/10"
            >
              {t.actionLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            className={`shrink-0 rounded px-1 ${
              t.tone === 'error'
                ? 'text-danger-text hover:bg-danger-surface/50 hover:text-danger-text-strong'
                : 'text-fg-muted hover:bg-surface hover:text-fg'
            }`}
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
