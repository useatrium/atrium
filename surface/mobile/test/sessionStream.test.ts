import { describe, expect, it } from 'vitest';
import { initialSessionState, type CentaurEventFrame, type TextItem } from '@atrium/centaur-client';
import { streamSessionOnce } from '../src/lib/sessionStreamCore';

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
});
