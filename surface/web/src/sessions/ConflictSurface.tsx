// Conflict-resolution surface (Phase 2 / A3). When two actors edit the same
// shared artifact concurrently the ledger records a jj-style status=conflict
// version that preserves BOTH sides (never auto-picks). This surface shows both
// sides + the base and lets a human resolve with one action. Presentational only —
// the caller fetches `GET .../artifacts/conflict` and wires `onResolve` to
// `POST .../artifacts/:id/resolve`.

import { useState } from 'react';
import { XIcon } from '../components/icons';
import { EscapeLayer, isEditableEscapeTarget, useEscapeLayer } from '../lib/escapeLayers';
import { DiffView } from './fileChangeView';

export interface ConflictSide {
  label: string;
  author: string;
  sha: string | null;
  text: string;
}
export interface ArtifactConflict {
  artifactId: string;
  path: string;
  canonicalPath?: string;
  displayPath?: string;
  kind: string;
  conflictSeq: number;
  baseSeq: number | null;
  base: { sha: string | null; text: string };
  left: ConflictSide;
  right: ConflictSide;
  markers: string;
}
export type ResolveChoice = { kind: 'left' } | { kind: 'right' } | { kind: 'merged'; text: string };

/** A minimal line diff (base → side) for the side-by-side view. */
function lineDiff(base: string, side: string): string {
  const a = base.split('\n');
  const b = side.split('\n');
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) out.push(` ${a[i] ?? ''}`);
    else {
      if (a[i] !== undefined) out.push(`-${a[i]}`);
      if (b[i] !== undefined) out.push(`+${b[i]}`);
    }
  }
  return out.join('\n');
}

function SideColumn({ side, base }: { side: ConflictSide; base: string }) {
  return (
    <div className="min-w-0 md:flex-1">
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-2xs">
        <span className="font-semibold text-fg-body">{side.label}</span>
        <span className="truncate font-mono text-fg-muted" title={side.author}>
          {side.author}
        </span>
      </div>
      <DiffView diff={lineDiff(base, side.text)} />
    </div>
  );
}

function conflictDisplayPath(conflict: ArtifactConflict): string {
  return conflict.displayPath ?? conflict.path;
}

function conflictCanonicalPath(conflict: ArtifactConflict): string | null {
  const display = conflictDisplayPath(conflict);
  const canonical = conflict.canonicalPath ?? conflict.path;
  return canonical !== display ? canonical : null;
}

export function ConflictSurface({
  conflict,
  onResolve,
  onClose,
  embedded = false,
}: {
  conflict: ArtifactConflict;
  onResolve: (choice: ResolveChoice) => void | Promise<void>;
  onClose: () => void;
  embedded?: boolean;
}) {
  const [resolving, setResolving] = useState(false);
  const [merged, setMerged] = useState(conflict.markers);

  useEscapeLayer(
    EscapeLayer.workSurface,
    (event) => {
      if (isEditableEscapeTarget(event.target)) return false;
      onClose();
      return true;
    },
    !embedded,
  );

  async function resolve(choice: ResolveChoice) {
    if (resolving) return;
    setResolving(true);
    try {
      await onResolve(choice);
    } finally {
      setResolving(false);
    }
  }

  const body = (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {embedded && (
        // The drawer chrome shows the tab but not which file — surface the path +
        // seq at the top of the body so the user knows what they're resolving.
        <div className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
          <span className="shrink-0 rounded bg-danger-surface px-1 py-px text-3xs font-semibold uppercase tracking-wide text-danger-text">
            Conflict
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-mono text-2xs text-fg-body" title={conflictDisplayPath(conflict)}>
              {conflictDisplayPath(conflict)}
            </span>
            {conflictCanonicalPath(conflict) && (
              <span
                className="truncate font-mono text-3xs text-fg-muted"
                title={conflictCanonicalPath(conflict) ?? undefined}
              >
                {conflictCanonicalPath(conflict)}
              </span>
            )}
          </span>
          <span className="shrink-0 tabular-nums text-2xs text-fg-muted">· v{conflict.conflictSeq}</span>
        </div>
      )}
      <div className="flex flex-col border-b border-edge md:flex-row">
        <SideColumn side={conflict.left} base={conflict.base.text} />
        <div className="h-px w-full shrink-0 bg-edge md:h-auto md:w-px" />
        <SideColumn side={conflict.right} base={conflict.base.text} />
      </div>

      <details className="border-b border-edge px-3 py-1.5">
        <summary className="cursor-pointer text-2xs text-fg-muted">Show conflict markers</summary>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-2xs text-fg-body">
          {conflict.markers}
        </pre>
      </details>

      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          disabled={resolving}
          onClick={() => resolve({ kind: 'left' })}
          className="rounded-md border border-edge px-2 py-1 text-2xs font-semibold text-fg-body hover:bg-surface-overlay disabled:opacity-50"
        >
          Keep theirs
        </button>
        <button
          type="button"
          disabled={resolving}
          onClick={() => resolve({ kind: 'right' })}
          className="rounded-md border border-edge px-2 py-1 text-2xs font-semibold text-fg-body hover:bg-surface-overlay disabled:opacity-50"
        >
          Keep yours
        </button>
      </div>

      <div className="px-3 pb-3">
        <label htmlFor="conflict-merged-resolution" className="text-2xs text-fg-muted">
          Edit a merged resolution
        </label>
        <textarea
          id="conflict-merged-resolution"
          aria-label="merged resolution"
          value={merged}
          onChange={(e) => setMerged(e.target.value)}
          className="mt-1 h-32 w-full resize-y rounded-md border border-edge bg-surface p-2 font-mono text-2xs text-fg-body outline-none focus:border-edge-focus"
        />
        <button
          type="button"
          disabled={resolving}
          onClick={() => resolve({ kind: 'merged', text: merged })}
          className="mt-1 rounded-md bg-accent px-2 py-1 text-2xs font-semibold text-on-accent hover:opacity-90 disabled:opacity-50"
        >
          Apply merged
        </button>
      </div>
    </div>
  );

  if (embedded) return body;

  return (
    <div
      data-testid="conflict-surface"
      role="dialog"
      aria-label="Resolve conflict"
      className="absolute inset-0 z-raised flex flex-col bg-surface/95 backdrop-blur-sm"
    >
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-edge px-3">
        <h3 className="flex min-w-0 items-center gap-2 text-xs font-semibold text-fg">
          <span className="shrink-0 rounded bg-danger-surface px-1.5 py-px text-3xs font-semibold uppercase tracking-wide text-danger-text">
            Conflict
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-mono text-fg-body" title={conflictDisplayPath(conflict)}>
              {conflictDisplayPath(conflict)}
            </span>
            {conflictCanonicalPath(conflict) && (
              <span
                className="truncate font-mono text-3xs text-fg-muted"
                title={conflictCanonicalPath(conflict) ?? undefined}
              >
                {conflictCanonicalPath(conflict)}
              </span>
            )}
          </span>
          <span className="shrink-0 tabular-nums text-fg-muted">· v{conflict.conflictSeq}</span>
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close conflict"
          className="rounded-md px-1.5 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
        >
          <XIcon size={15} />
        </button>
      </header>
      {body}
    </div>
  );
}

/** Human banner: N unresolved conflicts, click to open the resolution surface. */
export function ConflictBanner({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 border-b border-danger-edge bg-danger-surface px-3 py-1.5 text-left text-2xs text-danger-text hover:opacity-90"
    >
      <span className="font-semibold">
        {count} unresolved conflict{count === 1 ? '' : 's'}
      </span>
      <span className="text-fg-muted">— resolve</span>
    </button>
  );
}

/** Version-skew badge (#14): the working copy is frozen at `workingSeq`; if the
 * ledger latest is newer, flag it. Renders nothing when in sync. */
export function VersionSkewBadge({ workingSeq, latestSeq }: { workingSeq: number; latestSeq: number }) {
  if (latestSeq <= workingSeq) return null;
  return (
    <span className="shrink-0 rounded bg-warning-surface px-1 py-px text-3xs font-semibold text-warning-text">
      newer: v{latestSeq}
    </span>
  );
}
