// Configured spawn: the @agent grammar starts a session with defaults; this
// dialog is the richer door — pick the harness and (optionally) the repo/branch
// the agent targets. The git metadata is captured at spawn time and read by the
// Phase 4 work surfaces + side-effect gate (Centaur doesn't consume it yet).

import { useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ProviderCredentialProvider, ProviderCredentialStatus } from '../api';
import { XIcon } from '../components/icons';

const HARNESSES: { value: string; label: string }[] = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude-code', label: 'Claude Code' },
];

export interface SpawnConfig {
  task: string;
  harness: string;
  repo?: string;
  branch?: string;
}

export function SpawnDialog({
  channelName,
  onCancel,
  onSpawn,
  providerStatuses,
  onConnectProvider,
}: {
  channelName: string;
  onCancel: () => void;
  onSpawn: (config: SpawnConfig) => void;
  providerStatuses?: Record<string, ProviderCredentialStatus | undefined>;
  onConnectProvider?: (provider: ProviderCredentialProvider) => void;
}) {
  const [task, setTask] = useState('');
  const [harness, setHarness] = useState(HARNESSES[0]!.value);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');

  const claudeStatus = providerStatuses?.['claude-code'];
  const codexStatus = providerStatuses?.codex;
  const claudeUsesDefaultAuth = harness === 'claude-code' && claudeStatus?.connected !== true;
  const codexUsesDefaultAuth = harness === 'codex' && codexStatus?.connected !== true;
  const canSpawn = task.trim().length > 0;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSpawn) return;
    onSpawn({
      task: task.trim(),
      harness,
      ...(repo.trim() ? { repo: repo.trim() } : {}),
      ...(branch.trim() ? { branch: branch.trim() } : {}),
    });
  }

  // ⌘/Ctrl+Enter submits from the task textarea.
  function onTaskKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
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

          <div className="flex gap-3">
            <label className="block flex-1">
              <span className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-fg-muted">
                Repo <span className="font-normal normal-case text-fg-muted">· optional</span>
              </span>
              <input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="owner/name"
                className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-strong"
              />
            </label>
            <label className="block flex-1">
              <span className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-fg-muted">
                Branch <span className="font-normal normal-case text-fg-muted">· optional</span>
              </span>
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-strong"
              />
            </label>
          </div>
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
