// Changes work-surface (Phase 4) — the peek drawer listing the files a session
// edited, each with its synthesized diff. Opens over the transcript from the
// "Changes·N" strip; dismissible. Grouped by path, newest edit per file on top.

import { useEffect, useMemo, useState } from 'react';
import type { FileChange } from '@atrium/centaur-client';
import { XIcon } from '../components/icons';
import { EmptyState } from './EmptyState';
import { DiffView, KIND_BADGE, KIND_LABEL, diffStats } from './fileChangeView';

export function groupFileChanges(changes: FileChange[]): [string, FileChange[]][] {
  const byPath = new Map<string, FileChange[]>();
  for (const c of changes) {
    const list = byPath.get(c.path);
    if (list) list.push(c);
    else byPath.set(c.path, [c]);
  }
  return [...byPath.entries()];
}

/** One file's row: path + kind badge + a collapsible diff (every edit to the file). */
export function ChangeFileRow({ path, changes }: { path: string; changes: FileChange[] }) {
  const [open, setOpen] = useState(false);
  // Newest edit wins the displayed kind; the diff shows every edit to the file.
  const kind = changes[changes.length - 1]!.kind;
  const diff = changes.map((c) => c.diff).filter(Boolean).join('\n');
  const { adds, dels } = diffStats(diff);

  return (
    <div className="border-b border-edge last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-overlay/50"
      >
        <span
          className={`shrink-0 rounded px-1.5 py-px text-3xs font-semibold uppercase tracking-wide ${KIND_BADGE[kind]}`}
        >
          {KIND_LABEL[kind]}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-body" title={path}>
          {path}
        </span>
        {adds > 0 && <span className="shrink-0 text-2xs tabular-nums text-success-text">+{adds}</span>}
        {dels > 0 && <span className="shrink-0 text-2xs tabular-nums text-danger-text">−{dels}</span>}
      </button>
      {open && diff && <DiffView diff={diff} />}
    </div>
  );
}

export function ChangesSurface({
  changes,
  onClose,
  embedded = false,
}: {
  changes: FileChange[];
  onClose: () => void;
  /** Render body-only (no own header/overlay) — the WorkDrawer supplies the
   * chrome and counts. Standalone (false) keeps its dialog header + close. */
  embedded?: boolean;
}) {
  // Group by display path, preserving first-seen order.
  const groups = useMemo(() => groupFileChanges(changes), [changes]);

  useEffect(() => {
    if (embedded) return;
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onDocumentKeyDown, true);
    return () => document.removeEventListener('keydown', onDocumentKeyDown, true);
  }, [embedded, onClose]);

  const body = (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {groups.length === 0 ? (
        <EmptyState title="No files changed" hint="This run didn't edit any files in the repo." />
      ) : (
        groups.map(([path, fileChanges]) => (
          <ChangeFileRow key={path} path={path} changes={fileChanges} />
        ))
      )}
    </div>
  );

  if (embedded) return body;

  return (
    <div
      data-testid="changes-surface"
      role="dialog"
      aria-label="Changes"
      className="absolute inset-0 z-10 flex flex-col bg-surface/95 backdrop-blur-sm"
    >
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-edge px-3">
        <h3 className="text-xs font-semibold text-fg">
          Changes <span className="tabular-nums text-fg-muted">· {groups.length}</span>
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close changes"
          className="rounded-md px-1.5 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
        >
          <XIcon size={15} />
        </button>
      </header>
      {body}
    </div>
  );
}
