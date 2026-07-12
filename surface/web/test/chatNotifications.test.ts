import { describe, expect, it } from 'vitest';
import type { UserRef, WireEvent } from '@atrium/surface-client';
import type { Channel } from '../src/api';
import { notificationForWireEvent } from '../src/chatNotifications';
import type { Session } from '../src/sessions/types';

const me: UserRef = { id: 'u-me', handle: 'me', displayName: 'Me User' };
const ada: UserRef = { id: 'u-ada', handle: 'ada', displayName: 'Ada Lovelace' };

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

function event(overrides: Partial<WireEvent> = {}): WireEvent {
  return {
    id: 101,
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    type: 'message.posted',
    actorId: ada.id,
    payload: { text: 'hello @me' },
    createdAt: '2026-06-28T14:00:00.000Z',
    author: ada,
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    title: 'Write the report',
    status: 'completed',
    harness: 'codex',
    spawnedBy: me.id,
    driverId: null,
    archivedAt: null,
    pinned: false,
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: '2026-06-28T14:00:00.000Z',
    completedAt: '2026-06-28T14:05:00.000Z',
    lastEventId: 101,
    permalink: '/s/s-1',
    ...overrides,
  };
}

describe('notificationForWireEvent', () => {
  it('notifies for mentions in unmuted channels', () => {
    expect(notificationForWireEvent(event(), me, [channel()], {})).toEqual({
      kind: 'message',
      title: 'Ada Lovelace mentioned you in #general',
      body: 'hello @me',
      tag: 'evt-101',
      channelId: 'ch-1',
    });
  });

  it('notifies for DMs without a mention', () => {
    expect(
      notificationForWireEvent(
        event({ payload: { text: 'hello there' } }),
        me,
        [channel({ kind: 'dm' })],
        {},
      ),
    ).toMatchObject({
      kind: 'message',
      title: 'Ada Lovelace (direct message)',
      body: 'hello there',
    });
  });

  it('ignores self-authored, unmentioned, and muted channel messages', () => {
    expect(notificationForWireEvent(event({ actorId: me.id }), me, [channel()], {})).toBeNull();
    expect(
      notificationForWireEvent(event({ payload: { text: 'hello there' } }), me, [channel()], {}),
    ).toBeNull();
    expect(notificationForWireEvent(event(), me, [channel({ muted: true })], {})).toBeNull();
  });

  it('respects message notification preferences', () => {
    expect(
      notificationForWireEvent(
        event({ payload: { text: 'hello everyone' } }),
        me,
        [channel()],
        {},
        { messages: 'all', sessions: true, calls: true },
      ),
    ).toMatchObject({
      kind: 'message',
      body: 'hello everyone',
    });
    expect(
      notificationForWireEvent(event(), me, [channel()], {}, {
        messages: 'off',
        sessions: true,
        calls: true,
      }),
    ).toBeNull();
  });

  it('notifies for my completed agent sessions', () => {
    expect(
      notificationForWireEvent(
        event({
          type: 'session.completed',
          actorId: null,
          payload: {
            sessionId: 's-1',
            status: 'failed',
            resultExcerpt: 'The command failed because the token expired.',
          },
          author: null,
        }),
        me,
        [channel()],
        { 's-1': session() },
      ),
    ).toEqual({
      kind: 'session-completed',
      title: 'Agent failed: Write the report',
      body: 'The command failed because the token expired.',
      tag: 'evt-101',
      sessionId: 's-1',
    });
  });

  it('ignores sessions spawned by another user', () => {
    expect(
      notificationForWireEvent(
        event({
          type: 'session.completed',
          actorId: null,
          payload: { sessionId: 's-1' },
          author: null,
        }),
        me,
        [channel()],
        { 's-1': session({ spawnedBy: ada.id }) },
      ),
    ).toBeNull();
  });

  it('respects agent session notification preferences', () => {
    expect(
      notificationForWireEvent(
        event({
          type: 'session.completed',
          actorId: null,
          payload: { sessionId: 's-1' },
          author: null,
        }),
        me,
        [channel()],
        { 's-1': session() },
        { messages: 'dm_mention', sessions: false, calls: true },
      ),
    ).toBeNull();
  });
});
