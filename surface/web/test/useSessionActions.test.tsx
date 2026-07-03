// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnqueueOpInput } from '@atrium/surface-client';
import { useSessionActions } from '../src/useSessionActions';

type SessionActionType = 'session.answer' | 'session.cancel' | 'session.stop_turn' | 'session.steer';
type TestEnqueue = <T extends SessionActionType>(input: EnqueueOpInput<T>) => Promise<unknown>;

function renderActions(enqueueOp = vi.fn(async () => ({ opId: 'op-1' }))) {
  const clearFailedCancel = vi.fn();
  const clearFailedSteer = vi.fn();
  const view = renderHook(() =>
    useSessionActions({
      clearFailedCancel,
      clearFailedSteer,
      enqueueOp: enqueueOp as TestEnqueue,
    }),
  );
  return { ...view, clearFailedCancel, clearFailedSteer, enqueueOp };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useSessionActions', () => {
  it('clears failed steer state before queueing a steer op', async () => {
    const { result, clearFailedSteer, enqueueOp } = renderActions();

    await act(async () => {
      await result.current.steerSession('session-1', 'try another approach');
    });

    expect(clearFailedSteer).toHaveBeenCalledWith('session-1');
    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'session.steer',
        payload: { sessionId: 'session-1', text: 'try another approach' },
      }),
    );
    expect(clearFailedSteer.mock.invocationCallOrder[0]).toBeLessThan(enqueueOp.mock.invocationCallOrder[0]!);
  });

  it('queues steer attachments and upload refs', async () => {
    const { result, enqueueOp } = renderActions();
    const attachment = { id: 'file-1', filename: 'a.txt', contentType: 'text/plain', size: 10 };

    await act(async () => {
      await result.current.steerSession(
        'session-1',
        'use this file',
        undefined,
        [attachment],
        [{ uploadKey: 'upload-1' }],
      );
    });

    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'session.steer',
        payload: {
          sessionId: 'session-1',
          text: 'use this file',
          attachments: [attachment],
          attachmentRefs: [{ uploadKey: 'upload-1' }],
        },
      }),
    );
  });

  it('clears failed cancel state before queueing a cancel op', async () => {
    const { result, clearFailedCancel, enqueueOp } = renderActions();

    await act(async () => {
      await result.current.cancelSession('session-2');
    });

    expect(clearFailedCancel).toHaveBeenCalledWith('session-2');
    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'session.cancel',
        payload: { sessionId: 'session-2' },
      }),
    );
    expect(clearFailedCancel.mock.invocationCallOrder[0]).toBeLessThan(enqueueOp.mock.invocationCallOrder[0]!);
  });

  it('clears failed cancel state before queueing a stop-turn op', async () => {
    const { result, clearFailedCancel, enqueueOp } = renderActions();

    await act(async () => {
      await result.current.stopTurn('session-2');
    });

    expect(clearFailedCancel).toHaveBeenCalledWith('session-2');
    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'session.stop_turn',
        payload: { sessionId: 'session-2' },
      }),
    );
    expect(clearFailedCancel.mock.invocationCallOrder[0]).toBeLessThan(
      enqueueOp.mock.invocationCallOrder[0]!,
    );
  });

  it('queues session question answers without touching failure state', async () => {
    const { result, clearFailedCancel, clearFailedSteer, enqueueOp } = renderActions();
    const answers = { option: { answers: ['yes', 'continue'] } };

    await act(async () => {
      await result.current.answerSessionQuestion('session-3', 'question-1', answers);
    });

    expect(clearFailedCancel).not.toHaveBeenCalled();
    expect(clearFailedSteer).not.toHaveBeenCalled();
    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'session.answer',
        payload: { sessionId: 'session-3', questionId: 'question-1', answers },
      }),
    );
  });
});
