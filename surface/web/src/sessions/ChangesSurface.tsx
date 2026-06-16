// Changes work-surface (Phase 4) — the peek drawer listing the files a session
// edited, each with its synthesized diff. Opens over the transcript from the
// "Changes·N" strip; dismissible. Grouped by path, newest edit per file on top.

import { useMemo, useState } from 'react';
import type { FileChange, FileChangeKind } from '@atrium/centaur-client';
import { XIcon } from '../components/icons';

const KIND_BADGE: Record<FileChangeKind, string> = {
  add: 'bg-success/15 text-success-text',
  update: 'bg-info/15 text-info-text',
  delete: 'bg-danger/15 text-danger-text',
};
const KIND_LABEL: Record<FileChangeKind, string> = { add: 'added', update: 'edited', delete: 'deleted' };

/** One file's row: path + kind badge + a collapsible diff. */
function FileRow({ path, changes }: { path: string; changes: FileChange[] }) {
  const [open, setOpen] = useState(false);
  // Newest edit wins the displayed kind; the diff shows every edit to the file.
  const kind = changes[changes.length - 1]!.kind;
  const diff = changes.map((c) => c.diff).filter(Boolean).join('\n');
  const adds = diff.split('\n').filter((l) => l.startsWith('+')).length;
  const dels = diff.split('\n').filter((l) => l.startsWith('-')).length;

  return (
    <div className="border-b border-edge last:border-b-0">
      <button
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
      {open && diff && (
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
      )}
    </div>
  );
}

export function ChangesSurface({
  changes,
  onClose,
}: {
  changes: FileChange[];
  onClose: () => void;
}) {
  // Group by display path, preserving first-seen order.
  const groups = useMemo(() => {
    const byPath = new Map<string, FileChange[]>();
    for (const c of changes) {
      const list = byPath.get(c.path);
      if (list) list.push(c);
      else byPath.set(c.path, [c]);
    }
    return [...byPath.entries()];
  }, [changes]);

  return (
    <div
      data-testid="changes-surface"
      className="absolute inset-0 z-10 flex flex-col bg-surface/95 backdrop-blur-sm"
    >
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-edge px-3">
        <h3 className="text-xs font-semibold text-fg">
          Changes <span className="tabular-nums text-fg-muted">· {groups.length}</span>
        </h3>
        <button
          onClick={onClose}
          aria-label="Close changes"
          className="rounded-md px-1.5 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
        >
          <XIcon size={15} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.map(([path, fileChanges]) => (
          <FileRow key={path} path={path} changes={fileChanges} />
        ))}
      </div>
    </div>
  );
}
