// Work drawer (Phase 4) — one tabbed surface consolidating the session's work
// products (What changed · What it ran · Files) behind a single peek→pin→detach
// ladder. Opened from the summary strips; tabs switch without closing. Peek =
// overlay over the transcript; pinned = a persistent side pane the transcript
// reflows beside (single swappable slot — the DevTools dock model); detach =
// the surface in its own browser tab (/s/:id/work/:tab), the top rung.

import { useEffect } from 'react';
import type { Artifact, ArtifactPresentation, FileChange, SideEffect } from '@atrium/centaur-client';
import { Tabs, TabsContent, TabsList, TabsTrigger, Tooltip } from '../components/a11y';
import { ExternalLinkIcon, PanelRightCloseIcon, PanelRightIcon, XIcon } from '../components/icons';
import { isDesktop } from '../desktop';
import { SideEffectsSurface } from './SideEffectsSurface';
import { ConflictSurface, type ArtifactConflict, type ResolveChoice } from './ConflictSurface';
import { EmptyState } from './EmptyState';
import { FilesHub, type FilesHubDefaultScope, type FilesHubSessionScope } from './FilesHub';
import { WhatChangedSurface } from './WhatChangedSurface';
import { AppsSurface } from './AppsSurface';

export type WorkTab = 'conflicts' | 'changes' | 'sideEffects' | 'hubFiles' | 'artifacts' | 'apps';
export type ActiveWorkTab = Exclude<WorkTab, 'artifacts'>;

export function normalizeWorkTab(tab: WorkTab): ActiveWorkTab {
  return tab === 'artifacts' ? 'changes' : tab;
}

// URL-friendly slugs for the detach route (/s/:id/work/:slug). Kept here next to
// WorkTab so the drawer's detach link and App's route parser stay in lockstep.
export const TAB_SLUG: Record<ActiveWorkTab, string> = {
  conflicts: 'conflicts',
  changes: 'changes',
  sideEffects: 'side-effects',
  hubFiles: 'hub-files',
  apps: 'apps',
};
export const SLUG_TAB: Record<string, ActiveWorkTab> = {
  conflicts: 'conflicts',
  changes: 'changes',
  'side-effects': 'sideEffects',
  artifacts: 'changes',
  'hub-files': 'hubFiles',
  // Back-compat: the retired "Browse files" surface now redirects to the hub.
  files: 'hubFiles',
  apps: 'apps',
};
export const TAB_LABEL: Record<ActiveWorkTab, string> = {
  conflicts: 'Conflicts',
  changes: 'What changed',
  sideEffects: 'What it ran',
  hubFiles: 'Files',
  apps: 'Published apps',
};

function Tab({
  value,
  label,
  count,
  danger = false,
}: {
  value: ActiveWorkTab;
  label: string;
  /** Omit to render a count-less tab (e.g. Files, which is always present). */
  count?: number;
  danger?: boolean;
}) {
  return (
    <TabsTrigger
      value={value}
      className="flex items-center gap-1.5 rounded-none border-b-2 border-transparent bg-transparent px-2.5 py-2 text-xs font-semibold text-fg-muted hover:text-fg-secondary data-[state=active]:border-accent-border-strong data-[state=active]:bg-transparent data-[state=active]:text-fg"
    >
      <span>{label}</span>
      {count != null && (
        <span className={`tabular-nums font-normal ${danger ? 'text-danger-text' : 'text-fg-muted'}`}>
          · {count}
        </span>
      )}
    </TabsTrigger>
  );
}

export function WorkDrawer({
  changes,
  changedFileCount,
  effects,
  sideEffectCount,
  hasDanger,
  artifacts,
  artifactPresentations = [],
  artifactCount,
  conflicts = [],
  conflictCount = 0,
  onResolveConflict,
  sessionId,
  workspaceId,
  channelId,
  filesSessionScope,
  filesDefaultScope,
  tab,
  onTab,
  pinned,
  onTogglePin,
  canPin = true,
  canDetach = true,
  onClose,
}: {
  changes: FileChange[];
  changedFileCount: number;
  effects: SideEffect[];
  sideEffectCount: number;
  hasDanger: boolean;
  artifacts: Artifact[];
  artifactPresentations?: ArtifactPresentation[];
  artifactCount: number;
  /** Unresolved conflicts (A3). Optional — absent surfaces hide the tab. */
  conflicts?: ArtifactConflict[];
  conflictCount?: number;
  onResolveConflict?: (artifactId: string, choice: ResolveChoice) => void | Promise<void>;
  sessionId: string;
  workspaceId?: string;
  channelId?: string | null;
  filesSessionScope?: FilesHubSessionScope;
  filesDefaultScope?: FilesHubDefaultScope;
  tab: WorkTab;
  onTab: (tab: ActiveWorkTab) => void;
  pinned: boolean;
  onTogglePin: () => void;
  /** Whether the pin control is offered (mobile/peek-only ceilings hide it). */
  canPin?: boolean;
  /** Whether the detach-to-new-tab control is offered (hidden for pending
   * sessions, which have no permalink yet). */
  canDetach?: boolean;
  onClose: () => void;
}) {
  // Only non-empty surfaces get a tab; if the active tab emptied out (or never
  // had content), fall back to the first available one.
  const combinedChangeCount = changedFileCount + artifactCount;
  const counted: { key: ActiveWorkTab; label: string; count?: number; danger?: boolean }[] = [
    // Conflicts lead — an unresolved collision is the most action-worthy surface.
    { key: 'conflicts', label: TAB_LABEL.conflicts, count: conflictCount, danger: true },
    { key: 'changes', label: TAB_LABEL.changes, count: combinedChangeCount },
    { key: 'sideEffects', label: TAB_LABEL.sideEffects, count: sideEffectCount, danger: hasDanger },
  ];
  // Files (the hub) is always available — it's the single files surface now that
  // "Browse files" (FilesSurface) is retired; a missing workspace shows an empty state.
  const available = counted
    .filter((t) => (t.count ?? 0) > 0)
    .concat([
      { key: 'hubFiles', label: TAB_LABEL.hubFiles },
      { key: 'apps', label: TAB_LABEL.apps },
    ]);
  const normalizedTab = normalizeWorkTab(tab);
  const active: ActiveWorkTab = available.some((t) => t.key === normalizedTab)
    ? normalizedTab
    : available[0]?.key ?? normalizedTab;
  const showDetach = canDetach && !isDesktop;
  const pinLabel = pinned ? 'Unpin (back to overlay)' : 'Pin beside the transcript';
  const pinAriaLabel = pinned ? 'Unpin work drawer' : 'Pin work drawer';
  const detachLabel = `Open ${TAB_LABEL[active]} in a new tab`;

  useEffect(() => {
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onDocumentKeyDown, true);
    return () => document.removeEventListener('keydown', onDocumentKeyDown, true);
  }, [onClose]);

  return (
    <Tabs
      data-testid="work-drawer"
      value={active}
      onValueChange={(value) => onTab(value as ActiveWorkTab)}
      role="dialog"
      aria-label="Work"
      className={
        pinned
          ? 'flex min-h-0 flex-1 flex-col bg-surface'
          : 'absolute inset-0 z-10 flex flex-col bg-surface/95 backdrop-blur-sm'
      }
    >
      <header className="flex h-10 shrink-0 items-center border-b border-edge pr-2">
        <TabsList aria-label="Work surfaces" className="min-w-0 flex-1 gap-0 px-1">
          {available.map((t) => (
            <Tab
              key={t.key}
              value={t.key}
              label={t.label}
              count={t.count}
              danger={t.danger}
            />
          ))}
        </TabsList>
        {canPin && (
          <Tooltip content={pinLabel}>
            <button
              type="button"
              onClick={onTogglePin}
              aria-pressed={pinned}
              aria-label={pinAriaLabel}
              className={`rounded-md px-1.5 py-1 ${
                pinned
                  ? 'text-accent-text-strong hover:bg-surface-overlay'
                  : 'text-fg-tertiary hover:bg-surface-overlay hover:text-fg'
              }`}
            >
              {pinned ? <PanelRightCloseIcon size={15} /> : <PanelRightIcon size={15} />}
            </button>
          </Tooltip>
        )}
        {showDetach && (
          <Tooltip content={detachLabel}>
            <a
              href={`/s/${sessionId}/work/${TAB_SLUG[active]}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={detachLabel}
              className="rounded-md px-1.5 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
            >
              <ExternalLinkIcon size={15} />
            </a>
          </Tooltip>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close work drawer"
          className="rounded-md px-1.5 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
        >
          <XIcon size={15} />
        </button>
      </header>
      <TabsContent value="conflicts" className="min-h-0 flex-1">
        {conflicts[0] ? (
          <ConflictSurface
            conflict={conflicts[0]}
            onResolve={(choice) => onResolveConflict?.(conflicts[0]!.artifactId, choice)}
            onClose={onClose}
            embedded
          />
        ) : null}
      </TabsContent>
      <TabsContent value="changes" className="min-h-0 flex-1">
        <WhatChangedSurface
          changes={changes}
          artifacts={artifacts}
          presentations={artifactPresentations}
          sessionId={sessionId}
          onClose={onClose}
          embedded
        />
      </TabsContent>
      <TabsContent value="sideEffects" className="min-h-0 flex-1">
        <SideEffectsSurface effects={effects} onClose={onClose} embedded />
      </TabsContent>
      <TabsContent value="hubFiles" className="min-h-0 flex-1">
        {workspaceId ? (
          <FilesHub
            workspaceId={workspaceId}
            channelId={channelId}
            sessionId={sessionId}
            sessionScope={filesSessionScope}
            defaultScope={filesDefaultScope}
          />
        ) : (
          <EmptyState title="Files unavailable" hint="This session is missing workspace metadata." />
        )}
      </TabsContent>
      <TabsContent value="apps" className="min-h-0 flex-1">
        <AppsSurface sessionId={sessionId} artifacts={artifacts} presentations={artifactPresentations} embedded />
      </TabsContent>
    </Tabs>
  );
}
