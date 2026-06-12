import { describe, expect, it } from 'vitest';
import { reconcileDraftSnapshot } from '../src/drafts';

describe('draft snapshot reconciliation', () => {
  it('hydrates only inactive untouched drafts with newer server timestamps', () => {
    const snapshot = {
      'channel:newer': { text: 'remote newer', updatedAt: '2026-06-11T12:05:00.000Z' },
      'channel:older': { text: 'remote older', updatedAt: '2026-06-11T11:00:00.000Z' },
      'channel:touched': { text: 'remote touched', updatedAt: '2026-06-11T12:10:00.000Z' },
      'channel:active': { text: 'remote active', updatedAt: '2026-06-11T12:10:00.000Z' },
      'channel:missing': { text: 'remote missing', updatedAt: '2026-06-11T12:00:00.000Z' },
    };
    const local = {
      'channel:newer': { text: 'local old', updatedAt: '2026-06-11T12:00:00.000Z' },
      'channel:older': { text: 'local new', updatedAt: '2026-06-11T12:00:00.000Z' },
      'channel:touched': { text: 'local touched', updatedAt: '2026-06-11T12:00:00.000Z' },
      'channel:active': { text: 'typing now', updatedAt: '2026-06-11T12:00:00.000Z' },
    };

    expect(
      reconcileDraftSnapshot({
        snapshot,
        local,
        touchedThisSession: new Set(['channel:touched']),
        activeDraftKeys: new Set(['channel:active']),
      }).hydrate,
    ).toEqual({
      'channel:newer': snapshot['channel:newer'],
      'channel:missing': snapshot['channel:missing'],
    });
  });
});
