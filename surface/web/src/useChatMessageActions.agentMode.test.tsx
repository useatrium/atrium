// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import type { Channel, UserRef } from '@atrium/surface-client';
import { describe, expect, it, vi } from 'vitest';
import { useChatMessageActions } from './useChatMessageActions';

const me: UserRef = { id: 'me', handle: 'me', displayName: 'Me' };
const channel = { id: 'ch-1' } as Channel;

describe('agent-mode queued operations', () => {
  it('queues a thread spawn with a broadcast card and explicit delegate anchor', () => {
    const enqueueOp = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useChatMessageActions({ activeChannel: channel, dispatch: vi.fn(), enqueueOp, me, onSpawnDialogClose: vi.fn() }),
    );

    result.current.sendAgent(
      'ch-1',
      { target: 'spawn-thread', threadRootEventId: 41, anchorEventId: 39 },
      'Investigate this',
    );

    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'session.spawn',
        payload: expect.objectContaining({
          channelId: 'ch-1',
          task: 'Investigate this',
          threadRootEventId: 41,
          anchorEventId: 39,
          broadcastCard: true,
        }),
      }),
      expect.anything(),
    );
  });

  it('queues a steer with thread provenance and effort', () => {
    const enqueueOp = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useChatMessageActions({ activeChannel: channel, dispatch: vi.fn(), enqueueOp, me, onSpawnDialogClose: vi.fn() }),
    );

    result.current.sendAgent('ch-1', { target: 'steer', sessionId: 's-1', effort: 'high' }, 'Try another path');

    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'session.steer',
        payload: { sessionId: 's-1', text: 'Try another path', effort: 'high', postToThread: true },
      }),
    );
  });

  it('queues a suggestion with thread provenance', () => {
    const enqueueOp = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useChatMessageActions({ activeChannel: channel, dispatch: vi.fn(), enqueueOp, me, onSpawnDialogClose: vi.fn() }),
    );

    result.current.sendAgent('ch-1', { target: 'suggest', sessionId: 's-1' }, 'Consider a smaller change');

    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'session.suggest',
        payload: { sessionId: 's-1', text: 'Consider a smaller change', postToThread: true },
      }),
    );
  });
});
