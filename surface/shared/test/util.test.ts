import { describe, expect, it } from 'vitest';
import { channelAvatarName, channelLabel, initials } from '../src/util.js';

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
