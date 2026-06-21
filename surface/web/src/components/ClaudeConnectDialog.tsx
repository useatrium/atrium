import { useState, type FormEvent } from 'react';
import { XIcon } from './icons';
import type { ProviderCredentialStatus } from '../api';

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
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = status?.connected === true;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next = token.trim();
    if (!next || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(next);
      setToken('');
      onCancel();
    } catch (err) {
      setError((err as Error).message || 'Could not connect Claude');
    } finally {
      setBusy(false);
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
      setError((err as Error).message || 'Could not disconnect Claude');
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-surface/60 p-4"
      onClick={onCancel}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      role="dialog"
      aria-modal="true"
      aria-label="Connect Claude Code"
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="mt-28 w-[min(440px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-edge-strong bg-surface-raised shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-edge px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-fg">Claude Code</h2>
            <p className="text-2xs text-fg-muted">
              {connected ? 'Connected' : 'Not connected'}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close dialog"
            className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
          >
            <XIcon />
          </button>
        </header>

        <div className="space-y-3 px-4 py-3">
          <div className="rounded-md border border-edge bg-surface px-3 py-2 text-xs leading-relaxed text-fg-muted">
            Run <span className="font-mono text-fg-secondary">claude setup-token</span> and paste
            the token here.
          </div>
          <label className="block">
            <span className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-fg-muted">
              Token
            </span>
            <input
              autoFocus
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste Claude token"
              className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-strong"
            />
          </label>
          {status?.lastError && (
            <div className="rounded-md border border-warning-border/50 bg-warning-tint/20 px-3 py-2 text-xs text-warning-text">
              {status.lastError}
            </div>
          )}
          {error && (
            <div role="alert" className="rounded-md border border-danger-edge bg-danger-surface px-3 py-2 text-xs text-danger-text">
              {error}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-edge px-4 py-3">
          <button
            type="button"
            onClick={disconnect}
            disabled={!connected || busy}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            Disconnect
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!token.trim() || busy}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {connected ? 'Reconnect' : 'Connect'}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
