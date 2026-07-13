// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
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

  it('inserts a queued thread steer eagerly with retryable message identity', async () => {
    const enqueueOp = vi.fn().mockImplementation(async (_input, options) => options?.onStored?.());
    const dispatch = vi.fn();
    const { result } = renderHook(() =>
      useChatMessageActions({ activeChannel: channel, dispatch, enqueueOp, me, onSpawnDialogClose: vi.fn() }),
    );

    await act(async () => {
      result.current.sendAgent(
        'ch-1',
        { target: 'steer', sessionId: 's-1', threadRootEventId: 41, effort: 'high' },
        'Try another path',
      );
    });

    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'session.steer',
        payload: expect.objectContaining({
          sessionId: 's-1',
          text: 'Try another path',
          effort: 'high',
          postToThread: true,
          channelId: 'ch-1',
          threadRootEventId: 41,
          clientMsgId: expect.any(String),
          createdAt: expect.any(String),
        }),
      }),
      expect.objectContaining({ onStored: expect.any(Function) }),
    );
    const queuedInput = enqueueOp.mock.calls[0]![0];
    expect(queuedInput.opId).toBe(queuedInput.payload.clientMsgId);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'send-pending',
      channelId: 'ch-1',
      message: expect.objectContaining({
        text: 'Try another path',
        status: 'pending',
        threadRootEventId: 41,
        steeredSessionId: 's-1',
        clientMsgId: expect.any(String),
      }),
    });
  });

  it('marks the eager thread steer failed when the queued operation rejects', async () => {
    const dispatch = vi.fn();
    const enqueueOp = vi.fn().mockImplementation(async (_input, options) => {
      options?.onStored?.();
      throw new Error('offline queue failed');
    });
    const { result } = renderHook(() =>
      useChatMessageActions({ activeChannel: channel, dispatch, enqueueOp, me, onSpawnDialogClose: vi.fn() }),
    );

    act(() => {
      result.current.sendAgent(
        'ch-1',
        { target: 'steer', sessionId: 's-1', threadRootEventId: 41 },
        'Keep this retryable',
      );
    });

    await waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'send-failed' })));
    const pending = dispatch.mock.calls.find(([action]) => action.type === 'send-pending')?.[0].message;
    expect(dispatch).toHaveBeenCalledWith({
      type: 'send-failed',
      channelId: 'ch-1',
      clientMsgId: pending.clientMsgId,
    });
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
