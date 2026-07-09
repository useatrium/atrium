import { describe, expect, it } from 'vitest';
import { countActiveQueuedChanges, deriveSyncStuck, reconnectingLabel } from '../src/index';

describe('reconnecting label', () => {
  it('renders nothing while connected, regardless of queue depth', () => {
    expect(reconnectingLabel('open')).toBeNull();
  });

  it('shows reconnecting when the socket is not open', () => {
    expect(reconnectingLabel('connecting')).toBe('Reconnecting…');
    expect(reconnectingLabel('closed')).toBe('Reconnecting…');
  });
});

describe('queued-change counting', () => {
  it('counts pending and inflight ops but excludes completed markers', () => {
    expect(
      countActiveQueuedChanges([
        { status: 'pending' },
        { status: 'inflight' },
        { status: 'completed' },
      ]),
    ).toBe(2);
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
