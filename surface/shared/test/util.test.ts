import { describe, expect, it } from 'vitest';
import { channelLabel, initials } from '../src/util.js';

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
