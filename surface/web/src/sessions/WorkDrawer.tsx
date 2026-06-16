// Work drawer (Phase 4) — one tabbed surface consolidating the session's work
// products (Changes · Side-effects · Artifacts) behind a single peek→pin ladder.
// Opened from the summary strips; tabs switch without closing. Peek = overlay
// over the transcript; pinned = a persistent side pane the transcript reflows
// beside (single swappable slot — the DevTools dock model).

import type { Artifact, FileChange, SideEffect } from '@atrium/centaur-client';
import { PanelRightCloseIcon, PanelRightIcon, XIcon } from '../components/icons';
import { ArtifactsSurface } from './ArtifactsSurface';
import { ChangesSurface } from './ChangesSurface';
import { SideEffectsSurface } from './SideEffectsSurface';

export type WorkTab = 'changes' | 'sideEffects' | 'artifacts';

function Tab({
  active,
  onClick,
  label,
  count,
  danger = false,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  danger?: boolean;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-xs font-semibold ${
        active
          ? 'border-accent-border-strong text-fg'
          : 'border-transparent text-fg-muted hover:text-fg-secondary'
      }`}
    >
      <span>{label}</span>
      <span className={`tabular-nums font-normal ${danger ? 'text-danger-text' : 'text-fg-muted'}`}>
        · {count}
      </span>
    </button>
  );
}

export function WorkDrawer({
  changes,
  changedFileCount,
  effects,
  sideEffectCount,
  hasDanger,
  artifacts,
  artifactCount,
  sessionId,
  tab,
  onTab,
  pinned,
  onTogglePin,
  canPin = true,
  onClose,
}: {
  changes: FileChange[];
  changedFileCount: number;
  effects: SideEffect[];
  sideEffectCount: number;
  hasDanger: boolean;
  artifacts: Artifact[];
  artifactCount: number;
  sessionId: string;
  tab: WorkTab;
  onTab: (tab: WorkTab) => void;
  pinned: boolean;
  onTogglePin: () => void;
  /** Whether the pin control is offered (mobile/peek-only ceilings hide it). */
  canPin?: boolean;
  onClose: () => void;
}) {
  // Only non-empty surfaces get a tab; if the active tab emptied out (or never
  // had content), fall back to the first available one.
  const available = (
    [
      { key: 'changes' as const, label: 'Changes', count: changedFileCount },
      { key: 'sideEffects' as const, label: 'Side-effects', count: sideEffectCount, danger: hasDanger },
      { key: 'artifacts' as const, label: 'Artifacts', count: artifactCount },
    ] satisfies { key: WorkTab; label: string; count: number; danger?: boolean }[]
  ).filter((t) => t.count > 0);
  const active: WorkTab = available.some((t) => t.key === tab) ? tab : available[0]?.key ?? tab;

  return (
    <div
      data-testid="work-drawer"
      role="dialog"
      aria-label="Work"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      className={
        pinned
          ? 'flex min-h-0 flex-1 flex-col bg-surface'
          : 'absolute inset-0 z-10 flex flex-col bg-surface/95 backdrop-blur-sm'
      }
    >
      <header className="flex h-10 shrink-0 items-center border-b border-edge pr-2">
        <div role="tablist" aria-label="Work surfaces" className="flex min-w-0 flex-1 items-center px-1">
          {available.map((t) => (
            <Tab
              key={t.key}
              active={active === t.key}
              onClick={() => onTab(t.key)}
              label={t.label}
              count={t.count}
              danger={t.danger}
            />
          ))}
        </div>
        {canPin && (
          <button
            onClick={onTogglePin}
            aria-pressed={pinned}
            title={pinned ? 'Unpin (back to overlay)' : 'Pin beside the transcript'}
            aria-label={pinned ? 'Unpin work drawer' : 'Pin work drawer'}
            className={`rounded-md px-1.5 py-1 ${
              pinned
                ? 'text-accent-text-strong hover:bg-surface-overlay'
                : 'text-fg-tertiary hover:bg-surface-overlay hover:text-fg'
            }`}
          >
            {pinned ? <PanelRightCloseIcon size={15} /> : <PanelRightIcon size={15} />}
          </button>
        )}
        <button
          onClick={onClose}
          aria-label="Close work drawer"
          className="rounded-md px-1.5 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
        >
          <XIcon size={15} />
        </button>
      </header>
      {active === 'changes' ? (
        <ChangesSurface changes={changes} onClose={onClose} embedded />
      ) : active === 'sideEffects' ? (
        <SideEffectsSurface effects={effects} onClose={onClose} embedded />
      ) : (
        <ArtifactsSurface artifacts={artifacts} sessionId={sessionId} onClose={onClose} embedded />
      )}
    </div>
  );
}
