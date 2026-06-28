import { useCallback, useEffect, useRef } from 'react';
import {
  randomId,
  type AppAction,
  type EnqueueOpInput,
} from '@atrium/surface-client';

type ReadMarkEnqueue = (input: EnqueueOpInput<'read.mark'>) => Promise<unknown>;
type DispatchAppAction = (action: AppAction) => void;

export function useReadMarks({
  dispatch,
  enqueueOp,
  onApiError,
  throttleMs = 2000,
}: {
  dispatch: DispatchAppAction;
  enqueueOp: ReadMarkEnqueue;
  onApiError: (err: unknown) => void;
  throttleMs?: number;
}) {
  const lastReadSentRef = useRef<Record<string, number>>({});
  const lastReadAtRef = useRef<Record<string, number>>({});
  const readTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

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
      if (elapsed >= throttleMs) {
        fire();
        return;
      }
      if (readTimersRef.current[channelId]) clearTimeout(readTimersRef.current[channelId]);
      readTimersRef.current[channelId] = setTimeout(fire, throttleMs - elapsed);
    },
    [dispatch, enqueueOp, onApiError, throttleMs],
  );

  useEffect(
    () => () => {
      for (const timer of Object.values(readTimersRef.current)) clearTimeout(timer);
    },
    [],
  );

  return { markRead, noteReadCursor };
}
