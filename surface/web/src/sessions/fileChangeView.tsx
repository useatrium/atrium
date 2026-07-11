// Shared rendering for a file change's diff — used by both the Changes drawer
// (grouped per path) and the inline transcript card (per edit). One source of
// truth for the +/- colouring and the kind badge so the two surfaces never drift.

import { useState, type CSSProperties } from 'react';
import type { FileChange, FileChangeKind } from '@atrium/centaur-client';
import { ChevronDownIcon, ChevronRightIcon } from '../components/icons';

// Skip offscreen rendering work in long transcripts (parity with the other
// transcript item cards in SessionPane).
const ITEM_VIS: CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto 32px' };

export const KIND_BADGE: Record<FileChangeKind, string> = {
  add: 'bg-success/15 text-success-text',
  update: 'bg-info/15 text-info-text',
  delete: 'bg-danger/15 text-danger-text',
};
export const KIND_LABEL: Record<FileChangeKind, string> = {
  add: 'added',
  update: 'edited',
  delete: 'deleted',
};

/** Added / removed line counts from a synthesized -/+ hunk. */
export function diffStats(diff: string): { adds: number; dels: number } {
  if (!diff) return { adds: 0, dels: 0 };
  const lines = diff.split('\n');
  return {
    adds: lines.filter((l) => l.startsWith('+')).length,
    dels: lines.filter((l) => l.startsWith('-')).length,
  };
}

/** The coloured diff body (green adds, red dels, muted context). */
export function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="max-h-72 overflow-auto bg-surface px-3 py-2 font-mono text-2xs leading-relaxed">
      {diff.split('\n').map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith('+')
              ? 'text-success-text'
              : line.startsWith('-')
                ? 'text-danger-text'
                : 'text-fg-muted'
          }
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

/** Path + kind badge + add/del counts. Shared header row for both surfaces. */
function FileChangeHeader({
  change,
  open,
  status = 'done',
}: {
  change: FileChange;
  open: boolean;
  status?: 'running' | 'error' | 'done';
}) {
  const { adds, dels } = diffStats(change.diff);
  return (
    <>
      <span className="text-fg-muted">
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
      </span>
      <span
        className={`shrink-0 rounded px-1.5 py-px text-3xs font-semibold uppercase tracking-wide ${KIND_BADGE[change.kind]}`}
      >
        {KIND_LABEL[change.kind]}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-fg-body" title={change.path}>
        {change.path}
      </span>
      {adds > 0 && <span className="shrink-0 text-2xs tabular-nums text-success-text">+{adds}</span>}
      {dels > 0 && <span className="shrink-0 text-2xs tabular-nums text-danger-text">−{dels}</span>}
      {status === 'running' && (
        <span className="ml-0.5 inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent-text" />
      )}
      {status === 'error' && <span className="shrink-0 text-2xs font-semibold text-danger">error</span>}
    </>
  );
}

/**
 * Inline transcript card for a single file edit — renders the actual diff where
 * the edit happened, in place of the raw-JSON tool card. Collapsed by default
 * (calm transcript): a glanceable "edited src/app.ts +3 −1" line that expands to
 * the diff.
 */
export function InlineFileChange({
  change,
  status = 'done',
}: {
  change: FileChange;
  status?: 'running' | 'error' | 'done';
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={ITEM_VIS}
      data-testid="inline-file-change"
      className={`my-1 rounded-md border text-xs ${
        status === 'error' ? 'border-danger-border/60 bg-danger-tint/20' : 'border-edge bg-surface-raised/50'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-overlay/40"
      >
        <FileChangeHeader change={change} open={open} status={status} />
      </button>
      {open && change.diff && (
        <div className="border-t border-edge/80">
          <DiffView diff={change.diff} />
        </div>
      )}
    </div>
  );
}
