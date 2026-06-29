import { useState } from 'react';
import type { ConnectionStatus } from '../api';
import { XIcon } from './icons';

export function GitHubConnectionDialog({
  available,
  status,
  onCancel,
  onConnect,
  onDisconnect,
}: {
  available: boolean;
  status?: ConnectionStatus;
  onCancel: () => void;
  onConnect: (body?: Record<string, unknown>) => Promise<void>;
  onDisconnect: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const connected = status?.connected === true;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onCancel();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-surface/60 p-4"
      onClick={onCancel}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      role="dialog"
      aria-modal="true"
      aria-label="GitHub connection"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="mt-24 w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-edge-strong bg-surface-raised shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-edge px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-fg">GitHub connection</h2>
            <p className="text-2xs text-fg-muted">
              {connected ? status?.accountLabel ?? 'Connected' : 'Use your GitHub account for repository access.'}
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

        <div className="space-y-3 px-4 py-3 text-sm text-fg-secondary">
          {!available ? (
            <p className="text-xs leading-relaxed text-fg-muted">
              GitHub connections are not available on this server yet. You can still start sessions
              and enter repository names manually.
            </p>
          ) : connected ? (
            <div className="rounded-md border border-edge bg-surface px-3 py-2 text-xs">
              <div className="font-medium text-fg">Connected</div>
              <div className="mt-1 text-fg-muted">
                {status?.accountLabel ?? 'GitHub'}{status?.scopes?.length ? ` · ${status.scopes.join(', ')}` : ''}
              </div>
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-fg-muted">
              Connect GitHub to make repository access use your workspace or account credentials.
            </p>
          )}

          {error && (
            <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          {available && (
            <details className="rounded-md border border-edge bg-surface px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium text-fg-secondary">Paste token</summary>
              <div className="mt-3 space-y-2">
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  type="password"
                  placeholder="github_pat_..."
                  className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-strong"
                />
                <button
                  type="button"
                  disabled={busy || token.trim().length === 0}
                  onClick={() => void run(() => onConnect({ tokenKind: 'pat', token: token.trim() }))}
                  className="rounded-md border border-edge px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Connect token
                </button>
              </div>
            </details>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-edge px-4 py-3">
          {connected && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(onDisconnect)}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              Disconnect
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !available}
            onClick={() => void run(() => onConnect({ tokenKind: 'app_user' }))}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {connected ? 'Reconnect GitHub' : 'Connect GitHub'}
          </button>
        </footer>
      </div>
    </div>
  );
}
