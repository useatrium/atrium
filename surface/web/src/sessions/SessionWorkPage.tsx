// Detach rung (Phase 4) — a standalone, full-viewport view of one work surface
// (What changed · What it ran · Browse files), opened in its own browser tab via
// /s/:id/work/:slug from the drawer's ⤢ control. It folds the same live session
// stream the in-app pane does, so the detached tab stays in sync — one source of
// truth, many views (never a copy). Top of the peek→pin→detach ladder.

import { useMemo } from 'react';
import {
  artifactCount,
  changedPaths,
  collectArtifacts,
  collectFileChanges,
  collectSideEffects,
  sideEffectCount,
} from '@atrium/centaur-client';
import { useSessionStream } from './useSessionStream';
import { ConflictSurface } from './ConflictSurface';
import { EmptyState } from './EmptyState';
import { FilesSurface } from './FilesSurface';
import { SideEffectsSurface } from './SideEffectsSurface';
import { AppsSurface } from './AppsSurface';
import { TAB_LABEL, normalizeWorkTab, type WorkTab } from './WorkDrawer';
import { WhatChangedSurface } from './WhatChangedSurface';
import { useConflicts } from './useConflicts';
import { useArtifactPresentations } from './useArtifactPresentations';

const noop = () => {};

function assertNever(tab: never): never {
  throw new Error(`Unhandled work tab: ${tab}`);
}

export function SessionWorkPage({ sessionId, tab }: { sessionId: string; tab: WorkTab }) {
  const activeTab = normalizeWorkTab(tab);
  const { stream, connected } = useSessionStream(sessionId);
  const { conflicts, resolve: resolveConflict } = useConflicts(sessionId, { enabled: activeTab === 'conflicts' });

  const changes = useMemo(() => collectFileChanges(stream), [stream.items, stream.fileChanges]);
  const effects = useMemo(() => collectSideEffects(stream.items), [stream.items]);
  const artifacts = useMemo(() => collectArtifacts(stream), [stream.artifacts]);
  const artifactPresentations = useArtifactPresentations(sessionId, stream);

  const count = (() => {
    switch (activeTab) {
      case 'conflicts':
        return conflicts.length;
      case 'changes':
        return changedPaths(changes).length + artifactCount(artifacts);
      case 'sideEffects':
        return sideEffectCount(effects);
      case 'files':
        return null;
      case 'apps':
        return null;
      default:
        return assertNever(activeTab);
    }
  })();

  function surface() {
    switch (activeTab) {
      case 'conflicts':
        return conflicts[0] ? (
          <ConflictSurface
            conflict={conflicts[0]}
            onResolve={(choice) => resolveConflict(conflicts[0]!.artifactId, choice)}
            onClose={noop}
            embedded
          />
        ) : (
          <EmptyState title="No conflicts" hint="Unresolved artifact conflicts will appear here." />
        );
      case 'changes':
        return (
          <WhatChangedSurface
            changes={changes}
            artifacts={artifacts}
            presentations={artifactPresentations}
            sessionId={sessionId}
            onClose={noop}
            embedded
          />
        );
      case 'sideEffects':
        return <SideEffectsSurface effects={effects} onClose={noop} embedded />;
      case 'files':
        return <FilesSurface sessionId={sessionId} onClose={noop} embedded />;
      case 'apps':
        return <AppsSurface sessionId={sessionId} artifacts={artifacts} presentations={artifactPresentations} embedded />;
      default:
        return assertNever(activeTab);
    }
  }

  return (
    <div data-testid="session-work-page" className="flex h-dvh flex-col bg-surface">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-edge px-3">
        <a
          href={`/s/${sessionId}`}
          className="rounded-md px-1.5 py-1 text-xs text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
        >
          ← Full session
        </a>
        <h1 className="text-sm font-semibold text-fg">
          {TAB_LABEL[activeTab]}
          {count != null && <span className="tabular-nums text-fg-muted"> · {count}</span>}
        </h1>
        {!connected && <span className="ml-auto text-2xs text-fg-tertiary">connecting…</span>}
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">{surface()}</div>
    </div>
  );
}
