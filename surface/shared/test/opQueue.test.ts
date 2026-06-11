import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  ApiError,
  DurableOpQueue,
  MemoryOpStorage,
  createDefaultOpRegistry,
  makeQueuedOp,
  type Api,
  type AppAction,
  type MsgSendPayload,
  type OpRegistry,
  type QueuedOp,
  type WireEvent,
} from '../src/index';

const api = {} as Api;

function registryFor(
  execute: (payload: MsgSendPayload, op: QueuedOp) => Promise<{ event: WireEvent }>,
  dispatches: AppAction[] = [],
): OpRegistry {
  const registry = createDefaultOpRegistry();
  registry['msg.send'] = {
    execute: (_api, payload, op) => execute(payload, op),
    onConfirmed: (dispatch) => dispatches.forEach(dispatch),
    onRejected: (dispatch, payload) =>
      dispatch({
        type: 'send-failed',
        channelId: payload.channelId,
        clientMsgId: payload.clientMsgId,
      }),
  };
  return registry;
}

function eventFor(payload: MsgSendPayload, id = 1): WireEvent {
  return {
    id,
    workspaceId: 'ws-1',
    channelId: payload.channelId,
    threadRootEventId: payload.threadRootEventId ?? null,
    type: 'message.posted',
    actorId: 'u-1',
    payload: { text: payload.text, client_msg_id: payload.clientMsgId },
    createdAt: '2026-06-11T12:00:00.000Z',
    author: { id: 'u-1', handle: 'ada', displayName: 'Ada' },
  };
}

function msg(opId: string, channelId: string, clientMsgId = opId): QueuedOp {
  return makeQueuedOp(
    {
      opId,
      opType: 'msg.send',
      payload: {
        channelId,
        text: clientMsgId,
        clientMsgId,
        createdAt: '2026-06-11T12:00:00.000Z',
      },
    },
    '2026-06-11T12:00:00.000Z',
  );
}

describe('durable op queue coalescing', () => {
  it('keeps the max read cursor per channel', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.nat({ max: 10_000 }), { minLength: 1 }), async (values) => {
        const storage = new MemoryOpStorage();
        const queue = new DurableOpQueue({ storage, api, dispatch: () => {} });
        for (const [i, value] of values.entries()) {
          await queue.enqueue({
            opId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            opType: 'read.mark',
            payload: { channelId: 'ch-1', lastReadEventId: value },
          });
        }
        const ops = await storage.listOps();
        expect(ops).toHaveLength(1);
        expect((ops[0]!.payload as { lastReadEventId: number }).lastReadEventId).toBe(
          Math.max(...values),
        );
      }),
    );
  });

  it('keeps the latest edit and lets delete replace queued edits', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string(), { minLength: 1 }), async (texts) => {
        const storage = new MemoryOpStorage();
        const queue = new DurableOpQueue({ storage, api, dispatch: () => {} });
        for (const [i, text] of texts.entries()) {
          await queue.enqueue({
            opId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            opType: 'msg.edit',
            payload: { channelId: 'ch-1', eventId: 7, text },
          });
        }
        let ops = await storage.listOps();
        expect(ops).toHaveLength(1);
        expect((ops[0]!.payload as { text: string }).text).toBe(texts.at(-1));

        await queue.enqueue({
          opId: '00000000-0000-4000-8000-999999999999',
          opType: 'msg.delete',
          payload: { channelId: 'ch-1', eventId: 7 },
        });
        ops = await storage.listOps();
        expect(ops.map((op) => op.opType)).toEqual(['msg.delete']);
      }),
    );
  });

  it('never coalesces against inflight ops', async () => {
    const inflight = makeQueuedOp({
      opId: '00000000-0000-4000-8000-000000000001',
      opType: 'msg.edit',
      payload: { channelId: 'ch-1', eventId: 1, text: 'inflight' },
    });
    const storage = new MemoryOpStorage([{ ...inflight, status: 'inflight' }]);
    const queue = new DurableOpQueue({ storage, api, dispatch: () => {} });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000002',
      opType: 'msg.edit',
      payload: { channelId: 'ch-1', eventId: 1, text: 'pending' },
    });
    expect((await storage.listOps()).map((op) => op.status)).toEqual(['inflight', 'pending']);
  });
});

describe('durable op queue flushing', () => {
  it('preserves FIFO per queueKey while allowing independent keys', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { minLength: 1, maxLength: 40 }),
        async (channels) => {
          const storage = new MemoryOpStorage();
          const executed: string[] = [];
          const queue = new DurableOpQueue({
            storage,
            api,
            dispatch: () => {},
            registry: registryFor(async (payload) => {
              executed.push(`${payload.channelId}:${payload.clientMsgId}`);
              return { event: eventFor(payload) };
            }),
          });
          for (const [i, channelId] of channels.entries()) {
            await queue.enqueue({
              opId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
              opType: 'msg.send',
              payload: {
                channelId,
                text: String(i),
                clientMsgId: String(i),
                createdAt: '2026-06-11T12:00:00.000Z',
              },
            });
          }
          await queue.flush();
          for (const channelId of new Set(channels)) {
            const expected = channels
              .map((ch, i) => ({ ch, i }))
              .filter((entry) => entry.ch === channelId)
              .map((entry) => `${channelId}:${entry.i}`);
            expect(executed.filter((entry) => entry.startsWith(`${channelId}:`))).toEqual(expected);
          }
          expect(await storage.listOps()).toEqual([]);
        },
      ),
    );
  });

  it('treats startup inflight ops as pending', async () => {
    const storage = new MemoryOpStorage([{ ...msg('op-1', 'ch-1'), status: 'inflight' }]);
    const executed: string[] = [];
    const queue = new DurableOpQueue({
      storage,
      api,
      dispatch: () => {},
      registry: registryFor(async (_payload, op) => {
        executed.push(op.opId);
        return { event: eventFor(_payload) };
      }),
    });
    await queue.recoverInflight();
    await queue.flush();
    expect(executed).toEqual(['op-1']);
    expect(await storage.listOps()).toEqual([]);
  });

  it('a network-stuck key does not block another key', async () => {
    const storage = new MemoryOpStorage([msg('op-a', 'a'), msg('op-b', 'b')]);
    const queue = new DurableOpQueue({
      storage,
      api,
      dispatch: () => {},
        registry: registryFor(async (payload) => {
          if (payload.channelId === 'a') throw new TypeError('lost response');
          return { event: eventFor(payload) };
        }),
      setTimer: () => undefined,
    });
    await queue.flush();
    const remaining = await storage.listOps();
    expect(remaining.map((op) => op.opId)).toEqual(['op-a']);
    expect(remaining[0]!.retryCount).toBe(1);
  });

  it('retries network failures with the same opId and rejects HTTP 4xx once', async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryOpStorage([msg('op-net', 'a'), msg('op-4xx', 'b')]);
      const attempts: Record<string, number> = {};
      const rejected: AppAction[] = [];
      const queue = new DurableOpQueue({
        storage,
        api,
        dispatch: (action) => rejected.push(action),
        registry: registryFor(async (_payload, op) => {
          attempts[op.opId] = (attempts[op.opId] ?? 0) + 1;
          if (op.opId === 'op-net' && attempts[op.opId] === 1) {
            throw new TypeError('lost response');
          }
          if (op.opId === 'op-4xx') throw new ApiError(400, 'bad_request', 'bad');
          return { event: eventFor(_payload) };
        }),
      });
      await queue.flush();
      await vi.advanceTimersByTimeAsync(30_000);
      await queue.flush();

      expect(attempts).toEqual({ 'op-net': 2, 'op-4xx': 1 });
      expect(rejected).toEqual([
        { type: 'send-failed', channelId: 'b', clientMsgId: 'op-4xx' },
      ]);
      expect(await storage.listOps()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
