import type { HubFileVersion } from '@atrium/surface-client';
import type { ArtifactConflict, ResolveChoice } from '../../sessions/ConflictSurface';

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'code' | 'text' | 'data' | 'opaque';

export interface PreviewFile {
  id: string;
  name: string;
  mime: string;
  mediaKind: MediaKind;
  sizeBytes?: number;
  tombstoned?: boolean;
  width?: number;
  height?: number;
  contentUrl: string;
  thumbnailUrl?: string;
  textUrl?: string;
  uploader?: { id: string; name?: string };
  createdAt?: string;
  source?: { kind: 'message' | 'session' | 'channel'; id: string; label?: string };
}

export interface LightboxCallbacks {
  onDownload?: (f: PreviewFile) => void;
  onCopyLink?: (f: PreviewFile) => void;
  onRename?: (f: PreviewFile, name: string) => Promise<void> | void;
  onDelete?: (f: PreviewFile) => Promise<void> | void;
  onComment?: (f: PreviewFile) => void;
  canManage?: (f: PreviewFile) => boolean;
  /** Files Hub version history: list newest-first versions for this artifact. */
  onListVersions?: (f: PreviewFile, signal?: AbortSignal) => Promise<HubFileVersion[]>;
  /** Files Hub version history: fetch latest bytes or a specific historical version. */
  onFetchVersionContent?: (f: PreviewFile, seq?: number, signal?: AbortSignal) => Promise<Blob>;
  /** Files Hub version history: make a previous version the new head. */
  onRevertVersion?: (f: PreviewFile, seq: number) => Promise<void> | void;
  /** Files Hub version history: un-delete a tombstoned file. */
  onRestoreFile?: (f: PreviewFile) => Promise<void> | void;
  // slice3: Files Hub text editing.
  onSaveText?: (f: PreviewFile, text: string, baseSeq: number) => Promise<{ seq: number; status: 'normal' | 'conflict' }>;
  // slice3: Files Hub text conflict detail.
  onLoadConflict?: (f: PreviewFile) => Promise<ArtifactConflict>;
  // slice3: Files Hub text conflict resolution.
  onResolveConflict?: (
    f: PreviewFile,
    conflict: ArtifactConflict,
    choice: ResolveChoice,
  ) => Promise<{ seq: number; status: string }>;
}

export type MediaPreviewVariant = 'tile' | 'full';
