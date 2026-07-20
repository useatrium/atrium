import { describe, expect, it } from 'vitest';
import { classifyFailure, failureLine } from './failures.js';
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

describe('classifyFailure — stable failure_class (primary)', () => {
  it('returns null for non-failed statuses', () => {
    expect(classifyFailure({ status: 'idle' })).toBeNull();
    expect(classifyFailure({ status: 'running' })).toBeNull();
    expect(classifyFailure({ status: 'completed' })).toBeNull();
    expect(classifyFailure({ status: 'cancelled' })).toBeNull();
  });

  it('maps platform classes (timeout/orphaned/sandbox_io) to Platform error', () => {
    for (const failureClass of ['timeout', 'orphaned', 'sandbox_io']) {
      const info = classifyFailure({ status: 'failed', failureClass, failureReason: 'raw detail' });
      expect(info?.class).toBe('platform');
      expect(info?.label).toBe('Platform error');
      expect(info?.detail).toBe('raw detail');
    }
  });

  it('maps the harness class to Agent error', () => {
    const info = classifyFailure({
      status: 'failed',
      failureClass: 'harness',
      failureReason: 'terminal harness output reported failure',
    });
    expect(info?.class).toBe('agent');
    expect(info?.label).toBe('Agent error');
    expect(info?.detail).toContain('harness');
  });

  it('class wins over the legacy reason matcher', () => {
    // A "harness" class must stay Agent even though the prose looks platform-ish.
    const info = classifyFailure({ status: 'failed', failureClass: 'harness', failureReason: 'sandbox stdout closed' });
    expect(info?.class).toBe('agent');
  });

  it('an unknown future class degrades to a neutral label + raw detail', () => {
    const info = classifyFailure({ status: 'failed', failureClass: 'some_new_bucket', failureReason: 'weird' });
    expect(info?.class).toBe('unknown');
    expect(info?.label).toBe('Run failed');
    expect(info?.detail).toBe('weird');
  });
});

describe('classifyFailure — legacy fallback (class-less historical frames)', () => {
  it('classifies the startup-deadline incident string as platform', () => {
    const info = classifyFailure({
      status: 'failed',
      failureReason: 'execution startup deadline exceeded before Codex accepted the turn (300000ms)',
    });
    expect(info?.class).toBe('platform');
    expect(info?.detail).toContain('300000ms');
  });

  it('classifies a reconnect string as platform', () => {
    expect(classifyFailure({ status: 'failed', failureReason: 'Reconnecting... 2/5' })?.class).toBe('platform');
  });

  it('classifies a harness-reported failure string as agent', () => {
    expect(
      classifyFailure({ status: 'failed', failureReason: 'terminal harness output reported failure' })?.class,
    ).toBe('agent');
  });

  it('returns null when there is nothing to surface (no class, no reason)', () => {
    expect(classifyFailure({ status: 'failed' })).toBeNull();
    expect(classifyFailure({ status: 'failed', failureReason: '   ' })).toBeNull();
    expect(classifyFailure({ status: 'failed_permanent', failureReason: '', failureClass: '' })).toBeNull();
  });

  it('unattributable reason → neutral label, raw detail preserved', () => {
    const info = classifyFailure({ status: 'failed', failureReason: 'some novel error' });
    expect(info?.class).toBe('unknown');
    expect(info?.detail).toBe('some novel error');
  });
});

describe('failureLine', () => {
  it('prefers the engine reason over the class summary', () => {
    // The real prod case: "The agent hit an error and stopped" is useless next
    // to the reason, which names the cause and when it clears.
    const line = failureLine({
      status: 'failed',
      failureClass: 'harness',
      failureReason: "You've hit your usage limit. Try again at Jul 25th, 2026 3:25 AM.",
    });
    expect(line).toBe("You've hit your usage limit. Try again at Jul 25th, 2026 3:25 AM.");
  });

  it('falls back to the class summary when no reason was reported', () => {
    expect(failureLine({ status: 'failed', failureClass: 'timeout' })).toBe('The run timed out before it finished.');
  });

  it('truncates to the caller budget', () => {
    const line = failureLine({ status: 'failed', failureReason: 'x'.repeat(300) }, 20);
    expect(line).toHaveLength(20);
    expect(line?.endsWith('…')).toBe(true);
  });

  it('is null when there is nothing to say, so callers keep their bare "Failed"', () => {
    expect(failureLine({ status: 'failed' })).toBeNull();
    expect(failureLine({ status: 'completed', failureReason: 'stale' })).toBeNull();
  });
});

describe('reduceSession failure folding', () => {
  it('folds failure_class + terminal_reason + reason onto SessionState', () => {
    const state = reduceAll([
      running(1),
      failed(2, {
        failure_class: 'timeout',
        terminal_reason: 'startup deadline exceeded',
        reason: 'startup_turn_not_accepted',
      }),
    ]);
    expect(state.status).toBe('failed');
    expect(state.failureClass).toBe('timeout');
    expect(state.failureReason).toBe('startup deadline exceeded');
    expect(state.failureCode).toBe('startup_turn_not_accepted');
    expect(classifyFailure(state)?.class).toBe('platform');
  });

  it('clears folded failure fields when a new turn starts', () => {
    const state = reduceAll([running(1), failed(2, { failure_class: 'harness', terminal_reason: 'boom' }), running(3)]);
    expect(state.failureClass).toBeUndefined();
    expect(state.failureReason).toBeUndefined();
    expect(classifyFailure(state)).toBeNull();
  });
});
