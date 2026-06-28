// Configured spawn: the @agent grammar starts a session with defaults; this
// dialog captures the harness and optional repo specs Centaur mounts into the
// sandbox for the run.

import { useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AgentProfile, ProviderCredentialProvider, ProviderCredentialStatus } from '../api';
import { PlusIcon, XIcon } from '../components/icons';

const HARNESSES: { value: string; label: string }[] = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude-code', label: 'Claude Code' },
];

export interface SpawnConfig {
  task: string;
  harness: string;
  repo?: string;
  branch?: string;
  repos?: { repo: string; ref?: string; subdir?: string }[];
  agentProfileId?: string;
  agentProfileVersionId?: string;
}

type ReferenceRepoInput = {
  id: string;
  repo: string;
  ref: string;
  subdir: string;
};

export function SpawnDialog({
  channelName,
  onCancel,
  onSpawn,
  providerStatuses,
  profiles = [],
  onConnectProvider,
}: {
  channelName: string;
  onCancel: () => void;
  onSpawn: (config: SpawnConfig) => void;
  providerStatuses?: Record<string, ProviderCredentialStatus | undefined>;
  profiles?: AgentProfile[];
  onConnectProvider?: (provider: ProviderCredentialProvider) => void;
}) {
  const [task, setTask] = useState('');
  const [harness, setHarness] = useState(HARNESSES[0]!.value);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [referenceRepos, setReferenceRepos] = useState<ReferenceRepoInput[]>([]);
  const [agentProfileId, setAgentProfileId] = useState('');

  const claudeStatus = providerStatuses?.['claude-code'];
  const codexStatus = providerStatuses?.codex;
  const claudeUsesDefaultAuth = harness === 'claude-code' && claudeStatus?.connected !== true;
  const codexUsesDefaultAuth = harness === 'codex' && codexStatus?.connected !== true;
  const canSpawn = task.trim().length > 0;
  const providerProfiles = profiles.filter(
    (profile) => profile.provider === harness && profile.currentVersionId,
  );
  const selectedProfile = providerProfiles.find((profile) => profile.id === agentProfileId);
  const activeReferenceCount = referenceRepos.filter((item) => item.repo.trim().length > 0).length;
  const repoMode = repo.trim()
    ? activeReferenceCount > 0
      ? `Working repo + ${activeReferenceCount} reference ${activeReferenceCount === 1 ? 'repo' : 'repos'}`
      : 'Working repo'
    : activeReferenceCount > 0
      ? `${activeReferenceCount} reference ${activeReferenceCount === 1 ? 'repo' : 'repos'}`
      : 'No repo selected';

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSpawn) return;
    const trimmedRepo = repo.trim();
    const trimmedBranch = branch.trim();
    const repos = [
      ...(trimmedRepo ? [{ repo: trimmedRepo, ...(trimmedBranch ? { ref: trimmedBranch } : {}) }] : []),
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
      ...(selectedProfile ? { agentProfileId: selectedProfile.id } : {}),
      ...(selectedProfile?.currentVersionId ? { agentProfileVersionId: selectedProfile.currentVersionId } : {}),
    });
  }

  // ⌘/Ctrl+Enter submits from the task textarea.
  function onTaskKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
  }

  function addReferenceRepo() {
    setReferenceRepos((items) => [...items, { id: crypto.randomUUID(), repo: '', ref: '', subdir: '' }]);
  }

  function updateReferenceRepo(id: string, patch: Partial<Omit<ReferenceRepoInput, 'id'>>) {
    setReferenceRepos((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function removeReferenceRepo(id: string) {
    setReferenceRepos((items) => items.filter((item) => item.id !== id));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-surface/60 p-4"
      onClick={onCancel}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      role="dialog"
      aria-modal="true"
      aria-label="Start an agent session"
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="mt-24 w-[min(520px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-edge-strong bg-surface-raised shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-edge px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-fg">New agent session</h2>
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
            <span className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-fg-muted">
              Task
            </span>
            <textarea
              autoFocus
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={onTaskKeyDown}
              rows={3}
              placeholder="What should the agent do?"
              className="w-full resize-y rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-strong"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-fg-muted">
              Harness
            </span>
            <select
              value={harness}
              onChange={(e) => setHarness(e.target.value)}
              className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg outline-none focus:border-edge-strong"
            >
              {HARNESSES.map((h) => (
                <option key={h.value} value={h.value}>
                  {h.label}
                </option>
              ))}
            </select>
          </label>

          {/* Calm, neutral note (not a warning / live region): the default auth
              already works; Connect is an opt-in upgrade, not an error. */}
          {claudeUsesDefaultAuth && (
            <div className="rounded-md border border-edge bg-surface px-3 py-2 text-2xs leading-relaxed text-fg-muted">
              Using Atrium&rsquo;s default agent auth.{' '}
              <button
                type="button"
                onClick={() => onConnectProvider?.('claude-code')}
                className="font-medium text-accent-text hover:text-accent-text-strong hover:underline"
              >
                Connect Claude
              </button>{' '}
              to run on your own subscription.
            </div>
          )}

          {codexUsesDefaultAuth && (
            <div className="rounded-md border border-edge bg-surface px-3 py-2 text-2xs leading-relaxed text-fg-muted">
              Using Atrium&rsquo;s default agent auth.{' '}
              <button
                type="button"
                onClick={() => onConnectProvider?.('codex')}
                className="font-medium text-accent-text hover:text-accent-text-strong hover:underline"
              >
                Connect Codex
              </button>{' '}
              to run on your own subscription.
            </div>
          )}

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="block text-2xs font-semibold uppercase tracking-wider text-fg-muted">
                Working repo <span className="font-normal normal-case text-fg-muted">· optional</span>
              </span>
              <span className="text-2xs text-fg-muted">~/repos/&lt;owner&gt;/&lt;repo&gt;</span>
            </div>
            <div className="flex gap-3">
              <label className="block flex-1">
                <span className="sr-only">Working repo</span>
                <input
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="owner/name"
                  className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-strong"
                />
              </label>
              <label className="block flex-1">
                <span className="sr-only">Working ref</span>
                <input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                  className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-strong"
                />
              </label>
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="block text-2xs font-semibold uppercase tracking-wider text-fg-muted">
                Reference repos <span className="font-normal normal-case text-fg-muted">· optional</span>
              </span>
              <button
                type="button"
                onClick={addReferenceRepo}
                aria-label="Add reference repo"
                title="Add reference repo"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-overlay hover:text-fg"
              >
                <PlusIcon size={14} />
              </button>
            </div>
            {referenceRepos.length > 0 && (
              <div className="space-y-2">
                {referenceRepos.map((item) => (
                  <div key={item.id} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_2rem] gap-2">
                    <label>
                      <span className="sr-only">Reference repo</span>
                      <input
                        value={item.repo}
                        onChange={(e) => updateReferenceRepo(item.id, { repo: e.target.value })}
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
                    <button
                      type="button"
                      onClick={() => removeReferenceRepo(item.id)}
                      aria-label="Remove reference repo"
                      title="Remove reference repo"
                      className="inline-flex h-9 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-surface-overlay hover:text-fg"
                    >
                      <XIcon size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border border-edge bg-surface px-3 py-2 text-2xs">
            <span className="font-medium text-fg-secondary">{repoMode}</span>
            <span className="shrink-0 text-fg-muted">mounts under ~/repos</span>
          </div>

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
          <button
            type="submit"
            disabled={!canSpawn}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Start session
          </button>
        </footer>
      </form>
    </div>
  );
}
