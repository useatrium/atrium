import { describe, expect, it } from 'vitest';
import type { CallWire, UserRef } from '@atrium/surface-client';
import { labelForCallChannel, userForCall } from '@atrium/surface-client';
import type { Channel } from '../src/api';

const me: UserRef = { id: 'u-me', handle: 'me', displayName: 'Me User' };
const ada: UserRef = { id: 'u-ada', handle: 'ada', displayName: 'Ada Lovelace' };

function call(overrides: Partial<CallWire> = {}): CallWire {
  return {
    id: 'call-1',
    channelId: 'ch-1',
    initiatorId: 'u-ada',
    status: 'ringing',
    startedAt: '2026-06-28T14:00:00.000Z',
    participants: [ada],
    ...overrides,
  };
}

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-1',
    workspaceId: 'ws-1',
    name: 'general',
    createdAt: '2026-06-28T14:00:00.000Z',
    kind: 'public',
    members: [me, ada],
    muted: false,
    archivedAt: null,
    pinned: false,
    ...overrides,
  };
}

describe('callPresentation', () => {
  it('finds callers from call participants before channel membership', () => {
    expect(userForCall(call(), [channel()], 'u-ada')).toEqual(ada);
  });

  it('falls back to channel members, then identity-shaped users', () => {
    expect(userForCall(call({ participants: [] }), [channel()], 'u-ada')).toEqual(ada);
    expect(userForCall(call({ participants: [] }), [channel()], 'u-missing')).toEqual({
      id: 'u-missing',
      handle: 'u-missing',
      displayName: 'u-missing',
    });
  });

  it('labels private channels with raw channel names and DMs with participant labels', () => {
    expect(labelForCallChannel(call(), [channel({ kind: 'private', name: 'ops' })], me.id)).toBe('#ops');
    expect(labelForCallChannel(call(), [channel({ kind: 'dm' })], me.id)).toBe('Ada Lovelace');
  });

  it('handles deleted or missing call channels', () => {
    expect(labelForCallChannel(call(), [], me.id)).toBe('Unknown channel');
  });
});
