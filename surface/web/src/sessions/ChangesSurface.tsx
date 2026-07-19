// Changes work-surface (Phase 4) — the peek drawer listing the files a session
// edited, each with its synthesized diff. Opens over the transcript from the
// "Changes·N" strip; dismissible. Grouped by path, newest edit per file on top.

import { useState } from 'react';
import type { FileChange } from '@atrium/centaur-client';
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
  const diff = changes
    .map((c) => c.diff)
    .filter(Boolean)
    .join('\n');
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
