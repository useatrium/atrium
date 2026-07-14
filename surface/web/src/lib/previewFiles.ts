import type { AttachmentMeta } from '@atrium/surface-client';
import type { PreviewFile } from '../components/media';

export function mediaKindForContentType(contentType: string): PreviewFile['mediaKind'] {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType === 'application/pdf') return 'document';
  if (contentType.startsWith('text/')) return 'text';
  return 'opaque';
}

export function attachmentMetaToPreviewFile(attachment: AttachmentMeta, messageEventId?: number | null): PreviewFile {
  return {
    id: attachment.id,
    name: attachment.filename,
    mime: attachment.contentType,
    mediaKind: mediaKindForContentType(attachment.contentType),
    sizeBytes: attachment.size,
    width: attachment.width,
    height: attachment.height,
    contentUrl: `/api/files/${attachment.id}`,
    ...(messageEventId != null ? { source: { kind: 'message' as const, id: String(messageEventId) } } : {}),
  };
}
