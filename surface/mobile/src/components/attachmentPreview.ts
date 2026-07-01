import type { AttachmentMeta, HubFile } from '@atrium/surface-client';

const DEFAULT_TIMESTAMP = '1970-01-01T00:00:00.000Z';

function mediaKindFor(contentType: string): HubFile['mediaKind'] {
  const mime = contentType.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'document';
  if (mime.startsWith('text/')) return 'text';
  return 'opaque';
}

export function attachmentToHubFile(attachment: AttachmentMeta): HubFile {
  const mediaKind = mediaKindFor(attachment.contentType);
  return {
    artifactId: attachment.id,
    workspaceId: '',
    path: '',
    name: attachment.filename,
    mime: attachment.contentType,
    mediaKind,
    isText: mediaKind === 'text',
    sizeBytes: attachment.size,
    ...(attachment.width != null ? { width: attachment.width } : {}),
    ...(attachment.height != null ? { height: attachment.height } : {}),
    origin: 'upload',
    channelId: null,
    sessionId: null,
    sourceMessageId: null,
    createdAt: DEFAULT_TIMESTAMP,
    updatedAt: DEFAULT_TIMESTAMP,
    versionSeq: 0,
    labels: [],
    starred: false,
    tombstoned: false,
    thumbnailUrl: null,
  };
}
