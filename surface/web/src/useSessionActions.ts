import { useCallback } from 'react';
import {
  pendingMessageFromThreadSteerPayload,
  randomId,
  type AppAction,
  type AttachmentMeta,
  type AttachmentRef,
  type EnqueueOpInput,
  type QueuedThreadSteerPayload,
  type SessionQuestionAnswers,
  type UserRef,
} from '@atrium/surface-client';

type SessionActionType =
  | 'session.answer'
  | 'session.archive'
  | 'session.cancel'
  | 'session.pin'
  | 'session.stop_turn'
  | 'session.steer';
type SessionActionEnqueue = <T extends SessionActionType>(
  input: EnqueueOpInput<T>,
  options?: { onStored?: () => void },
) => Promise<unknown>;

export type SessionSteerContext = {
  channelId: string;
  threadRootEventId: number;
  clientMsgId: string;
  createdAt: string;
};

export type { SessionQuestionAnswers } from '@atrium/surface-client';

export function useSessionActions({
  clearFailedCancel,
  clearFailedSteer,
  markPendingSteer,
  dispatch,
  enqueueOp,
  me,
}: {
  clearFailedCancel: (sessionId: string) => void;
  clearFailedSteer: (sessionId: string) => void;
  markPendingSteer: (sessionId: string) => void;
  dispatch?: (action: AppAction) => void;
  enqueueOp: SessionActionEnqueue;
  me?: UserRef;
}) {
  const steerSession = useCallback(
    async (
      sessionId: string,
      text: string,
      effort?: string,
      attachments?: AttachmentMeta[],
      attachmentRefs?: AttachmentRef[],
      context?: SessionSteerContext,
    ): Promise<void> => {
      clearFailedSteer(sessionId);
      const payload = {
        sessionId,
        text,
        ...(context ? { postToThread: true, ...context } : {}),
        ...(effort ? { effort } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(attachmentRefs && attachmentRefs.length > 0 ? { attachmentRefs } : {}),
      };
      const input = {
        opId: context?.clientMsgId ?? randomId(),
        opType: 'session.steer' as const,
        payload,
      };
      if (context && dispatch && me) {
        await enqueueOp(input, {
          onStored: () => {
            markPendingSteer(sessionId);
            dispatch({
              type: 'send-pending',
              channelId: context.channelId,
              message: pendingMessageFromThreadSteerPayload(payload as QueuedThreadSteerPayload, me),
            });
          },
        });
      } else {
        await enqueueOp(input, { onStored: () => markPendingSteer(sessionId) });
      }
    },
    [clearFailedSteer, markPendingSteer, dispatch, enqueueOp, me],
  );

  const cancelSession = useCallback(
    async (sessionId: string): Promise<void> => {
      clearFailedCancel(sessionId);
      await enqueueOp({
        opId: randomId(),
        opType: 'session.cancel',
        payload: { sessionId },
      });
    },
    [clearFailedCancel, enqueueOp],
  );

  const stopTurn = useCallback(
    async (sessionId: string): Promise<void> => {
      clearFailedCancel(sessionId);
      await enqueueOp({
        opId: randomId(),
        opType: 'session.stop_turn',
        payload: { sessionId },
      });
    },
    [clearFailedCancel, enqueueOp],
  );

  const answerSessionQuestion = useCallback(
    async (sessionId: string, questionId: string, answers: SessionQuestionAnswers): Promise<void> => {
      await enqueueOp({
        opId: randomId(),
        opType: 'session.answer',
        payload: { sessionId, questionId, answers },
      });
    },
    [enqueueOp],
  );

  const setSessionArchived = useCallback(
    async (sessionId: string, archived: boolean, previousArchivedAt: string | null): Promise<void> => {
      // Archive state folds from the durable session.archived/unarchived event;
      // the queue op needs the previous value only for coalescing.
      await enqueueOp({
        opId: randomId(),
        opType: 'session.archive',
        payload: { sessionId, archived, previousArchivedAt },
      });
    },
    [enqueueOp],
  );

  const setSessionPinned = useCallback(
    async (sessionId: string, pinned: boolean, previousPinned: boolean): Promise<void> => {
      dispatch?.({ type: 'session-pin-changed', sessionId, pinned });
      await enqueueOp({
        opId: randomId(),
        opType: 'session.pin',
        payload: { sessionId, pinned, previousPinned },
      }).catch((err) => {
        dispatch?.({ type: 'session-pin-changed', sessionId, pinned: previousPinned });
        throw err;
      });
    },
    [dispatch, enqueueOp],
  );

  return { answerSessionQuestion, cancelSession, setSessionArchived, setSessionPinned, steerSession, stopTurn };
}
