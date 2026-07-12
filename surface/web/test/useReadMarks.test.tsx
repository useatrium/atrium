// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppAction, EnqueueOpInput } from '@atrium/surface-client';
import { useReadMarks } from '../src/useReadMarks';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useReadMarks', () => {
  it('dispatches and queues an immediate read mark', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3000);
    const dispatch = vi.fn();
    const enqueueOp = vi.fn(async (_input: EnqueueOpInput<'read.mark'>) => ({ opId: 'op-1' }));
    const onApiError = vi.fn();

    const { result } = renderHook(() => useReadMarks({ dispatch, enqueueOp, onApiError }));

    act(() => result.current.markRead('ch-1', 5));

    expect(dispatch).toHaveBeenCalledWith({
      type: 'read-cursor',
      channelId: 'ch-1',
      lastReadEventId: 5,
    } satisfies AppAction);
    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'read.mark',
        payload: { channelId: 'ch-1', lastReadEventId: 5 },
      }),
    );
  });

  it('throttles repeated read marks per channel and sends the latest scheduled cursor', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3000);
    const dispatch = vi.fn();
    const enqueueOp = vi.fn(async (_input: EnqueueOpInput<'read.mark'>) => ({ opId: 'op-1' }));
    const onApiError = vi.fn();

    const { result } = renderHook(() => useReadMarks({ dispatch, enqueueOp, onApiError }));

    act(() => result.current.markRead('ch-1', 5));
    act(() => {
      vi.setSystemTime(3500);
      result.current.markRead('ch-1', 6);
      result.current.markRead('ch-1', 7);
    });

    expect(enqueueOp).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1499));
    expect(enqueueOp).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));

    expect(enqueueOp).toHaveBeenCalledTimes(2);
    expect(enqueueOp).toHaveBeenLastCalledWith(
      expect.objectContaining({
        opType: 'read.mark',
        payload: { channelId: 'ch-1', lastReadEventId: 7 },
      }),
    );
  });

  it('uses externally observed read cursors to suppress stale marks', () => {
    const dispatch = vi.fn();
    const enqueueOp = vi.fn(async (_input: EnqueueOpInput<'read.mark'>) => ({ opId: 'op-1' }));
    const onApiError = vi.fn();

    const { result } = renderHook(() => useReadMarks({ dispatch, enqueueOp, onApiError, throttleMs: 0 }));

    act(() => {
      result.current.noteReadCursor('ch-1', 10);
      result.current.markRead('ch-1', 9);
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(enqueueOp).not.toHaveBeenCalled();
  });

  it('rolls back a failed read mark so the same cursor can retry', async () => {
    const dispatch = vi.fn();
    const enqueueOp = vi
      .fn<(_: EnqueueOpInput<'read.mark'>) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ opId: 'op-2' });
    const onApiError = vi.fn();

    const { result } = renderHook(() => useReadMarks({ dispatch, enqueueOp, onApiError, throttleMs: 0 }));

    act(() => result.current.markRead('ch-1', 5));
    await waitFor(() => expect(onApiError).toHaveBeenCalledOnce());
    act(() => result.current.markRead('ch-1', 5));

    expect(enqueueOp).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
