import type { AttachmentMeta, ChatMessage, HubFile } from '@atrium/surface-client';

function mediaKindFor(contentType: string): HubFile['mediaKind'] {
  const mime = contentType.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'document';
  if (mime.startsWith('text/')) return 'text';
  return 'opaque';
}

export function attachmentToHubFile(
  attachment: AttachmentMeta,
  message: Pick<ChatMessage, 'author' | 'channelId' | 'createdAt' | 'id'>,
): HubFile {
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
    uploader: { id: message.author.id, name: message.author.displayName },
    channelId: message.channelId,
    sessionId: null,
    sourceMessageId: message.id == null ? null : String(message.id),
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    versionSeq: 0,
    labels: [],
    starred: false,
    tombstoned: false,
    thumbnailUrl: null,
  };
}
