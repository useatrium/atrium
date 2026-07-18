// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppAction, EnqueueOpInput, UserRef } from '@atrium/surface-client';
import { useSessionActions } from '../src/useSessionActions';

type SessionActionType =
  | 'session.answer'
  | 'session.archive'
  | 'session.cancel'
  | 'session.pin'
  | 'session.stop_turn'
  | 'session.steer';
type TestEnqueue = <T extends SessionActionType>(
  input: EnqueueOpInput<T>,
  options?: { onStored?: () => void },
) => Promise<unknown>;

const me: UserRef = { id: 'u-me', handle: 'me', displayName: 'Me' };

function renderActions(
  enqueueOp: ReturnType<typeof vi.fn> = vi.fn(async () => ({ opId: 'op-1' })),
  dispatch?: (action: AppAction) => void,
) {
  const clearFailedCancel = vi.fn();
  const clearFailedSteer = vi.fn();
  const markPendingSteer = vi.fn();
  const view = renderHook(() =>
    useSessionActions({
      clearFailedCancel,
      clearFailedSteer,
      markPendingSteer,
      dispatch,
      enqueueOp: enqueueOp as TestEnqueue,
      me,
    }),
  );
  return { ...view, clearFailedCancel, clearFailedSteer, markPendingSteer, enqueueOp };
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
      expect.objectContaining({ onStored: expect.any(Function) }),
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
      expect.objectContaining({ onStored: expect.any(Function) }),
    );
  });

  it('marks the session as pending-steer once the op is stored', async () => {
    const enqueueOp = vi.fn(async (_input: unknown, options?: { onStored?: () => void }) => {
      options?.onStored?.();
      return { opId: 'op-1' };
    });
    const { result, markPendingSteer } = renderActions(enqueueOp);

    await act(async () => {
      await result.current.steerSession('session-1', 'revive it');
    });

    expect(markPendingSteer).toHaveBeenCalledWith('session-1');
  });

  it('uses one stable id and eagerly inserts a pane steer into its thread', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();
    const enqueueOp = vi.fn(async (_input: unknown, options?: { onStored?: () => void }) => {
      options?.onStored?.();
      return { opId: 'steer-client-1' };
    });
    const { result } = renderActions(enqueueOp, dispatch);
    const context = {
      channelId: 'ch-1',
      threadRootEventId: 42,
      clientMsgId: 'steer-client-1',
      createdAt: '2026-07-13T12:00:00.000Z',
    };

    await act(async () => {
      await result.current.steerSession('session-1', 'inspect this', undefined, undefined, undefined, context);
    });

    expect(enqueueOp).toHaveBeenCalledWith(
      {
        opId: 'steer-client-1',
        opType: 'session.steer',
        payload: { sessionId: 'session-1', text: 'inspect this', postToThread: true, ...context },
      },
      expect.objectContaining({ onStored: expect.any(Function) }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'send-pending',
        channelId: 'ch-1',
        message: expect.objectContaining({
          clientMsgId: 'steer-client-1',
          steeredSessionId: 'session-1',
          status: 'pending',
        }),
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
    expect(clearFailedCancel.mock.invocationCallOrder[0]).toBeLessThan(enqueueOp.mock.invocationCallOrder[0]!);
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
