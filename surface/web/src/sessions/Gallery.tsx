import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  FILE_CATEGORIES,
  fileTypeLabel,
  type FileCategory,
  type HubFile,
  type HubFileListResult,
  type HubFileVersionsResponse,
} from '@atrium/surface-client';
import { Menu, MenuContent, MenuLabel, MenuSeparator, MenuTrigger, Tooltip } from '../components/a11y';
import { SearchIcon } from '../components/icons';
import { Lightbox } from '../components/media';
import type { LightboxCallbacks } from '../components/media';
import { showErrorToast } from '../components/Toasts';
import { entryShareUrl } from '../lib/publicUrl';
import { navigate, useLocation } from '../router';
import type { ArtifactConflict, ResolveChoice } from './ConflictSurface';
import { EmptyState } from './EmptyState';
import { hubFileToPreview } from './FilesHub';

type GallerySort = 'recent' | 'name' | 'size';
type GalleryScope = 'everything' | 'channel' | 'session';
type GalleryCategorySelection = 'all' | FileCategory;

export interface GalleryScopeContext {
  channelId?: string | null;
  sessionId?: string | null;
}

export interface GalleryQueryState {
  q: string;
  category: GalleryCategorySelection;
  scope: GalleryScope;
  channelId: string;
  sessionId: string;
  sort: GallerySort;
  includeDeleted: boolean;
  includeScratch: boolean;
  starred: boolean;
  label: string;
}

const PAGE_SIZE = 60;
const SORT_VALUES = new Set<GallerySort>(['recent', 'name', 'size']);

function isFileCategory(value: string | null): value is FileCategory {
  return value != null && FILE_CATEGORIES.some((category) => category.key === value);
}

function boolFromParam(params: URLSearchParams, key: string): boolean {
  return params.get(key) === 'true';
}

function cleanId(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function pathWithSearch(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function galleryStateFromSearch(
  search: string,
  context: GalleryScopeContext = {},
): GalleryQueryState {
  const params = new URLSearchParams(search);
  const category = params.get('category');
  const queryChannelId = cleanId(params.get('channelId'));
  const querySessionId = cleanId(params.get('sessionId'));
  const sort = params.get('sort');
  const scope: GalleryScope = querySessionId ? 'session' : queryChannelId ? 'channel' : 'everything';

  return {
    q: params.get('q') ?? '',
    category: isFileCategory(category) ? category : 'all',
    scope,
    channelId: queryChannelId || cleanId(context.channelId),
    sessionId: querySessionId || cleanId(context.sessionId),
    sort: sort && SORT_VALUES.has(sort as GallerySort) ? (sort as GallerySort) : 'recent',
    includeDeleted: boolFromParam(params, 'includeDeleted'),
    includeScratch: boolFromParam(params, 'includeScratch'),
    starred: boolFromParam(params, 'starred'),
    label: params.get('label') ?? '',
  };
}

export function galleryApiSearchParams(
  state: GalleryQueryState,
  cursor?: string | null,
  limit = PAGE_SIZE,
): URLSearchParams {
  const params = new URLSearchParams();
  const q = state.q.trim();
  const label = state.label.trim();
  if (q) params.set('q', q);
  if (state.category !== 'all') params.set('category', state.category);
  if (state.scope === 'channel' && state.channelId.trim()) params.set('channelId', state.channelId.trim());
  if (state.scope === 'session' && state.sessionId.trim()) params.set('sessionId', state.sessionId.trim());
  if (label) params.set('label', label);
  if (state.starred) params.set('starred', 'true');
  params.set('includeDeleted', String(state.includeDeleted));
  params.set('includeScratch', String(state.includeScratch));
  params.set('sort', state.sort);
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  return params;
}

export function galleryUrlSearchParams(state: GalleryQueryState): URLSearchParams {
  const params = new URLSearchParams();
  const q = state.q.trim();
  const label = state.label.trim();
  if (q) params.set('q', q);
  if (state.category !== 'all') params.set('category', state.category);
  if (state.scope === 'channel' && state.channelId.trim()) params.set('channelId', state.channelId.trim());
  if (state.scope === 'session' && state.sessionId.trim()) params.set('sessionId', state.sessionId.trim());
  if (state.sort !== 'recent') params.set('sort', state.sort);
  if (state.includeDeleted) params.set('includeDeleted', 'true');
  if (state.includeScratch) params.set('includeScratch', 'true');
  if (state.starred) params.set('starred', 'true');
  if (label) params.set('label', label);
  return params;
}

export function galleryPathForScope(context: GalleryScopeContext): string {
  const base = galleryStateFromSearch('', context);
  const scoped: GalleryQueryState = {
    ...base,
    scope: context.sessionId ? 'session' : context.channelId ? 'channel' : 'everything',
  };
  return pathWithSearch('/files', galleryUrlSearchParams(scoped));
}

export function formatGalleryBytes(bytes?: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

export function relativeFileTime(value?: string): string {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const divisions: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 60 * 60 * 24 * 365],
    ['month', 60 * 60 * 24 * 30],
    ['week', 60 * 60 * 24 * 7],
    ['day', 60 * 60 * 24],
    ['hour', 60 * 60],
    ['minute', 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, seconds] of divisions) {
    if (Math.abs(diffSeconds) >= seconds) return formatter.format(Math.round(diffSeconds / seconds), unit);
  }
  return formatter.format(diffSeconds, 'second');
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.clone().json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? fallback;
  } catch {
    try {
      const text = await response.text();
      return text.trim() || fallback;
    } catch {
      return fallback;
    }
  }
}

function contentUrl(artifactId: string): string {
  return `/api/files/artifact/${artifactId}/content`;
}

function absoluteArtifactEntryUrl(artifactId: string): string {
  return entryShareUrl(`art_${artifactId}`);
}

function uploaderLabel(file: HubFile): string {
  if (file.uploader?.name) return file.uploader.name;
  if (file.uploader?.id) return file.uploader.id;
  if (file.origin === 'agent') return 'Agent';
  if (file.origin === 'upload') return 'Upload';
  return 'Workspace';
}

function fileMeta(file: HubFile): string {
  return `${formatGalleryBytes(file.sizeBytes)} · ${relativeFileTime(file.createdAt)} · ${uploaderLabel(file)}`;
}

function mergeFile(files: HubFile[], next: HubFile): HubFile[] {
  return files.map((file) => (file.artifactId === next.artifactId ? next : file));
}

function updateFile(files: HubFile[], artifactId: string, patch: Partial<HubFile>): HubFile[] {
  return files.map((file) => (file.artifactId === artifactId ? { ...file, ...patch } : file));
}

function resolvedTextForChoice(conflict: ArtifactConflict, choice: ResolveChoice): string {
  if (choice.kind === 'left') return conflict.left.text;
  if (choice.kind === 'right') return conflict.right.text;
  return choice.text;
}

function GalleryCard({ file, onOpen }: { file: HubFile; onOpen: () => void }) {
  const imageThumbnail = file.mediaKind === 'image' && file.thumbnailUrl ? file.thumbnailUrl : null;
  const type = fileTypeLabel(file);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group flex min-h-52 min-w-0 flex-col overflow-hidden rounded-md border text-left transition-colors ${
        file.tombstoned
          ? 'border-danger-border/60 bg-danger-tint/20 opacity-80'
          : 'border-edge bg-surface-raised/45 hover:border-edge-strong hover:bg-surface-raised'
      }`}
    >
      <div className="aspect-[4/3] w-full overflow-hidden border-b border-edge bg-surface">
        {imageThumbnail ? (
          <img
            src={imageThumbnail}
            alt=""
            className="size-full object-cover transition-transform duration-200 ease-out group-hover:scale-[1.02]"
            loading="lazy"
          />
        ) : (
          <div className="flex size-full items-center justify-center px-3">
            <span className="max-w-full truncate rounded-md border border-edge-strong bg-surface-overlay px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg-secondary">
              {type}
            </span>
          </div>
        )}
      </div>
      <div className="flex min-h-20 min-w-0 flex-1 flex-col justify-between gap-2 px-2.5 py-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-fg-body" title={file.path}>
            {file.name}
          </div>
          <div className="mt-1 truncate text-3xs text-fg-muted" title={fileMeta(file)}>
            {imageThumbnail ? relativeFileTime(file.createdAt) : fileMeta(file)}
          </div>
        </div>
        {!imageThumbnail && (
          <div className="truncate text-3xs text-fg-faint" title={file.path}>
            {file.path}
          </div>
        )}
      </div>
    </button>
  );
}

function CategoryChips({
  value,
  onChange,
}: {
  value: GalleryCategorySelection;
  onChange: (value: GalleryCategorySelection) => void;
}) {
  const chipClass = (active: boolean) =>
    `h-8 rounded-full border px-3 text-2xs font-semibold transition-colors max-md:h-10 ${
      active
        ? 'border-accent-border bg-accent-tint text-accent-text-strong'
        : 'border-edge bg-surface text-fg-muted hover:border-edge-strong hover:bg-surface-overlay hover:text-fg'
    }`;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <button type="button" aria-pressed={value === 'all'} onClick={() => onChange('all')} className={chipClass(value === 'all')}>
        All
      </button>
      {FILE_CATEGORIES.map((category) => (
        <button
          type="button"
          key={category.key}
          aria-pressed={value === category.key}
          onClick={() => onChange(category.key)}
          className={chipClass(value === category.key)}
        >
          {category.label}
        </button>
      ))}
    </div>
  );
}

function OverflowControls({
  state,
  onChange,
}: {
  state: GalleryQueryState;
  onChange: (patch: Partial<GalleryQueryState>) => void;
}) {
  const fieldClass =
    'h-8 rounded-md border border-edge bg-surface px-2 text-xs text-fg-body outline-none focus:border-edge-focus';
  const checkClass = 'flex items-center gap-2 text-xs text-fg-secondary';
  return (
    <Menu>
      <Tooltip content="More file filters">
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label="More file filters"
            className="grid size-8 place-items-center rounded-md border border-edge bg-surface text-sm font-semibold text-fg-muted hover:border-edge-strong hover:bg-surface-overlay hover:text-fg max-md:size-10"
          >
            ...
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="end" className="w-72 max-w-[calc(100vw-1rem)] bg-surface-raised p-2">
        <MenuLabel>Filters</MenuLabel>
        <div className="grid gap-3 px-1 py-2">
          <label className="grid gap-1.5 text-xs text-fg-muted">
            <span>Sort</span>
            <select
              value={state.sort}
              onChange={(event) => onChange({ sort: event.target.value as GallerySort })}
              className={fieldClass}
            >
              <option value="recent">Recent</option>
              <option value="name">Name</option>
              <option value="size">Size</option>
            </select>
          </label>
          <label className={checkClass}>
            <input
              type="checkbox"
              checked={state.includeDeleted}
              onChange={(event) => onChange({ includeDeleted: event.target.checked })}
            />
            Show removed
          </label>
          <label className={checkClass}>
            <input
              type="checkbox"
              checked={state.includeScratch}
              onChange={(event) => onChange({ includeScratch: event.target.checked })}
            />
            Include scratch
          </label>
          <label className={checkClass}>
            <input
              type="checkbox"
              checked={state.starred}
              onChange={(event) => onChange({ starred: event.target.checked })}
            />
            Starred only
          </label>
        </div>
        <MenuSeparator />
        <div className="px-1 py-2">
          <label className="grid gap-1.5 text-xs text-fg-muted">
            <span>Label</span>
            <input
              value={state.label}
              onChange={(event) => onChange({ label: event.target.value })}
              placeholder="Any label"
              className={fieldClass}
            />
          </label>
        </div>
      </MenuContent>
    </Menu>
  );
}

function ScopeSelect({
  state,
  onChange,
}: {
  state: GalleryQueryState;
  onChange: (patch: Partial<GalleryQueryState>) => void;
}) {
  const value =
    state.scope === 'session' && state.sessionId
      ? 'session'
      : state.scope === 'channel' && state.channelId
        ? 'channel'
        : 'everything';
  return (
    <>
      <label className="sr-only" htmlFor="gallery-scope">
        Scope
      </label>
      <select
        id="gallery-scope"
        value={value}
        onChange={(event) => {
          const next = event.target.value as GalleryScope;
          onChange({ scope: next });
        }}
        className="h-8 rounded-md border border-edge bg-surface px-2 text-2xs font-semibold text-fg-secondary outline-none hover:border-edge-strong hover:bg-surface-overlay focus:border-edge-focus max-md:h-10"
        aria-label="File scope"
      >
        <option value="everything">Everything</option>
        {state.channelId && <option value="channel">This channel</option>}
        {state.sessionId && <option value="session">This session</option>}
      </select>
    </>
  );
}

export function Gallery({
  workspaceId,
  channelId,
  sessionId,
  filesEventSeq = 0,
  initialOpenArtifactId,
  onInitialOpenArtifactHandled,
  onSeedChannelComposer,
}: {
  workspaceId: string;
  channelId?: string | null;
  sessionId?: string | null;
  filesEventSeq?: number;
  initialOpenArtifactId?: string | null;
  onInitialOpenArtifactHandled?: (artifactId: string) => void;
  onSeedChannelComposer?: (draft: string) => void;
}): JSX.Element {
  const location = useLocation();
  const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/files`;
  const parsedWithoutContext = useMemo(() => galleryStateFromSearch(location.search), [location.search]);
  const [rememberedScopeIds, setRememberedScopeIds] = useState(() => ({
    channelId: parsedWithoutContext.channelId || cleanId(channelId),
    sessionId: parsedWithoutContext.sessionId || cleanId(sessionId),
  }));
  const queryState = useMemo(
    () =>
      galleryStateFromSearch(location.search, {
        channelId: rememberedScopeIds.channelId || channelId,
        sessionId: rememberedScopeIds.sessionId || sessionId,
      }),
    [channelId, location.search, rememberedScopeIds.channelId, rememberedScopeIds.sessionId, sessionId],
  );
  const [searchDraft, setSearchDraft] = useState(queryState.q);
  const [files, setFiles] = useState<HubFile[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const previews = useMemo(() => files.map(hubFileToPreview), [files]);
  const activeScope = queryState.scope === 'session' ? 'session' : queryState.scope === 'channel' ? 'channel' : 'everything';
  const scopeEmpty = activeScope !== 'everything' && !loading && !error && files.length === 0;

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 2600);
  }, []);

  useEffect(() => {
    setRememberedScopeIds((current) => {
      const next = {
        channelId: parsedWithoutContext.channelId || cleanId(channelId) || current.channelId,
        sessionId: parsedWithoutContext.sessionId || cleanId(sessionId) || current.sessionId,
      };
      return next.channelId === current.channelId && next.sessionId === current.sessionId ? current : next;
    });
  }, [channelId, parsedWithoutContext.channelId, parsedWithoutContext.sessionId, sessionId]);

  useEffect(() => {
    setSearchDraft(queryState.q);
  }, [queryState.q]);

  const updateQuery = useCallback(
    (patch: Partial<GalleryQueryState>, options: { replace?: boolean } = {}) => {
      const next = { ...queryState, ...patch };
      if (patch.scope === 'everything') {
        next.scope = 'everything';
      } else if (patch.scope === 'channel' && !next.channelId) {
        next.scope = 'everything';
      } else if (patch.scope === 'session' && !next.sessionId) {
        next.scope = 'everything';
      }
      navigate(pathWithSearch('/files', galleryUrlSearchParams(next)), options);
    },
    [queryState],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchDraft !== queryState.q) updateQuery({ q: searchDraft }, { replace: true });
    }, 250);
    return () => clearTimeout(timer);
  }, [queryState.q, searchDraft, updateQuery]);

  const loadFiles = useCallback(
    async ({
      cursor,
      append = false,
      signal,
    }: {
      cursor?: string | null;
      append?: boolean;
      signal?: AbortSignal;
    } = {}) => {
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setLoadedOnce(false);
        setError(null);
      }
      try {
        const params = galleryApiSearchParams(queryState, cursor);
        const response = await fetch(`${endpoint}?${params.toString()}`, {
          credentials: 'same-origin',
          signal,
        });
        if (!response.ok) throw new Error(await responseError(response, 'Could not load files'));
        const body = (await response.json()) as HubFileListResult;
        setFiles((current) => (append ? [...current, ...body.files] : body.files));
        setNextCursor(body.nextCursor ?? null);
        if (!append) setLightboxIndex(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const message = err instanceof Error ? err.message : 'Could not load files';
        if (!append) setFiles([]);
        setError(message);
        showErrorToast(message);
      } finally {
        if (append) setLoadingMore(false);
        else {
          setLoading(false);
          setLoadedOnce(true);
        }
      }
    },
    [endpoint, queryState],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadFiles({ signal: controller.signal });
    return () => controller.abort();
  }, [filesEventSeq, loadFiles]);

  useEffect(() => {
    if (!nextCursor || loadingMore || loading || !loadMoreRef.current) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadFiles({ cursor: nextCursor, append: true });
      },
      { root: scrollRef.current, rootMargin: '360px' },
    );
    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [loadFiles, loading, loadingMore, nextCursor]);

  useEffect(() => {
    if (!initialOpenArtifactId || !loadedOnce) return;
    const index = files.findIndex((file) => file.artifactId === initialOpenArtifactId);
    if (index >= 0) setLightboxIndex(index);
    onInitialOpenArtifactHandled?.(initialOpenArtifactId);
  }, [files, initialOpenArtifactId, loadedOnce, onInitialOpenArtifactHandled]);

  const callbacks: LightboxCallbacks = useMemo(
    () => ({
      onDownload: (file) => {
        window.open(contentUrl(file.id), '_blank', 'noopener,noreferrer');
      },
      onCopyLink: async (file) => {
        try {
          await navigator.clipboard.writeText(absoluteArtifactEntryUrl(file.id));
          showNotice('Link copied');
        } catch {
          showErrorToast('Could not copy file link.');
        }
      },
      onDiscuss: async (_file, draft) => {
        setLightboxIndex(null);
        if (channelId && onSeedChannelComposer) {
          onSeedChannelComposer(draft);
          return;
        }
        try {
          await navigator.clipboard.writeText(draft.trimEnd());
          showNotice('Link copied, paste it in a channel to discuss');
        } catch {
          showErrorToast('Could not copy file link.');
        }
      },
      onRename: async (file, name) => {
        const previous = files.find((item) => item.artifactId === file.id);
        if (!previous) return;
        setFiles((current) => updateFile(current, file.id, { name }));
        try {
          const response = await fetch(`/api/files/${file.id}`, {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (!response.ok) {
            throw new Error(
              await responseError(
                response,
                response.status === 409 ? 'A file with that name already exists' : 'Could not rename file',
              ),
            );
          }
          const body = (await response.json()) as { artifactId: string; path: string; name: string };
          setFiles((current) => updateFile(current, body.artifactId, { name: body.name, path: body.path }));
        } catch (err) {
          setFiles((current) => mergeFile(current, previous));
          showErrorToast(err instanceof Error ? err.message : 'Could not rename file');
          throw err;
        }
      },
      onDelete: async (file) => {
        const previous = files.find((item) => item.artifactId === file.id);
        if (!previous) return;
        if (queryState.includeDeleted) setFiles((current) => updateFile(current, file.id, { tombstoned: true }));
        else setFiles((current) => current.filter((item) => item.artifactId !== file.id));
        try {
          const response = await fetch(`/api/files/${file.id}`, { method: 'DELETE', credentials: 'same-origin' });
          if (!response.ok) {
            const fallback = response.status === 403 ? 'You do not have permission to delete this file' : 'Could not delete file';
            throw new Error(await responseError(response, fallback));
          }
        } catch (err) {
          setFiles((current) => {
            const exists = current.some((item) => item.artifactId === previous.artifactId);
            return exists ? mergeFile(current, previous) : [...current, previous];
          });
          showErrorToast(err instanceof Error ? err.message : 'Could not delete file');
          throw err;
        }
      },
      onListVersions: async (file, signal) => {
        try {
          const response = await fetch(`/api/files/${file.id}/versions`, {
            credentials: 'same-origin',
            signal,
          });
          if (!response.ok) throw new Error(await responseError(response, 'Could not load version history'));
          const body = (await response.json()) as HubFileVersionsResponse;
          return body.versions;
        } catch (err) {
          if (!(err instanceof DOMException && err.name === 'AbortError')) {
            showErrorToast(err instanceof Error ? err.message : 'Could not load version history');
          }
          throw err;
        }
      },
      onFetchVersionContent: async (file, seq, signal) => {
        const params = new URLSearchParams();
        if (seq != null) params.set('at', String(seq));
        const suffix = params.toString() ? `?${params.toString()}` : '';
        try {
          const response = await fetch(`/api/files/artifact/${file.id}/content${suffix}`, {
            credentials: 'same-origin',
            signal,
          });
          if (!response.ok) throw new Error(await responseError(response, 'Could not load version content'));
          return await response.blob();
        } catch (err) {
          if (!(err instanceof DOMException && err.name === 'AbortError')) {
            showErrorToast(err instanceof Error ? err.message : 'Could not load version content');
          }
          throw err;
        }
      },
      onRevertVersion: async (file, seq) => {
        try {
          const response = await fetch(`/api/files/${file.id}/revert`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seq }),
          });
          if (!response.ok) {
            throw new Error(
              await responseError(
                response,
                response.status === 409 ? 'That version cannot be restored' : 'Could not restore version',
              ),
            );
          }
          const body = (await response.json()) as { artifactId: string; seq: number; tombstoned: false };
          setFiles((current) => updateFile(current, body.artifactId, { versionSeq: body.seq, tombstoned: false }));
          await loadFiles();
        } catch (err) {
          showErrorToast(err instanceof Error ? err.message : 'Could not restore version');
          throw err;
        }
      },
      onRestoreFile: async (file) => {
        try {
          const response = await fetch(`/api/files/${file.id}/restore`, {
            method: 'POST',
            credentials: 'same-origin',
          });
          if (!response.ok) throw new Error(await responseError(response, 'Could not restore file'));
          const body = (await response.json()) as { artifactId: string; tombstoned: false };
          setFiles((current) => updateFile(current, body.artifactId, { tombstoned: body.tombstoned }));
          await loadFiles();
        } catch (err) {
          showErrorToast(err instanceof Error ? err.message : 'Could not restore file');
          throw err;
        }
      },
      onSaveText: async (file, text, baseSeq) => {
        const response = await fetch(`/api/files/${file.id}/content`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: {
            'X-Artifact-Base-Seq': String(baseSeq),
            'Content-Type': file.mime || 'text/plain',
          },
          body: text,
        });

        if (response.status === 409) {
          const message = 'File changed on the server, reload and retry';
          showErrorToast(message);
          await loadFiles();
          throw new Error(message);
        }
        if (response.status === 415) {
          const message = 'This file cannot be edited as text.';
          showErrorToast(message);
          throw new Error(message);
        }
        if (response.status === 403) {
          const message = "You don't have permission to edit this file.";
          showErrorToast(message);
          throw new Error(message);
        }
        if (!response.ok) {
          const message = await responseError(response, 'Could not save file');
          showErrorToast(message);
          throw new Error(message);
        }

        const body = (await response.json()) as { seq: number; status: 'normal' | 'conflict' };
        setFiles((current) => updateFile(current, file.id, { versionSeq: body.seq, tombstoned: false }));
        await loadFiles();
        return body;
      },
      onLoadConflict: async (file) => {
        const response = await fetch(`/api/files/${file.id}/conflict`, {
          credentials: 'same-origin',
        });
        if (!response.ok) {
          const fallback = response.status === 404 ? 'No conflict found for this file' : 'Could not load file conflict';
          const message = await responseError(response, fallback);
          showErrorToast(message);
          throw new Error(message);
        }
        return (await response.json()) as ArtifactConflict;
      },
      onResolveConflict: async (file, conflict, choice) => {
        const headers: Record<string, string> = {
          'X-Artifact-Base-Seq': String(conflict.conflictSeq),
          'Content-Type': file.mime || 'text/plain',
        };
        if (
          (choice.kind === 'left' && conflict.left.sha === null) ||
          (choice.kind === 'right' && conflict.right.sha === null)
        ) {
          headers['X-Artifact-Delete'] = 'true';
        }
        const response = await fetch(`/api/files/${file.id}/resolve`, {
          method: 'POST',
          credentials: 'same-origin',
          headers,
          body: resolvedTextForChoice(conflict, choice),
        });
        if (response.status === 403) {
          const message = "You don't have permission to edit this file.";
          showErrorToast(message);
          throw new Error(message);
        }
        if (!response.ok) {
          const message = await responseError(response, 'Could not resolve file conflict');
          showErrorToast(message);
          throw new Error(message);
        }
        const body = (await response.json()) as { seq: number; status: string };
        setFiles((current) => updateFile(current, file.id, { versionSeq: body.seq, tombstoned: false }));
        await loadFiles();
        return body;
      },
      canManage: () => true,
    }),
    [channelId, files, loadFiles, onSeedChannelComposer, queryState.includeDeleted, showNotice],
  );

  const empty = loadedOnce && !loading && !error && files.length === 0;
  const countLabel = `${files.length}${nextCursor ? '+' : ''}`;

  return (
    <div data-testid="files-gallery" className="relative flex min-h-0 flex-1 flex-col bg-surface">
      <header className="shrink-0 border-b border-edge bg-surface-raised/30 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-2 min-w-0">
            <h1 className="text-sm font-semibold text-fg">Files</h1>
            <div className="text-3xs text-fg-muted">{countLabel} shown</div>
          </div>
          <label className="flex h-8 min-w-[15rem] flex-1 items-center gap-2 rounded-md border border-edge bg-surface px-2 text-fg-muted focus-within:border-edge-focus max-md:h-10 max-md:min-w-full">
            <SearchIcon size={14} className="shrink-0" />
            <input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="Search name or path"
              className="min-w-0 flex-1 bg-transparent text-xs text-fg-body outline-none placeholder:text-fg-faint"
            />
          </label>
          <CategoryChips value={queryState.category} onChange={(category) => updateQuery({ category })} />
          <ScopeSelect state={queryState} onChange={updateQuery} />
          <OverflowControls state={queryState} onChange={(patch) => updateQuery(patch)} />
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading && files.length === 0 && <div className="px-1 py-2 text-2xs text-fg-muted">Loading files...</div>}
        {error && (
          <div role="alert" className="px-1 py-2 text-2xs text-danger-text">
            {error}
          </div>
        )}
        {empty && (
          <div className="flex min-h-[18rem] items-center justify-center">
            <div className="max-w-sm text-center">
              <EmptyState
                title={queryState.q.trim() || queryState.category !== 'all' ? 'No matching files' : 'No files yet'}
                hint="Files you upload and files agents create appear here."
              />
              {scopeEmpty && (
                <button
                  type="button"
                  onClick={() => updateQuery({ scope: 'everything' })}
                  className="mt-3 rounded-md border border-edge-strong px-3 py-1.5 text-xs font-semibold text-fg-secondary hover:bg-surface-overlay hover:text-fg"
                >
                  See all workspace files
                </button>
              )}
            </div>
          </div>
        )}
        {!error && files.length > 0 && (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
            {files.map((file, index) => (
              <GalleryCard key={file.artifactId} file={file} onOpen={() => setLightboxIndex(index)} />
            ))}
          </div>
        )}
        {nextCursor && !error && (
          <div ref={loadMoreRef} className="mt-4 flex justify-center">
            <button
              type="button"
              onClick={() => void loadFiles({ cursor: nextCursor, append: true })}
              disabled={loadingMore}
              className="rounded-md border border-edge-strong px-3 py-1.5 text-2xs font-semibold text-fg-secondary hover:bg-surface-overlay hover:text-fg disabled:cursor-default disabled:text-fg-faint"
            >
              {loadingMore ? 'Loading...' : 'Load more'}
            </button>
          </div>
        )}
      </div>

      {lightboxIndex != null && previews.length > 0 && (
        <Lightbox
          files={previews}
          index={Math.min(lightboxIndex, previews.length - 1)}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          {...callbacks}
        />
      )}
      {notice && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-[75] -translate-x-1/2 rounded-md border border-accent-border/60 bg-surface-overlay px-3 py-2 text-xs font-medium text-accent-text-strong shadow-lg">
          {notice}
        </div>
      )}
    </div>
  );
}
