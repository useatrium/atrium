import { describe, expect, it } from 'vitest';
import { classifyFailure } from './failures.js';
import { initialSessionState, reduceSession, type SessionState } from './reducer.js';
import type { CentaurEventFrame } from './types.js';

const reduceAll = (frames: CentaurEventFrame[]): SessionState =>
  frames.reduce((state, frame) => reduceSession(state, frame), initialSessionState());

const running = (eventId: number): CentaurEventFrame =>
  ({
    event: 'execution_state',
    event_id: eventId,
    data: { type: 'execution.state', status: 'running' },
  }) as CentaurEventFrame;

const failed = (eventId: number, extra: Record<string, unknown> = {}): CentaurEventFrame =>
  ({
    event: 'execution_state',
    event_id: eventId,
    data: { type: 'execution.state', status: 'failed', ...extra },
  }) as CentaurEventFrame;

describe('classifyFailure', () => {
  it('returns null for non-failed statuses', () => {
    expect(classifyFailure({ status: 'idle' })).toBeNull();
    expect(classifyFailure({ status: 'running' })).toBeNull();
    expect(classifyFailure({ status: 'completed' })).toBeNull();
    expect(classifyFailure({ status: 'cancelled' })).toBeNull();
  });

  it('classifies a known platform machine code', () => {
    const info = classifyFailure({
      status: 'failed',
      failureCode: 'startup_turn_not_accepted',
      failureReason: 'execution startup deadline exceeded before Codex accepted the turn (300000ms)',
    });
    expect(info).not.toBeNull();
    expect(info?.class).toBe('platform');
    expect(info?.label).toBe('Platform error');
    // Raw reason is preserved for the expandable detail.
    expect(info?.detail).toContain('300000ms');
  });

  it('classifies a model-stream reconnect by reason text (no code)', () => {
    const info = classifyFailure({ status: 'failed', failureReason: 'Reconnecting... 2/5' });
    expect(info?.class).toBe('platform');
    expect(info?.summary).toMatch(/model/i);
    expect(info?.detail).toBe('Reconnecting... 2/5');
  });

  it('classifies a responseStreamDisconnected reason as platform', () => {
    const info = classifyFailure({ status: 'failed_permanent', failureReason: 'responseStreamDisconnected' });
    expect(info?.class).toBe('platform');
  });

  it('classifies an explicit agent error code', () => {
    const info = classifyFailure({ status: 'failed', failureCode: 'turn_failed', failureReason: 'boom' });
    expect(info?.class).toBe('agent');
    expect(info?.label).toBe('Agent error');
    expect(info?.detail).toBe('boom');
  });

  it('falls back to unknown without blaming a side', () => {
    const info = classifyFailure({ status: 'failed', failureReason: 'weird custom message' });
    expect(info?.class).toBe('unknown');
    expect(info?.label).toBe('Run failed');
    expect(info?.detail).toBe('weird custom message');
  });

  it('omits detail when no reason was reported', () => {
    const info = classifyFailure({ status: 'failed' });
    expect(info?.class).toBe('unknown');
    expect(info?.detail).toBeUndefined();
  });
});

describe('reduceSession failure folding', () => {
  it('folds terminal_reason + reason onto SessionState', () => {
    const state = reduceAll([
      running(1),
      failed(2, { terminal_reason: 'Reconnecting... 2/5', reason: 'response_stream_disconnected' }),
    ]);
    expect(state.status).toBe('failed');
    expect(state.failureReason).toBe('Reconnecting... 2/5');
    expect(state.failureCode).toBe('response_stream_disconnected');
    expect(classifyFailure(state)?.class).toBe('platform');
  });

  it('clears folded failure when a new turn starts', () => {
    const state = reduceAll([running(1), failed(2, { terminal_reason: 'boom' }), running(3)]);
    expect(state.failureReason).toBeUndefined();
    expect(state.failureCode).toBeUndefined();
    expect(classifyFailure(state)).toBeNull();
  });

  it('does not fold a reason onto a clean completion', () => {
    const state = reduceAll([running(1), failed(2, { terminal_reason: 'x' })]);
    expect(state.failureReason).toBe('x');
    // sanity: a fresh state has no failure
    expect(classifyFailure(initialSessionState())).toBeNull();
  });
});
