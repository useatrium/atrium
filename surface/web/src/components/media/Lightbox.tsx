import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';
import type { SVGProps } from 'react';
import { MediaPreview } from './MediaPreview';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  DownloadIcon,
  EditIcon,
  HighlighterIcon,
  InfoIcon,
  LinkIcon,
  RotateIcon,
  TrashIcon,
} from './Icon';
import { TextEditorPane } from './TextEditorPane';
import { VersionHistoryPanel } from './VersionHistoryPanel';
import { ApplyMarkupMenu } from '../ApplyMarkupMenu';
import { Tooltip } from '../a11y';
import type { LightboxCallbacks, PreviewFile } from './types';
import { effectiveMediaKind, formatBytes, formatDateTime, kindLabel } from './utils';
import { ConflictSurface, type ArtifactConflict, type ResolveChoice } from '../../sessions/ConflictSurface';
import { EntryReferencesChip, type EntryReferenceSummary } from '../EntryReferencesChip';
import { useDialog } from '../../useDialog';

interface LightboxProps extends LightboxCallbacks {
  files: PreviewFile[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  panel?: LightboxPanel | null;
  onPanelChange?: (panel: LightboxPanel | null) => void;
  sessionId?: string;
  entryReferencesByFileId?: Record<string, EntryReferenceSummary | null>;
}

export type LightboxPanel = 'info' | 'history';

const iconButtonClass =
  'grid size-8 max-md:size-11 place-items-center rounded-md border border-edge-strong bg-surface-overlay text-fg-secondary shadow-sm hover:bg-edge-strong hover:text-fg disabled:cursor-default disabled:text-fg-faint';
// A fixed window makes preview request cost independent of viewport width.
const FILMSTRIP_PRELOAD_RADIUS = 2;

/** Viewport default for the side panel: info on desktop, closed on narrow
 * screens. URL-controlled hosts write this into the URL on open so the
 * address stays the source of truth for what's on screen. */
export function defaultLightboxPanel(): LightboxPanel | null {
  if (typeof window === 'undefined') return 'info';
  if (typeof window.matchMedia !== 'function') return 'info';
  return window.matchMedia('(min-width: 768px)').matches ? 'info' : null;
}

function defaultOpenPanel(): LightboxPanel | null {
  return defaultLightboxPanel();
}

function MessagePlusIcon({ size = 16, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v3" />
      <path d="M16 8h5" />
      <path d="M18.5 5.5v5" />
    </svg>
  );
}

function cacheBustedFile(file: PreviewFile, reloadKey: number): PreviewFile {
  if (reloadKey === 0) return file;
  const separator = file.contentUrl.includes('?') ? '&' : '?';
  return { ...file, contentUrl: `${file.contentUrl}${separator}lbv=${reloadKey}` };
}

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

function FilmstripPreview({ file, eager }: { file: PreviewFile; eager: boolean }) {
  return (
    <div className="size-full">
      {eager ? (
        <MediaPreview file={file} variant="tile" />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-1 bg-surface-raised/40 px-2 text-center">
          <span className="rounded border border-edge px-1.5 py-0.5 text-3xs uppercase tracking-wide text-fg-muted">
            {kindLabel(effectiveMediaKind(file))}
          </span>
          <span className="max-w-full truncate text-3xs text-fg-faint">{file.name}</span>
        </div>
      )}
    </div>
  );
}

export function Lightbox({
  files,
  index,
  onIndexChange,
  onClose,
  panel,
  onPanelChange,
  onDownload,
  onCopyLink,
  onRename,
  onDelete,
  onDiscuss,
  canManage,
  onListVersions,
  onFetchVersionContent,
  onRevertVersion,
  onRestoreFile,
  onSaveText,
  onLoadConflict,
  onResolveConflict,
  onMarkup,
  applyMarkupTarget,
  sessionId,
  entryReferencesByFileId,
}: LightboxProps) {
  const file = files[index];
  const [localOpenPanel, setLocalOpenPanel] = useState<LightboxPanel | null>(() => defaultOpenPanel());
  const openPanel = panel !== undefined ? panel : localOpenPanel;
  const setOpenPanel = useCallback(
    (next: LightboxPanel | null | ((panel: LightboxPanel | null) => LightboxPanel | null)) => {
      const resolved = typeof next === 'function' ? next(openPanel) : next;
      if (panel === undefined) setLocalOpenPanel(resolved);
      onPanelChange?.(resolved);
    },
    [onPanelChange, openPanel, panel],
  );
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(file?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editBaseSeq, setEditBaseSeq] = useState<number | null>(null);
  const [editText, setEditText] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ArtifactConflict | null>(null);
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const activeFilmstripButtonRef = useRef<HTMLButtonElement | null>(null);
  const touchStartRef = useRef<number | null>(null);
  const canPrev = index > 0;
  const canNext = index < files.length - 1;
  const renameInputId = 'lightbox-rename-input';
  const manageable = file ? canManage?.(file) === true : false;
  const mediaKind = file ? effectiveMediaKind(file) : 'opaque';
  const editAvailable =
    file != null &&
    !file.tombstoned &&
    manageable &&
    (mediaKind === 'text' || mediaKind === 'code') &&
    Boolean(onListVersions && onFetchVersionContent && onSaveText && onLoadConflict && onResolveConflict);
  const markupAvailable =
    file != null &&
    !file.tombstoned &&
    sessionId != null &&
    (mediaKind === 'text' || mediaKind === 'code') &&
    Boolean(onMarkup);

  useEffect(() => {
    setDraftName(file?.name ?? '');
    setRenaming(false);
    setEditing(false);
    setEditLoading(false);
    setEditSaving(false);
    setEditBaseSeq(null);
    setEditText(null);
    setEditError(null);
    setConflict(null);
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
      const target = event.target as HTMLElement | null;
      const targetAcceptsText =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable === true;
      if (targetAcceptsText) return;
      if (event.key === 'ArrowLeft' && canPrev) onIndexChange(index - 1);
      if (event.key === 'ArrowRight' && canNext) onIndexChange(index + 1);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canNext, canPrev, index, onIndexChange]);

  useEffect(() => {
    activeFilmstripButtonRef.current?.scrollIntoView?.({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'smooth',
    });
  }, [index]);

  useDialog({ open: true, containerRef: dialogRef, initialFocusRef: closeButtonRef, onClose });

  const refreshAfterWrite = useCallback(async () => {
    setPreviewReloadKey((value) => value + 1);
    setHistoryRefreshKey((value) => value + 1);
    if (file && onListVersions) {
      try {
        await onListVersions(file);
      } catch {
        // The callback owns user-facing error reporting. Keep the saved preview path moving.
      }
    }
  }, [file, onListVersions]);

  const loadEditSource = useCallback(
    async (signal?: AbortSignal) => {
      if (!file || !editAvailable || !onListVersions || !onFetchVersionContent) return;
      setEditLoading(true);
      setEditError(null);
      setConflict(null);
      try {
        const [versions, blob] = await Promise.all([
          onListVersions(file, signal),
          onFetchVersionContent(file, undefined, signal),
        ]);
        const latest = versions[0];
        if (!latest) throw new Error('Could not find the latest file version');
        const text = await blob.text();
        if (signal?.aborted) return;
        setEditBaseSeq(latest.seq);
        setEditText(text);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setEditBaseSeq(null);
        setEditText(null);
        setEditError(err instanceof Error ? err.message : 'Could not load file content');
      } finally {
        if (!signal?.aborted) setEditLoading(false);
      }
    },
    [editAvailable, file, onFetchVersionContent, onListVersions],
  );

  useEffect(() => {
    if (!editing || !editAvailable) return;
    const controller = new AbortController();
    void loadEditSource(controller.signal);
    return () => controller.abort();
  }, [editAvailable, editing, loadEditSource]);

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
  const displayFile = cacheBustedFile(file, previewReloadKey);
  const entryReferences = entryReferencesByFileId?.[file.id] ?? null;

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

  const saveEdit = async (text: string) => {
    if (!onSaveText || !onLoadConflict || editBaseSeq == null) return;
    setEditSaving(true);
    setEditError(null);
    try {
      const result = await onSaveText(file, text, editBaseSeq);
      if (result.status === 'conflict') {
        const nextConflict = await onLoadConflict(file);
        setConflict(nextConflict);
        setEditText(null);
        setEditBaseSeq(null);
        setHistoryRefreshKey((value) => value + 1);
        return;
      }
      setEditing(false);
      setConflict(null);
      setEditText(null);
      setEditBaseSeq(null);
      await refreshAfterWrite();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Could not save file');
      void loadEditSource();
    } finally {
      setEditSaving(false);
    }
  };

  const resolveConflict = async (choice: ResolveChoice) => {
    if (!onResolveConflict || !conflict) return;
    setEditSaving(true);
    setEditError(null);
    try {
      await onResolveConflict(file, conflict, choice);
      setConflict(null);
      setEditing(false);
      setEditText(null);
      setEditBaseSeq(null);
      await refreshAfterWrite();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Could not resolve conflict');
      throw err;
    } finally {
      setEditSaving(false);
    }
  };

  const onTouchStart = (event: TouchEvent<HTMLElement>) => {
    if (editing) return;
    touchStartRef.current = event.touches[0]?.clientX ?? null;
  };

  const onTouchEnd = (event: TouchEvent<HTMLElement>) => {
    if (editing) return;
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
    <div
      ref={dialogRef}
      className="fixed inset-0 z-overlay flex flex-col bg-surface text-fg shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lightbox-title"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge bg-surface-raised px-3 py-2 md:h-12 md:flex-nowrap md:py-0">
        <Tooltip content="Close">
          <button
            ref={closeButtonRef}
            type="button"
            className={iconButtonClass}
            onClick={onClose}
            aria-label="Close lightbox"
          >
            <CloseIcon size={16} />
          </button>
        </Tooltip>
        <div className="min-w-0 flex-1 max-md:order-last max-md:basis-full">
          {renaming ? (
            <>
              <h2 id="lightbox-title" className="sr-only">
                {file.name}
              </h2>
              <form
                className="flex max-w-xl items-center gap-2"
                aria-busy={busy ? 'true' : undefined}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitRename();
                }}
              >
                <label htmlFor={renameInputId} className="sr-only">
                  File name
                </label>
                <input
                  id={renameInputId}
                  className="min-w-0 flex-1 rounded-md border border-edge-strong bg-surface px-2 py-1 text-sm text-fg outline-none focus:border-accent-hover"
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  disabled={busy}
                  // biome-ignore lint/a11y/noAutofocus: lightbox rename dialog intentionally focuses the editable filename; useDialog manages focus containment and restore.
                  autoFocus
                />
                <button
                  type="submit"
                  className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-on-accent disabled:bg-surface-overlay disabled:text-fg-muted"
                >
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
            </>
          ) : (
            <>
              <h2 id="lightbox-title" className="truncate text-sm font-semibold text-fg">
                {file.name}
              </h2>
              <div className="truncate text-2xs text-fg-muted">
                {index + 1} of {files.length} · {kindLabel(effectiveMediaKind(file))}
              </div>
            </>
          )}
        </div>
        <div className="shrink-0 max-md:[&_button]:min-h-11 max-md:[&_button]:px-3">
          <EntryReferencesChip summary={entryReferences} />
        </div>
        <Tooltip content="Discuss">
          <button
            type="button"
            className={iconButtonClass}
            onClick={() => void onDiscuss?.(file, `/e/art_${file.id} `)}
            disabled={!onDiscuss}
            aria-label="Discuss in channel"
          >
            <MessagePlusIcon size={16} />
          </button>
        </Tooltip>
        {applyMarkupTarget && (
          <div className="max-md:[&_button]:min-h-11 max-md:[&_button]:px-3">
            <ApplyMarkupMenu
              artifactId={applyMarkupTarget.artifactId}
              path={applyMarkupTarget.path}
              channelId={applyMarkupTarget.channelId}
              sessions={applyMarkupTarget.sessions}
              onSpawnNewAgent={applyMarkupTarget.onSpawnNewAgent}
            />
          </div>
        )}
        <Tooltip content="Download">
          <button
            type="button"
            className={iconButtonClass}
            onClick={() => onDownload?.(file)}
            disabled={!onDownload}
            aria-label="Download file"
          >
            <DownloadIcon size={16} />
          </button>
        </Tooltip>
        <Tooltip content="Copy link">
          <button
            type="button"
            className={iconButtonClass}
            onClick={() => onCopyLink?.(file)}
            disabled={!onCopyLink}
            aria-label="Copy file link"
          >
            <LinkIcon size={16} />
          </button>
        </Tooltip>
        {onListVersions && (
          <Tooltip content="History">
            <button
              type="button"
              className={`${iconButtonClass} ${openPanel === 'history' ? 'border-accent-border text-accent-text-strong' : ''}`}
              onClick={() => setOpenPanel((panel) => (panel === 'history' ? null : 'history'))}
              aria-label="Toggle version history"
            >
              <RotateIcon size={16} />
            </button>
          </Tooltip>
        )}
        {editAvailable && (
          <Tooltip content="Edit">
            <button
              type="button"
              className={`${iconButtonClass} ${editing ? 'border-accent-border text-accent-text-strong' : ''}`}
              onClick={() => {
                setEditing((value) => !value);
                setEditError(null);
                setConflict(null);
              }}
              aria-label="Edit file"
            >
              <EditIcon size={16} />
            </button>
          </Tooltip>
        )}
        {markupAvailable && (
          <Tooltip content="Mark up">
            <button
              type="button"
              className={iconButtonClass}
              onClick={() => void onMarkup?.(file)}
              aria-label="Mark up"
            >
              <HighlighterIcon size={16} />
            </button>
          </Tooltip>
        )}
        <Tooltip content="Info">
          <button
            type="button"
            className={`${iconButtonClass} ${openPanel === 'info' ? 'border-accent-border text-accent-text-strong' : ''}`}
            onClick={() => setOpenPanel((panel) => (panel === 'info' ? null : 'info'))}
            aria-label="Toggle info panel"
          >
            <InfoIcon size={16} />
          </button>
        </Tooltip>
      </header>

      <main className="min-h-0 flex-1" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_auto] md:grid-rows-none">
          <section className="relative flex min-h-0 bg-surface">
            {editing && conflict ? (
              <div className="flex min-h-0 flex-1 flex-col">
                {editError && (
                  <div
                    role="alert"
                    className="border-b border-danger-border bg-danger-tint px-3 py-2 text-2xs text-danger-text"
                  >
                    {editError}
                  </div>
                )}
                <ConflictSurface
                  conflict={conflict}
                  onResolve={resolveConflict}
                  onClose={() => {
                    setConflict(null);
                    setEditing(false);
                  }}
                  embedded
                />
              </div>
            ) : editing ? (
              editLoading ? (
                <div className="flex flex-1 items-center justify-center text-2xs text-fg-muted">
                  Loading editable content...
                </div>
              ) : editBaseSeq != null && editText != null ? (
                <TextEditorPane
                  file={file}
                  baseSeq={editBaseSeq}
                  initialText={editText}
                  onSave={saveEdit}
                  onCancel={() => {
                    setEditing(false);
                    setEditError(null);
                    setConflict(null);
                  }}
                  saving={editSaving}
                  error={editError}
                />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
                  <div role="alert" className="text-2xs text-danger-text">
                    {editError ?? 'Could not load editable content'}
                  </div>
                  <button
                    type="button"
                    className="rounded-md border border-edge-strong px-2 py-1 text-2xs font-semibold text-fg-secondary hover:bg-surface-overlay hover:text-fg"
                    onClick={() => void loadEditSource()}
                  >
                    Retry
                  </button>
                </div>
              )
            ) : (
              <>
                <MediaPreview file={displayFile} variant="full" />
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
              </>
            )}
          </section>

          {openPanel === 'info' && (
            <aside className="flex w-full min-w-0 flex-col border-t border-edge bg-surface-raised max-md:max-h-[45svh] max-md:overflow-y-auto md:w-[min(340px,38vw)] md:min-w-72 md:border-l md:border-t-0">
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

          {openPanel === 'history' && (
            <VersionHistoryPanel
              key={`${file.id}:${historyRefreshKey}`}
              file={file}
              canManage={manageable}
              onListVersions={onListVersions}
              onFetchVersionContent={onFetchVersionContent}
              onRevertVersion={onRevertVersion}
              onRestoreFile={onRestoreFile}
            />
          )}
        </div>
      </main>

      <footer className="flex h-32 shrink-0 items-center gap-3 overflow-x-auto border-t border-edge bg-surface-raised px-3 py-2 max-md:h-28 max-md:gap-2 max-md:px-2">
        {files.map((item, itemIndex) => (
          <button
            type="button"
            key={item.id}
            ref={(node) => {
              if (itemIndex === index) activeFilmstripButtonRef.current = node;
            }}
            className={`h-28 w-36 shrink-0 overflow-hidden rounded-md border-2 text-left transition-colors max-md:h-24 max-md:w-32 ${
              itemIndex === index
                ? 'border-accent-border bg-accent-tint'
                : 'border-edge bg-surface hover:border-edge-strong'
            }`}
            onClick={() => onIndexChange(itemIndex)}
            aria-label={`Open ${item.name}`}
          >
            <FilmstripPreview file={item} eager={Math.abs(itemIndex - index) <= FILMSTRIP_PRELOAD_RADIUS} />
          </button>
        ))}
      </footer>
    </div>
  );
}
