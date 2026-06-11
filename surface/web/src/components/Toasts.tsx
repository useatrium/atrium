// Last-resort error surface. Anything that throws in an event handler or
// rejects unhandled lands here as a visible toast — a failure the user
// triggered must never be silent (e.g. crypto.randomUUID missing on
// insecure origins made Send a no-op with only a console error).

import { useEffect, useState } from 'react';

interface Toast {
  id: number;
  message: string;
}

let nextId = 1;
const listeners = new Set<(t: Toast) => void>();

/** Imperative error toast — callable from non-React modules. */
export function showErrorToast(message: string): void {
  const toast = { id: nextId++, message };
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

  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          role="alert"
          onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
          className="pointer-events-auto max-w-md rounded-md border border-danger-border/60 bg-danger-tint/95 px-3 py-2 text-left text-xs text-danger-text-strong shadow-lg"
          title="Dismiss"
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
