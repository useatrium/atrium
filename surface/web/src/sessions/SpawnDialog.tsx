// Configured spawn: the summon sigil starts a session with defaults; this
// dialog captures the harness and optional repo specs Centaur mounts into the
// sandbox for the run.

import { useCallback, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type {
  AgentProfile,
  ConnectionIdentity,
  ConnectionStatus,
  ProviderCredentialProvider,
  ProviderCredentialStatus,
} from '../api';
import { Tooltip } from '../components/a11y';
import { PlusIcon, XIcon } from '../components/icons';
import { SHORTCUTS } from '../lib/shortcuts';
import { useDialog } from '../useDialog';

const HARNESSES: { value: ProviderCredentialProvider; label: string }[] = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude-code', label: 'Claude Code' },
];

type GitHubIdentityMode = 'automatic' | 'app_installation' | 'app_user' | 'pat';

export interface SpawnConfig {
  task: string;
  harness: string;
  repo?: string;
  branch?: string;
  repos?: { repo: string; ref?: string; subdir?: string; private?: boolean }[];
  githubIdentityMode?: GitHubIdentityMode;
  githubIdentityId?: string;
  agentProfileId?: string;
  agentProfileVersionId?: string;
}

type ReferenceRepoInput = {
  id: string;
  repo: string;
  ref: string;
  subdir: string;
  private: boolean;
};

export function SpawnDialog({
  channelName,
  onCancel,
  onSpawn,
  providerStatuses,
  githubConnection,
  connectionsAvailable = true,
  profiles = [],
  onConnectGitHub,
  onConnectProvider,
  onRunDemo,
  initialTask = '',
}: {
  channelName: string;
  onCancel: () => void;
  onSpawn: (config: SpawnConfig) => void;
  providerStatuses?: Record<string, ProviderCredentialStatus | undefined>;
  githubConnection?: ConnectionStatus;
  connectionsAvailable?: boolean;
  profiles?: AgentProfile[];
  onConnectGitHub?: () => void;
  onConnectProvider?: (provider: ProviderCredentialProvider) => void;
  onRunDemo?: () => void;
  initialTask?: string;
}) {
  const containerRef = useRef<HTMLFormElement>(null);
  const taskInputRef = useRef<HTMLTextAreaElement>(null);
  const [task, setTask] = useState(initialTask);
  const [harness, setHarness] = useState(HARNESSES[0]!.value);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [repoPrivate, setRepoPrivate] = useState(false);
  const [referenceRepos, setReferenceRepos] = useState<ReferenceRepoInput[]>([]);
  const [githubIdentitySelection, setGitHubIdentitySelection] = useState('automatic');
  const [agentProfileId, setAgentProfileId] = useState('');

  const providerConnected = providerStatuses?.[harness]?.connected === true;
  const providerLabel = HARNESSES.find((item) => item.value === harness)?.label ?? harness;
  const privateRepoRequested =
    (repo.trim().length > 0 && repoPrivate) ||
    referenceRepos.some((item) => item.repo.trim().length > 0 && item.private);
  const githubReadyForPrivateRepos = githubConnection?.connected === true;
  const privateRepoBlocked = privateRepoRequested && !githubReadyForPrivateRepos;
  const canSpawn = task.trim().length > 0 && !privateRepoBlocked;
  const providerProfiles = profiles.filter((profile) => profile.provider === harness && profile.currentVersionId);
  const selectedProfile = providerProfiles.find((profile) => profile.id === agentProfileId);
  const spawnDisabled = !canSpawn;
  const spawnTooltip = spawnDisabled
    ? privateRepoBlocked
      ? 'Connect GitHub before starting a private repo agent'
      : 'Add a task before starting an agent'
    : 'Start agent';
  const activeReferenceCount = referenceRepos.filter((item) => item.repo.trim().length > 0).length;
  const repoScoped = repo.trim().length > 0 || activeReferenceCount > 0;
  const activeGitHubIdentityMode = githubConnection?.connected
    ? githubIdentityModeForTokenKind(githubConnection.tokenKind)
    : null;
  const savedGitHubIdentities = githubConnection?.identities ?? [];
  const selectedGitHubIdentity = savedGitHubIdentities.find((identity) => identity.id === githubIdentitySelection);
  const selectedGitHubIdentityMode = selectedGitHubIdentity
    ? githubIdentityModeForTokenKind(selectedGitHubIdentity.tokenKind)
    : null;
  const githubIdentityOptions = [
    { value: 'automatic', label: githubAutomaticLabel(activeGitHubIdentityMode) },
    ...savedGitHubIdentities.map((identity) => ({
      value: identity.id,
      label: githubSavedIdentityLabel(identity),
    })),
  ];
  const repoMode = repo.trim()
    ? activeReferenceCount > 0
      ? `Working repo + ${activeReferenceCount} reference ${activeReferenceCount === 1 ? 'repo' : 'repos'}`
      : 'Working repo'
    : activeReferenceCount > 0
      ? `${activeReferenceCount} reference ${activeReferenceCount === 1 ? 'repo' : 'repos'}`
      : 'No repo selected';
  const titleId = 'spawn-dialog-title';
  const taskErrorId = 'spawn-task-error';
  const privateRepoBlockedId = 'spawn-private-repo-error';
  const taskMissing = task.trim().length === 0;
  const workingRepoBlocked = repo.trim().length > 0 && repoPrivate && !githubReadyForPrivateRepos;
  const referenceRepoBlocked = (item: ReferenceRepoInput) =>
    item.repo.trim().length > 0 && item.private && !githubReadyForPrivateRepos;

  // Keep a stable onClose so useDialog's focus-trap effect runs once per open.
  // Callers pass an inline onCancel (new identity each parent render), and an
  // unstable dep would re-run the effect on every background re-render — its
  // setTimeout would then yank focus back to the autofocused task field
  // mid-edit, so a keystroke in a repo field can land in the task box.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const handleClose = useCallback(() => onCancelRef.current(), []);
  useDialog({
    open: true,
    containerRef,
    initialFocusRef: taskInputRef,
    onClose: handleClose,
    closeOnOutsidePointer: true,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (spawnDisabled) return;
    const trimmedRepo = repo.trim();
    const trimmedBranch = branch.trim();
    const repos = [
      ...(trimmedRepo
        ? [
            {
              repo: trimmedRepo,
              ...(trimmedBranch ? { ref: trimmedBranch } : {}),
              ...(repoPrivate ? { private: true } : {}),
            },
          ]
        : []),
      ...referenceRepos.flatMap((item) => {
        const itemRepo = item.repo.trim();
        if (!itemRepo) return [];
        const itemRef = item.ref.trim();
        const itemSubdir = item.subdir.trim();
        return [
          {
            repo: itemRepo,
            ...(itemRef ? { ref: itemRef } : {}),
            ...(itemSubdir ? { subdir: itemSubdir } : {}),
            ...(item.private ? { private: true } : {}),
          },
        ];
      }),
    ];
    onSpawn({
      task: task.trim(),
      harness,
      ...(trimmedRepo ? { repo: trimmedRepo } : {}),
      ...(trimmedBranch ? { branch: trimmedBranch } : {}),
      ...(repos.length ? { repos } : {}),
      ...(selectedGitHubIdentityMode ? { githubIdentityMode: selectedGitHubIdentityMode } : {}),
      ...(selectedGitHubIdentity ? { githubIdentityId: selectedGitHubIdentity.id } : {}),
      ...(selectedProfile ? { agentProfileId: selectedProfile.id } : {}),
      ...(selectedProfile?.currentVersionId ? { agentProfileVersionId: selectedProfile.currentVersionId } : {}),
    });
  }

  // ⌘/Ctrl+Enter submits from the task textarea.
  function onTaskKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
  }

  function addReferenceRepo() {
    setReferenceRepos((items) => [
      ...items,
      { id: crypto.randomUUID(), repo: '', ref: '', subdir: '', private: false },
    ]);
  }

  function updateReferenceRepo(id: string, patch: Partial<Omit<ReferenceRepoInput, 'id'>>) {
    setReferenceRepos((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function removeReferenceRepo(id: string) {
    setReferenceRepos((items) => items.filter((item) => item.id !== id));
  }

  return (
    <div className="fixed inset-0 z-overlay flex items-start justify-center bg-surface/60 p-4">
      <form
        ref={containerRef}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label="Start an agent"
        className="mt-12 max-h-[calc(100dvh-6rem)] w-[min(520px,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-edge-strong bg-surface-raised shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-edge px-4 py-3">
          <div>
            <h2 id={titleId} className="text-sm font-semibold text-fg">
              New agent
            </h2>
            <p className="text-2xs text-fg-muted">in {channelName}</p>
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
          <label className="block">
            <span className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-fg-muted">Task</span>
            <textarea
              ref={taskInputRef}
              // biome-ignore lint/a11y/noAutofocus: dialog primary task field is intentionally focused on open; useDialog manages focus containment and restore.
              autoFocus
              value={task}
              aria-invalid={taskMissing ? 'true' : undefined}
              aria-describedby={taskMissing ? taskErrorId : undefined}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={onTaskKeyDown}
              rows={3}
              placeholder="What should the agent do?"
              className="w-full resize-y rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-strong"
            />
            <span id={taskErrorId} className="sr-only">
              Add a task before starting an agent.
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-fg-muted">Harness</span>
            <select
              value={harness}
              onChange={(e) => setHarness(e.target.value as ProviderCredentialProvider)}
              className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg outline-none focus:border-edge-strong"
            >
              {HARNESSES.map((h) => (
                <option key={h.value} value={h.value}>
                  {h.label}
                </option>
              ))}
            </select>
          </label>

          {!providerConnected && (
            // Default agent auth is a server-side concern the client can't
            // verify, so an unconnected provider is NOT a hard block — the
            // deliberate model is "default auth works; Connect is an opt-in
            // upgrade" (enforced by claude-provider.spec). The demo path rides
            // along for zero-setup first runs.
            <div className="rounded-md border border-edge bg-surface px-3 py-2 text-2xs leading-relaxed text-fg-muted">
              Using Atrium&rsquo;s default agent auth.{' '}
              <button
                type="button"
                onClick={() => onConnectProvider?.(harness)}
                className="font-medium text-accent-text hover:text-accent-text-strong hover:underline"
              >
                Connect {providerLabel}
              </button>{' '}
              to run on your own subscription — or watch a demo agent with no setup at all.
            </div>
          )}

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="block text-2xs font-semibold uppercase tracking-wider text-fg-muted">
                Working repo <span className="font-normal normal-case text-fg-muted">· optional</span>
              </span>
              <span className="flex items-center gap-2 text-2xs text-fg-muted">
                <span>~/repos/&lt;owner&gt;/&lt;repo&gt;</span>
                <Tooltip content={connectionsAvailable ? 'Manage GitHub connection' : 'GitHub connections unavailable'}>
                  <button
                    type="button"
                    onClick={onConnectGitHub}
                    className="inline-flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-3xs font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
                  >
                    <span
                      className={`size-1.5 rounded-full ${
                        githubConnection?.connected
                          ? 'bg-success'
                          : connectionsAvailable
                            ? 'bg-warning'
                            : 'bg-fg-muted/60'
                      }`}
                    />
                    GitHub
                  </button>
                </Tooltip>
              </span>
            </div>
            <div className="flex flex-col gap-2 md:flex-row md:gap-3">
              <label className="block md:flex-1">
                <span className="sr-only">Working repo</span>
                <input
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  aria-invalid={workingRepoBlocked ? 'true' : undefined}
                  aria-describedby={workingRepoBlocked ? privateRepoBlockedId : undefined}
                  placeholder="owner/name"
                  className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-strong"
                />
              </label>
              <label className="block md:flex-1">
                <span className="sr-only">Working ref</span>
                <input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                  className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-strong"
                />
              </label>
            </div>
            <label className="mt-2 inline-flex items-center gap-2 text-2xs text-fg-muted">
              <input
                type="checkbox"
                checked={repoPrivate}
                onChange={(e) => setRepoPrivate(e.target.checked)}
                aria-invalid={workingRepoBlocked ? 'true' : undefined}
                aria-describedby={workingRepoBlocked ? privateRepoBlockedId : undefined}
                className="h-3.5 w-3.5 rounded border-edge bg-surface"
              />
              Private repo
            </label>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="block text-2xs font-semibold uppercase tracking-wider text-fg-muted">
                Reference repos <span className="font-normal normal-case text-fg-muted">· optional</span>
              </span>
              <Tooltip content="Add reference repo">
                <button
                  type="button"
                  onClick={addReferenceRepo}
                  aria-label="Add reference repo"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-overlay hover:text-fg"
                >
                  <PlusIcon size={14} />
                </button>
              </Tooltip>
            </div>
            {referenceRepos.length > 0 && (
              <div className="space-y-2">
                {referenceRepos.map((item) => (
                  <div
                    key={item.id}
                    className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto_2rem]"
                  >
                    <label>
                      <span className="sr-only">Reference repo</span>
                      <input
                        value={item.repo}
                        onChange={(e) => updateReferenceRepo(item.id, { repo: e.target.value })}
                        aria-invalid={referenceRepoBlocked(item) ? 'true' : undefined}
                        aria-describedby={referenceRepoBlocked(item) ? privateRepoBlockedId : undefined}
                        placeholder="owner/name"
                        className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-strong"
                      />
                    </label>
                    <label>
                      <span className="sr-only">Reference ref</span>
                      <input
                        value={item.ref}
                        onChange={(e) => updateReferenceRepo(item.id, { ref: e.target.value })}
                        placeholder="ref"
                        className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-strong"
                      />
                    </label>
                    <label>
                      <span className="sr-only">Reference subdir</span>
                      <input
                        value={item.subdir}
                        onChange={(e) => updateReferenceRepo(item.id, { subdir: e.target.value })}
                        placeholder="subdir"
                        className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-strong"
                      />
                    </label>
                    <label className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-edge px-2 text-2xs text-fg-muted">
                      <input
                        type="checkbox"
                        checked={item.private}
                        onChange={(e) => updateReferenceRepo(item.id, { private: e.target.checked })}
                        aria-invalid={referenceRepoBlocked(item) ? 'true' : undefined}
                        aria-describedby={referenceRepoBlocked(item) ? privateRepoBlockedId : undefined}
                        className="h-3.5 w-3.5 rounded border-edge bg-surface"
                      />
                      Private
                    </label>
                    <Tooltip content="Remove reference repo">
                      <button
                        type="button"
                        onClick={() => removeReferenceRepo(item.id)}
                        aria-label="Remove reference repo"
                        className="inline-flex h-9 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-surface-overlay hover:text-fg"
                      >
                        <XIcon size={14} />
                      </button>
                    </Tooltip>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-edge bg-surface px-3 py-2 text-2xs">
            <span className="font-medium text-fg-secondary">{repoMode}</span>
            <span className="shrink-0 text-fg-muted">mounts under ~/repos</span>
            {repoScoped && (
              <span className="shrink-0 text-fg-muted">
                GitHub: {githubIdentitySummary(githubConnection, selectedGitHubIdentity, activeGitHubIdentityMode)}
              </span>
            )}
          </div>

          {repoScoped && (
            <label className="block">
              <span className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-fg-muted">
                GitHub identity <span className="font-normal normal-case text-fg-muted">· advanced</span>
              </span>
              <select
                value={githubIdentitySelection}
                onChange={(e) => setGitHubIdentitySelection(e.target.value)}
                className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg outline-none focus:border-edge-strong"
              >
                {githubIdentityOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {privateRepoBlocked && (
            <div
              id={privateRepoBlockedId}
              role="alert"
              className="flex items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-2xs text-fg-secondary"
            >
              <span>Connect GitHub before starting an agent with private repositories.</span>
              <button
                type="button"
                onClick={onConnectGitHub}
                className="shrink-0 rounded border border-edge bg-surface px-2 py-1 font-medium text-accent-text hover:bg-surface-overlay"
              >
                {githubConnection?.status === 'needs_auth' ? 'Reconnect GitHub' : 'Connect GitHub'}
              </button>
            </div>
          )}

          {providerProfiles.length > 0 && (
            <label className="block">
              <span className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-fg-muted">
                Profile <span className="font-normal normal-case text-fg-muted">· optional</span>
              </span>
              <select
                value={agentProfileId}
                onChange={(e) => setAgentProfileId(e.target.value)}
                className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg outline-none focus:border-edge-strong"
              >
                <option value="">Default</option>
                {providerProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-edge px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg"
          >
            Cancel
          </button>
          {!providerConnected && onRunDemo && (
            <button
              type="button"
              onClick={onRunDemo}
              className="rounded-md border border-edge-strong bg-surface px-3 py-1.5 text-xs font-semibold text-fg-secondary hover:bg-surface-overlay hover:text-fg"
            >
              Watch a demo agent
            </button>
          )}
          <Tooltip content={spawnTooltip} shortcut={SHORTCUTS.spawnSession.keys}>
            <button
              type="submit"
              aria-disabled={spawnDisabled || undefined}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-accent-hover aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            >
              Start session
            </button>
          </Tooltip>
        </footer>
      </form>
    </div>
  );
}

function githubIdentityModeForTokenKind(tokenKind: ConnectionStatus['tokenKind']): GitHubIdentityMode | null {
  switch (tokenKind) {
    case 'app_installation':
      return 'app_installation';
    case 'app_user':
      return 'app_user';
    case 'pat':
      return 'pat';
    default:
      return null;
  }
}

function githubIdentityModeLabel(mode: GitHubIdentityMode): string {
  switch (mode) {
    case 'app_installation':
      return 'App installation';
    case 'app_user':
      return 'GitHub user';
    case 'pat':
      return 'PAT';
    default:
      return 'Automatic';
  }
}

function githubAutomaticLabel(connectedMode: GitHubIdentityMode | null): string {
  return connectedMode ? `Automatic (${githubIdentityModeLabel(connectedMode)})` : 'Automatic (public unless private)';
}

function githubIdentitySummary(
  connection: ConnectionStatus | undefined,
  selectedIdentity: ConnectionIdentity | undefined,
  automaticMode: GitHubIdentityMode | null,
): string {
  const mode = selectedIdentity ? githubIdentityModeForTokenKind(selectedIdentity.tokenKind) : automaticMode;
  const account =
    selectedIdentity?.accountLabel ??
    selectedIdentity?.accountLogin ??
    connection?.accountLabel ??
    connection?.accountLogin ??
    null;
  switch (mode) {
    case 'app_installation':
      return account ? `app install for ${account}` : 'app installation';
    case 'app_user':
      return account ? `@${account} as user` : 'GitHub user';
    case 'pat':
      return account ? `PAT for @${account}` : 'PAT';
    default:
      return 'public read';
  }
}

function githubSavedIdentityLabel(identity: ConnectionIdentity): string {
  const mode = githubIdentityModeForTokenKind(identity.tokenKind);
  const account = identity.accountLabel ?? identity.accountLogin ?? null;
  const suffix = identity.active ? ' (active)' : '';
  switch (mode) {
    case 'app_installation':
      return `${account ? `App installation for ${account}` : 'App installation'}${suffix}`;
    case 'app_user':
      return `${account ? `GitHub user @${account}` : 'GitHub user'}${suffix}`;
    case 'pat':
      return `${account ? `PAT for @${account}` : 'PAT'}${suffix}`;
    default:
      return `GitHub${suffix}`;
  }
}
