import { useCallback, useEffect, useRef, useState } from 'react';
import {
  pollCodexDeviceFlow,
  PROVIDER_CREDENTIALS_REFRESH_SENTINEL,
  startCodexDeviceFlow,
  type CodexDeviceStartResponse,
  type ProviderCredentialStatus,
} from '../api';
import { useDialog } from '../useDialog';
import { XIcon } from './icons';

export function CodexConnectDialog({
  status,
  onCancel,
  onSave,
  onDisconnect,
}: {
  status?: ProviderCredentialStatus;
  onCancel: () => void;
  onSave: (authJson: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
}) {
  const containerRef = useRef<HTMLFormElement>(null);
  const [flow, setFlow] = useState<CodexDeviceStartResponse | null>(null);
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'finalizing' | 'error' | 'expired'>('starting');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const completedRef = useRef(false);
  const connected = status?.connected === true;
  const titleId = 'codex-connect-title';
  const statusErrorId = 'codex-connect-status-error';
  const errorId = 'codex-connect-error';
  const waitingId = 'codex-connect-waiting';
  const finalizingId = 'codex-connect-finalizing';
  const showStatusError = Boolean(status?.lastError) && (phase === 'starting' || phase === 'waiting');
  const descriptionIds = [
    phase === 'waiting' ? waitingId : null,
    phase === 'finalizing' ? finalizingId : null,
    showStatusError ? statusErrorId : null,
    error ? errorId : null,
  ]
    .filter((id): id is string => Boolean(id))
    .join(' ');

  useDialog({ open: true, containerRef, onClose: onCancel, closeOnOutsidePointer: true });

  const start = useCallback(async () => {
    setPhase('starting');
    setError(null);
    setFlow(null);
    completedRef.current = false;
    try {
      const next = await startCodexDeviceFlow();
      setFlow(next);
      setPhase('waiting');
    } catch (err) {
      setPhase('error');
      setError((err as Error).message || 'Could not start Codex sign-in');
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    if (!flow || (phase !== 'waiting' && phase !== 'finalizing')) return undefined;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const result = await pollCodexDeviceFlow(flow.pendingId);
        if (cancelled) return;
        if (result.status === 'pending') {
          timeout = setTimeout(poll, Math.max(flow.intervalSec ?? 5, 1) * 1000);
          return;
        }
        if (result.status === 'finalizing') {
          setPhase('finalizing');
          timeout = setTimeout(poll, 2000);
          return;
        }
        if (result.status === 'connected') {
          completedRef.current = true;
          await onSave(PROVIDER_CREDENTIALS_REFRESH_SENTINEL);
          if (!cancelled) onCancel();
          return;
        }
        setPhase(result.status);
        setError(
          result.message ||
            (result.status === 'expired'
              ? 'This Codex sign-in expired. Start a new one to continue.'
              : 'Could not connect Codex'),
        );
      } catch (err) {
        if (cancelled) return;
        setPhase('error');
        setError((err as Error).message || 'Could not connect Codex');
      }
    };

    timeout = setTimeout(poll, phase === 'finalizing' ? 2000 : Math.max(flow.intervalSec ?? 5, 1) * 1000);
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [flow, onCancel, onSave, phase]);

  function openSignIn() {
    if (!flow?.verificationUri) return;
    window.open(flow.verificationUri, '_blank', 'noopener,noreferrer');
  }

  async function copyCode() {
    if (!flow?.userCode) return;
    try {
      await navigator.clipboard.writeText(flow.userCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard access is best-effort. */
    }
  }

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDisconnect();
      onCancel();
    } catch (err) {
      setError((err as Error).message || 'Could not disconnect Codex');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-surface/60 p-4">
      <form
        ref={containerRef}
        onSubmit={(e) => e.preventDefault()}
        role="dialog"
        aria-modal="true"
        aria-label="Connect Codex"
        aria-describedby={descriptionIds || undefined}
        aria-busy={busy || phase === 'starting' || phase === 'waiting' || phase === 'finalizing' ? 'true' : undefined}
        className="mt-28 w-[min(520px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-edge-strong bg-surface-raised shadow-2xl max-md:my-4"
      >
        <header className="flex items-center justify-between border-b border-edge px-4 py-3">
          <div>
            <h2 id={titleId} className="text-sm font-semibold text-fg">
              Codex
            </h2>
            <p className="text-2xs text-fg-muted">{connected ? 'Connected' : 'Not connected'}</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close dialog"
            className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg max-md:min-h-11 max-md:min-w-11"
          >
            <XIcon />
          </button>
        </header>

        <div className="space-y-3 px-4 py-3">
          <button
            type="button"
            onClick={openSignIn}
            disabled={!flow?.verificationUri || phase === 'starting' || phase === 'finalizing'}
            className="w-full rounded-md bg-accent px-3 py-2 text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11"
          >
            Open OpenAI sign-in
          </button>
          <div className="rounded-md border border-edge bg-surface px-3 py-3">
            <div className="mb-2 text-2xs font-semibold uppercase tracking-wider text-fg-muted">User code</div>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 rounded-md border border-edge bg-surface-raised px-3 py-2 text-center font-mono text-2xl font-semibold tracking-wider text-fg">
                {flow?.userCode ?? (phase === 'starting' ? 'Starting...' : 'Unavailable')}
              </div>
              <button
                type="button"
                onClick={copyCode}
                disabled={!flow?.userCode}
                aria-live="polite"
                className={`rounded-md border px-3 py-2 text-xs font-medium transition-colors active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 max-md:min-h-11 ${
                  copied
                    ? 'border-success bg-success/15 text-success'
                    : 'border-edge-strong text-fg-secondary hover:bg-surface-overlay hover:text-fg active:bg-surface-overlay'
                }`}
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
          {phase === 'waiting' && (
            <div
              id={waitingId}
              className="flex items-center gap-2 rounded-md border border-edge bg-surface px-3 py-2 text-xs text-fg-muted"
            >
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-edge-strong border-t-transparent" />
              <span>Waiting for approval on OpenAI...</span>
            </div>
          )}
          {phase === 'finalizing' && (
            <div
              id={finalizingId}
              className="flex items-center gap-2 rounded-md border border-edge bg-surface px-3 py-2 text-xs text-fg-muted"
            >
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-edge-strong border-t-transparent" />
              <span>Finalizing connection…</span>
            </div>
          )}
          {showStatusError && (
            <div
              id={statusErrorId}
              className="rounded-md border border-warning-border/50 bg-warning-tint/20 px-3 py-2 text-xs text-warning-text"
            >
              <div className="font-semibold">Reconnecting because:</div>
              <div>{status?.lastError}</div>
            </div>
          )}
          {error && (
            <div
              id={errorId}
              role="alert"
              className="space-y-2 rounded-md border border-danger-edge bg-danger-surface px-3 py-2 text-xs text-danger-text"
            >
              <div>{error}</div>
              {(phase === 'error' || phase === 'expired') && !completedRef.current && (
                <button
                  type="button"
                  onClick={start}
                  className="rounded-md bg-surface-raised px-2.5 py-1 text-xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg max-md:min-h-11"
                >
                  Try again
                </button>
              )}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-edge px-4 py-3 max-md:flex-wrap">
          <button
            type="button"
            onClick={disconnect}
            disabled={!connected || busy}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 max-md:min-h-11"
          >
            Disconnect
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg max-md:min-h-11"
            >
              Cancel
            </button>
            <button
              type="submit"
              onClick={start}
              disabled={busy || phase === 'starting' || phase === 'waiting' || phase === 'finalizing'}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11"
            >
              {connected ? 'Reconnect' : 'Connect'}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
