// Work drawer (Phase 4) — one tabbed surface consolidating the session's work
// products (What changed · What it ran · Files) behind a single peek→pin→detach
// ladder. Opened from the summary strips; tabs switch without closing. Peek =
// overlay over the transcript; pinned = a persistent side pane the transcript
// reflows beside (single swappable slot — the DevTools dock model); detach =
// the surface in its own browser tab (/s/:id/work/:tab), the top rung.

import { useEffect, useState } from 'react';
import type { Artifact, ArtifactPresentation, FileChange, SideEffect } from '@atrium/centaur-client';
import { fileTypeLabel, type HubFile, type HubFileListResult } from '@atrium/surface-client';
import { Tabs, TabsContent, TabsList, TabsTrigger, Tooltip } from '../components/a11y';
import { ExternalLinkIcon, PanelRightCloseIcon, PanelRightIcon, XIcon } from '../components/icons';
import { isDesktop } from '../desktop';
import { navigate } from '../router';
import { SideEffectsSurface } from './SideEffectsSurface';
import { ConflictSurface, type ArtifactConflict, type ResolveChoice } from './ConflictSurface';
import { EmptyState } from './EmptyState';
import type { FilesHubDefaultScope, FilesHubSessionScope } from './FilesHub';
import { formatGalleryBytes, galleryPathForScope, relativeFileTime } from './Gallery';
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
      className="flex items-center gap-1.5 rounded-none border-b-2 border-transparent bg-transparent px-2.5 py-2 text-xs font-semibold text-fg-muted hover:text-fg-secondary data-[state=active]:border-accent-border-strong data-[state=active]:bg-transparent data-[state=active]:text-fg max-md:min-h-11 max-md:shrink-0 max-md:whitespace-nowrap [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:whitespace-nowrap"
    >
      <span>{label}</span>
      {count != null && (
        <span className={`tabular-nums font-normal ${danger ? 'text-danger-text' : 'text-fg-muted'}`}>· {count}</span>
      )}
    </TabsTrigger>
  );
}

function sessionFilesPeekQuery(sessionId: string): URLSearchParams {
  const params = new URLSearchParams();
  params.set('sessionId', sessionId);
  params.set('sort', 'recent');
  params.set('includeScratch', 'false');
  params.set('includeDeleted', 'false');
  params.set('limit', '5');
  return params;
}

function SessionFilesPeekCard({ file, href, onOpen }: { file: HubFile; href: string; onOpen: () => void }) {
  const imageThumbnail = file.mediaKind === 'image' && file.thumbnailUrl ? file.thumbnailUrl : null;
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        onOpen();
      }}
      className="flex min-w-0 items-center gap-2 rounded-md border border-edge bg-surface-raised/45 px-2 py-2 text-left transition-colors hover:border-edge-strong hover:bg-surface-raised"
    >
      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md border border-edge bg-surface text-3xs font-semibold text-fg-muted">
        {imageThumbnail ? (
          <img src={imageThumbnail} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          fileTypeLabel(file)
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs font-semibold text-fg-body" title={file.path}>
          {file.name}
        </span>
        <span className="block truncate text-3xs text-fg-muted">
          {formatGalleryBytes(file.sizeBytes)} · {relativeFileTime(file.createdAt)}
        </span>
      </span>
    </a>
  );
}

function SessionFilesPeek({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
  const [files, setFiles] = useState<HubFile[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const href = galleryPathForScope({ sessionId });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/files?${sessionFilesPeekQuery(sessionId).toString()}`, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load session files');
        return (await response.json()) as HubFileListResult;
      })
      .then((body) => {
        setFiles(body.files);
        setNextCursor(body.nextCursor ?? null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setFiles([]);
        setNextCursor(null);
        setError(err instanceof Error ? err.message : 'Could not load session files');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [sessionId, workspaceId]);

  const openGallery = () => navigate(href);
  const count = `${files.length}${nextCursor ? '+' : ''}`;
  const countLabel = loading
    ? 'Loading files...'
    : `${count} ${files.length === 1 && !nextCursor ? 'file' : 'files'} in this session`;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex shrink-0 items-center gap-3 border-b border-edge px-3 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-fg">{countLabel}</h3>
          <p className="mt-0.5 truncate text-2xs text-fg-muted">
            Files you upload and files agents create appear in Gallery.
          </p>
        </div>
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault();
            openGallery();
          }}
          className="shrink-0 rounded-md border border-accent-border bg-accent-tint px-2.5 py-1.5 text-2xs font-semibold text-accent-text-strong hover:bg-accent-soft"
        >
          Open in Gallery →
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error && (
          <div role="alert" className="text-2xs text-danger-text">
            {error}
          </div>
        )}
        {!error && !loading && files.length === 0 && (
          <EmptyState title="No agent files" hint="Files touched by this session will appear here." />
        )}
        {!error && files.length > 0 && (
          <div className="grid gap-2">
            {files.map((file) => (
              <SessionFilesPeekCard key={file.artifactId} file={file} href={href} onOpen={openGallery} />
            ))}
          </div>
        )}
      </div>
    </div>
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
    : (available[0]?.key ?? normalizedTab);
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
          : 'absolute inset-0 z-raised flex flex-col bg-surface/95 backdrop-blur-sm'
      }
    >
      <header className="flex h-10 min-w-0 shrink-0 items-center border-b border-edge pr-2 max-md:h-11 [@media(pointer:coarse)]:h-11">
        <div className="min-w-0 flex-1 max-md:overflow-x-auto max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden [@media(pointer:coarse)]:overflow-x-auto">
          <TabsList aria-label="Work surfaces" className="w-max min-w-full flex-nowrap gap-0 px-1">
            {available.map((t) => (
              <Tab key={t.key} value={t.key} label={t.label} count={t.count} danger={t.danger} />
            ))}
          </TabsList>
        </div>
        {canPin && (
          <Tooltip content={pinLabel}>
            <button
              type="button"
              onClick={onTogglePin}
              aria-pressed={pinned}
              aria-label={pinAriaLabel}
              className={`rounded-md px-1.5 py-1 max-md:inline-flex max-md:size-11 max-md:shrink-0 max-md:items-center max-md:justify-center max-md:p-0 [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:shrink-0 [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center [@media(pointer:coarse)]:p-0 ${
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
              className="rounded-md px-1.5 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg max-md:inline-flex max-md:size-11 max-md:shrink-0 max-md:items-center max-md:justify-center max-md:p-0 [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:shrink-0 [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center [@media(pointer:coarse)]:p-0"
            >
              <ExternalLinkIcon size={15} />
            </a>
          </Tooltip>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close work drawer"
          className="rounded-md px-1.5 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg max-md:inline-flex max-md:size-11 max-md:shrink-0 max-md:items-center max-md:justify-center max-md:p-0 [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:shrink-0 [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center [@media(pointer:coarse)]:p-0"
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
          <SessionFilesPeek workspaceId={workspaceId} sessionId={sessionId} />
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
