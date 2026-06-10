// @vitest-environment jsdom
// (d) LONGSTREAM fixture folds to a single text item whose content equals the
// concatenated streaming deltas — no dupes, including across a resume overlap.

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CentaurEventFrame, TextItem } from '@atrium/centaur-client';
import rawC from '../../../packages/centaur-client/test/fixtures/C_longstream.json';
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
});
