export type FileOrigin = 'upload' | 'agent' | 'workspace';

export interface HubFileUploader {
  id: string;
  name?: string;
}

export interface HubFile {
  artifactId: string;
  workspaceId: string;
  path: string;
  name: string;
  mime: string | null;
  mediaKind: string | null;
  isText: boolean | null;
  sizeBytes: number | null;
  thumbnailUrl?: string | null;
  width?: number;
  height?: number;
  origin: FileOrigin;
  uploader?: HubFileUploader;
  channelId?: string | null;
  sessionId?: string | null;
  sourceMessageId?: string | null;
  createdAt: string;
  updatedAt: string;
  versionSeq: number;
  labels: string[];
  starred: boolean;
  tombstoned: boolean;
}

export interface HubFileListQuery {
  origin?: FileOrigin[];
  mediaKind?: string[];
  /** Human-facing category chip (Gallery). Server-side so pagination stays correct. */
  category?: FileCategory;
  channelId?: string;
  sessionId?: string;
  label?: string;
  starred?: boolean;
  q?: string;
  includeDeleted?: boolean;
  includeScratch?: boolean;
  sort?: 'recent' | 'name' | 'size';
  cursor?: string;
  limit?: number;
}

// === Gallery categories (shared by web + mobile) ===
// Human categories that replace the ledger-internal Source/media_kind vocabulary
// on the Gallery surface. Chips are non-exclusive filters (a file can match more
// than one); `matchesCategory` is the single source of truth, mirrored by the
// server's SQL predicate so client filtering and server filtering agree.

export type FileCategory = 'image' | 'doc' | 'data' | 'app' | 'upload';

export interface FileCategoryChip {
  key: FileCategory;
  /** Plural label for the chip, e.g. "Images". */
  label: string;
}

/** Chip order for the Gallery toolbar (an "All" chip precedes these in the UI). */
export const FILE_CATEGORIES: FileCategoryChip[] = [
  { key: 'image', label: 'Images' },
  { key: 'doc', label: 'Docs' },
  { key: 'data', label: 'Data' },
  { key: 'app', label: 'Apps' },
  { key: 'upload', label: 'Uploads' },
];

const APP_PATH_RE = /^shared\/apps\/|^shared\/channels\/[^/]+\/apps\//;
const DOC_EXT_RE = /\.(md|markdown|mdown|txt|rtf|pdf|docx?|odt|pages)$/i;
const DATA_EXT_RE = /\.(csv|tsv|json|ndjson|ya?ml|xlsx?|xls|parquet|arrow)$/i;

/** True when a path is agent-app source (`shared/apps/…` or channel-scoped apps). */
export function isAppPath(path: string): boolean {
  return APP_PATH_RE.test(path);
}

/** Whether a file belongs under a given Gallery category chip. Non-exclusive. */
export function matchesCategory(file: Pick<HubFile, 'mediaKind' | 'path' | 'origin'>, category: FileCategory): boolean {
  switch (category) {
    case 'image':
      return file.mediaKind === 'image';
    case 'doc':
      return (
        file.mediaKind === 'document' ||
        file.mediaKind === 'pdf' ||
        DOC_EXT_RE.test(file.path) ||
        (file.mediaKind === 'text' && !DATA_EXT_RE.test(file.path))
      );
    case 'data':
      return file.mediaKind === 'json' || file.mediaKind === 'data' || DATA_EXT_RE.test(file.path);
    case 'app':
      return isAppPath(file.path);
    case 'upload':
      return file.origin === 'upload';
  }
}

/** Short uppercase type badge for a card, e.g. PNG · CSV · PDF · MD · APP. */
export function fileTypeLabel(file: Pick<HubFile, 'path' | 'mime' | 'mediaKind'>): string {
  if (isAppPath(file.path)) return 'APP';
  const base = file.path.split('/').pop() ?? file.path;
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  if (ext && ext.length <= 5 && /^[a-z0-9]+$/.test(ext)) return ext.toUpperCase();
  if (file.mediaKind) return file.mediaKind.toUpperCase().slice(0, 4);
  return 'FILE';
}

export interface HubFileListResult {
  files: HubFile[];
  nextCursor?: string | null;
}

export interface HubFileVersion {
  seq: number;
  author: string;
  kind: 'created' | 'modified' | 'deleted';
  status: 'normal' | 'conflict';
  createdAt: string;
  sizeBytes: number | null;
  mime: string | null;
  isLatest: boolean;
}

export interface HubFileVersionsResponse {
  versions: HubFileVersion[];
}

export interface HubFileLabelRequest {
  label: string;
}

export interface HubFileLabelResponse {
  artifactId: string;
  labels: string[];
}

export interface HubFileStarResponse {
  artifactId: string;
  starred: boolean;
}

export interface HubFileRenameRequest {
  name: string;
}

export interface HubFileRenameResponse {
  artifactId: string;
  path: string;
  name: string;
}

export interface HubFileDeleteResponse {
  artifactId: string;
  tombstoned: true;
}

export interface HubFileRestoreResponse {
  artifactId: string;
  tombstoned: false;
}

// === text edit + diff3 conflict (shared by web + mobile) ===

/** Result of a text writeback / conflict resolution. `conflict` means the base
 * was stale and a diff3 merge produced markers now sitting at head. */
export interface HubFileSaveResult {
  seq: number;
  status: 'normal' | 'conflict';
}

export interface HubFileConflictSide {
  label: string;
  author: string;
  sha: string | null;
  text: string;
}

/** The both-sides conflict payload the resolution UI renders (mirrors the
 * server's `ArtifactConflictOut`). */
export interface HubFileConflict {
  artifactId: string;
  path: string;
  kind: string;
  conflictSeq: number;
  baseSeq: number | null;
  base: { sha: string | null; text: string };
  left: HubFileConflictSide;
  right: HubFileConflictSide;
  markers: string;
}

/** A user's conflict-resolution choice: keep the latest ('left'), keep the
 * incoming edit ('right'), or supply a hand-merged text. */
export type HubFileResolveChoice = { kind: 'left' } | { kind: 'right' } | { kind: 'merged'; text: string };

export interface HubFileRevertResponse {
  artifactId: string;
  seq: number;
  tombstoned: false;
}
