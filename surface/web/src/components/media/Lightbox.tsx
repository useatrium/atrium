import { useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';
import { MediaPreview } from './MediaPreview';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  DownloadIcon,
  EditIcon,
  InfoIcon,
  LinkIcon,
  MessageIcon,
  TrashIcon,
} from './Icon';
import type { LightboxCallbacks, PreviewFile } from './types';
import { effectiveMediaKind, formatBytes, formatDateTime, kindLabel } from './utils';

interface LightboxProps extends LightboxCallbacks {
  files: PreviewFile[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

const iconButtonClass =
  'grid size-8 place-items-center rounded-md border border-edge-strong bg-surface-overlay text-fg-secondary shadow-sm hover:bg-edge-strong hover:text-fg disabled:cursor-default disabled:text-fg-faint';

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 truncate text-fg-secondary" title={value}>
        {value}
      </dd>
    </>
  );
}

export function Lightbox({
  files,
  index,
  onIndexChange,
  onClose,
  onDownload,
  onCopyLink,
  onRename,
  onDelete,
  onComment,
  canManage,
}: LightboxProps) {
  const file = files[index];
  const [infoOpen, setInfoOpen] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(file?.name ?? '');
  const [busy, setBusy] = useState(false);
  const touchStartRef = useRef<number | null>(null);
  const canPrev = index > 0;
  const canNext = index < files.length - 1;
  const manageable = file ? canManage?.(file) === true : false;

  useEffect(() => {
    setDraftName(file?.name ?? '');
    setRenaming(false);
  }, [file]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && canPrev) onIndexChange(index - 1);
      if (event.key === 'ArrowRight' && canNext) onIndexChange(index + 1);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canNext, canPrev, index, onClose, onIndexChange]);

  const details = useMemo(() => {
    if (!file) return [];
    const kind = effectiveMediaKind(file);
    const dimensions = file.width && file.height ? `${file.width} x ${file.height}` : 'Unknown';
    return [
      ['Kind', kindLabel(kind)],
      ['MIME', file.mime || 'Unknown'],
      ['Size', formatBytes(file.sizeBytes)],
      ['Dimensions', dimensions],
      ['Uploader', file.uploader?.name ?? file.uploader?.id ?? 'Unknown'],
      ['Created', formatDateTime(file.createdAt)],
      ['Source', file.source?.label ?? file.source?.id ?? 'Unknown'],
    ] as const;
  }, [file]);

  if (!file) return null;

  const submitRename = async () => {
    const nextName = draftName.trim();
    if (!nextName || nextName === file.name || !onRename) {
      setRenaming(false);
      setDraftName(file.name);
      return;
    }
    setBusy(true);
    try {
      await onRename(file, nextName);
      setRenaming(false);
    } finally {
      setBusy(false);
    }
  };

  const deleteFile = async () => {
    if (!onDelete) return;
    if (!window.confirm(`Delete ${file.name}?`)) return;
    setBusy(true);
    try {
      await onDelete(file);
    } finally {
      setBusy(false);
    }
  };

  const onTouchStart = (event: TouchEvent<HTMLElement>) => {
    touchStartRef.current = event.touches[0]?.clientX ?? null;
  };

  const onTouchEnd = (event: TouchEvent<HTMLElement>) => {
    const start = touchStartRef.current;
    const end = event.changedTouches[0]?.clientX;
    touchStartRef.current = null;
    if (start == null || end == null) return;
    const delta = end - start;
    if (Math.abs(delta) < 55) return;
    if (delta > 0 && canPrev) onIndexChange(index - 1);
    if (delta < 0 && canNext) onIndexChange(index + 1);
  };

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-surface text-fg shadow-2xl" role="dialog" aria-modal="true">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge bg-surface-raised px-3">
        <button type="button" className={iconButtonClass} onClick={onClose} aria-label="Close lightbox" title="Close">
          <CloseIcon size={16} />
        </button>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              className="flex max-w-xl items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submitRename();
              }}
            >
              <input
                className="min-w-0 flex-1 rounded-md border border-edge-strong bg-surface px-2 py-1 text-sm text-fg outline-none focus:border-accent-hover"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                disabled={busy}
                autoFocus
              />
              <button className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-on-accent disabled:bg-surface-overlay disabled:text-fg-muted">
                Save
              </button>
              <button
                type="button"
                className="rounded-md px-2.5 py-1 text-xs text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
                onClick={() => {
                  setRenaming(false);
                  setDraftName(file.name);
                }}
              >
                Cancel
              </button>
            </form>
          ) : (
            <>
              <div className="truncate text-sm font-semibold text-fg">{file.name}</div>
              <div className="truncate text-2xs text-fg-muted">
                {index + 1} of {files.length} · {kindLabel(effectiveMediaKind(file))}
              </div>
            </>
          )}
        </div>
        <button
          type="button"
          className={iconButtonClass}
          onClick={() => onDownload?.(file)}
          disabled={!onDownload}
          aria-label="Download file"
          title="Download"
        >
          <DownloadIcon size={16} />
        </button>
        <button
          type="button"
          className={iconButtonClass}
          onClick={() => onCopyLink?.(file)}
          disabled={!onCopyLink}
          aria-label="Copy file link"
          title="Copy link"
        >
          <LinkIcon size={16} />
        </button>
        <button
          type="button"
          className={`${iconButtonClass} ${infoOpen ? 'border-accent-border text-accent-text-strong' : ''}`}
          onClick={() => setInfoOpen((open) => !open)}
          aria-label="Toggle info panel"
          title="Info"
        >
          <InfoIcon size={16} />
        </button>
      </header>

      <main className="min-h-0 flex-1" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_auto]">
          <section className="relative min-h-0 bg-surface">
            <MediaPreview file={file} variant="full" />
            <button
              type="button"
              className="absolute left-3 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full border border-edge-strong bg-surface-overlay/95 text-fg-secondary shadow-lg hover:bg-edge-strong hover:text-fg disabled:opacity-30"
              onClick={() => onIndexChange(index - 1)}
              disabled={!canPrev}
              aria-label="Previous file"
            >
              <ChevronLeftIcon size={20} />
            </button>
            <button
              type="button"
              className="absolute right-3 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full border border-edge-strong bg-surface-overlay/95 text-fg-secondary shadow-lg hover:bg-edge-strong hover:text-fg disabled:opacity-30"
              onClick={() => onIndexChange(index + 1)}
              disabled={!canNext}
              aria-label="Next file"
            >
              <ChevronRightIcon size={20} />
            </button>
          </section>

          {infoOpen && (
            <aside className="flex w-[min(340px,38vw)] min-w-72 flex-col border-l border-edge bg-surface-raised">
              <div className="border-b border-edge px-4 py-3">
                <div className="text-xs font-semibold text-fg">Info</div>
                <dl className="mt-3 grid grid-cols-[5.75rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                  {details.map(([label, value]) => (
                    <InfoRow key={label} label={label} value={value} />
                  ))}
                </dl>
              </div>
              {manageable && (
                <div className="border-b border-edge px-4 py-3">
                  <div className="mb-2 text-3xs font-semibold uppercase tracking-wider text-fg-muted">Manage</div>
                  <div className="flex flex-wrap gap-2">
                    {onRename && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-md border border-edge-strong px-2 py-1 text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg"
                        onClick={() => setRenaming(true)}
                      >
                        <EditIcon size={13} />
                        Rename
                      </button>
                    )}
                    {onComment && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-md border border-edge-strong px-2 py-1 text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg"
                        onClick={() => onComment(file)}
                      >
                        <MessageIcon size={13} />
                        Comment
                      </button>
                    )}
                    {onDelete && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-md border border-danger-border px-2 py-1 text-xs text-danger-text hover:bg-danger-tint disabled:opacity-50"
                        onClick={() => void deleteFile()}
                        disabled={busy}
                      >
                        <TrashIcon size={13} />
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              )}
            </aside>
          )}
        </div>
      </main>

      <footer className="flex h-20 shrink-0 items-center gap-2 overflow-x-auto border-t border-edge bg-surface-raised px-3">
        {files.map((item, itemIndex) => (
          <button
            type="button"
            key={item.id}
            className={`h-14 w-20 shrink-0 overflow-hidden rounded-md border text-left transition-colors ${
              itemIndex === index ? 'border-accent-border bg-accent-tint' : 'border-edge bg-surface hover:border-edge-strong'
            }`}
            onClick={() => onIndexChange(itemIndex)}
            aria-label={`Open ${item.name}`}
          >
            <MediaPreview file={item} variant="tile" />
          </button>
        ))}
      </footer>
    </div>
  );
}
