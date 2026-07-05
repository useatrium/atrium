import { useEffect, useRef, useState } from 'react';
import {
  formatExactTimestamp,
  formatRelativeTimestamp,
  type EntryReferenceMap,
  type EntryReferenceSummary,
} from '@atrium/surface-client';
import { api } from '../api';
import { Tooltip } from './a11y';

export type EntryReferencesByHandle = EntryReferenceMap;
export type { EntryReferenceSummary };

export const ENTRY_REFERENCES_CHUNK_SIZE = 200;

export async function queryEntryReferencesForHandles(handles: string[]): Promise<EntryReferencesByHandle> {
  if (handles.length === 0) return {};
  const references: EntryReferencesByHandle = {};
  for (let i = 0; i < handles.length; i += ENTRY_REFERENCES_CHUNK_SIZE) {
    const chunk = handles.slice(i, i + ENTRY_REFERENCES_CHUNK_SIZE);
    const response = await api.queryEntryReferences(chunk);
    Object.assign(references, response.references as EntryReferencesByHandle);
  }
  return references;
}

export function EntryReferencesChip({
  summary,
  onNavigate = navigateToEntry,
}: {
  summary: EntryReferenceSummary | null | undefined;
  onNavigate?: (handle: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  if (!summary || summary.count <= 0) return null;
  const refs = summary.latest;
  const single = summary.count === 1 && refs.length === 1;
  const discussionLabel = `${summary.count} ${summary.count === 1 ? 'discussion' : 'discussions'}`;
  return (
    <div className="relative">
      <Tooltip content={discussionLabel}>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            if (single) onNavigate(refs[0]!.handle);
            else setOpen((value) => !value);
          }}
          aria-label={discussionLabel}
          aria-expanded={single ? undefined : open}
          aria-haspopup={single ? undefined : 'dialog'}
          className="inline-flex items-center gap-1 rounded-full border border-edge bg-surface-overlay/80 px-1.5 py-0.5 text-3xs font-medium tabular-nums text-fg-muted shadow-sm hover:border-edge-strong hover:text-fg-secondary"
        >
          <span aria-hidden="true">↗</span>
          <span>{summary.count}</span>
        </button>
      </Tooltip>
      {open && !single && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Entry discussions"
          className="absolute right-0 z-20 mt-1 w-72 rounded-md border border-edge-strong bg-surface-overlay p-1 shadow-lg"
        >
          {refs.map((ref) => {
            const relativeTimestamp = formatRelativeTimestamp(ref.ts);
            const exactTimestamp = formatExactTimestamp(ref.ts);
            const actor = ref.actorLabel ?? 'Someone';
            const rowLabel = [actor, exactTimestamp ? `created ${exactTimestamp}` : null, ref.excerpt]
              .filter(Boolean)
              .join(', ');
            return (
              <button
                key={`${ref.eventId}:${ref.handle}`}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onNavigate(ref.handle);
                }}
                aria-label={rowLabel}
                className="block w-full rounded px-2 py-1.5 text-left hover:bg-edge-strong"
              >
                <div className="flex min-w-0 items-center gap-2 text-2xs">
                  <span className="truncate font-medium text-fg-secondary">{actor}</span>
                  {relativeTimestamp && (
                    <span
                      className="shrink-0 text-fg-faint"
                      title={exactTimestamp || undefined}
                      aria-label={exactTimestamp ? `Exact timestamp: ${exactTimestamp}` : undefined}
                    >
                      {relativeTimestamp}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 line-clamp-2 text-xs leading-snug text-fg-muted">{ref.excerpt}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function navigateToEntry(handle: string) {
  window.location.assign(`/e/${encodeURIComponent(handle)}`);
}
