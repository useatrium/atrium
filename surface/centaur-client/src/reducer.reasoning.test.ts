import { describe, expect, it } from 'vitest';
import { initialSessionState, reduceSession, type SessionState } from './reducer.js';
import type { CentaurEventFrame } from './types.js';

const reduceAll = (frames: CentaurEventFrame[]): SessionState =>
  frames.reduce((state, frame) => reduceSession(state, frame), initialSessionState());

const raw = (eventId: number, data: unknown): CentaurEventFrame =>
  ({
    event: 'amp_raw_event',
    event_id: eventId,
    data,
  }) as CentaurEventFrame;

const completedReasoning = (eventId: number, item: Record<string, unknown>): CentaurEventFrame =>
  raw(eventId, { type: 'item.completed', item: { id: 'reason-1', type: 'reasoning', ...item } } as never);

describe('Codex reasoning', () => {
  it('does not emit an item for an empty terminal payload', () => {
    const state = reduceAll([completedReasoning(1, { summary: [] })]);
    expect(state.items).toEqual([]);
  });

  it('keeps streamed text when completion omits text', () => {
    const state = reduceAll([
      raw(1, { type: 'item.reasoning.textDelta', itemId: 'reason-1', delta: 'streamed ' } as never),
      raw(2, { type: 'item.reasoning.textDelta', itemId: 'reason-1', delta: 'thought' } as never),
      completedReasoning(3, { summary: [] }),
    ]);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      type: 'reasoning',
      text: 'streamed thought',
      sourceEventIds: [1, 2, 3],
    });
  });

  it('joins summary array parts with paragraph breaks', () => {
    const state = reduceAll([
      completedReasoning(1, {
        summary: [
          { type: 'summary_text', text: 'A' },
          { type: 'summary_text', text: 'B' },
        ],
      }),
    ]);
    expect(state.items[0]).toMatchObject({ type: 'reasoning', summary: 'A\n\nB' });
  });

  it('continues accepting string summaries', () => {
    const state = reduceAll([completedReasoning(1, { summary: 'A summary' })]);
    expect(state.items[0]).toMatchObject({ type: 'reasoning', summary: 'A summary' });
  });

  // Verbatim prod wire shape: the JSON-RPC dialect (`method`/`params`) with an
  // encrypted-only reasoning item (`content: []`, `summary: []`) — the exact
  // frames behind the empty expandable "Thinking" chips.
  it('suppresses the empty item for the method/params dialect too', () => {
    const rpc = (eventId: number, method: string, params: Record<string, unknown>): CentaurEventFrame =>
      raw(eventId, { method, params } as never);
    const item = { id: 'rs_x', type: 'reasoning', content: [], summary: [] };
    const state = reduceAll([
      rpc(1, 'item/started', { item, turnId: 't', threadId: 'th', startedAtMs: 1 }),
      rpc(2, 'item/completed', { item, turnId: 't', threadId: 'th', completedAtMs: 2 }),
    ]);
    expect(state.items).toEqual([]);
  });
});

const assistant = (eventId: number, content: Record<string, unknown>[]): CentaurEventFrame =>
  raw(eventId, {
    type: 'assistant',
    uuid: 'assistant-uuid',
    message: { id: 'message-1', role: 'assistant', content },
  } as never);

describe('Claude thinking', () => {
  it('precedes message text and updates in place on re-delivery', () => {
    const frame = assistant(1, [
      { type: 'thinking', thinking: 'Consider the options' },
      { type: 'text', text: 'The answer' },
    ]);
    const state = reduceAll([frame, { ...frame, event_id: 2 }]);

    expect(state.items.map((item) => item.type)).toEqual(['reasoning', 'text']);
    expect(state.items[0]).toMatchObject({
      id: 'reasoning:claude:message-1:0',
      text: 'Consider the options',
      sourceEventIds: [1, 2],
    });
    expect(state.items).toHaveLength(2);
  });

  it('ignores redacted thinking', () => {
    const state = reduceAll([assistant(1, [{ type: 'redacted_thinking', data: 'encrypted' }])]);
    expect(state.items).toEqual([]);
  });

  it('ignores whitespace-only thinking', () => {
    const state = reduceAll([assistant(1, [{ type: 'thinking', thinking: '  \n ' }])]);
    expect(state.items).toEqual([]);
  });
});
