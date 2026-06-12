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

  it('removes stale local drafts from deletion tombstones', () => {
    expect(
      reconcileDraftSnapshot({
        snapshot: {},
        deletions: { 'channel:one': '2026-06-11T12:05:00.000Z' },
        local: { 'channel:one': { text: 'stale', updatedAt: '2026-06-11T12:00:00.000Z' } },
        touchedThisSession: new Set(),
        activeDraftKeys: new Set(),
      }).remove,
    ).toEqual(['channel:one']);
  });

  it('does not remove active or touched drafts', () => {
    const local = {
      'channel:active': { text: 'typing', updatedAt: '2026-06-11T12:00:00.000Z' },
      'channel:touched': { text: 'edited here', updatedAt: '2026-06-11T12:00:00.000Z' },
    };

    expect(
      reconcileDraftSnapshot({
        snapshot: {},
        deletions: {
          'channel:active': '2026-06-11T12:05:00.000Z',
          'channel:touched': '2026-06-11T12:05:00.000Z',
        },
        local,
        touchedThisSession: new Set(['channel:touched']),
        activeDraftKeys: new Set(['channel:active']),
      }).remove,
    ).toEqual([]);
  });

  it('keeps newer local edits over older remote deletions', () => {
    expect(
      reconcileDraftSnapshot({
        snapshot: {},
        deletions: { 'channel:one': '2026-06-11T12:00:00.000Z' },
        local: { 'channel:one': { text: 'newer local', updatedAt: '2026-06-11T12:05:00.000Z' } },
        touchedThisSession: new Set(),
        activeDraftKeys: new Set(),
      }).remove,
    ).toEqual([]);
  });
});
