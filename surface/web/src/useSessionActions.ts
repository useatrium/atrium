import { useCallback } from 'react';
import {
  randomId,
  type AttachmentMeta,
  type AttachmentRef,
  type EnqueueOpInput,
  type SessionQuestionAnswers,
} from '@atrium/surface-client';

type SessionActionType = 'session.answer' | 'session.cancel' | 'session.stop_turn' | 'session.steer';
type SessionActionEnqueue = <T extends SessionActionType>(input: EnqueueOpInput<T>) => Promise<unknown>;

export type { SessionQuestionAnswers } from '@atrium/surface-client';

export function useSessionActions({
  clearFailedCancel,
  clearFailedSteer,
  enqueueOp,
}: {
  clearFailedCancel: (sessionId: string) => void;
  clearFailedSteer: (sessionId: string) => void;
  enqueueOp: SessionActionEnqueue;
}) {
  const steerSession = useCallback(
    async (
      sessionId: string,
      text: string,
      effort?: string,
      attachments?: AttachmentMeta[],
      attachmentRefs?: AttachmentRef[],
    ): Promise<void> => {
      clearFailedSteer(sessionId);
      await enqueueOp({
        opId: randomId(),
        opType: 'session.steer',
        payload: {
          sessionId,
          text,
          ...(effort ? { effort } : {}),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          ...(attachmentRefs && attachmentRefs.length > 0 ? { attachmentRefs } : {}),
        },
      });
    },
    [clearFailedSteer, enqueueOp],
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

  return { answerSessionQuestion, cancelSession, steerSession, stopTurn };
}
