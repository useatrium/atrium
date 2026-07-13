import { Fragment, useRef, useState } from 'react';
import type { ConnectionIdentity, ConnectionStatus } from '../api';
import { useDialog } from '../useDialog';
import { XIcon } from './icons';

export function GitHubConnectionDialog({
  available,
  status,
  onCancel,
  onConnect,
  onActivate,
  onDisconnect,
}: {
  available: boolean;
  status?: ConnectionStatus;
  onCancel: () => void;
  onConnect: (body?: Record<string, unknown>) => Promise<void>;
  onActivate: (identityId: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<'installation' | 'token' | null>(null);
  const [token, setToken] = useState('');
  const [installationId, setInstallationId] = useState('');
  const connected = status?.connected === true;
  const needsAuth = status?.status === 'needs_auth';
  const activeSummary = githubActiveSummary(status);
  const connectionDetails = githubConnectionDetails(status);
  const identities = status?.identities ?? [];
  const titleId = 'github-connection-title';
  const errorId = 'github-connection-error';
  const installationHelpId = 'github-installation-help';
  const patHelpId = 'github-pat-help';
  const installationDescription =
    error && errorField === 'installation' ? `${installationHelpId} ${errorId}` : installationHelpId;
  const patDescription = error && errorField === 'token' ? `${patHelpId} ${errorId}` : patHelpId;

  useDialog({ open: true, containerRef, onClose: onCancel, closeOnOutsidePointer: true });

  async function run(action: () => Promise<void>, field: 'installation' | 'token' | null = null) {
    setBusy(true);
    setError(null);
    setErrorField(field);
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
    <div className="fixed inset-0 z-overlay flex items-start justify-center overflow-y-auto bg-surface/60 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="GitHub connection"
        aria-busy={busy ? 'true' : undefined}
        className="mt-24 w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-edge-strong bg-surface-raised shadow-2xl max-md:my-4"
      >
        <header className="flex items-center justify-between border-b border-edge px-4 py-3">
          <div>
            <h2 id={titleId} className="text-sm font-semibold text-fg">
              GitHub connection
            </h2>
            <p className="text-2xs text-fg-muted">
              {connected || needsAuth ? activeSummary : 'Use your GitHub account for repository access.'}
            </p>
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

        <div className="space-y-3 px-4 py-3 text-sm text-fg-secondary">
          {!available ? (
            <p className="text-xs leading-relaxed text-fg-muted">
              GitHub connections are not available on this server yet. You can still start sessions and enter repository
              names manually.
            </p>
          ) : connected || needsAuth ? (
            <div className="rounded-md border border-edge bg-surface px-3 py-2 text-xs">
              <div className="font-medium text-fg">
                {needsAuth ? 'Reconnect required' : 'Active for this workspace'}
              </div>
              <div className="mt-1 text-fg-muted">
                {activeSummary}
                {status?.scopes?.length ? ` · ${status.scopes.join(', ')}` : ''}
              </div>
              {connectionDetails.length > 0 && (
                <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-fg-muted">
                  {connectionDetails.map(([label, value]) => (
                    <Fragment key={label}>
                      <dt>{label}</dt>
                      <dd className="truncate text-fg-secondary">{value}</dd>
                    </Fragment>
                  ))}
                </dl>
              )}
              {needsAuth && status?.lastError && (
                <div className="mt-2 rounded border border-danger/30 bg-danger/10 px-2 py-1 text-danger">
                  {status.lastError}
                </div>
              )}
              {identities.length > 0 && (
                <div className="mt-3 border-t border-edge pt-2">
                  <div className="text-2xs font-medium uppercase text-fg-muted">Saved identities</div>
                  <ul className="mt-2 space-y-1">
                    {identities.map((identity) => (
                      <li key={identity.id} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-fg-secondary">{githubIdentitySummary(identity)}</span>
                        {identity.active ? (
                          <span className="shrink-0 rounded border border-success/40 px-1.5 py-0.5 text-2xs font-medium text-success">
                            Active
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void run(() => onActivate(identity.id))}
                            className="shrink-0 rounded border border-edge px-1.5 py-0.5 text-2xs font-medium text-fg-muted hover:bg-surface-overlay hover:text-fg disabled:opacity-50 max-md:min-h-11 max-md:px-2.5"
                          >
                            Make active
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-fg-muted">
              Connect a GitHub user, app installation, or PAT for repository access.
            </p>
          )}

          {error && (
            <div
              id={errorId}
              role="alert"
              className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              {error}
            </div>
          )}

          {available && (
            <div className="space-y-2">
              {(connected || needsAuth) && (
                <p className="text-xs leading-relaxed text-fg-muted">
                  Connecting another GitHub identity replaces the active identity for future sessions in this workspace.
                </p>
              )}
              <div className="rounded-md border border-edge bg-surface px-3 py-2 text-xs">
                <div className="font-medium text-fg-secondary">Connect an installed Atrium GitHub App</div>
                <div className="mt-3 space-y-2">
                  <p id={installationHelpId} className="text-fg-muted">
                    Use the installation owned by the org or user that should grant repository access.
                  </p>
                  <label className="block">
                    <span className="mb-1 block text-2xs font-medium text-fg-muted">Installation ID</span>
                    <input
                      value={installationId}
                      onChange={(e) => setInstallationId(e.target.value)}
                      inputMode="numeric"
                      aria-invalid={errorField === 'installation' ? 'true' : undefined}
                      aria-describedby={installationDescription}
                      placeholder="12345"
                      className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-strong max-md:min-h-11"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || installationId.trim().length === 0}
                    onClick={() =>
                      void run(
                        () => onConnect({ tokenKind: 'app_installation', installationId: installationId.trim() }),
                        'installation',
                      )
                    }
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11"
                  >
                    Connect GitHub App
                  </button>
                </div>
              </div>
              <details className="rounded-md border border-edge bg-surface px-3 py-2 text-xs">
                <summary className="cursor-pointer font-medium text-fg-secondary">Personal access token</summary>
                <div className="mt-3 space-y-2">
                  <p id={patHelpId} className="text-fg-muted">
                    Uses your pasted PAT. Private repo access is checked before sessions start.
                  </p>
                  <label className="block">
                    <span className="sr-only">Personal access token</span>
                    <input
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      type="password"
                      aria-invalid={errorField === 'token' ? 'true' : undefined}
                      aria-describedby={patDescription}
                      placeholder="github_pat_..."
                      className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-strong max-md:min-h-11"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || token.trim().length === 0}
                    onClick={() => void run(() => onConnect({ tokenKind: 'pat', token: token.trim() }), 'token')}
                    className="rounded-md border border-edge px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11"
                  >
                    Connect PAT
                  </button>
                </div>
              </details>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-edge px-4 py-3 max-md:flex-wrap">
          {(connected || needsAuth) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(onDisconnect)}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50 max-md:min-h-11"
            >
              Disconnect
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg max-md:min-h-11"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !available}
            onClick={() => void run(() => onConnect({ tokenKind: 'app_user' }))}
            className="rounded-md border border-edge px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11"
          >
            {connected || needsAuth ? 'Reconnect GitHub user' : 'Connect GitHub user'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function githubConnectionDetails(status?: ConnectionStatus): Array<[string, string]> {
  if (!status) return [];
  const details: Array<[string, string]> = [];
  details.push(['Workspace', status.workspaceId]);
  if (status.lastValidatedAt) details.push(['Last checked', formatDateTime(status.lastValidatedAt)]);
  const repoAccess = repoAccessSummary(status.capabilities);
  if (repoAccess) details.push(['Repo access', repoAccess]);
  if (!status.metadata) return details;
  const installationAccountType = metadataString(status.metadata, 'installationAccountType');
  const installationTargetType = metadataString(status.metadata, 'installationTargetType');
  const last4 = metadataString(status.metadata, 'last4');
  if (status.tokenKind === 'app_installation') {
    if (installationAccountType) details.push(['Account', installationAccountType]);
    if (installationTargetType && installationTargetType !== installationAccountType) {
      details.push(['Target', installationTargetType]);
    }
  }
  if (status.tokenKind === 'pat' && last4) details.push(['Token', `...${last4}`]);
  return details;
}

function repoAccessSummary(capabilities: Record<string, unknown> | undefined): string | null {
  if (!capabilities) return null;
  const summary = capabilities.repoAccessSummary;
  if (typeof summary === 'string' && summary.trim()) return summary.trim();
  const repositories = capabilities.repositories;
  if (Array.isArray(repositories) && repositories.length > 0) return `${repositories.length} repositories`;
  const privateRepos = capabilities.privateRepos;
  if (typeof privateRepos === 'number' && Number.isFinite(privateRepos)) return `${privateRepos} private repositories`;
  return null;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function githubActiveSummary(status?: ConnectionStatus): string {
  const account = status?.accountLabel ?? status?.accountLogin ?? null;
  switch (status?.tokenKind) {
    case 'app_installation':
      return account ? `App installation for ${account}` : 'App installation';
    case 'app_user':
      return account ? `@${account} as GitHub user` : 'GitHub user';
    case 'pat':
      return account ? `PAT for @${account}` : 'Personal access token';
    case 'public_read':
      return 'Public read';
    default:
      return 'GitHub';
  }
}

function githubIdentitySummary(identity: ConnectionIdentity): string {
  const account = identity.accountLabel ?? identity.accountLogin ?? null;
  switch (identity.tokenKind) {
    case 'app_installation':
      return account ? `App installation for ${account}` : 'App installation';
    case 'app_user':
      return account ? `@${account} as GitHub user` : 'GitHub user';
    case 'pat':
      return account ? `PAT for @${account}` : 'Personal access token';
    default:
      return 'GitHub';
  }
}
