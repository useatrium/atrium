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
  type SessionSpawnPayload,
  type UploadPayload,
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

function upload(opId: string, payload: Partial<UploadPayload> = {}): QueuedOp {
  return makeQueuedOp(
    {
      opId,
      opType: 'upload',
      payload: {
        uploadKey: 'up-1',
        localUri: 'memory://file',
        filename: 'shot.png',
        contentType: 'image/png',
        size: 123,
        ...payload,
      },
    },
    '2026-06-11T12:00:00.000Z',
  );
}

function msgWithUpload(opId: string, uploadKey = 'up-1'): QueuedOp {
  return makeQueuedOp(
    {
      opId,
      opType: 'msg.send',
      payload: {
        channelId: 'ch-1',
        text: 'with file',
        clientMsgId: opId,
        attachmentRefs: [{ uploadKey }],
        attachments: [
          {
            id: uploadKey,
            filename: 'shot.png',
            contentType: 'image/png',
            size: 123,
          },
        ],
        createdAt: '2026-06-11T12:00:00.000Z',
      },
    },
    '2026-06-11T12:00:00.000Z',
  );
}

function spawnWithUpload(opId: string, uploadKey = 'up-1'): QueuedOp {
  return makeQueuedOp(
    {
      opId,
      opType: 'session.spawn',
      payload: {
        channelId: 'ch-1',
        task: 'summarize this file',
        clientSpawnId: 'pending-session-1',
        attachmentRefs: [{ uploadKey }],
        attachments: [
          {
            id: uploadKey,
            filename: 'shot.png',
            contentType: 'image/png',
            size: 123,
          },
        ],
        createdAt: '2026-06-11T12:00:00.000Z',
      },
    },
    '2026-06-11T12:00:00.000Z',
  );
}

function steerWithUpload(opId: string, uploadKey = 'up-1'): QueuedOp {
  return makeQueuedOp(
    {
      opId,
      opType: 'session.steer',
      payload: {
        sessionId: 'sess-1',
        text: 'use this file',
        attachmentRefs: [{ uploadKey }],
        attachments: [
          {
            id: uploadKey,
            filename: 'shot.png',
            contentType: 'image/png',
            size: 123,
          },
        ],
      },
    },
    '2026-06-11T12:00:00.000Z',
  );
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
        expect((ops[0]!.payload as { lastReadEventId: number }).lastReadEventId).toBe(Math.max(...values));
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

  it('merges pending prefs patches with later keys winning', async () => {
    const storage = new MemoryOpStorage();
    const queue = new DurableOpQueue({ storage, api, dispatch: () => {} });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000001',
      opType: 'prefs.set',
      payload: { theme: 'dark', accent: 'teal' },
    });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000002',
      opType: 'prefs.set',
      payload: { accent: 'rose', highContrast: true },
    });
    const ops = await storage.listOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.queueKey).toBe('prefs:me');
    expect(ops[0]!.payload).toEqual({
      theme: 'dark',
      accent: 'rose',
      highContrast: true,
    });
  });

  it('does not coalesce session steer messages', async () => {
    const storage = new MemoryOpStorage();
    const queue = new DurableOpQueue({ storage, api, dispatch: () => {} });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000001',
      opType: 'session.steer',
      payload: { sessionId: 'sess-1', text: 'first' },
    });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000002',
      opType: 'session.steer',
      payload: { sessionId: 'sess-1', text: 'second' },
    });
    const ops = await storage.listOps();
    expect(ops.map((op) => op.queueKey)).toEqual(['steer:sess-1', 'steer:sess-1']);
    expect(ops.map((op) => (op.payload as { text: string }).text)).toEqual(['first', 'second']);
  });

  it('coalesces duplicate session cancels', async () => {
    const storage = new MemoryOpStorage();
    const queue = new DurableOpQueue({ storage, api, dispatch: () => {} });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000001',
      opType: 'session.cancel',
      payload: { sessionId: 'sess-1' },
    });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000002',
      opType: 'session.cancel',
      payload: { sessionId: 'sess-1' },
    });
    const ops = await storage.listOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.queueKey).toBe('cancel:sess-1');
  });

  it('keeps only the latest draft value per draft key', async () => {
    const storage = new MemoryOpStorage();
    const queue = new DurableOpQueue({ storage, api, dispatch: () => {} });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000001',
      opType: 'draft.set',
      payload: { draftKey: 'channel:one', text: 'hello' },
    });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000002',
      opType: 'draft.set',
      payload: { draftKey: 'channel:one', text: 'hello world' },
    });
    const ops = await storage.listOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.queueKey).toBe('draft:channel:one');
    expect(ops[0]!.payload).toEqual({ draftKey: 'channel:one', text: 'hello world' });
  });

  it('last-write-wins archive and pin operations per target', async () => {
    const storage = new MemoryOpStorage();
    const queue = new DurableOpQueue({ storage, api, dispatch: () => {} });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000101',
      opType: 'channel.archive',
      payload: { channelId: 'ch-1', archived: true, previousArchivedAt: null },
    });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000102',
      opType: 'channel.archive',
      payload: { channelId: 'ch-1', archived: false, previousArchivedAt: 'stale' },
    });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000103',
      opType: 'channel.pin',
      payload: { channelId: 'ch-1', pinned: true, previousPinned: false },
    });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000104',
      opType: 'channel.pin',
      payload: { channelId: 'ch-1', pinned: false, previousPinned: true },
    });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000105',
      opType: 'session.archive',
      payload: { sessionId: 'sess-1', archived: true, previousArchivedAt: null },
    });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000106',
      opType: 'session.archive',
      payload: { sessionId: 'sess-1', archived: false, previousArchivedAt: 'stale' },
    });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000107',
      opType: 'session.pin',
      payload: { sessionId: 'sess-1', pinned: true, previousPinned: false },
    });
    await queue.enqueue({
      opId: '00000000-0000-4000-8000-000000000108',
      opType: 'session.pin',
      payload: { sessionId: 'sess-1', pinned: false, previousPinned: true },
    });

    const byType = new Map((await storage.listOps()).map((op) => [op.opType, op]));
    expect(byType.size).toBe(4);
    expect(byType.get('channel.archive')!.payload).toEqual({
      channelId: 'ch-1',
      archived: false,
      previousArchivedAt: null,
    });
    expect(byType.get('channel.pin')!.payload).toEqual({ channelId: 'ch-1', pinned: false, previousPinned: false });
    expect(byType.get('session.archive')!.payload).toEqual({
      sessionId: 'sess-1',
      archived: false,
      previousArchivedAt: null,
    });
    expect(byType.get('session.pin')!.payload).toEqual({ sessionId: 'sess-1', pinned: false, previousPinned: false });
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
      expect(rejected).toEqual([{ type: 'send-failed', channelId: 'b', clientMsgId: 'op-4xx' }]);
      expect(await storage.listOps()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries op_in_flight without surfacing rejection and confirms on replay', async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryOpStorage([msg('op-in-flight', 'a')]);
      const attempts: string[] = [];
      const rejected: string[] = [];
      const actions: AppAction[] = [];
      const queue = new DurableOpQueue({
        storage,
        api,
        dispatch: (action) => actions.push(action),
        registry: registryFor(async (payload, op) => {
          attempts.push(op.opId);
          if (attempts.length === 1) {
            throw new ApiError(409, 'op_in_flight', 'operation is still in flight');
          }
          return { event: eventFor(payload) };
        }),
        onRejected: (op) => rejected.push(op.opId),
      });

      await queue.flush();
      expect(attempts).toEqual(['op-in-flight']);
      expect(rejected).toEqual([]);
      expect(actions).toEqual([]);
      let remaining = await storage.listOps();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toMatchObject({ opId: 'op-in-flight', status: 'pending', retryCount: 1 });

      await vi.advanceTimersByTimeAsync(500);
      await queue.flush();

      expect(attempts).toEqual(['op-in-flight', 'op-in-flight']);
      expect(rejected).toEqual([]);
      expect(actions).toEqual([]);
      remaining = await storage.listOps();
      expect(remaining).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hard-rejects op_id_reuse 409 responses', async () => {
    const storage = new MemoryOpStorage([msg('op-reuse', 'a')]);
    const rejected: string[] = [];
    const actions: AppAction[] = [];
    const queue = new DurableOpQueue({
      storage,
      api,
      dispatch: (action) => actions.push(action),
      registry: registryFor(async () => {
        throw new ApiError(409, 'op_id_reuse', 'opId was already used');
      }),
      onRejected: (op) => rejected.push(op.opId),
    });

    await queue.flush();

    expect(rejected).toEqual(['op-reuse']);
    expect(actions).toEqual([{ type: 'send-failed', channelId: 'a', clientMsgId: 'op-reuse' }]);
    expect(await storage.listOps()).toEqual([]);
  });

  it('serializes enqueue coalescing behind the pending-to-inflight transition', async () => {
    const inflightWrite = deferred();
    const executeStarted = deferred();
    const finishExecute = deferred<{ event: WireEvent }>();
    let blockedInflight = false;
    class BlockingInflightStorage extends MemoryOpStorage {
      override async putOp(op: QueuedOp): Promise<void> {
        if (op.opId === 'edit-1' && op.status === 'inflight' && !blockedInflight) {
          blockedInflight = true;
          await inflightWrite.promise;
        }
        await super.putOp(op);
      }
    }

    const first = makeQueuedOp({
      opId: 'edit-1',
      opType: 'msg.edit',
      payload: { channelId: 'ch-1', eventId: 7, text: 'first' },
    });
    const storage = new BlockingInflightStorage([first]);
    const registry = createDefaultOpRegistry();
    registry['msg.edit'] = {
      execute: async () => {
        executeStarted.resolve(undefined);
        return finishExecute.promise;
      },
      onConfirmed: () => {},
      onRejected: () => {},
    };
    const queue = new DurableOpQueue({ storage, api, dispatch: () => {}, registry });

    const flushPromise = queue.flush();
    await vi.waitFor(() => expect(blockedInflight).toBe(true));

    let enqueueSettled = false;
    const enqueuePromise = queue
      .enqueue({
        opId: 'edit-2',
        opType: 'msg.edit',
        payload: { channelId: 'ch-1', eventId: 7, text: 'second' },
      })
      .finally(() => {
        enqueueSettled = true;
      });
    await Promise.resolve();
    expect(enqueueSettled).toBe(false);

    inflightWrite.resolve(undefined);
    await enqueuePromise;
    await executeStarted.promise;
    const duringExecute = await storage.listOps();
    expect(duringExecute.map((op) => [op.opId, op.status])).toEqual([
      ['edit-1', 'inflight'],
      ['edit-2', 'pending'],
    ]);

    finishExecute.resolve({ event: eventFor(msg('sentinel', 'ch-1').payload as MsgSendPayload) });
    await flushPromise;
    expect(await storage.listOps()).toEqual([]);
  });

  it('uses the lock provider as a cross-instance single writer', async () => {
    class SerialLockProvider {
      private tail: Promise<void> = Promise.resolve();

      request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
        const run = this.tail.then(callback, callback);
        this.tail = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      }
    }

    const storage = new MemoryOpStorage([msg('op-locked', 'a')]);
    const lockProvider = new SerialLockProvider();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const executed: string[] = [];
    const firstQueue = new DurableOpQueue({
      storage,
      api,
      dispatch: () => {},
      registry: registryFor(async (_payload, op) => {
        executed.push(`first:${op.opId}`);
        firstStarted.resolve(undefined);
        await releaseFirst.promise;
        throw new TypeError('offline');
      }),
      lockProvider,
      setTimer: () => undefined,
    });
    const secondQueue = new DurableOpQueue({
      storage,
      api,
      dispatch: () => {},
      registry: registryFor(async (payload, op) => {
        executed.push(`second:${op.opId}`);
        return { event: eventFor(payload) };
      }),
      lockProvider,
    });

    const firstFlush = firstQueue.flush();
    await firstStarted.promise;
    const secondFlush = secondQueue.flush();
    await Promise.resolve();
    expect(executed).toEqual(['first:op-locked']);

    releaseFirst.resolve(undefined);
    await firstFlush;
    await secondFlush;

    expect(executed).toEqual(['first:op-locked', 'second:op-locked']);
    expect(await storage.listOps()).toEqual([]);
  });
});

describe('upload op dependencies', () => {
  it('passes thread broadcast voice sends with resolved attachments through the default executor', async () => {
    const registry = createDefaultOpRegistry();
    const payload: MsgSendPayload = {
      channelId: 'ch-1',
      text: 'voice reply',
      clientMsgId: 'cm-voice',
      threadRootEventId: 42,
      broadcast: true,
      voice: { durationMs: 1234, waveform: [0, 0.5, 1] },
      attachmentRefs: [{ uploadKey: 'up-1' }],
      attachments: [
        {
          id: 'up-1',
          filename: 'voice.m4a',
          contentType: 'audio/mp4',
          size: 456,
        },
      ],
      createdAt: '2026-06-11T12:00:00.000Z',
    };
    const op = makeQueuedOp(
      {
        opId: 'msg-voice',
        opType: 'msg.send',
        payload,
      },
      '2026-06-11T12:00:00.000Z',
    );
    const posted: Array<Parameters<Api['postMessage']>[0]> = [];
    const postMessage = vi.fn(async (body: Parameters<Api['postMessage']>[0]) => {
      posted.push(body);
      return { event: eventFor(payload) };
    });

    await registry['msg.send'].execute({ postMessage } as unknown as Api, payload, op, {
      listOps: async () => [
        {
          ...upload('upload-1', { fileId: 'file-1', uploaded: true }),
          status: 'completed',
        },
      ],
      putOp: async () => {},
      uploadFetch: async () => new Response(),
      readUploadBody: async () => new Blob(),
    });

    expect(posted).toEqual([
      {
        channelId: 'ch-1',
        text: 'voice reply',
        clientMsgId: 'cm-voice',
        threadRootEventId: 42,
        broadcast: true,
        attachments: ['file-1'],
        voice: { durationMs: 1234, waveform: [0, 0.5, 1] },
        opId: 'msg-voice',
      },
    ]);
  });

  it('does not flush a dependent message until its upload marker is completed', async () => {
    const storage = new MemoryOpStorage([msgWithUpload('msg-1')]);
    const posted: string[][] = [];
    const queue = new DurableOpQueue({
      storage,
      api: {
        postMessage: async (body: MsgSendPayload & { attachments?: string[] }) => {
          posted.push(body.attachments ?? []);
          return { event: eventFor(body) };
        },
      } as unknown as Api,
      dispatch: () => {},
    });

    await queue.flush();
    expect(posted).toEqual([]);

    await storage.putOp({
      ...upload('upload-1', { fileId: 'file-1', uploaded: true }),
      status: 'completed',
    });
    await queue.flush();
    expect(posted).toEqual([['file-1']]);
    expect(await storage.listOps()).toEqual([]);
  });

  it('resolves upload refs before spawning a session', async () => {
    const registry = createDefaultOpRegistry();
    const createAgentSession = vi.fn(async () => ({ session: {} }));
    const op = spawnWithUpload('spawn-1');

    await registry['session.spawn'].execute(
      { createAgentSession } as unknown as Api,
      op.payload as SessionSpawnPayload,
      op,
      {
        listOps: async () => [
          {
            ...upload('upload-1', { fileId: 'file-1', uploaded: true }),
            status: 'completed',
          },
        ],
        putOp: async () => {},
        uploadFetch: async () => new Response(),
        readUploadBody: async () => new Blob(),
      },
    );

    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'ch-1',
        task: 'summarize this file',
        clientSpawnId: 'pending-session-1',
        attachments: ['file-1'],
        opId: 'spawn-1',
      }),
    );
  });

  it('does not flush a dependent steer until its upload marker is completed', async () => {
    const storage = new MemoryOpStorage([steerWithUpload('steer-1')]);
    const steered: string[][] = [];
    const queue = new DurableOpQueue({
      storage,
      api: {
        steerSession: async (_id: string, _text: string, _op: unknown, opts: { attachments?: string[] }) => {
          steered.push(opts.attachments ?? []);
          return { ok: true };
        },
      } as unknown as Api,
      dispatch: () => {},
    });

    await queue.flush();
    expect(steered).toEqual([]);

    await storage.putOp({
      ...upload('upload-1', { fileId: 'file-1', uploaded: true }),
      status: 'completed',
    });
    await queue.flush();
    expect(steered).toEqual([['file-1']]);
    expect(await storage.listOps()).toEqual([]);
  });

  it('rejects a dependent message when its upload is rejected', async () => {
    const storage = new MemoryOpStorage([upload('upload-1'), msgWithUpload('msg-1')]);
    const actions: AppAction[] = [];
    const rejected: string[] = [];
    const registry = createDefaultOpRegistry();
    registry.upload = {
      ...registry.upload,
      execute: async () => {
        throw new ApiError(400, 'bad_upload', 'bad upload');
      },
    };
    const queue = new DurableOpQueue({
      storage,
      api,
      dispatch: (action) => actions.push(action),
      registry,
      onRejected: (op) => rejected.push(op.opId),
    });

    await queue.flush();

    expect(actions).toEqual([{ type: 'send-failed', channelId: 'ch-1', clientMsgId: 'msg-1' }]);
    expect(rejected).toEqual(['upload-1', 'msg-1']);
    expect(await storage.listOps()).toEqual([]);
  });

  it('rejects a pending message whose upload dependency disappeared during recovery', async () => {
    const storage = new MemoryOpStorage([msgWithUpload('msg-1')]);
    const actions: AppAction[] = [];
    const postMessage = vi.fn();
    const queue = new DurableOpQueue({
      storage,
      api: { postMessage } as unknown as Api,
      dispatch: (action) => actions.push(action),
    });

    await queue.recoverInflight();
    await queue.flush();

    expect(actions).toEqual([{ type: 'send-failed', channelId: 'ch-1', clientMsgId: 'msg-1' }]);
    expect(postMessage).not.toHaveBeenCalled();
    expect(await storage.listOps()).toEqual([]);
  });

  it('persists fileId after upload intent creation and resumes with refresh before PUT', async () => {
    const storage = new MemoryOpStorage([upload('upload-1')]);
    let createCalls = 0;
    let refreshCalls = 0;
    let putCalls = 0;
    const firstApi = {
      createUpload: async () => {
        createCalls += 1;
        return { fileId: 'file-1', uploadUrl: 'https://storage.local/put/old' };
      },
      refreshUpload: async () => {
        refreshCalls += 1;
        return { uploadUrl: 'https://storage.local/put/refreshed' };
      },
    } as unknown as Api;
    const firstQueue = new DurableOpQueue({
      storage,
      api: firstApi,
      dispatch: () => {},
      readUploadBody: async () => 'body',
      uploadFetch: async () => {
        putCalls += 1;
        throw new TypeError('offline during put');
      },
      setTimer: () => undefined,
    });

    await firstQueue.flush();
    let remaining = await storage.listOps();
    expect(createCalls).toBe(1);
    expect(putCalls).toBe(1);
    expect((remaining[0]!.payload as UploadPayload).fileId).toBe('file-1');
    expect(remaining[0]!.status).toBe('pending');

    const secondApi = {
      createUpload: async () => {
        throw new Error('createUpload should not be called after fileId is persisted');
      },
      refreshUpload: async (fileId: string) => {
        refreshCalls += 1;
        expect(fileId).toBe('file-1');
        return { uploadUrl: 'https://storage.local/put/refreshed' };
      },
    } as unknown as Api;
    const secondQueue = new DurableOpQueue({
      storage,
      api: secondApi,
      dispatch: () => {},
      readUploadBody: async () => 'body',
      uploadFetch: async (url) => {
        expect(String(url)).toBe('https://storage.local/put/refreshed');
        return new Response(null, { status: 200 });
      },
    });
    await secondQueue.flush();

    remaining = await storage.listOps();
    expect(refreshCalls).toBe(1);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.status).toBe('completed');
    expect(remaining[0]!.payload).toMatchObject({ fileId: 'file-1', uploaded: true });
  });

  it('refreshes an expired presigned PUT URL once after a 403', async () => {
    const storage = new MemoryOpStorage([upload('upload-1')]);
    const putUrls: string[] = [];
    let refreshCalls = 0;
    const queue = new DurableOpQueue({
      storage,
      api: {
        createUpload: async () => ({ fileId: 'file-1', uploadUrl: 'https://storage.local/old' }),
        refreshUpload: async (fileId: string) => {
          refreshCalls += 1;
          expect(fileId).toBe('file-1');
          return { uploadUrl: 'https://storage.local/new' };
        },
      } as unknown as Api,
      dispatch: () => {},
      readUploadBody: async () => 'body',
      uploadFetch: async (url) => {
        putUrls.push(String(url));
        return new Response(null, { status: putUrls.length === 1 ? 403 : 200 });
      },
    });

    await queue.flush();

    expect(refreshCalls).toBe(1);
    expect(putUrls).toEqual(['https://storage.local/old', 'https://storage.local/new']);
    const [completed] = await storage.listOps();
    expect(completed).toMatchObject({
      opId: 'upload-1',
      status: 'completed',
      payload: { fileId: 'file-1', uploaded: true },
    });
  });
});
