import { describe, expect, it } from 'vitest';
import {
  channelAvatarName,
  channelLabel,
  formatExactTimestamp,
  formatRelativeTimestamp,
  initials,
} from '../src/util.js';

describe('initials', () => {
  it('keeps existing plain-name behavior', () => {
    expect(initials('alice')).toBe('AL');
    expect(initials('Gary Basin')).toBe('GB');
  });

  it('strips leading punctuation from each name part', () => {
    expect(initials('Gary (mobile)')).toBe('GM');
    expect(initials('(bot) helper')).toBe('BH');
  });

  it('falls back for names with no letters or digits', () => {
    expect(initials('???')).toBe('?');
  });
});

describe('channelLabel', () => {
  it('renders group DMs as other member names', () => {
    expect(
      channelLabel(
        {
          id: 'gdm-1',
          workspaceId: 'ws-1',
          name: 'internal',
          createdAt: new Date(0).toISOString(),
          archivedAt: null,
          pinned: false,
          kind: 'gdm',
          members: [
            { id: 'u1', handle: 'alice', displayName: 'Alice' },
            { id: 'u2', handle: 'ben', displayName: 'Ben' },
            { id: 'u3', handle: 'cara', displayName: 'Cara' },
          ],
        },
        'u1',
      ),
    ).toBe('Ben, Cara');
  });
});

describe('channelAvatarName', () => {
  it('uses the undecorated display name for self-DM avatars', () => {
    expect(
      channelAvatarName(
        {
          id: 'dm-self',
          workspaceId: 'ws-1',
          name: 'dm-self',
          createdAt: new Date(0).toISOString(),
          archivedAt: null,
          pinned: false,
          kind: 'dm',
          members: [{ id: 'u1', handle: 'alice', displayName: 'Alice Example' }],
        },
        'u1',
      ),
    ).toBe('Alice Example');
  });

  it('falls back to the visible label for group DMs', () => {
    expect(
      channelAvatarName(
        {
          id: 'gdm-1',
          workspaceId: 'ws-1',
          name: 'internal',
          createdAt: new Date(0).toISOString(),
          archivedAt: null,
          pinned: false,
          kind: 'gdm',
          members: [
            { id: 'u1', handle: 'alice', displayName: 'Alice' },
            { id: 'u2', handle: 'ben', displayName: 'Ben' },
            { id: 'u3', handle: 'cara', displayName: 'Cara' },
          ],
        },
        'u1',
      ),
    ).toBe('Ben, Cara');
  });
});

describe('formatExactTimestamp', () => {
  it('formats a local date and time with a timezone name', () => {
    const iso = '2026-01-02T15:04:05.000Z';
    expect(formatExactTimestamp(iso)).toBe(
      new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(iso)),
    );
  });

  it('returns an empty string for invalid timestamps', () => {
    expect(formatExactTimestamp('not-a-date')).toBe('');
  });
});

describe('formatRelativeTimestamp', () => {
  const now = new Date('2026-07-03T12:00:00.000Z');

  it('formats compact relative timestamps', () => {
    expect(formatRelativeTimestamp('2026-07-03T11:59:31.000Z', now)).toBe('just now');
    expect(formatRelativeTimestamp('2026-07-03T11:59:00.000Z', now)).toBe('1m ago');
    expect(formatRelativeTimestamp('2026-07-03T11:01:00.000Z', now)).toBe('59m ago');
    expect(formatRelativeTimestamp('2026-07-03T11:00:00.000Z', now)).toBe('1h ago');
    expect(formatRelativeTimestamp('2026-07-02T13:00:00.000Z', now)).toBe('23h ago');
    expect(formatRelativeTimestamp('2026-07-02T12:00:00.000Z', now)).toBe('1d ago');
    expect(formatRelativeTimestamp('2026-06-27T12:00:00.000Z', now)).toBe('6d ago');
  });

  it('falls back to month and day for older timestamps', () => {
    const iso = '2026-06-26T12:00:00.000Z';
    expect(formatRelativeTimestamp(iso, now)).toBe(
      new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    );
  });

  it('treats future timestamps as just now', () => {
    expect(formatRelativeTimestamp('2026-07-03T12:00:30.000Z', now)).toBe('just now');
  });

  it('returns an empty string for invalid timestamps', () => {
    expect(formatRelativeTimestamp('not-a-date', now)).toBe('');
    expect(formatRelativeTimestamp('2026-07-03T12:00:00.000Z', new Date('not-a-date'))).toBe('');
  });
});
