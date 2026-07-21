import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, JSX, KeyboardEvent, RefObject } from 'react';
import {
  containsCriticMarkup,
  FILE_CATEGORIES,
  fileTypeLabel,
  splitMarkdownFrontmatter,
  type FileCategory,
  type HubFile,
  type HubFileListResult,
  type HubFileVersionsResponse,
} from '@atrium/surface-client';
import { Menu, MenuContent, MenuLabel, MenuSeparator, MenuTrigger, Tooltip } from '../components/a11y';
import {
  EntryReferencesChip,
  queryEntryReferencesForHandles,
  type EntryReferenceSummary,
} from '../components/EntryReferencesChip';
import { SearchIcon } from '../components/icons';
import { MarkupPane, type MarkupPaneSource } from '../components/MarkupPane';
import { Lightbox, MediaPreview, defaultLightboxPanel } from '../components/media';
import type { LightboxCallbacks, PreviewFile } from '../components/media';
import { effectiveMediaKind, isAppFile } from '../components/media/utils';
import { showErrorToast } from '../components/Toasts';
import { navigate, URL_PARAMS, useLocation } from '../router';
import { useDialog } from '../useDialog';
import { EmptyState } from './EmptyState';
import {
  artifactEntryHandle,
  artifactEntryUrl as absoluteArtifactEntryUrl,
  cleanId,
  createFileLightboxCallbacks,
  hubFileToPreview,
  lightboxPanelFromSearch,
  pathWithSearch,
  responseError,
  updateFile,
} from './fileHubCore';
import type { Session } from './types';

type GallerySort = 'recent' | 'name' | 'size';
type GalleryScope = 'everything' | 'channel' | 'session';
type GalleryCategorySelection = 'all' | FileCategory;

export interface GalleryScopeContext {
  channelId?: string | null;
  sessionId?: string | null;
  /**
   * Scope to fall back to when the URL carries no explicit scope param — lets
   * the detached session view open in session scope without seeding the URL.
   */
  defaultScope?: GalleryScope;
  /** Whether scratch files are included when the URL omits the toggle. */
  defaultIncludeScratch?: boolean;
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
const TEXT_TILE_PREVIEW_SIZE_LIMIT_BYTES = 512 * 1024;
const ENTRY_REFERENCES_REFETCH_MS = 60_000;
const SORT_VALUES = new Set<GallerySort>(['recent', 'name', 'size']);
const GALLERY_URL_PARAM_KEYS = [
  'q',
  'category',
  'channelId',
  'sessionId',
  'sort',
  'includeDeleted',
  'includeScratch',
  'starred',
  'label',
];

/**
 * Keep server-query state separate from presentation-only URL state. Opening a
 * file or toggling its lightbox panel must not invalidate the gallery listing.
 */
export function galleryQuerySearch(search: string, defaultIncludeScratch = false): string {
  return galleryUrlSearchParams(
    galleryStateFromSearch(search, { defaultIncludeScratch }),
    defaultIncludeScratch,
  ).toString();
}

function isFileCategory(value: string | null): value is FileCategory {
  return value != null && FILE_CATEGORIES.some((category) => category.key === value);
}

function boolFromParam(params: URLSearchParams, key: string): boolean {
  return params.get(key) === 'true';
}

export function galleryStateFromSearch(search: string, context: GalleryScopeContext = {}): GalleryQueryState {
  const params = new URLSearchParams(search);
  const category = params.get('category');
  const queryChannelId = cleanId(params.get('channelId'));
  const querySessionId = cleanId(params.get('sessionId'));
  const sort = params.get('sort');
  const contextChannelId = cleanId(context.channelId);
  const contextSessionId = cleanId(context.sessionId);
  const scope: GalleryScope = querySessionId
    ? 'session'
    : queryChannelId
      ? 'channel'
      : context.defaultScope === 'session' && contextSessionId
        ? 'session'
        : context.defaultScope === 'channel' && contextChannelId
          ? 'channel'
          : 'everything';

  return {
    q: params.get('q') ?? '',
    category: isFileCategory(category) ? category : 'all',
    scope,
    channelId: queryChannelId || contextChannelId,
    sessionId: querySessionId || contextSessionId,
    sort: sort && SORT_VALUES.has(sort as GallerySort) ? (sort as GallerySort) : 'recent',
    includeDeleted: boolFromParam(params, 'includeDeleted'),
    includeScratch: params.has('includeScratch')
      ? boolFromParam(params, 'includeScratch')
      : (context.defaultIncludeScratch ?? false),
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

function galleryUrlSearchParams(state: GalleryQueryState, defaultIncludeScratch = false): URLSearchParams {
  const params = new URLSearchParams();
  const q = state.q.trim();
  const label = state.label.trim();
  if (q) params.set('q', q);
  if (state.category !== 'all') params.set('category', state.category);
  if (state.scope === 'channel' && state.channelId.trim()) params.set('channelId', state.channelId.trim());
  if (state.scope === 'session' && state.sessionId.trim()) params.set('sessionId', state.sessionId.trim());
  if (state.sort !== 'recent') params.set('sort', state.sort);
  if (state.includeDeleted) params.set('includeDeleted', 'true');
  // Encode scratch only when it diverges from the view's default so a
  // default-scratch detached view can still persist an explicit opt-out.
  if (state.includeScratch !== defaultIncludeScratch) params.set('includeScratch', String(state.includeScratch));
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

function shouldFetchTextForTilePreview(file: PreviewFile): boolean {
  if (isAppFile(file)) return false;
  const kind = effectiveMediaKind(file);
  return kind === 'text' || kind === 'code' || kind === 'data';
}

function hasSafeTextTilePreviewSize(file: PreviewFile): boolean {
  return (
    typeof file.sizeBytes === 'number' &&
    Number.isFinite(file.sizeBytes) &&
    file.sizeBytes <= TEXT_TILE_PREVIEW_SIZE_LIMIT_BYTES
  );
}

function shouldUseTypeChipPreview(file: PreviewFile): boolean {
  return shouldFetchTextForTilePreview(file) && !hasSafeTextTilePreviewSize(file);
}

function TypeChipPreview({ label }: { label: string }) {
  return (
    <div className="flex size-full items-center justify-center px-3">
      <span className="max-w-full truncate rounded-md border border-edge-strong bg-surface-overlay px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg-secondary">
        {label}
      </span>
    </div>
  );
}

function GalleryCardPreview({ file, preview, hydrated }: { file: HubFile; preview: PreviewFile; hydrated: boolean }) {
  return !hydrated || shouldUseTypeChipPreview(preview) ? (
    <TypeChipPreview label={fileTypeLabel(file)} />
  ) : (
    <MediaPreview file={preview} variant="tile" />
  );
}

function StarGlyph({ filled }: { filled: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={13}
      height={13}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9 6.2 20.86l1.11-6.46-4.7-4.58 6.49-.94Z" />
    </svg>
  );
}

function nestedControlKeyDown(event: KeyboardEvent<HTMLElement>, run: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  run();
}

const LABEL_POPOVER_WIDTH = 192;

/**
 * Inline "Add label" popover anchored under the card's "+ label" chip. Built on
 * the same `useDialog` primitive as the other anchored menus (ChannelMembersMenu,
 * MessageActionMenu): it focuses the input on open, returns focus to the chip on
 * close, and owns Escape (isModalDialogOpen makes the layered-escape dispatcher
 * stand down, so Escape here never reaches the lightbox/route behind the grid).
 * Positioned `fixed` off the chip's rect so it escapes the card's overflow clip.
 */
function LabelPopover({
  anchorRef,
  suggestions,
  suggestionsId,
  onSubmit,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  suggestions: string[];
  suggestionsId: string;
  onSubmit: (label: string) => void;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState('');

  useDialog({
    open: true,
    containerRef,
    initialFocusRef: inputRef,
    invokerRef: anchorRef,
    closeOnOutsidePointer: true,
    onClose,
  });

  const submit = () => {
    const trimmed = draft.trim();
    // Empty and duplicate handling lives in the card's addLabel; submit always closes.
    if (trimmed) onSubmit(trimmed);
    onClose();
  };

  const rect = anchorRef.current?.getBoundingClientRect();
  const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
  const style: CSSProperties = rect
    ? { top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, viewportWidth - LABEL_POPOVER_WIDTH - 8)) }
    : { top: 0, left: 0 };

  return (
    // Clicks/keys inside the popover are stopped so they never reach the
    // keyboard-activatable card behind it (which would open the lightbox).
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Add label"
      style={style}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      className="fixed z-dropdown w-48 rounded-md border border-edge-strong bg-surface-overlay p-1.5 shadow-lg"
    >
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
        list={suggestions.length > 0 ? suggestionsId : undefined}
        placeholder="Add label"
        aria-label="Add label"
        className="w-full rounded border border-edge bg-surface px-2 py-1 text-2xs text-fg-body outline-none focus:border-edge-focus placeholder:text-fg-faint"
      />
      {suggestions.length > 0 && (
        <datalist id={suggestionsId}>
          {suggestions.map((label) => (
            <option key={label} value={label} />
          ))}
        </datalist>
      )}
    </div>
  );
}

function GalleryCard({
  file,
  references,
  knownLabels,
  onOpen,
  onToggleStar,
  onAddLabel,
  onRemoveLabel,
  onRestore,
  previewHydrated,
}: {
  file: HubFile;
  references?: EntryReferenceSummary | null;
  knownLabels: string[];
  onOpen: () => void;
  onToggleStar: () => void;
  onAddLabel: (label: string) => void;
  onRemoveLabel: (label: string) => void;
  onRestore: () => void;
  previewHydrated: boolean;
}) {
  // Route-only lightbox changes rerender Gallery, but a stable file must keep a
  // stable preview object so text renderers do not refetch behind the overlay.
  const preview = useMemo(() => hubFileToPreview(file), [file]);
  const showPath = effectiveMediaKind(preview) !== 'image';
  const [labelPopoverOpen, setLabelPopoverOpen] = useState(false);
  const addLabelRef = useRef<HTMLSpanElement | null>(null);
  const labelSuggestions = useMemo(
    () => knownLabels.filter((label) => !file.labels.includes(label)),
    [file.labels, knownLabels],
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: keyboard-activatable file card; a <button> can't host the nested star/label controls.
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => nestedControlKeyDown(event, onOpen)}
      className={`group relative flex min-h-52 min-w-0 flex-col overflow-hidden rounded-md border text-left transition-colors ${
        file.tombstoned
          ? 'border-danger-border/60 bg-danger-tint/20 opacity-80'
          : 'border-edge bg-surface-raised/45 hover:border-edge-strong hover:bg-surface-raised'
      }`}
    >
      <div className="aspect-[4/3] w-full overflow-hidden border-b border-edge bg-surface">
        <div
          data-gallery-preview-id={file.artifactId}
          className="size-full transition-transform duration-200 ease-out group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
        >
          <GalleryCardPreview file={file} preview={preview} hydrated={previewHydrated} />
        </div>
      </div>
      <Tooltip content={file.starred ? 'Unstar file' : 'Star file'}>
        {/* biome-ignore lint/a11y/useSemanticElements: keyboard-activatable overlay control nested inside the card. */}
        <span
          role="button"
          tabIndex={0}
          aria-label={file.starred ? 'Unstar file' : 'Star file'}
          aria-pressed={file.starred}
          onClick={(event) => {
            event.stopPropagation();
            onToggleStar();
          }}
          onKeyDown={(event) => nestedControlKeyDown(event, onToggleStar)}
          className={`absolute right-2 top-2 grid size-7 place-items-center rounded-md border shadow-sm transition-opacity ${
            file.starred
              ? 'border-warning-border bg-warning-tint text-warning-text opacity-100'
              : 'border-edge bg-surface/85 text-fg-muted opacity-0 hover:bg-surface-overlay hover:text-fg group-hover:opacity-100 focus-visible:opacity-100'
          }`}
        >
          <StarGlyph filled={file.starred} />
        </span>
      </Tooltip>
      <div className="flex min-h-20 min-w-0 flex-1 flex-col justify-between gap-2 px-2.5 py-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="min-w-0 flex-1 truncate text-xs font-semibold text-fg-body" title={file.path}>
              {file.name}
            </div>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: entry-ref chip only stops propagation inside the keyboard-activatable card. */}
            <span
              className="shrink-0"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <EntryReferencesChip summary={references} />
            </span>
          </div>
          <div className="mt-1 truncate text-3xs text-fg-muted" title={fileMeta(file)}>
            {fileMeta(file)}
          </div>
        </div>
        {showPath && (
          <div className="truncate text-3xs text-fg-faint" title={file.path}>
            {file.path}
          </div>
        )}
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
                onKeyDown={(event) => nestedControlKeyDown(event, () => onRemoveLabel(label))}
              >
                ×
              </span>
            </span>
          ))}
          {file.labels.length > 3 && <span className="text-3xs text-fg-muted">+{file.labels.length - 3}</span>}
          {/* biome-ignore lint/a11y/useSemanticElements: keyboard-activatable inline label control; a button would alter compact chip layout. */}
          <span
            ref={addLabelRef}
            role="button"
            tabIndex={0}
            aria-label="Add label"
            aria-haspopup="dialog"
            aria-expanded={labelPopoverOpen}
            className="rounded px-1.5 py-px text-3xs text-fg-muted opacity-0 hover:bg-surface-overlay hover:text-fg-body focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              setLabelPopoverOpen(true);
            }}
            onKeyDown={(event) => nestedControlKeyDown(event, () => setLabelPopoverOpen(true))}
          >
            + label
          </span>
          {labelPopoverOpen && (
            <LabelPopover
              anchorRef={addLabelRef}
              suggestions={labelSuggestions}
              suggestionsId={`gallery-label-suggestions-${file.artifactId}`}
              onSubmit={onAddLabel}
              onClose={() => setLabelPopoverOpen(false)}
            />
          )}
          {file.tombstoned && (
            // biome-ignore lint/a11y/useSemanticElements: keyboard-activatable inline restore control; a button would alter compact card layout.
            <span
              role="button"
              tabIndex={0}
              aria-label="Restore file"
              className="ml-auto rounded px-1.5 py-px text-3xs font-semibold text-accent-text hover:bg-accent-soft"
              onClick={(event) => {
                event.stopPropagation();
                onRestore();
              }}
              onKeyDown={(event) => nestedControlKeyDown(event, onRestore)}
            >
              restore
            </span>
          )}
        </div>
      </div>
    </div>
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
      <button
        type="button"
        aria-pressed={value === 'all'}
        onClick={() => onChange('all')}
        className={chipClass(value === 'all')}
      >
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
  onStartAgentWithTask,
  sessions,
  defaultScope = 'everything',
  defaultIncludeScratch = false,
}: {
  workspaceId: string;
  channelId?: string | null;
  sessionId?: string | null;
  filesEventSeq?: number;
  initialOpenArtifactId?: string | null;
  onInitialOpenArtifactHandled?: (artifactId: string) => void;
  onSeedChannelComposer?: (draft: string) => void;
  /** Seed a new agent from an applied markup review (Lightbox → apply markup). */
  onStartAgentWithTask?: (task: string) => void;
  sessions?: Record<string, Session>;
  /** Scope to open in when the URL carries no explicit scope param. */
  defaultScope?: GalleryScope;
  /** Whether the initial listing includes scratch files (detached session view). */
  defaultIncludeScratch?: boolean;
}): JSX.Element {
  const location = useLocation();
  const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/files`;
  const querySearch = useMemo(
    () => galleryQuerySearch(location.search, defaultIncludeScratch),
    [defaultIncludeScratch, location.search],
  );
  const urlFileArtifactId = useMemo(
    () => cleanId(new URLSearchParams(location.search).get(URL_PARAMS.file)),
    [location.search],
  );
  const urlPanel = useMemo(() => lightboxPanelFromSearch(location.search), [location.search]);
  const parsedWithoutContext = useMemo(() => galleryStateFromSearch(querySearch), [querySearch]);
  const [rememberedScopeIds, setRememberedScopeIds] = useState(() => ({
    channelId: parsedWithoutContext.channelId || cleanId(channelId),
    sessionId: parsedWithoutContext.sessionId || cleanId(sessionId),
  }));
  const queryState = useMemo(
    () =>
      galleryStateFromSearch(querySearch, {
        channelId: rememberedScopeIds.channelId || channelId,
        sessionId: rememberedScopeIds.sessionId || sessionId,
        defaultScope,
        defaultIncludeScratch,
      }),
    [
      channelId,
      defaultIncludeScratch,
      defaultScope,
      querySearch,
      rememberedScopeIds.channelId,
      rememberedScopeIds.sessionId,
      sessionId,
    ],
  );
  const [searchDraft, setSearchDraft] = useState(queryState.q);
  const [files, setFiles] = useState<HubFile[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [hydratedPreviewIds, setHydratedPreviewIds] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [markupSource, setMarkupSource] = useState<MarkupPaneSource | null>(null);
  const [applyMarkupCandidate, setApplyMarkupCandidate] = useState<{
    artifactId: string;
    path: string;
    seq: number;
  } | null>(null);
  const [artifactEntryReferences, setArtifactEntryReferences] = useState<Record<string, EntryReferenceSummary | null>>(
    {},
  );
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const handledLegacyInitialOpenRef = useRef<string | null>(null);
  const revealRef = useRef<{ id: string; state: 'injecting' | 'failed' } | null>(null);
  const artifactEntryReferencesFetchedAtRef = useRef(0);

  const previews = useMemo(() => files.map(hubFileToPreview), [files]);
  const knownLabels = useMemo(() => {
    const seen = new Set<string>();
    for (const file of files) for (const label of file.labels) seen.add(label);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [files]);
  const activeScope =
    queryState.scope === 'session' ? 'session' : queryState.scope === 'channel' ? 'channel' : 'everything';
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

  const addLabel = useCallback(async (file: HubFile, rawLabel: string) => {
    const label = rawLabel.trim();
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

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || files.length === 0) return;
    const fileIds = new Set(files.map((file) => file.artifactId));
    setHydratedPreviewIds((current) => {
      const retained = [...current].filter((id) => fileIds.has(id));
      if (retained.length === current.size) return current;
      return new Set(retained);
    });
    const nodes = root.querySelectorAll<HTMLElement>('[data-gallery-preview-id]');
    if (typeof IntersectionObserver === 'undefined') {
      setHydratedPreviewIds((current) => {
        const ids = files.map((file) => file.artifactId);
        if (current.size === ids.length && ids.every((id) => current.has(id))) return current;
        return new Set(ids);
      });
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visibleIds = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => (entry.target as HTMLElement).dataset.galleryPreviewId)
          .filter((id): id is string => Boolean(id));
        if (visibleIds.length === 0) return;
        setHydratedPreviewIds((current) => {
          const next = new Set(current);
          let changed = false;
          for (const id of visibleIds) {
            if (next.has(id)) continue;
            next.add(id);
            changed = true;
          }
          return changed ? next : current;
        });
        for (const entry of entries) {
          if (entry.isIntersecting) observer.unobserve(entry.target);
        }
      },
      { root, rootMargin: '240px' },
    );
    for (const node of nodes) {
      observer.observe(node);
    }
    return () => observer.disconnect();
  }, [files]);

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
      const params = new URLSearchParams(location.search);
      for (const key of GALLERY_URL_PARAM_KEYS) params.delete(key);
      for (const [key, value] of galleryUrlSearchParams(next, defaultIncludeScratch)) params.set(key, value);
      navigate(pathWithSearch(location.pathname, params), options);
    },
    [defaultIncludeScratch, location.pathname, location.search, queryState],
  );

  const updateLightboxSearch = useCallback(
    (patch: { file?: string | null; panel?: 'info' | 'history' | null }, options: { replace?: boolean } = {}) => {
      const params = new URLSearchParams(location.search);
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

  const openLightboxAtIndex = useCallback(
    (index: number) => {
      const file = previews[index];
      if (!file) return;
      setLightboxIndex(index);
      updateLightboxSearch({ file: file.id, panel: defaultLightboxPanel() }, { replace: false });
    },
    [previews, updateLightboxSearch],
  );

  const changeLightboxIndex = useCallback(
    (index: number) => {
      const nextIndex = Math.max(0, Math.min(index, previews.length - 1));
      const file = previews[nextIndex];
      if (!file) return;
      setLightboxIndex(nextIndex);
      updateLightboxSearch({ file: file.id }, { replace: true });
    },
    [previews, updateLightboxSearch],
  );

  const closeLightbox = useCallback(() => {
    setLightboxIndex(null);
    updateLightboxSearch({ file: null }, { replace: false });
  }, [updateLightboxSearch]);

  const changeLightboxPanel = useCallback(
    (panel: 'info' | 'history' | null) => {
      updateLightboxSearch({ panel }, { replace: true });
    },
    [updateLightboxSearch],
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
    if (!loadedOnce) return;
    if (!urlFileArtifactId) {
      setLightboxIndex(null);
      return;
    }
    const index = files.findIndex((file) => file.artifactId === urlFileArtifactId);
    if (index >= 0) revealRef.current = null;
    setLightboxIndex(index >= 0 ? index : null);
  }, [files, loadedOnce, urlFileArtifactId]);

  // Auto-reveal: a ?file= deep link may point at a file the current
  // filters/page don't load (restrictive filters, tombstoned, beyond the
  // loaded page). Fetch its hub row by id and inject it so the effect above
  // opens the lightbox. A deep link should always land on its file or say
  // why it can't.
  useEffect(() => {
    if (!urlFileArtifactId) {
      // Param gone (including after a failed reveal stripped it) — a later
      // navigation to the same id is a fresh attempt.
      revealRef.current = null;
      return;
    }
    if (!loadedOnce) return;
    if (files.some((file) => file.artifactId === urlFileArtifactId)) return;
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
        updateLightboxSearch({ file: null }, { replace: true });
        return;
      }
      const found = file;
      revealRef.current = null;
      setFiles((current) =>
        current.some((item) => item.artifactId === found.artifactId) ? current : [...current, found],
      );
    })();
  }, [files, loadedOnce, updateLightboxSearch, urlFileArtifactId]);

  useEffect(() => {
    const legacyArtifactId = cleanId(initialOpenArtifactId);
    if (!legacyArtifactId || urlFileArtifactId || handledLegacyInitialOpenRef.current === legacyArtifactId) return;
    handledLegacyInitialOpenRef.current = legacyArtifactId;
    updateLightboxSearch({ file: legacyArtifactId }, { replace: true });
    onInitialOpenArtifactHandled?.(legacyArtifactId);
  }, [initialOpenArtifactId, onInitialOpenArtifactHandled, updateLightboxSearch, urlFileArtifactId]);

  const sharedCallbacks = useMemo(
    () =>
      createFileLightboxCallbacks({
        files,
        setFiles,
        includeDeleted: queryState.includeDeleted,
        reload: loadFiles,
        showError: showErrorToast,
      }),
    [files, loadFiles, queryState.includeDeleted],
  );

  const callbacks: LightboxCallbacks = useMemo(
    () => ({
      ...sharedCallbacks,
      onCopyLink: async (file) => {
        try {
          await navigator.clipboard.writeText(absoluteArtifactEntryUrl(file.id));
          showNotice('Link copied');
        } catch {
          showErrorToast('Could not copy file link.');
        }
      },
      onDiscuss: async (_file, draft) => {
        closeLightbox();
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
    [channelId, closeLightbox, onSeedChannelComposer, sessionId, sharedCallbacks, showNotice, workspaceId],
  );

  const currentLightboxFile =
    lightboxIndex != null && previews.length > 0 ? previews[Math.min(lightboxIndex, previews.length - 1)]! : null;

  // Apply-markup: when the open file carries CriticMarkup, offer to apply it via
  // an agent. Requires a channel to route the spawned/steered agent into.
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

  const visibleArtifactHandles = useMemo(() => {
    const seen = new Set<string>();
    for (const file of files) seen.add(artifactEntryHandle(file.artifactId));
    return [...seen];
  }, [files]);
  const visibleArtifactHandleKey = visibleArtifactHandles.join('\n');
  const lightboxEntryReferencesByFileId = useMemo(
    () =>
      Object.fromEntries(
        files.map((file) => [file.artifactId, artifactEntryReferences[artifactEntryHandle(file.artifactId)] ?? null]),
      ),
    [artifactEntryReferences, files],
  );

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
              <GalleryCard
                key={file.artifactId}
                file={file}
                references={artifactEntryReferences[artifactEntryHandle(file.artifactId)]}
                knownLabels={knownLabels}
                onOpen={() => openLightboxAtIndex(index)}
                onToggleStar={() => void toggleStar(file)}
                onAddLabel={(label) => void addLabel(file, label)}
                onRemoveLabel={(label) => void removeLabel(file, label)}
                onRestore={() => void restoreFile(file)}
                previewHydrated={hydratedPreviewIds.has(file.artifactId)}
              />
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
          onIndexChange={changeLightboxIndex}
          sessionId={sessionId ?? undefined}
          entryReferencesByFileId={lightboxEntryReferencesByFileId}
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
          panel={urlPanel}
          onPanelChange={changeLightboxPanel}
          {...callbacks}
        />
      )}
      {notice && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-toast -translate-x-1/2 rounded-md border border-accent-border/60 bg-surface-overlay px-3 py-2 text-xs font-medium text-accent-text-strong shadow-lg">
          {notice}
        </div>
      )}
      {markupSource && (
        <MarkupPane
          source={markupSource}
          onClose={() => setMarkupSource(null)}
          onSent={() => showNotice('Markup sent to agent')}
        />
      )}
    </div>
  );
}
