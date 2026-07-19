import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import {
  containsCriticMarkup,
  splitMarkdownFrontmatter,
  type FileOrigin,
  type HubFile,
  type HubFileListResult,
  type HubFileVersionsResponse,
} from '@atrium/surface-client';
import { MarkupPane, type MarkupPaneSource } from '../components/MarkupPane';
import { showErrorToast } from '../components/Toasts';
import { Tooltip } from '../components/a11y';
import { FileIcon, SearchIcon } from '../components/icons';
import { Lightbox, MediaPreview, defaultLightboxPanel } from '../components/media';
import type { LightboxCallbacks, MediaKind, PreviewFile } from '../components/media';
import {
  EntryReferencesChip,
  queryEntryReferencesForHandles,
  type EntryReferenceSummary,
} from '../components/EntryReferencesChip';
import { navigate, URL_PARAMS, useLocation } from '../router';
import { EmptyState } from './EmptyState';
import {
  artifactContentUrl as contentUrl,
  artifactEntryHandle,
  artifactEntryUrl as absoluteArtifactEntryUrl,
  cleanId,
  createFileLightboxCallbacks,
  lightboxPanelFromSearch,
  pathWithSearch,
  responseError,
  updateFile,
} from './fileHubCore';
import type { Session } from './types';

type SortMode = 'recent' | 'name' | 'size';
type OriginFilter = 'all' | FileOrigin;
type MediaFilter = 'all' | MediaKind;
type FileHubBrowseScope = 'channel' | 'workspace';
type FileHubScope = FileHubBrowseScope | 'session';

export type FilesHubDefaultScope = FileHubScope;
export interface FilesHubSessionScope {
  label: string;
  paths: string[];
}

interface Filters {
  origin: OriginFilter;
  mediaKind: MediaFilter;
  channelId: string;
  sessionId: string;
  label: string;
  starred: boolean;
  includeDeleted: boolean;
  includeScratch: boolean;
  sort: SortMode;
}

const PAGE_SIZE = 48;
const ENTRY_REFERENCES_REFETCH_MS = 60_000;
const MEDIA_FILTERS: MediaFilter[] = ['all', 'image', 'video', 'audio', 'document', 'code', 'text', 'data', 'opaque'];
const ORIGIN_FILTERS: OriginFilter[] = ['all', 'upload', 'agent', 'workspace'];

const mediaKindSet = new Set<MediaKind>(['image', 'video', 'audio', 'document', 'code', 'text', 'data', 'opaque']);

function asMediaKind(value: string | null): MediaKind {
  return value && mediaKindSet.has(value as MediaKind) ? (value as MediaKind) : 'opaque';
}

function dirFromSearch(search: string): string {
  const value = new URLSearchParams(search).get(URL_PARAMS.dir);
  if (!value) return '';
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function formatBytes(bytes?: number | null): string {
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

function fileLocation(file: HubFile): string {
  if (file.channelId) return `channel ${file.channelId.slice(0, 8)}`;
  if (file.sessionId) return `session ${file.sessionId.slice(0, 8)}`;
  return 'workspace';
}

function fileBadge(file: HubFile): string {
  const uploader = file.uploader?.name ?? file.uploader?.id;
  return uploader ? `${file.origin} / ${uploader}` : file.origin;
}

export function hubFileToPreview(f: HubFile): PreviewFile {
  return {
    id: f.artifactId,
    name: f.name,
    path: f.path,
    mime: f.mime ?? 'application/octet-stream',
    mediaKind: asMediaKind(f.mediaKind),
    versionSeq: f.versionSeq,
    sizeBytes: f.sizeBytes ?? undefined,
    tombstoned: f.tombstoned,
    width: f.width,
    height: f.height,
    contentUrl: contentUrl(f.artifactId),
    ...(f.thumbnailUrl ? { thumbnailUrl: f.thumbnailUrl } : {}),
    uploader: f.uploader,
    createdAt: f.createdAt,
    source: f.channelId
      ? { kind: 'channel', id: f.channelId }
      : f.sessionId
        ? { kind: 'session', id: f.sessionId }
        : undefined,
  };
}

function queryFor(filters: Filters, q: string, cursor?: string | null): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.origin !== 'all') params.set('origin', filters.origin);
  if (filters.mediaKind !== 'all') params.set('mediaKind', filters.mediaKind);
  if (filters.channelId.trim()) params.set('channelId', filters.channelId.trim());
  if (filters.sessionId.trim()) params.set('sessionId', filters.sessionId.trim());
  if (filters.label.trim()) params.set('label', filters.label.trim());
  if (filters.starred) params.set('starred', 'true');
  if (q.trim()) params.set('q', q.trim());
  if (filters.includeDeleted) params.set('includeDeleted', 'true');
  if (filters.includeScratch) params.set('includeScratch', 'true');
  params.set('sort', filters.sort);
  params.set('limit', String(PAGE_SIZE));
  if (cursor) params.set('cursor', cursor);
  return params;
}

function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function dirname(path: string): string {
  const segments = pathSegments(path);
  return segments.slice(0, -1).join('/');
}

function dirSegments(dir: string): string[] {
  return dir ? dir.split('/').filter(Boolean) : [];
}

function joinDir(segments: string[]): string {
  return segments.join('/');
}

function hasPrefix(segments: string[], prefix: string[]): boolean {
  return prefix.every((segment, index) => segments[index] === segment);
}

function normalizeScopePath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  return trimmed
    .replace(/^file:\/\//, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function pathCandidates(path: string): string[] {
  const normalized = normalizeScopePath(path);
  if (!normalized) return [];
  const candidates = new Set<string>([normalized]);
  const workspaceMarker = '/workspace/';
  const workspaceIndex = `/${normalized}`.lastIndexOf(workspaceMarker);
  if (workspaceIndex >= 0) candidates.add(`/${normalized}`.slice(workspaceIndex + workspaceMarker.length));
  const channelMatch = normalized.match(/(?:^|\/)shared\/channels\/[^/]+\/(.+)$/);
  if (channelMatch?.[1]) candidates.add(channelMatch[1]);
  const scratchMatch = normalized.match(/(?:^|\/)scratch\/[^/]+\/(.+)$/);
  if (scratchMatch?.[1]) candidates.add(scratchMatch[1]);
  const globalMatch = normalized.match(/(?:^|\/)shared\/global\/(.+)$/);
  if (globalMatch?.[1]) candidates.add(globalMatch[1]);
  return [...candidates].filter(Boolean);
}

function candidateMatchesScope(filePath: string, scopePath: string): boolean {
  if (filePath === scopePath || filePath.startsWith(`${scopePath}/`)) return true;
  if (filePath.endsWith(`/${scopePath}`)) return true;
  if (scopePath.endsWith(`/${filePath}`)) return true;
  return false;
}

export function fileMatchesSessionScope(filePath: string, scopePaths: readonly string[]): boolean {
  const fileCandidates = pathCandidates(filePath);
  if (fileCandidates.length === 0) return false;
  for (const scopePath of scopePaths) {
    const scopeCandidates = pathCandidates(scopePath);
    for (const fileCandidate of fileCandidates) {
      for (const scopeCandidate of scopeCandidates) {
        if (candidateMatchesScope(fileCandidate, scopeCandidate)) return true;
      }
    }
  }
  return false;
}

interface FolderEntry {
  name: string;
  path: string;
  fileCount: number;
}

function folderView(files: HubFile[], currentDir: string): { folders: FolderEntry[]; filesHere: HubFile[] } {
  const currentSegments = dirSegments(currentDir);
  const folderCounts = new Map<string, { path: string; fileCount: number }>();
  const filesHere: HubFile[] = [];

  for (const file of files) {
    const fileDirSegments = dirSegments(dirname(file.path));
    if (joinDir(fileDirSegments) === currentDir) {
      filesHere.push(file);
    }

    if (fileDirSegments.length <= currentSegments.length || !hasPrefix(fileDirSegments, currentSegments)) {
      continue;
    }

    const childName = fileDirSegments[currentSegments.length]!;
    const childPath = joinDir([...currentSegments, childName]);
    const current = folderCounts.get(childName);
    if (current) {
      current.fileCount += 1;
    } else {
      folderCounts.set(childName, { path: childPath, fileCount: 1 });
    }
  }

  const folders = [...folderCounts.entries()]
    .map(([name, value]) => ({ name, path: value.path, fileCount: value.fileCount }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { folders, filesHere };
}

function FolderIcon({ size = 18, className }: { size?: number; className?: string }) {
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
      className={className}
    >
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function FolderTile({ folder, onOpen }: { folder: FolderEntry; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex min-h-[7rem] min-w-0 flex-col justify-between rounded-md border border-edge bg-surface-raised/45 px-3 py-2 text-left transition-colors hover:border-edge-strong hover:bg-surface-raised"
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-md border border-edge bg-surface text-fg-muted group-hover:text-fg-secondary">
          <FolderIcon size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-2xs font-semibold text-fg-body" title={folder.path}>
            {folder.name}
          </div>
          <div className="mt-1 text-3xs text-fg-muted">
            {folder.fileCount} {folder.fileCount === 1 ? 'file' : 'files'}
          </div>
        </div>
      </div>
      <div className="truncate text-3xs text-fg-faint" title={folder.path}>
        {folder.path}
      </div>
    </button>
  );
}

function FolderBreadcrumb({ currentDir, onNavigate }: { currentDir: string; onNavigate: (dir: string) => void }) {
  const segments = dirSegments(currentDir);

  return (
    <nav aria-label="Folder breadcrumb" className="mb-3 flex min-w-0 flex-wrap items-center gap-1 text-2xs">
      <button
        type="button"
        onClick={() => onNavigate('')}
        className={`rounded px-1.5 py-1 font-semibold ${
          currentDir ? 'text-fg-muted hover:bg-surface-overlay hover:text-fg-body' : 'text-fg-body'
        }`}
      >
        Files
      </button>
      {segments.map((segment, index) => {
        const dir = joinDir(segments.slice(0, index + 1));
        const isCurrent = dir === currentDir;
        return (
          <span key={dir} className="flex min-w-0 items-center gap-1">
            <span className="text-fg-faint">/</span>
            <Tooltip content={dir}>
              <button
                type="button"
                onClick={() => onNavigate(dir)}
                className={`max-w-40 truncate rounded px-1.5 py-1 font-mono ${
                  isCurrent ? 'text-fg-body' : 'text-fg-muted hover:bg-surface-overlay hover:text-fg-body'
                }`}
              >
                {segment}
              </button>
            </Tooltip>
          </span>
        );
      })}
    </nav>
  );
}

function FilterBar({
  filters,
  setFilters,
  search,
  setSearch,
  scopedChannel,
}: {
  filters: Filters;
  setFilters: (updater: (value: Filters) => Filters) => void;
  search: string;
  setSearch: (value: string) => void;
  scopedChannel: boolean;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  const activeFilterCount = [
    search.trim().length > 0,
    filters.origin !== 'all',
    filters.mediaKind !== 'all',
    !scopedChannel && filters.channelId.trim().length > 0,
    filters.sessionId.trim().length > 0,
    filters.label.trim().length > 0,
    filters.starred,
    filters.includeDeleted,
    !filters.includeScratch,
    filters.sort !== 'recent',
  ].filter(Boolean).length;
  const fieldClass =
    'h-7 rounded-md border border-edge bg-surface px-2 text-2xs text-fg-body outline-none focus:border-edge-focus max-md:h-11 max-md:w-auto max-md:min-w-0 max-md:flex-1 max-md:text-sm';
  const labelClass =
    'flex min-w-0 items-center gap-1.5 text-2xs text-fg-muted max-md:min-h-11 max-md:w-full max-md:gap-2 max-md:text-xs';

  return (
    <div className="shrink-0 border-b border-edge bg-surface-raised/30 px-3 py-2">
      <button
        type="button"
        aria-expanded={filtersOpen}
        aria-controls={filtersId}
        onClick={() => setFiltersOpen((value) => !value)}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md border border-edge bg-surface px-3 text-left text-xs font-semibold text-fg hover:bg-surface-overlay md:hidden"
      >
        <span className="flex min-w-0 items-center gap-2">
          <SearchIcon size={14} className="shrink-0 text-fg-muted" />
          <span>Filters</span>
          {activeFilterCount > 0 && (
            <span className="rounded-full bg-surface-overlay px-1.5 py-0.5 text-3xs tabular-nums text-fg-muted">
              {activeFilterCount}
            </span>
          )}
        </span>
        <span className="shrink-0 text-2xs text-fg-muted">{filtersOpen ? 'Hide' : 'Show'}</span>
      </button>
      <div
        id={filtersId}
        className={`${filtersOpen ? 'grid' : 'hidden'} mt-2 grid-cols-1 gap-2 md:mt-0 md:flex md:flex-wrap md:items-center`}
      >
        <label className={`${labelClass} min-w-[13rem] flex-1 max-md:min-w-0`}>
          <SearchIcon size={14} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search filename"
            className={`${fieldClass} min-w-0 flex-1`}
          />
        </label>
        <label className={labelClass}>
          Source
          <select
            value={filters.origin}
            onChange={(event) => setFilters((value) => ({ ...value, origin: event.target.value as OriginFilter }))}
            className={fieldClass}
          >
            {ORIGIN_FILTERS.map((origin) => (
              <option key={origin} value={origin}>
                {origin}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Type
          <select
            value={filters.mediaKind}
            onChange={(event) => setFilters((value) => ({ ...value, mediaKind: event.target.value as MediaFilter }))}
            className={fieldClass}
          >
            {MEDIA_FILTERS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        {!scopedChannel && (
          <label className={labelClass}>
            Channel
            <input
              value={filters.channelId}
              onChange={(event) => setFilters((value) => ({ ...value, channelId: event.target.value }))}
              placeholder="id"
              className={`${fieldClass} w-28 font-mono`}
            />
          </label>
        )}
        <label className={labelClass}>
          Session
          <input
            value={filters.sessionId}
            onChange={(event) => setFilters((value) => ({ ...value, sessionId: event.target.value }))}
            placeholder="id"
            className={`${fieldClass} w-28 font-mono`}
          />
        </label>
        <label className={labelClass}>
          Label
          <input
            value={filters.label}
            onChange={(event) => setFilters((value) => ({ ...value, label: event.target.value }))}
            placeholder="tag"
            className={`${fieldClass} w-24`}
          />
        </label>
        <label className={labelClass}>
          Sort
          <select
            value={filters.sort}
            onChange={(event) => setFilters((value) => ({ ...value, sort: event.target.value as SortMode }))}
            className={fieldClass}
          >
            <option value="recent">recent</option>
            <option value="name">name</option>
            <option value="size">size</option>
          </select>
        </label>
        <label className={labelClass}>
          <input
            type="checkbox"
            checked={filters.starred}
            onChange={(event) => setFilters((value) => ({ ...value, starred: event.target.checked }))}
          />
          starred
        </label>
        <label className={labelClass}>
          <input
            type="checkbox"
            checked={filters.includeDeleted}
            onChange={(event) => setFilters((value) => ({ ...value, includeDeleted: event.target.checked }))}
          />
          show removed
        </label>
        <label className={labelClass}>
          <input
            type="checkbox"
            checked={filters.includeScratch}
            onChange={(event) => setFilters((value) => ({ ...value, includeScratch: event.target.checked }))}
          />
          scratch
        </label>
      </div>
    </div>
  );
}

function FileTile({
  file,
  preview,
  references,
  onOpen,
  onToggleStar,
  onAddLabel,
  onRemoveLabel,
  onRestore,
}: {
  file: HubFile;
  preview: PreviewFile;
  references?: EntryReferenceSummary | null;
  onOpen: () => void;
  onToggleStar: () => void;
  onAddLabel: () => void;
  onRemoveLabel: (label: string) => void;
  onRestore: () => void;
}) {
  const onOpenKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpen();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: keyboard-activatable custom file card; converting to a button would break nested controls.
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={onOpenKeyDown}
      className={`group flex min-w-0 flex-col overflow-hidden rounded-md border text-left transition-colors ${
        file.tombstoned
          ? 'border-danger-border/60 bg-danger-tint/20 opacity-80'
          : 'border-edge bg-surface-raised/45 hover:border-edge-strong hover:bg-surface-raised'
      }`}
    >
      <div className="h-36 overflow-hidden border-b border-edge bg-surface">
        <MediaPreview file={preview} variant="tile" />
      </div>
      <div className="flex min-h-[6.5rem] flex-col gap-1.5 px-2 py-1.5">
        <div className="flex min-w-0 items-start gap-1.5">
          <FileIcon size={13} className="mt-0.5 shrink-0 text-fg-muted" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-2xs font-semibold text-fg-body" title={file.path}>
              {file.name}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-3xs text-fg-muted">
              <span className="min-w-0 truncate" title={file.path}>
                {fileLocation(file)} / {formatBytes(file.sizeBytes)}
              </span>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: nested references chip only stops propagation inside the keyboard-activatable file card. */}
              <span
                className="shrink-0"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <EntryReferencesChip summary={references} />
              </span>
            </div>
          </div>
          <Tooltip content={file.starred ? 'Unstar file' : 'Star file'}>
            {/* biome-ignore lint/a11y/useSemanticElements: keyboard-activatable custom control nested inside a file card; a button would alter nested layout. */}
            <span
              role="button"
              tabIndex={0}
              aria-label={file.starred ? 'Unstar file' : 'Star file'}
              onClick={(event) => {
                event.stopPropagation();
                onToggleStar();
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                onToggleStar();
              }}
              className={`grid size-6 shrink-0 place-items-center rounded-md border ${
                file.starred
                  ? 'border-warning-border bg-warning-tint text-warning-text'
                  : 'border-edge text-fg-faint hover:bg-surface-overlay hover:text-fg-muted'
              }`}
            >
              *
            </span>
          </Tooltip>
        </div>
        <div className="flex items-center gap-1">
          <span className="max-w-full truncate rounded bg-surface-overlay px-1.5 py-px text-3xs font-semibold uppercase tracking-wide text-fg-muted">
            {fileBadge(file)}
          </span>
          {file.tombstoned && (
            <span className="rounded bg-danger-tint px-1.5 py-px text-3xs font-semibold uppercase tracking-wide text-danger-text">
              removed
            </span>
          )}
        </div>
        <div className="flex min-h-5 flex-wrap items-center gap-1">
          {file.labels.slice(0, 3).map((label) => (
            <span
              key={label}
              className="inline-flex max-w-full items-center gap-1 rounded bg-surface-overlay px-1.5 py-px text-3xs text-fg-secondary"
            >
              <span className="truncate">{label}</span>
              {/* biome-ignore lint/a11y/useSemanticElements: keyboard-activatable inline label control; a button would alter compact chip layout. */}
              <span
                role="button"
                tabIndex={0}
                aria-label={`Remove ${label} label`}
                className="text-fg-faint hover:text-danger-text"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemoveLabel(label);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  event.stopPropagation();
                  onRemoveLabel(label);
                }}
              >
                x
              </span>
            </span>
          ))}
          {file.labels.length > 3 && <span className="text-3xs text-fg-muted">+{file.labels.length - 3}</span>}
          {/* biome-ignore lint/a11y/useSemanticElements: keyboard-activatable inline label control; a button would alter compact chip layout. */}
          <span
            role="button"
            tabIndex={0}
            className="rounded px-1.5 py-px text-3xs text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
            onClick={(event) => {
              event.stopPropagation();
              onAddLabel();
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              event.stopPropagation();
              onAddLabel();
            }}
          >
            + label
          </span>
          {file.tombstoned && (
            // biome-ignore lint/a11y/useSemanticElements: keyboard-activatable inline restore control; a button would alter compact card layout.
            <span
              role="button"
              tabIndex={0}
              className="ml-auto rounded px-1.5 py-px text-3xs font-semibold text-accent-text hover:bg-accent-soft"
              onClick={(event) => {
                event.stopPropagation();
                onRestore();
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                onRestore();
              }}
            >
              restore
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function FilesHub({
  workspaceId,
  channelId,
  sessionId,
  sessionScope,
  defaultScope,
  filesEventSeq = 0,
  sessions,
  initialOpenArtifactId,
  onInitialOpenArtifactHandled,
  onSeedChannelComposer,
  onStartAgentWithTask,
}: {
  workspaceId: string;
  channelId?: string | null;
  sessionId?: string;
  sessionScope?: FilesHubSessionScope;
  defaultScope?: FilesHubDefaultScope;
  filesEventSeq?: number;
  sessions?: Record<string, Session>;
  initialOpenArtifactId?: string | null;
  onInitialOpenArtifactHandled?: (artifactId: string) => void;
  onSeedChannelComposer?: (draft: string) => void;
  onStartAgentWithTask?: (task: string) => void;
}): JSX.Element {
  const location = useLocation();
  const currentDir = useMemo(() => dirFromSearch(location.search), [location.search]);
  const urlFileArtifactId = useMemo(
    () => cleanId(new URLSearchParams(location.search).get(URL_PARAMS.file)),
    [location.search],
  );
  const urlPanel = useMemo(() => lightboxPanelFromSearch(location.search), [location.search]);
  const resolvedDefaultScope: FileHubScope =
    defaultScope === 'session' && sessionScope
      ? 'session'
      : defaultScope === 'workspace'
        ? 'workspace'
        : channelId
          ? 'channel'
          : 'workspace';
  const [scope, setScope] = useState<FileHubScope>(resolvedDefaultScope);
  const [lastBrowseScope, setLastBrowseScope] = useState<FileHubBrowseScope>(
    resolvedDefaultScope === 'workspace' || !channelId ? 'workspace' : 'channel',
  );
  const [filters, setFilters] = useState<Filters>({
    origin: 'all',
    mediaKind: 'all',
    channelId: '',
    sessionId: '',
    label: '',
    starred: false,
    includeDeleted: false,
    includeScratch: true,
    sort: 'recent',
  });
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [files, setFiles] = useState<HubFile[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [markupSource, setMarkupSource] = useState<MarkupPaneSource | null>(null);
  const [applyMarkupCandidate, setApplyMarkupCandidate] = useState<{
    artifactId: string;
    path: string;
    seq: number;
  } | null>(null);
  const [markupNotice, setMarkupNotice] = useState<string | null>(null);
  const [artifactEntryReferences, setArtifactEntryReferences] = useState<Record<string, EntryReferenceSummary | null>>(
    {},
  );
  const searchActive = search.trim().length > 0 || debouncedSearch.trim().length > 0;
  const artifactEntryReferencesFetchedAtRef = useRef(0);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handledLegacyInitialOpenRef = useRef<string | null>(null);
  const scopeEffectInitializedRef = useRef(false);
  const previousScopeRef = useRef<FileHubScope | null>(null);
  const previousSearchActiveRef = useRef(searchActive);
  const revealRef = useRef<{ id: string; state: 'injecting' | 'failed' } | null>(null);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const showMarkupNotice = useCallback((message: string) => {
    setMarkupNotice(message);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setMarkupNotice(null), 2600);
  }, []);

  useEffect(() => {
    setScope(resolvedDefaultScope);
    if (resolvedDefaultScope !== 'session') setLastBrowseScope(resolvedDefaultScope);
  }, [resolvedDefaultScope]);

  const browseScope: FileHubBrowseScope = scope === 'session' ? lastBrowseScope : scope;
  const scopedChannelId = channelId && browseScope === 'channel' ? channelId : null;
  const scopedChannel = scopedChannelId != null;
  const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/files`;
  const effectiveFilters = useMemo(
    () => (scopedChannelId ? { ...filters, channelId: scopedChannelId } : filters),
    [filters, scopedChannelId],
  );

  const updateUrlParams = useCallback(
    (
      patch: { dir?: string | null; file?: string | null; panel?: 'info' | 'history' | null },
      options: { replace?: boolean } = {},
    ) => {
      const params = new URLSearchParams(location.search);
      if ('dir' in patch) {
        const dir = patch.dir?.trim() ?? '';
        if (dir) params.set(URL_PARAMS.dir, dir);
        else params.delete(URL_PARAMS.dir);
      }
      if ('file' in patch) {
        if (patch.file) params.set(URL_PARAMS.file, patch.file);
        else {
          params.delete(URL_PARAMS.file);
          params.delete(URL_PARAMS.panel);
        }
      }
      if ('panel' in patch) {
        if (patch.panel) params.set(URL_PARAMS.panel, patch.panel);
        else params.delete(URL_PARAMS.panel);
      }
      navigate(pathWithSearch(location.pathname, params), options);
    },
    [location.pathname, location.search],
  );

  const navigateToDir = useCallback(
    (dir: string, options: { replace?: boolean } = {}) => {
      setLightboxIndex(null);
      updateUrlParams({ dir, file: null }, options);
    },
    [updateUrlParams],
  );

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (previousSearchActiveRef.current === searchActive) return;
    previousSearchActiveRef.current = searchActive;
    if (searchActive) navigateToDir('', { replace: true });
  }, [navigateToDir, searchActive]);

  useEffect(() => {
    if (!scopeEffectInitializedRef.current) {
      scopeEffectInitializedRef.current = true;
      previousScopeRef.current = scope;
      return;
    }
    if (previousScopeRef.current === scope) return;
    previousScopeRef.current = scope;
    navigateToDir('', { replace: true });
    if (scope !== 'session') setLastBrowseScope(scope);
  }, [navigateToDir, scope]);

  const loadFiles = useCallback(
    async ({ cursor, append }: { cursor?: string | null; append?: boolean } = {}) => {
      const controller = new AbortController();
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setLoadedOnce(false);
        setError(null);
      }
      try {
        const query = queryFor(effectiveFilters, debouncedSearch, cursor);
        const response = await fetch(`${endpoint}?${query.toString()}`, {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await responseError(response, 'Could not load files'));
        const body = (await response.json()) as HubFileListResult;
        setFiles((current) => (append ? [...current, ...body.files] : body.files));
        setNextCursor(body.nextCursor ?? null);
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
      return () => controller.abort();
    },
    [debouncedSearch, endpoint, effectiveFilters],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadedOnce(false);
    setError(null);
    const query = queryFor(effectiveFilters, debouncedSearch);
    fetch(`${endpoint}?${query.toString()}`, { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response, 'Could not load files'));
        return (await response.json()) as HubFileListResult;
      })
      .then((body) => {
        setFiles(body.files);
        setNextCursor(body.nextCursor ?? null);
        setLightboxIndex(null);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const message = err instanceof Error ? err.message : 'Could not load files';
        setFiles([]);
        setNextCursor(null);
        setError(message);
        showErrorToast(message);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setLoadedOnce(true);
        }
      });
    return () => controller.abort();
  }, [debouncedSearch, endpoint, effectiveFilters, filesEventSeq]);

  const toggleStar = useCallback(async (file: HubFile) => {
    const previous = file.starred;
    setFiles((current) => updateFile(current, file.artifactId, { starred: !previous }));
    try {
      const response = await fetch(`/api/files/${file.artifactId}/star`, {
        method: previous ? 'DELETE' : 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(await responseError(response, 'Could not update star'));
      const body = (await response.json()) as { artifactId: string; starred: boolean };
      setFiles((current) => updateFile(current, body.artifactId, { starred: body.starred }));
    } catch (err) {
      setFiles((current) => updateFile(current, file.artifactId, { starred: previous }));
      showErrorToast(err instanceof Error ? err.message : 'Could not update star');
    }
  }, []);

  const addLabel = useCallback(async (file: HubFile) => {
    const label = window.prompt('Label this file')?.trim();
    if (!label || file.labels.includes(label)) return;
    const previous = file.labels;
    setFiles((current) => updateFile(current, file.artifactId, { labels: [...previous, label] }));
    try {
      const response = await fetch(`/api/files/${file.artifactId}/labels`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      if (!response.ok) throw new Error(await responseError(response, 'Could not add label'));
      const body = (await response.json()) as { artifactId: string; labels: string[] };
      setFiles((current) => updateFile(current, body.artifactId, { labels: body.labels }));
    } catch (err) {
      setFiles((current) => updateFile(current, file.artifactId, { labels: previous }));
      showErrorToast(err instanceof Error ? err.message : 'Could not add label');
    }
  }, []);

  const removeLabel = useCallback(async (file: HubFile, label: string) => {
    const previous = file.labels;
    setFiles((current) =>
      updateFile(current, file.artifactId, { labels: previous.filter((value) => value !== label) }),
    );
    try {
      const response = await fetch(`/api/files/${file.artifactId}/labels/${encodeURIComponent(label)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(await responseError(response, 'Could not remove label'));
    } catch (err) {
      setFiles((current) => updateFile(current, file.artifactId, { labels: previous }));
      showErrorToast(err instanceof Error ? err.message : 'Could not remove label');
    }
  }, []);

  const restoreFile = useCallback(async (file: HubFile) => {
    try {
      const response = await fetch(`/api/files/${file.artifactId}/restore`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(await responseError(response, 'Could not restore file'));
      setFiles((current) => updateFile(current, file.artifactId, { tombstoned: false }));
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : 'Could not restore file');
    }
  }, []);

  const sharedCallbacks = useMemo(
    () =>
      createFileLightboxCallbacks({
        files,
        setFiles,
        includeDeleted: filters.includeDeleted,
        reload: loadFiles,
        showError: showErrorToast,
      }),
    [files, filters.includeDeleted, loadFiles],
  );

  const callbacks: LightboxCallbacks = useMemo(
    () => ({
      ...sharedCallbacks,
      onCopyLink: async (file) => {
        try {
          // Entry links unfurl as quote cards in chat, record references, and navigate via /e/;
          // the raw bytes URL remains reachable through Download.
          await navigator.clipboard.writeText(absoluteArtifactEntryUrl(file.id));
        } catch {
          showErrorToast('Could not copy file link.');
        }
      },
      onDiscuss: async (_file, draft) => {
        setLightboxIndex(null);
        updateUrlParams({ file: null }, { replace: false });
        if (channelId && onSeedChannelComposer) {
          onSeedChannelComposer(draft);
          return;
        }
        try {
          await navigator.clipboard.writeText(draft.trimEnd());
          showMarkupNotice('Link copied — paste it in a channel to discuss');
        } catch {
          showErrorToast('Could not copy file link.');
        }
      },
      onMarkup: async (file) => {
        if (!sessionId) return;
        try {
          const [versionsResponse, contentResponse] = await Promise.all([
            fetch(`/api/files/${file.id}/versions`, { credentials: 'same-origin' }),
            fetch(`/api/files/artifact/${file.id}/content`, { credentials: 'same-origin' }),
          ]);
          if (!versionsResponse.ok) {
            throw new Error(await responseError(versionsResponse, 'Could not load version history'));
          }
          if (!contentResponse.ok) {
            throw new Error(await responseError(contentResponse, 'Could not load version content'));
          }
          const versionsBody = (await versionsResponse.json()) as HubFileVersionsResponse;
          const latest = versionsBody.versions[0];
          if (!latest) throw new Error('Could not find the latest file version');
          const { frontmatter, body } = splitMarkdownFrontmatter(await contentResponse.text());
          setMarkupSource({
            artifactId: file.id,
            path: file.name,
            seq: latest.seq,
            workspaceId,
            sessionId,
            frontmatter,
            body,
          });
        } catch (err) {
          showErrorToast(err instanceof Error ? err.message : 'Could not open markup pane');
          throw err;
        }
      },
    }),
    [channelId, onSeedChannelComposer, sessionId, sharedCallbacks, showMarkupNotice, updateUrlParams, workspaceId],
  );

  const scopedFiles = useMemo(() => {
    if (scope !== 'session' || !sessionScope) return files;
    return files.filter((file) => fileMatchesSessionScope(file.path, sessionScope.paths));
  }, [files, scope, sessionScope]);
  const { folders, filesHere } = useMemo(() => folderView(scopedFiles, currentDir), [currentDir, scopedFiles]);
  const visibleFiles = searchActive ? scopedFiles : filesHere;
  const visiblePreviews = useMemo(() => visibleFiles.map(hubFileToPreview), [visibleFiles]);
  const openLightboxAtIndex = useCallback(
    (index: number) => {
      const file = visiblePreviews[index];
      if (!file) return;
      setLightboxIndex(index);
      updateUrlParams({ file: file.id, panel: defaultLightboxPanel() }, { replace: false });
    },
    [updateUrlParams, visiblePreviews],
  );
  const changeLightboxIndex = useCallback(
    (index: number) => {
      const nextIndex = Math.max(0, Math.min(index, visiblePreviews.length - 1));
      const file = visiblePreviews[nextIndex];
      if (!file) return;
      setLightboxIndex(nextIndex);
      updateUrlParams({ file: file.id }, { replace: true });
    },
    [updateUrlParams, visiblePreviews],
  );
  const closeLightbox = useCallback(() => {
    setLightboxIndex(null);
    updateUrlParams({ file: null }, { replace: false });
  }, [updateUrlParams]);
  const changeLightboxPanel = useCallback(
    (panel: 'info' | 'history' | null) => {
      updateUrlParams({ panel }, { replace: true });
    },
    [updateUrlParams],
  );
  const currentLightboxFile =
    lightboxIndex != null && visiblePreviews.length > 0
      ? visiblePreviews[Math.min(lightboxIndex, visiblePreviews.length - 1)]!
      : null;
  const visibleArtifactHandles = useMemo(() => {
    const seen = new Set<string>();
    for (const file of visibleFiles) seen.add(artifactEntryHandle(file.artifactId));
    return [...seen];
  }, [visibleFiles]);
  const visibleArtifactHandleKey = visibleArtifactHandles.join('\n');
  const lightboxEntryReferencesByFileId = useMemo(
    () =>
      Object.fromEntries(
        visibleFiles.map((file) => [
          file.artifactId,
          artifactEntryReferences[artifactEntryHandle(file.artifactId)] ?? null,
        ]),
      ),
    [artifactEntryReferences, visibleFiles],
  );
  const visibleItemCount = searchActive ? visibleFiles.length : folders.length + visibleFiles.length;
  const showBreadcrumb = !searchActive && (currentDir !== '' || folders.length > 0);
  const empty = !loading && !error && visibleItemCount === 0;
  const emptyTitle =
    scope === 'session'
      ? 'No agent files'
      : searchActive
        ? 'No matching files'
        : currentDir
          ? 'Empty folder'
          : 'No files';
  const emptyHint = searchActive
    ? 'Files matching the current search and filters will appear here.'
    : scope === 'session'
      ? 'Files touched by this session will appear here.'
      : currentDir
        ? 'Files added to this folder will appear here.'
        : 'Files matching the current filters will appear here.';

  useEffect(() => {
    if (!loadedOnce) return;
    if (!urlFileArtifactId) {
      setLightboxIndex(null);
      return;
    }
    const file = scopedFiles.find((item) => item.artifactId === urlFileArtifactId);
    if (!file) {
      setLightboxIndex(null);
      return;
    }
    revealRef.current = null;
    if (!searchActive) {
      const targetDir = dirname(file.path);
      if (currentDir !== targetDir) {
        updateUrlParams({ dir: targetDir }, { replace: true });
        return;
      }
    }
    const index = visibleFiles.findIndex((item) => item.artifactId === urlFileArtifactId);
    setLightboxIndex(index >= 0 ? index : null);
  }, [currentDir, loadedOnce, scopedFiles, searchActive, updateUrlParams, urlFileArtifactId, visibleFiles]);

  // Auto-reveal: a ?file= deep link may point at a file the current
  // scope/filters/page don't load (restrictive filters, tombstoned, beyond the
  // loaded page). Fetch its hub row by id, inject it into the list, and let
  // the effect above navigate to its folder and open the lightbox. A deep
  // link should always land on its file or say why it can't.
  useEffect(() => {
    if (!urlFileArtifactId) {
      // Param gone (including after a failed reveal stripped it) — a later
      // navigation to the same id is a fresh attempt.
      revealRef.current = null;
      return;
    }
    if (!loadedOnce) return;
    if (scopedFiles.some((item) => item.artifactId === urlFileArtifactId)) return;
    if (files.some((item) => item.artifactId === urlFileArtifactId)) {
      // Loaded but filtered out by the session scope's path filter — widen to
      // workspace scope, pre-syncing the guard that would otherwise clear
      // ?file= on the scope flip.
      if (scope === 'session') {
        previousScopeRef.current = 'workspace';
        setScope('workspace');
        setLastBrowseScope('workspace');
      }
      return;
    }
    if (revealRef.current?.id === urlFileArtifactId) return;
    revealRef.current = { id: urlFileArtifactId, state: 'injecting' };
    void (async () => {
      let file: HubFile | null = null;
      try {
        const response = await fetch(`/api/files/${encodeURIComponent(urlFileArtifactId)}/locator`, {
          credentials: 'same-origin',
        });
        if (response.ok) file = (await response.json()) as HubFile;
      } catch {
        // fall through to the failure toast
      }
      if (revealRef.current?.id !== urlFileArtifactId) return;
      if (!file || file.artifactId !== urlFileArtifactId) {
        revealRef.current = { id: urlFileArtifactId, state: 'failed' };
        showErrorToast('That file is not available — it may have been removed or is not shared with you.');
        updateUrlParams({ file: null }, { replace: true });
        return;
      }
      const found = file;
      revealRef.current = null;
      setFiles((current) =>
        current.some((item) => item.artifactId === found.artifactId) ? current : [...current, found],
      );
    })();
  }, [files, loadedOnce, scope, scopedFiles, updateUrlParams, urlFileArtifactId]);

  useEffect(() => {
    const legacyArtifactId = cleanId(initialOpenArtifactId);
    if (!legacyArtifactId || urlFileArtifactId || handledLegacyInitialOpenRef.current === legacyArtifactId) return;
    handledLegacyInitialOpenRef.current = legacyArtifactId;
    updateUrlParams({ file: legacyArtifactId }, { replace: true });
    onInitialOpenArtifactHandled?.(legacyArtifactId);
  }, [initialOpenArtifactId, onInitialOpenArtifactHandled, updateUrlParams, urlFileArtifactId]);

  useEffect(() => {
    setApplyMarkupCandidate(null);
    if (!currentLightboxFile || !channelId) return;
    if (currentLightboxFile.mediaKind !== 'text' && currentLightboxFile.mediaKind !== 'code') return;
    const controller = new AbortController();
    void Promise.all([
      fetch(`/api/files/${currentLightboxFile.id}/versions`, {
        credentials: 'same-origin',
        signal: controller.signal,
      }),
      fetch(`/api/files/artifact/${currentLightboxFile.id}/content`, {
        credentials: 'same-origin',
        signal: controller.signal,
      }),
    ])
      .then(async ([versionsResponse, contentResponse]) => {
        if (!versionsResponse.ok || !contentResponse.ok) return null;
        const versionsBody = (await versionsResponse.json()) as HubFileVersionsResponse;
        const latest = versionsBody.versions[0];
        if (!latest) return null;
        const text = await contentResponse.text();
        if (!containsCriticMarkup(text)) return null;
        return {
          artifactId: currentLightboxFile.id,
          path: currentLightboxFile.path ?? currentLightboxFile.name,
          seq: latest.seq,
        };
      })
      .then((target) => {
        if (!controller.signal.aborted) setApplyMarkupCandidate(target);
      })
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.warn('failed to inspect file markup', err);
        }
      });
    return () => controller.abort();
  }, [channelId, currentLightboxFile]);

  useEffect(() => {
    if (visibleArtifactHandles.length === 0) return;
    const now = Date.now();
    const stale = now - artifactEntryReferencesFetchedAtRef.current >= ENTRY_REFERENCES_REFETCH_MS;
    const handles = stale
      ? visibleArtifactHandles
      : visibleArtifactHandles.filter((handle) => !(handle in artifactEntryReferences));
    if (handles.length === 0) return;
    artifactEntryReferencesFetchedAtRef.current = now;
    let disposed = false;
    void queryEntryReferencesForHandles(handles)
      .then((references) => {
        if (disposed) return;
        setArtifactEntryReferences((prev) => {
          const next = { ...prev };
          for (const handle of handles) next[handle] = references[handle] ?? null;
          return next;
        });
      })
      .catch((err: unknown) => {
        console.warn('failed to query artifact entry references', err);
      });
    return () => {
      disposed = true;
    };
  }, [artifactEntryReferences, visibleArtifactHandleKey, visibleArtifactHandles]);

  return (
    <div data-testid="files-hub" className="relative flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-edge px-3 py-2 md:h-10 md:flex-nowrap md:py-0">
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-fg max-md:basis-full">
          Files <span className="tabular-nums text-fg-muted">/ {visibleItemCount}</span>
        </h3>
        {sessionScope && (
          // biome-ignore lint/a11y/useSemanticElements: compact segmented control already exposes a named group and pressed buttons; fieldset would alter toolbar layout.
          <div
            role="group"
            aria-label="Agent file scope"
            className="flex rounded-md border border-edge bg-surface p-0.5 max-md:min-w-0 max-md:flex-1 md:shrink-0"
          >
            {(['session', 'channel'] as const).map((nextScope) => {
              const active = nextScope === 'session' ? scope === 'session' : scope !== 'session';
              return (
                <button
                  key={nextScope}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setScope(nextScope === 'session' ? 'session' : lastBrowseScope)}
                  className={`h-6 rounded px-2 text-3xs font-semibold max-md:min-h-11 max-md:min-w-0 max-md:flex-1 max-md:truncate ${
                    active
                      ? 'bg-surface-overlay text-fg'
                      : 'text-fg-tertiary hover:bg-surface-overlay/60 hover:text-fg-body'
                  }`}
                >
                  {nextScope === 'session' ? sessionScope.label : 'All files'}
                </button>
              );
            })}
          </div>
        )}
        {channelId && scope !== 'session' && (
          // biome-ignore lint/a11y/useSemanticElements: compact segmented control already exposes a named group and pressed buttons; fieldset would alter toolbar layout.
          <div
            role="group"
            aria-label="File scope"
            className="flex rounded-md border border-edge bg-surface p-0.5 max-md:min-w-0 max-md:flex-1 md:shrink-0"
          >
            {(['channel', 'workspace'] as const).map((nextScope) => {
              const active = scope === nextScope;
              return (
                <button
                  key={nextScope}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setScope(nextScope)}
                  className={`h-6 rounded px-2 text-3xs font-semibold max-md:min-h-11 max-md:min-w-0 max-md:flex-1 max-md:truncate ${
                    active
                      ? 'bg-surface-overlay text-fg'
                      : 'text-fg-tertiary hover:bg-surface-overlay/60 hover:text-fg-body'
                  }`}
                >
                  {nextScope === 'channel' ? 'Channel' : 'Workspace'}
                </button>
              );
            })}
          </div>
        )}
        <span className="text-2xs text-fg-muted max-md:ml-auto md:shrink-0">
          {scope === 'session' ? 'Agent files' : scopedChannel ? 'Channel files' : 'Workspace files'}
        </span>
      </div>
      <FilterBar
        filters={filters}
        setFilters={setFilters}
        search={search}
        setSearch={setSearch}
        scopedChannel={scopedChannel}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading && visibleItemCount === 0 && <div className="px-1 py-2 text-2xs text-fg-muted">loading files...</div>}
        {error && (
          <div role="alert" className="px-1 py-2 text-2xs text-danger-text">
            {error}
          </div>
        )}
        {showBreadcrumb && <FolderBreadcrumb currentDir={currentDir} onNavigate={navigateToDir} />}
        {empty && <EmptyState title={emptyTitle} hint={emptyHint} />}
        {!error && visibleItemCount > 0 && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {!searchActive &&
              folders.map((folder) => (
                <FolderTile key={folder.path} folder={folder} onOpen={() => navigateToDir(folder.path)} />
              ))}
            {visibleFiles.map((file, index) => (
              <FileTile
                key={file.artifactId}
                file={file}
                preview={visiblePreviews[index]!}
                references={artifactEntryReferences[artifactEntryHandle(file.artifactId)]}
                onOpen={() => openLightboxAtIndex(index)}
                onToggleStar={() => void toggleStar(file)}
                onAddLabel={() => void addLabel(file)}
                onRemoveLabel={(label) => void removeLabel(file, label)}
                onRestore={() => void restoreFile(file)}
              />
            ))}
          </div>
        )}
        {nextCursor && !error && (
          <div className="mt-3 flex justify-center">
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
      {lightboxIndex != null && visiblePreviews.length > 0 && (
        <Lightbox
          files={visiblePreviews}
          index={Math.min(lightboxIndex, visiblePreviews.length - 1)}
          onIndexChange={changeLightboxIndex}
          sessionId={sessionId}
          entryReferencesByFileId={lightboxEntryReferencesByFileId}
          panel={urlPanel}
          onPanelChange={changeLightboxPanel}
          applyMarkupTarget={
            applyMarkupCandidate && channelId
              ? {
                  ...applyMarkupCandidate,
                  channelId,
                  ...(sessions ? { sessions } : {}),
                  ...(onStartAgentWithTask ? { onSpawnNewAgent: onStartAgentWithTask } : {}),
                }
              : null
          }
          onClose={closeLightbox}
          {...callbacks}
        />
      )}
      {markupNotice && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-toast -translate-x-1/2 rounded-md border border-accent-border/60 bg-surface-overlay px-3 py-2 text-xs font-medium text-accent-text-strong shadow-lg">
          {markupNotice}
        </div>
      )}
      {markupSource && (
        <MarkupPane
          source={markupSource}
          onClose={() => setMarkupSource(null)}
          onSent={() => showMarkupNotice('Markup sent to agent')}
        />
      )}
    </div>
  );
}
