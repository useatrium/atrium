import { describe, expect, it } from 'vitest';
import {
  UNREACHABLE_AFTER_MS,
  countActiveQueuedChanges,
  deriveSyncStuck,
  deriveWsFailureStatus,
  recordWsFailure,
  reconnectingLabel,
} from '../src/index';

describe('reconnecting label', () => {
  it('renders nothing while connected, regardless of queue depth', () => {
    expect(reconnectingLabel('open')).toBeNull();
  });

  it('shows reconnecting when the socket is not open', () => {
    expect(reconnectingLabel('connecting')).toBe('Reconnecting…');
    expect(reconnectingLabel('closed')).toBe('Reconnecting…');
  });

  it('escalates sustained failures using elapsed time', () => {
    const firstFailedAt = 1_000;
    const before = deriveWsFailureStatus(firstFailedAt, 'transport', firstFailedAt + UNREACHABLE_AFTER_MS - 1);
    const after = deriveWsFailureStatus(firstFailedAt, 'transport', firstFailedAt + UNREACHABLE_AFTER_MS);

    expect(before.status).toBe('closed');
    expect(after.status).toBe('unreachable');
    expect(reconnectingLabel(after, 'atrium.test')).toBe('Can’t reach atrium.test');
  });

  it('keeps a brief blip non-terminal and clears its banner on open', () => {
    const status = deriveWsFailureStatus(1_000, 'closed', 1_000 + UNREACHABLE_AFTER_MS - 1);

    expect(status.status).toBe('closed');
    expect(reconnectingLabel(status)).toBe('Reconnecting…');
    expect(reconnectingLabel('open')).toBeNull();
  });

  it('makes auth-class failures terminal immediately', () => {
    const status = deriveWsFailureStatus(1_000, 'auth', 1_000);

    expect(status.status).toBe('auth-failed');
    expect(reconnectingLabel(status)).toBe('Sign-in expired');
  });

  it('keeps elapsed failure evidence when a foreground wake resets attempts', () => {
    let retryAttempt = 4;
    const first = recordWsFailure(null, 'transport', 1_000);

    // bindWake intentionally resets backoff; the evidence clock is separate.
    retryAttempt = 0;
    const afterWake = recordWsFailure(first, 'transport', 2_000);
    const status = deriveWsFailureStatus(afterWake.firstFailedAt, afterWake.lastCause, 1_000 + UNREACHABLE_AFTER_MS);

    expect(retryAttempt).toBe(0);
    expect(afterWake.firstFailedAt).toBe(1_000);
    expect(status.status).toBe('unreachable');
  });
});

describe('queued-change counting', () => {
  it('counts pending and inflight ops but excludes completed markers', () => {
    expect(countActiveQueuedChanges([{ status: 'pending' }, { status: 'inflight' }, { status: 'completed' }])).toBe(2);
  });
});

describe('sync-stuck derivation', () => {
  const STUCK_AFTER = 2500;

  it('starts the clock when the queue becomes non-empty while connected', () => {
    const d = deriveSyncStuck('open', 1, null, 1000, STUCK_AFTER);
    expect(d.stuckSince).toBe(1000);
    expect(d.syncStuck).toBe(false);
  });

  it('stays quiet for quick sends that drain before the threshold', () => {
    let d = deriveSyncStuck('open', 1, null, 1000, STUCK_AFTER);
    d = deriveSyncStuck('open', 0, d.stuckSince, 1800, STUCK_AFTER);
    expect(d.stuckSince).toBeNull();
    expect(d.syncStuck).toBe(false);
  });

  it('flags stuck once the queue persists past the threshold', () => {
    let d = deriveSyncStuck('open', 2, null, 1000, STUCK_AFTER);
    d = deriveSyncStuck('open', 2, d.stuckSince, 1000 + STUCK_AFTER, STUCK_AFTER);
    expect(d.syncStuck).toBe(true);
  });

  it('never flags stuck while disconnected — the banner owns that state', () => {
    let d = deriveSyncStuck('closed', 3, null, 1000, STUCK_AFTER);
    expect(d.stuckSince).toBeNull();
    d = deriveSyncStuck('closed', 3, d.stuckSince, 1000 + STUCK_AFTER * 2, STUCK_AFTER);
    expect(d.syncStuck).toBe(false);
  });

  it('restarts the clock on reconnect so the flush does not flash', () => {
    // Queued for ages while offline…
    let d = deriveSyncStuck('closed', 3, null, 1000, STUCK_AFTER);
    // …socket reopens: clock starts now, not from the offline period.
    d = deriveSyncStuck('open', 3, d.stuckSince, 60_000, STUCK_AFTER);
    expect(d.stuckSince).toBe(60_000);
    expect(d.syncStuck).toBe(false);
    d = deriveSyncStuck('open', 3, d.stuckSince, 60_000 + STUCK_AFTER, STUCK_AFTER);
    expect(d.syncStuck).toBe(true);
  });
});
