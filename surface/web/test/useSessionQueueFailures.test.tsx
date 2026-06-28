// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueuedOp } from '@atrium/surface-client';
import {
  sessionQueueFailureFromOp,
  useSessionQueueFailures,
} from '../src/useSessionQueueFailures';

afterEach(cleanup);

describe('sessionQueueFailureFromOp', () => {
  it('extracts failed steer and cancel metadata from queued ops', () => {
    expect(
      sessionQueueFailureFromOp(queuedOp('session.steer', { sessionId: 's-1', text: 'try this' })),
    ).toEqual({ type: 'steer', sessionId: 's-1', text: 'try this' });

    expect(sessionQueueFailureFromOp(queuedOp('session.cancel', { sessionId: 's-2' }))).toEqual({
      type: 'cancel',
      sessionId: 's-2',
    });
  });

  it('ignores malformed or unrelated queued ops', () => {
    expect(sessionQueueFailureFromOp(queuedOp('session.steer', { sessionId: 's-1' }))).toBeNull();
    expect(sessionQueueFailureFromOp(queuedOp('session.cancel', { sessionId: 12 }))).toBeNull();
    expect(sessionQueueFailureFromOp(queuedOp('session.steer', null))).toBeNull();
    expect(sessionQueueFailureFromOp(queuedOp('session.cancel', undefined))).toBeNull();
    expect(sessionQueueFailureFromOp(queuedOp('msg.send', { channelId: 'ch-1' }))).toBeNull();
  });
});

describe('useSessionQueueFailures', () => {
  it('remembers and clears failed steer and cancel state by session', () => {
    const { result } = renderHook(() => useSessionQueueFailures());

    act(() => {
      result.current.rememberRejectedSessionOp(
        queuedOp('session.steer', { sessionId: 's-1', text: 'retry me' }),
      );
      result.current.rememberRejectedSessionOp(queuedOp('session.cancel', { sessionId: 's-2' }));
    });

    expect(result.current.failedSteers).toEqual({ 's-1': 'retry me' });
    expect(result.current.failedCancels).toEqual({ 's-2': true });

    act(() => {
      result.current.clearFailedSteer('s-1');
      result.current.clearFailedCancel('s-2');
    });

    expect(result.current.failedSteers).toEqual({});
    expect(result.current.failedCancels).toEqual({});
  });
});

function queuedOp(opType: QueuedOp['opType'], payload: unknown): Pick<QueuedOp, 'opType' | 'payload'> {
  return { opType, payload };
}
