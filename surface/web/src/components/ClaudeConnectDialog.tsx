import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useDialog } from '../useDialog';
import { XIcon } from './icons';
import {
  exchangeClaudeCodeOAuth,
  PROVIDER_CREDENTIALS_REFRESH_SENTINEL,
  startClaudeCodeOAuth,
  type ClaudeCodeOAuthStartResponse,
  type ProviderCredentialStatus,
} from '../api';

export function ClaudeConnectDialog({
  status,
  onCancel,
  onSave,
  onDisconnect,
}: {
  status?: ProviderCredentialStatus;
  onCancel: () => void;
  onSave: (token: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
}) {
  const containerRef = useRef<HTMLFormElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const [flow, setFlow] = useState<ClaudeCodeOAuthStartResponse | null>(null);
  const [code, setCode] = useState('');
  const [starting, setStarting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flowSucceeded, setFlowSucceeded] = useState(false);
  const connected = status?.connected === true;
  const titleId = 'claude-connect-title';
  const helpId = 'claude-connect-code-help';
  const statusErrorId = 'claude-connect-status-error';
  const errorId = 'claude-connect-error';
  const showStatusError = Boolean(status?.lastError) && !flowSucceeded && !error;
  const codeDescription = [helpId, showStatusError ? statusErrorId : null, error ? errorId : null]
    .filter((id): id is string => Boolean(id))
    .join(' ');

  useDialog({
    open: true,
    containerRef,
    initialFocusRef: codeInputRef,
    onClose: onCancel,
    closeOnOutsidePointer: true,
  });

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    setFlow(null);
    setCode('');
    setFlowSucceeded(false);
    try {
      setFlow(await startClaudeCodeOAuth());
    } catch (err) {
      setError((err as Error).message || 'Could not start Claude sign-in');
    } finally {
      setStarting(false);
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next = code.trim();
    if (!flow?.pendingId || !next || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await exchangeClaudeCodeOAuth(flow.pendingId, next);
      if (result.status !== 'connected') {
        setError(
          result.message ||
            (result.status === 'expired'
              ? 'This Claude sign-in expired. Start a new one to continue.'
              : 'Could not connect Claude'),
        );
        return;
      }
      setFlowSucceeded(true);
      await onSave(PROVIDER_CREDENTIALS_REFRESH_SENTINEL);
      setCode('');
      onCancel();
    } catch (err) {
      setError((err as Error).message || 'Could not connect Claude');
    } finally {
      setBusy(false);
    }
  }

  function openSignIn() {
    if (!flow?.authorizeUrl) return;
    window.open(flow.authorizeUrl, '_blank', 'noopener,noreferrer');
  }

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDisconnect();
      onCancel();
    } catch (err) {
      setError((err as Error).message || 'Could not disconnect Claude');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-overlay flex items-start justify-center overflow-y-auto bg-surface/60 p-4">
      <form
        ref={containerRef}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label="Connect Claude Code"
        aria-busy={busy || starting ? 'true' : undefined}
        className="mt-28 w-[min(440px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-edge-strong bg-surface-raised shadow-2xl max-md:my-4"
      >
        <header className="flex items-center justify-between border-b border-edge px-4 py-3">
          <div>
            <h2 id={titleId} className="text-sm font-semibold text-fg">
              Claude Code
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
            disabled={!flow?.authorizeUrl || starting}
            className="w-full rounded-md bg-accent px-3 py-2 text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11"
          >
            Open Claude sign-in
          </button>
          <div className="rounded-md border border-edge bg-surface px-3 py-2 text-xs leading-relaxed text-fg-muted">
            <span id={helpId}>Approve on claude.com, then paste the code it shows you.</span>
          </div>
          <label className="block">
            <span className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-fg-muted">Code</span>
            <input
              ref={codeInputRef}
              // biome-ignore lint/a11y/noAutofocus: dialog primary field is intentionally focused on open; useDialog manages focus containment and restore.
              autoFocus
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={codeDescription || undefined}
              placeholder="Paste Claude code"
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 font-mono text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-strong max-md:min-h-11"
            />
          </label>
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
              {!busy && (
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
              disabled={!flow?.pendingId || !code.trim() || busy || starting}
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
