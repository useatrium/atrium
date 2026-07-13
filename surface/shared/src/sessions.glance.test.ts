import { describe, expect, it } from 'vitest';
import {
  deriveSessionGlance,
  formatWaiting,
  sessionGlanceClockLabel,
  STALLED_AFTER_MS,
  type SessionGlanceInput,
} from './sessions';

const NOW = Date.parse('2026-07-13T12:00:00.000Z');

function input(overrides: Partial<SessionGlanceInput> = {}): SessionGlanceInput {
  return {
    status: 'running',
    pendingQuestion: null,
    providerAuthRequired: null,
    pendingSeatRequests: [],
    createdAt: '2026-07-13T11:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

describe('deriveSessionGlance', () => {
  it('a running session is Working with an elapsed clock', () => {
    const g = deriveSessionGlance(input(), NOW);
    expect(g.kind).toBe('working');
    expect(g.pulse).toBe(true);
    expect(g.clock).toEqual({ mode: 'elapsed', fromTs: '2026-07-13T11:00:00.000Z' });
    expect(sessionGlanceClockLabel(g, NOW)).toBe('1:00:00');
  });

  it('a pending question outranks the raw running status', () => {
    const g = deriveSessionGlance(
      input({
        pendingQuestion: {
          questionId: 'q1',
          questions: [],
          askedAt: '2026-07-13T11:48:00.000Z',
        },
      }),
      NOW,
    );
    expect(g.kind).toBe('needs_you');
    expect(g.clock).toEqual({ mode: 'waiting', fromTs: '2026-07-13T11:48:00.000Z' });
    expect(sessionGlanceClockLabel(g, NOW)).toBe('12m');
  });

  it('a pending question without askedAt shows no clock rather than a wrong one', () => {
    const g = deriveSessionGlance(input({ pendingQuestion: { questionId: 'q1', questions: [] } }), NOW);
    expect(g.kind).toBe('needs_you');
    expect(g.clock).toBeNull();
    expect(sessionGlanceClockLabel(g, NOW)).toBeNull();
  });

  it('a stale pendingQuestion on a terminal session never resurrects Needs you', () => {
    const g = deriveSessionGlance(
      input({
        status: 'completed',
        completedAt: '2026-07-13T11:30:00.000Z',
        pendingQuestion: { questionId: 'q1', questions: [] },
      }),
      NOW,
    );
    expect(g.kind).toBe('done');
    expect(sessionGlanceClockLabel(g, NOW)).toBe('30m');
  });

  it('auth and seat requests are Needs you with details', () => {
    const auth = deriveSessionGlance(
      input({
        providerAuthRequired: {
          provider: 'github',
          userId: 'u1',
          reason: 'missing_token',
          message: 'connect GitHub',
          at: '2026-07-13T11:59:00.000Z',
        },
      }),
      NOW,
    );
    expect(auth.kind).toBe('needs_you');
    expect(auth.detail).toBe('needs auth');
    expect(sessionGlanceClockLabel(auth, NOW)).toBe('1m');

    const seat = deriveSessionGlance(input({ pendingSeatRequests: [{ userId: 'u2', displayName: 'Jo' }] }), NOW);
    expect(seat.kind).toBe('needs_you');
    expect(seat.detail).toBe('seat request');
  });

  it('spawning is Working·starting, then Stalled past the threshold', () => {
    const fresh = deriveSessionGlance(
      input({ status: 'spawning', createdAt: new Date(NOW - 60_000).toISOString() }),
      NOW,
    );
    expect(fresh.kind).toBe('working');
    expect(fresh.detail).toBe('starting');

    const stuck = deriveSessionGlance(
      input({ status: 'queued', createdAt: new Date(NOW - STALLED_AFTER_MS - 1000).toISOString() }),
      NOW,
    );
    expect(stuck.kind).toBe('stalled');
    expect(stuck.pulse).toBe(false);
  });

  it('a live stuck verdict turns a running session Stalled', () => {
    const g = deriveSessionGlance(input(), NOW, { stuck: true });
    expect(g.kind).toBe('stalled');
    expect(g.clock).toBeNull();
  });

  it('terminal states map to Done / Failed / Stopped', () => {
    expect(deriveSessionGlance(input({ status: 'failed' }), NOW).kind).toBe('failed');
    expect(deriveSessionGlance(input({ status: 'cancelled' }), NOW).kind).toBe('stopped');
    const done = deriveSessionGlance(input({ status: 'completed', completedAt: '2026-07-13T11:07:00.000Z' }), NOW);
    expect(done.kind).toBe('done');
    expect(sessionGlanceClockLabel(done, NOW)).toBe('7m');
  });
});

describe('formatWaiting', () => {
  it('is minute-coarse and skew-tolerant', () => {
    expect(formatWaiting(-5_000)).toBe('just now');
    expect(formatWaiting(30_000)).toBe('just now');
    expect(formatWaiting(12 * 60_000)).toBe('12m');
    expect(formatWaiting(65 * 60_000)).toBe('1h 05m');
  });
});
