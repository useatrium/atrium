import type { ChatMessage } from '@atrium/surface-client';
import { describe, expect, it } from 'vitest';
import { deriveClusterPreview } from './clusterPreview';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 1,
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: null,
    text: 'Message',
    edited: false,
    author: { id: 'u-1', handle: 'ada', displayName: 'Ada' },
    createdAt: '2026-07-15T12:00:00.000Z',
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
    ...overrides,
  };
}

describe('deriveClusterPreview', () => {
  const plainReply = message({ id: 3, threadRootEventId: 1, text: 'Plain reply' });
  const agentAnswer = message({
    id: 4,
    threadRootEventId: 1,
    sessionId: 's-1',
    sessionEventType: 'replied',
    broadcast: true,
  });
  const humanBroadcast = message({ id: 5, threadRootEventId: 1, broadcast: true });
  const optimisticPreview = message({ id: null, clientMsgId: 'client-1', threadRootEventId: 1, broadcast: true });
  const confirmedAnswer = message({
    id: 6,
    clientMsgId: 'client-1',
    threadRootEventId: 1,
    sessionId: 's-1',
    sessionEventType: 'replied',
    broadcast: true,
  });

  it.each([
    {
      name: 'shows a plain latest reply',
      root: message({ replyCount: 3, lastReply: plainReply }),
      answers: [],
      latest: plainReply,
      anchored: false,
      count: 2,
      label: '2 earlier replies',
    },
    {
      name: 'uses an anchored agent answer without a duplicate preview',
      root: message({ replyCount: 2, lastReply: agentAnswer }),
      answers: [agentAnswer],
      latest: agentAnswer,
      anchored: true,
      count: 1,
      label: '1 earlier reply',
    },
    {
      name: 'suppresses a standalone human broadcast',
      root: message({ replyCount: 1, lastReply: humanBroadcast }),
      answers: [],
      latest: null,
      anchored: false,
      count: 1,
      label: '1 reply',
    },
    {
      name: 'dedupes an optimistic preview by clientMsgId',
      root: message({ replyCount: 2, lastReply: optimisticPreview }),
      answers: [confirmedAnswer],
      latest: confirmedAnswer,
      anchored: true,
      count: 1,
      label: '1 earlier reply',
    },
    {
      name: 'labels multiple suppressed replies without earlier',
      root: message({ replyCount: 3, lastReply: humanBroadcast }),
      answers: [],
      latest: null,
      anchored: false,
      count: 3,
      label: '3 replies',
    },
  ])('$name', ({ root, answers, latest, anchored, count, label }) => {
    expect(deriveClusterPreview(root, answers)).toEqual({
      latest,
      latestIsAnchored: anchored,
      earlierCount: count,
      earlierLabel: label,
    });
  });
});
