// Detach rung (Phase 4) — a standalone, full-viewport view of one work surface
// (Changes · Side-effects · Artifacts), opened in its own browser tab via
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
import { ArtifactsSurface } from './ArtifactsSurface';
import { ChangesSurface } from './ChangesSurface';
import { SideEffectsSurface } from './SideEffectsSurface';
import { TAB_LABEL, type WorkTab } from './WorkDrawer';

const noop = () => {};

export function SessionWorkPage({ sessionId, tab }: { sessionId: string; tab: WorkTab }) {
  const { stream, connected } = useSessionStream(sessionId);

  const changes = useMemo(() => collectFileChanges(stream), [stream.items, stream.fileChanges]);
  const effects = useMemo(() => collectSideEffects(stream.items), [stream.items]);
  const artifacts = useMemo(() => collectArtifacts(stream), [stream.artifacts]);

  const count =
    tab === 'changes'
      ? changedPaths(changes).length
      : tab === 'sideEffects'
        ? sideEffectCount(effects)
        : artifactCount(artifacts);

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
          {TAB_LABEL[tab]} <span className="tabular-nums text-fg-muted">· {count}</span>
        </h1>
        {!connected && <span className="ml-auto text-2xs text-fg-tertiary">connecting…</span>}
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {tab === 'changes' ? (
          <ChangesSurface changes={changes} onClose={noop} embedded />
        ) : tab === 'sideEffects' ? (
          <SideEffectsSurface effects={effects} onClose={noop} embedded />
        ) : (
          <ArtifactsSurface artifacts={artifacts} sessionId={sessionId} onClose={noop} embedded />
        )}
      </div>
    </div>
  );
}
