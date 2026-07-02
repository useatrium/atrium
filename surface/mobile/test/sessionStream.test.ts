import { describe, expect, it } from 'vitest';
import { initialSessionState, type CentaurEventFrame, type TextItem } from '@atrium/centaur-client';
import { silenceThresholdMs, streamSessionOnce } from '../src/lib/sessionStreamCore';

const encoder = new TextEncoder();

function streamFromChunks(chunks: string[], errorAtEnd = false): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk !== undefined) {
        controller.enqueue(encoder.encode(chunk));
        return;
      }
      if (errorAtEnd) {
        controller.error(new Error('synthetic disconnect'));
      } else {
        controller.close();
      }
    },
  });
}

function sse(frame: CentaurEventFrame): string {
  return `id: ${frame.event_id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

describe('mobile session stream glue', () => {
  it('reports ping activity without folding the ping event', async () => {
    const stamp = '2026-07-02T10:15:00.000Z';
    const body = `event: ping\ndata: ${JSON.stringify({ atrium_ts: stamp })}\n\n`;
    const fetchImpl: typeof fetch = async () =>
      new Response(streamFromChunks([body]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    const states: unknown[] = [];
    const activity: Array<['frame' | 'ping', string | null, boolean | undefined]> = [];

    const state = await streamSessionOnce(
      {
        baseUrl: 'http://server.test',
        token: 'tok',
        sessionId: 's-1',
        afterEventId: 0,
        signal: new AbortController().signal,
        fetchImpl,
      },
      initialSessionState(),
      (next) => states.push(next),
      undefined,
      (kind, serverTs, folded) => activity.push([kind, serverTs, folded]),
    );

    expect(activity).toEqual([['ping', stamp, undefined]]);
    expect(states).toHaveLength(0);
    expect(state.lastEventId).toBe(0);
    expect(state.frameSeq).toBe(0);
  });

  it('reports frame activity for folded frames', async () => {
    const stamp = '2026-07-02T10:16:00.000Z';
    const body = `id: 1\nevent: execution_state\ndata: ${JSON.stringify({
      type: 'execution.state',
      status: 'running',
      thread_key: 't',
      execution_id: 'e',
      event_id: 1,
      atrium_ts: stamp,
    })}\n\n`;
    const fetchImpl: typeof fetch = async () =>
      new Response(streamFromChunks([body]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    const activity: Array<['frame' | 'ping', string | null, boolean | undefined]> = [];

    const state = await streamSessionOnce(
      {
        baseUrl: 'http://server.test',
        token: 'tok',
        sessionId: 's-1',
        afterEventId: 0,
        signal: new AbortController().signal,
        fetchImpl,
      },
      initialSessionState(),
      undefined,
      undefined,
      (kind, serverTs, folded) => activity.push([kind, serverTs, folded]),
    );

    expect(activity).toEqual([['frame', stamp, true]]);
    expect(state.status).toBe('running');
    expect(state.lastEventId).toBe(1);
  });

  it('reports unfolded activity for deduplicated replay frames (liveness, not a fold)', async () => {
    const frame = {
      event: 'execution_state',
      event_id: 1,
      data: { type: 'execution.state', status: 'running', thread_key: 't', execution_id: 'e', event_id: 1 },
    } as CentaurEventFrame;
    // Same event id replayed twice: second fold is a no-op, but bytes flowed.
    const body =
      `id: 1\nevent: amp_raw_event\ndata: ${JSON.stringify({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'hi' }, event_id: 1 })}\n\n` +
      `id: 1\nevent: amp_raw_event\ndata: ${JSON.stringify({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'hi' }, event_id: 1 })}\n\n`;
    void frame;
    const fetchImpl: typeof fetch = async () =>
      new Response(streamFromChunks([body]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    const activity: Array<['frame' | 'ping', string | null, boolean | undefined]> = [];

    await streamSessionOnce(
      {
        baseUrl: 'http://server.test',
        token: 'tok',
        sessionId: 's-1',
        afterEventId: 0,
        signal: new AbortController().signal,
        fetchImpl,
      },
      initialSessionState(),
      undefined,
      undefined,
      (kind, serverTs, folded) => activity.push([kind, serverTs, folded]),
    );

    expect(activity.map(([kind, , folded]) => [kind, folded])).toEqual([
      ['frame', true],
      ['frame', false],
    ]);
  });

  it('uses ping proof to choose the silent-death watchdog threshold', () => {
    expect(silenceThresholdMs(true)).toBe(45_000);
    expect(silenceThresholdMs(false)).toBe(240_000);
  });

  it('folds SSE chunks and resumes with the last folded event id', async () => {
    const frames: CentaurEventFrame[] = [
      {
        event: 'execution_state',
        event_id: 1,
        data: {
          type: 'execution.state',
          status: 'running',
          thread_key: 't',
          execution_id: 'e',
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 2,
        data: {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hello ' }] },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 3,
        data: {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'world' }] },
        },
      },
      {
        event: 'execution_state',
        event_id: 4,
        data: {
          type: 'execution.state',
          status: 'completed',
          thread_key: 't',
          execution_id: 'e',
          result_text: 'done',
        },
      },
    ];
    const requestedAfterIds: number[] = [];
    let calls = 0;
    const fetchImpl = async (input: string): Promise<Response> => {
      calls += 1;
      const url = new URL(input);
      requestedAfterIds.push(Number(url.searchParams.get('after_event_id')));
      const body =
        calls === 1
          ? streamFromChunks([sse(frames[0]!), sse(frames[1]!)], true)
          : streamFromChunks([sse(frames[1]!), sse(frames[2]!), sse(frames[3]!)]);
      return new Response(body, { status: 200 });
    };

    let state = initialSessionState();
    await streamSessionOnce(
      {
        baseUrl: 'http://server.test',
        token: 'tok',
        sessionId: 's-1',
        afterEventId: state.lastEventId,
        signal: new AbortController().signal,
        fetchImpl,
      },
      state,
      (next) => {
        state = next;
      },
    ).catch(() => {});

    expect(state.lastEventId).toBe(2);

    state = await streamSessionOnce(
      {
        baseUrl: 'http://server.test',
        token: 'tok',
        sessionId: 's-1',
        afterEventId: state.lastEventId,
        signal: new AbortController().signal,
        fetchImpl,
      },
      state,
    );

    expect(requestedAfterIds).toEqual([0, 2]);
    expect(state.status).toBe('completed');
    expect(state.lastEventId).toBe(4);
    expect(state.resultText).toBe('done');
    expect(state.items).toHaveLength(1);
    expect((state.items[0] as TextItem).text).toBe('hello world');
  });

  it('lifts the atrium_ts stamp so folded items carry ts', async () => {
    const stamp = '2026-07-02T10:15:00.000Z';
    const body =
      `id: 1\nevent: execution_state\ndata: ${JSON.stringify({
        type: 'execution.state',
        status: 'running',
        thread_key: 't',
        execution_id: 'e',
        event_id: 1,
        atrium_ts: stamp,
      })}\n\n` +
      `id: 2\nevent: amp_raw_event\ndata: ${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
        event_id: 2,
        atrium_ts: stamp,
      })}\n\n`;
    const fetchImpl: typeof fetch = async () =>
      new Response(streamFromChunks([body]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    const state = await streamSessionOnce(
      {
        baseUrl: 'http://server.test',
        token: 'tok',
        sessionId: 's-1',
        afterEventId: 0,
        signal: new AbortController().signal,
        fetchImpl,
      },
      initialSessionState(),
    );
    expect(state.items).toHaveLength(1);
    expect((state.items[0] as TextItem).ts).toBe(stamp);
  });
});
