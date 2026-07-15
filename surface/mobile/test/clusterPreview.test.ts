import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@atrium/surface-client';
import { deriveClusterPreview } from '../src/components/clusterPreview';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 99,
    clientMsgId: null,
    channelId: 'c-1',
    threadRootEventId: null,
    text: 'message',
    edited: false,
    author: { id: 'u-1', handle: 'riley', displayName: 'Riley' },
    createdAt: '2026-07-03T12:00:00.000Z',
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
    ...overrides,
  };
}

describe('deriveClusterPreview', () => {
  it.each([
    {
      name: 'plain reply preview',
      root: message({ replyCount: 3, lastReplyId: 102 }),
      replies: [
        message({ id: 100, threadRootEventId: 99, text: 'First reply' }),
        message({ id: 101, threadRootEventId: 99, text: 'Second reply' }),
        message({ id: 102, threadRootEventId: 99, text: 'Latest reply' }),
      ],
      slotAnswers: [],
      expected: { latestId: 102, earlierCount: 2, earlierIds: [100, 101], toggleLabel: '2 earlier replies' },
    },
    {
      name: 'latest answer claimed by slot',
      root: message({ replyCount: 2, lastReplyId: 102 }),
      replies: [message({ id: 101, threadRootEventId: 99, text: 'Earlier reply' })],
      slotAnswers: [
        message({
          id: 102,
          threadRootEventId: 99,
          sessionId: 's-1',
          sessionEventType: 'replied',
          broadcast: true,
        }),
      ],
      expected: { latestId: null, earlierCount: 1, earlierIds: [101], toggleLabel: '1 reply' },
    },
    {
      name: 'human broadcast suppressed',
      root: message({
        replyCount: 1,
        lastReplyId: 102,
        lastReply: message({ id: 102, threadRootEventId: 99, broadcast: true }),
      }),
      replies: undefined,
      slotAnswers: [],
      expected: { latestId: null, earlierCount: 1, earlierIds: [], toggleLabel: '1 reply' },
    },
    {
      name: 'earlier count never drops below zero',
      root: message({ replyCount: 0, lastReplyId: 102 }),
      replies: [message({ id: 102, threadRootEventId: 99 })],
      slotAnswers: [],
      expected: { latestId: 102, earlierCount: 0, earlierIds: [], toggleLabel: '0 earlier replies' },
    },
  ])('$name', ({ root, replies, slotAnswers, expected }) => {
    const preview = deriveClusterPreview(root, replies, slotAnswers);

    expect(preview.latest?.id ?? null).toBe(expected.latestId);
    expect(preview.earlierCount).toBe(expected.earlierCount);
    expect(preview.earlierReplies.map((reply) => reply.id)).toEqual(expected.earlierIds);
    expect(preview.toggleLabel).toBe(expected.toggleLabel);
  });
});
