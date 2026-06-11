import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type WireEvent } from '@atrium/surface-client';
import type { OutboxMessage } from '../src/lib/cache';
import { createDraftChangeDebouncer, flushOutbox, type OutboxPostBody } from '../src/lib/outbox';

class MemoryOutbox {
  messages: OutboxMessage[];

  constructor(messages: OutboxMessage[]) {
    this.messages = structuredClone(messages);
  }

  async listOutbox(): Promise<OutboxMessage[]> {
    return structuredClone(this.messages);
  }

  async removeOutbox(clientMsgId: string): Promise<void> {
    this.messages = this.messages.filter((m) => m.clientMsgId !== clientMsgId);
  }
}

function queued(clientMsgId: string, text = clientMsgId): OutboxMessage {
  return {
    clientMsgId,
    channelId: 'channel-1',
    text,
    createdAt: `2026-06-11T12:00:0${clientMsgId.length}.000Z`,
  };
}

function event(id: number, body: OutboxPostBody): WireEvent {
  return {
    id,
    workspaceId: 'workspace-1',
    channelId: body.channelId,
    threadRootEventId: body.threadRootEventId ?? null,
    type: 'message.posted',
    actorId: 'user-1',
    payload: { text: body.text, client_msg_id: body.clientMsgId },
    createdAt: '2026-06-11T12:00:00.000Z',
    author: { id: 'user-1', handle: 'gary', displayName: 'Gary' },
  };
}

describe('outbox flushing', () => {
  it('flushes in FIFO order and preserves original clientMsgId', async () => {
    const storage = new MemoryOutbox([queued('client-a'), queued('client-b')]);
    const posted: OutboxPostBody[] = [];
    const confirmed: WireEvent[] = [];

    await flushOutbox({
      storage,
      postMessage: async (body) => {
        posted.push(body);
        return { event: event(posted.length, body) };
      },
      onConfirmed: (ev) => confirmed.push(ev),
      onRejected: () => {},
    });

    expect(posted.map((body) => body.clientMsgId)).toEqual(['client-a', 'client-b']);
    expect(confirmed.map((ev) => ev.payload.client_msg_id)).toEqual(['client-a', 'client-b']);
    expect(await storage.listOutbox()).toEqual([]);
  });

  it('stops on network failure and retains that message plus the remainder', async () => {
    const first = queued('client-a');
    const second = queued('client-b');
    const third = queued('client-c');
    const storage = new MemoryOutbox([first, second, third]);
    const posted: string[] = [];

    await flushOutbox({
      storage,
      postMessage: async (body) => {
        posted.push(body.clientMsgId);
        if (body.clientMsgId === 'client-b') throw new TypeError('Network request failed');
        return { event: event(posted.length, body) };
      },
      onConfirmed: () => {},
      onRejected: () => {},
    });

    expect(posted).toEqual(['client-a', 'client-b']);
    expect(await storage.listOutbox()).toEqual([second, third]);
  });

  it('drops HTTP failures from the outbox and marks the message rejected', async () => {
    const first = queued('client-a');
    const second = queued('client-b');
    const storage = new MemoryOutbox([first, second]);
    const rejected: OutboxMessage[] = [];

    await flushOutbox({
      storage,
      postMessage: async (body) => {
        if (body.clientMsgId === 'client-a') throw new ApiError(400, 'bad_request', 'bad');
        return { event: event(2, body) };
      },
      onConfirmed: () => {},
      onRejected: (msg) => rejected.push(msg),
    });

    expect(rejected).toEqual([first]);
    expect(await storage.listOutbox()).toEqual([]);
  });
});

describe('draft persistence debounce', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces saves and clears immediately on send', async () => {
    vi.useFakeTimers();
    const writes: { key: string; text: string }[] = [];
    const drafts = createDraftChangeDebouncer((key, text) => writes.push({ key, text }), 400);

    drafts.schedule('channel:one', 'h');
    drafts.schedule('channel:one', 'he');
    await vi.advanceTimersByTimeAsync(399);
    expect(writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual([{ key: 'channel:one', text: 'he' }]);

    drafts.schedule('channel:one', 'hello');
    drafts.saveNow('channel:one', '');
    await vi.advanceTimersByTimeAsync(400);
    expect(writes).toEqual([
      { key: 'channel:one', text: 'he' },
      { key: 'channel:one', text: '' },
    ]);
  });
});
