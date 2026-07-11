import { describe, expect, it } from 'vitest';
import type { AttachmentMeta, ChatMessage } from '@atrium/surface-client';
import { attachmentToHubFile } from '../src/components/attachmentPreview';

const attachment: AttachmentMeta = {
  id: 'file-1',
  filename: 'photo.png',
  contentType: 'image/png',
  size: 128,
  width: 16,
  height: 8,
};

const message: Pick<ChatMessage, 'author' | 'channelId' | 'createdAt' | 'id'> = {
  id: 42,
  channelId: 'channel-1',
  createdAt: '2026-07-11T20:49:45.000Z',
  author: { id: 'user-1', handle: 'manualqa', displayName: 'Manual QA' },
};

describe('attachmentToHubFile', () => {
  it('keeps the known message provenance instead of fabricating an epoch timestamp', () => {
    expect(attachmentToHubFile(attachment, message)).toMatchObject({
      artifactId: 'file-1',
      channelId: 'channel-1',
      sourceMessageId: '42',
      createdAt: '2026-07-11T20:49:45.000Z',
      updatedAt: '2026-07-11T20:49:45.000Z',
      uploader: { id: 'user-1', name: 'Manual QA' },
    });
  });
});
