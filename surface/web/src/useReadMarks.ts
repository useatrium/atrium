import { useCallback, useEffect, useRef } from 'react';
import {
  randomId,
  type AppAction,
  type EnqueueOpInput,
} from '@atrium/surface-client';

type ReadMarkEnqueue = (input: EnqueueOpInput<'read.mark'>) => Promise<unknown>;
type DispatchAppAction = (action: AppAction) => void;
type PendingReadMark = {
  timer: ReturnType<typeof setTimeout>;
  fire: () => void;
};

export function useReadMarks({
  dispatch,
  enqueueOp,
  onApiError,
  onAdvance,
  throttleMs = 2000,
}: {
  dispatch: DispatchAppAction;
  enqueueOp: ReadMarkEnqueue;
  onApiError: (err: unknown) => void;
  onAdvance?: (channelId: string, lastReadEventId: number) => void;
  throttleMs?: number;
}) {
  const lastReadSentRef = useRef<Record<string, number>>({});
  const lastReadAtRef = useRef<Record<string, number>>({});
  const readTimersRef = useRef<Record<string, PendingReadMark>>({});

  const noteReadCursor = useCallback((channelId: string, lastReadEventId: number) => {
    lastReadSentRef.current[channelId] = Math.max(
      lastReadSentRef.current[channelId] ?? 0,
      lastReadEventId,
    );
  }, []);

  const markRead = useCallback(
    (channelId: string, lastEventId: number) => {
      if (lastEventId <= 0 || (lastReadSentRef.current[channelId] ?? 0) >= lastEventId) return;
      const fire = () => {
        const previous = lastReadSentRef.current[channelId] ?? 0;
        if (previous >= lastEventId) return;
        lastReadAtRef.current[channelId] = Date.now();
        lastReadSentRef.current[channelId] = lastEventId;
        dispatch({ type: 'read-cursor', channelId, lastReadEventId: lastEventId });
        onAdvance?.(channelId, lastEventId);
        void enqueueOp({
          opId: randomId(),
          opType: 'read.mark',
          payload: { channelId, lastReadEventId: lastEventId },
        }).catch((err: unknown) => {
          if (lastReadSentRef.current[channelId] === lastEventId) {
            lastReadSentRef.current[channelId] = previous;
          }
          onApiError(err);
        });
      };
      const elapsed = Date.now() - (lastReadAtRef.current[channelId] ?? 0);
      const pending = readTimersRef.current[channelId];
      if (elapsed >= throttleMs) {
        if (pending) {
          clearTimeout(pending.timer);
          delete readTimersRef.current[channelId];
        }
        fire();
        return;
      }
      if (pending) clearTimeout(pending.timer);
      const timer = setTimeout(() => {
        delete readTimersRef.current[channelId];
        fire();
      }, throttleMs - elapsed);
      readTimersRef.current[channelId] = { timer, fire };
    },
    [dispatch, enqueueOp, onAdvance, onApiError, throttleMs],
  );

  const flush = useCallback(() => {
    const pending = Object.entries(readTimersRef.current);
    readTimersRef.current = {};
    for (const [, mark] of pending) {
      clearTimeout(mark.timer);
      mark.fire();
    }
  }, []);

  useEffect(
    () => () => {
      flush();
    },
    [flush],
  );

  return { markRead, noteReadCursor, flush };
}
