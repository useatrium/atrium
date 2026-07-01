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
export type HubFileResolveChoice =
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'merged'; text: string };

export interface HubFileRevertResponse {
  artifactId: string;
  seq: number;
  tombstoned: false;
}
