export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'code' | 'text' | 'data' | 'opaque';

export interface PreviewFile {
  id: string;
  name: string;
  mime: string;
  mediaKind: MediaKind;
  sizeBytes?: number;
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
}

export type MediaPreviewVariant = 'tile' | 'full';
