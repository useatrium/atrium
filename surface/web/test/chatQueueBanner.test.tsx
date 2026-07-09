// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { queueStatusBanner } from '../src/Chat';

describe('queueStatusBanner', () => {
  it('is absent when connected even with queued ops', () => {
    expect(queueStatusBanner('open', { queuedCount: 3, syncStuck: true })).toBeNull();
  });

  it('shows reconnecting text and queued count title when closed', () => {
    expect(queueStatusBanner('closed', { queuedCount: 3, syncStuck: false })).toEqual({
      text: 'Reconnecting…',
      title: '3 changes will send when reconnected',
    });
  });

  it('omits the title when offline with no queued ops', () => {
    expect(queueStatusBanner('connecting', { queuedCount: 0, syncStuck: false })).toEqual({
      text: 'Reconnecting…',
      title: undefined,
    });
  });
});
