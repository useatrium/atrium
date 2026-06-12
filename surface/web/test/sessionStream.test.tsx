// @vitest-environment jsdom
// (d) LONGSTREAM fixture folds to a single text item whose content equals the
// concatenated streaming deltas — no dupes, including across a resume overlap.

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CentaurEventFrame, TextItem } from '@atrium/centaur-client';
import rawC from '../../centaur-client/test/fixtures/C_longstream.json';
import { useSessionStream } from '../src/sessions/useSessionStream';
import { FakeEventSource, installFakeEventSource } from './helpers/fakeEventSource';

const C = rawC as unknown as CentaurEventFrame[];

interface AssistantData {
  type?: string;
  uuid?: string;
  message?: { content: Array<{ type: string; text?: string }> };
}

/** Every streaming (non-complete) assistant delta, concatenated in order. */
function concatenatedDeltas(frames: CentaurEventFrame[]): string {
  return frames
    .filter((f) => {
      if (f.event !== 'amp_raw_event') return false;
      const d = f.data as AssistantData;
      return d.type === 'assistant' && !d.uuid;
    })
    .map((f) =>
      ((f.data as AssistantData).message?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join(''),
    )
    .join('');
}

beforeEach(() => {
  FakeEventSource.reset();
  installFakeEventSource();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushStreamTimers(ms = 20): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function stateFrame(eventId: number, status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'): CentaurEventFrame {
  return {
    event: 'execution_state',
    event_id: eventId,
    data: {
      type: 'execution.state',
      status,
      thread_key: 'thread-test',
      execution_id: 'exe-test',
      ...(status === 'completed' ? { result_text: 'done' } : {}),
    },
  } as CentaurEventFrame;
}

function usageFrame(eventId: number, costUsd: number): CentaurEventFrame {
  return {
    event: 'usage_observed',
    event_id: eventId,
    data: {
      type: 'obs.usage',
      model: 'claude-test',
      engine: 'claude-code',
      harness: 'claude-code',
      thread_key: 'thread-test',
      execution_id: 'exe-test',
      cost_usd: costUsd,
    },
  } as CentaurEventFrame;
}

describe('useSessionStream folding the LONGSTREAM capture', () => {
  it('folds 400+ frames into one text item equal to the concatenated deltas', async () => {
    const { result, unmount } = renderHook(() => useSessionStream('s-c'));
    const es = FakeEventSource.last();
    await act(async () => {
      es.open();
      es.emitAll(C);
      await new Promise((r) => setTimeout(r, 60));
    });

    const expected = concatenatedDeltas(C);
    expect(expected.length).toBeGreaterThan(1000); // sanity: real capture

    const { stream, connected } = result.current;
    expect(connected).toBe(true);
    expect(stream.status).toBe('completed');
    expect(stream.items).toHaveLength(1);
    expect(stream.items[0]!.type).toBe('text');
    expect((stream.items[0] as TextItem).text).toBe(expected);
    expect(stream.lastEventId).toBe(Math.max(...C.map((f) => f.event_id)));

    // Resume overlap: replaying the whole capture again must not duplicate
    // anything (only execution_state frames pass the dedupe guard).
    await act(async () => {
      es.emitAll(C);
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(result.current.stream.items).toHaveLength(1);
    expect((result.current.stream.items[0] as TextItem).text).toBe(expected);

    unmount();
    expect(es.closed).toBe(true);
  });

  it('reconnects after an error with after_event_id set to the last folded frame', async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useSessionStream('s-resume'));
    const es = FakeEventSource.last();

    await act(async () => {
      es.open();
      es.emit(stateFrame(1, 'running'));
      es.emit(usageFrame(2, 0.25));
      await flushStreamTimers();
    });

    await act(async () => {
      es.error();
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(FakeEventSource.instances).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.last().url).toBe('/api/sessions/s-resume/stream?after_event_id=2');

    unmount();
  });

  it('drops replayed non-snapshot frames but accepts duplicate execution_state snapshots idempotently', async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useSessionStream('s-dedupe'));
    const es = FakeEventSource.last();

    await act(async () => {
      es.open();
      es.emit(stateFrame(1, 'running'));
      es.emit(usageFrame(2, 0.5));
      es.emit(usageFrame(2, 0.5));
      es.emit(stateFrame(1, 'running'));
      await flushStreamTimers();
    });

    expect(result.current.stream.status).toBe('running');
    expect(result.current.stream.costUsd).toBe(0.5);
    expect(result.current.stream.lastEventId).toBe(2);

    unmount();
  });

  it('does not reconnect after terminal status errors', async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useSessionStream('s-terminal'));
    const es = FakeEventSource.last();

    await act(async () => {
      es.open();
      es.emit(stateFrame(1, 'running'));
      es.emit(stateFrame(2, 'completed'));
      await flushStreamTimers();
      es.error();
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    unmount();
  });

  it('paces repeated immediate errors by the reconnect delay', async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useSessionStream('s-backoff'));
    const first = FakeEventSource.last();

    await act(async () => {
      first.open();
      first.emit(stateFrame(1, 'running'));
      await flushStreamTimers();
      first.error();
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(FakeEventSource.instances).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    const second = FakeEventSource.last();

    await act(async () => {
      second.open();
      second.error();
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(FakeEventSource.instances).toHaveLength(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(FakeEventSource.instances).toHaveLength(3);
    unmount();
  });

  it('ignores late frames from a dead connection racing a reconnect', async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useSessionStream('s-race'));
    const first = FakeEventSource.last();

    await act(async () => {
      first.open();
      first.emit(stateFrame(1, 'running'));
      await flushStreamTimers();
      first.error();
      first.emit(stateFrame(2, 'completed'));
      await flushStreamTimers();
    });

    expect(result.current.stream.status).toBe('running');
    expect(result.current.stream.lastEventId).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(FakeEventSource.last().url).toBe('/api/sessions/s-race/stream?after_event_id=1');

    unmount();
  });
});
