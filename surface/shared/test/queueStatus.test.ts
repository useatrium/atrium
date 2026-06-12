import { describe, expect, it } from 'vitest';
import { countActiveQueuedChanges, queuedChangesLabel } from '../src/index';

describe('queue status label', () => {
  it('renders nothing when online and drained', () => {
    expect(queuedChangesLabel('open', 0)).toBeNull();
  });

  it('shows reconnecting when the socket is not open', () => {
    expect(queuedChangesLabel('connecting', 0)).toBe('Reconnecting…');
    expect(queuedChangesLabel('closed', 0)).toBe('Reconnecting…');
  });

  it('shows singular and plural queued-change counts', () => {
    expect(queuedChangesLabel('open', 1)).toBe('1 change queued');
    expect(queuedChangesLabel('open', 2)).toBe('2 changes queued');
  });

  it('combines reconnecting and queued-change states', () => {
    expect(queuedChangesLabel('closed', 3)).toBe('Reconnecting… 3 changes queued');
  });

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
