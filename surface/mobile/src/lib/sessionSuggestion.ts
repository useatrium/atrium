import { randomId, type EnqueueOpInput, type OpType } from '@atrium/surface-client';

type EnqueueOp = <T extends OpType>(input: EnqueueOpInput<T>) => Promise<unknown>;

export function enqueueSessionSuggestion(enqueueOp: EnqueueOp, sessionId: string, text: string): Promise<unknown> {
  return enqueueOp({
    opId: randomId(),
    opType: 'session.suggest',
    payload: { sessionId, text, postToThread: true },
  });
}
