// Characterization tests for the shared call-core reducer + pure helpers.
//
// These pin BOTH platforms' behaviour through the policy/context parameters,
// derived by reading the pre-consolidation inline `handleCallEvent` bodies in
// web/src/useCall.ts and mobile/src/lib/useCall.ts. Where web and mobile
// legitimately diverge (design §3), each platform's expectation is asserted
// separately so the consolidation cannot silently flip either.

import { describe, expect, it, vi } from 'vitest';
import type { CallEvent, CallWire } from '../src/calls';
import { CALL_RING_TTL_MS } from '../src/calls';
import type { UserRef } from '../src/timeline';
import type { Channel } from '../src/api';
import {
  type BaseActiveCallState,
  type CallContext,
  CALL_ORDER_ASC,
  CALL_ORDER_DESC,
  callEventReducer,
  type CallReducerState,
  enrichParticipants,
  isExpiredRing,
  MOBILE_CALL_POLICY,
  ringAgeMs,
  sortLiveCalls,
  upsertUser,
  WEB_CALL_POLICY,
  withSelf,
} from '../src/call-core';

const me: UserRef = { id: 'me', handle: 'me', displayName: 'Me' };
const ada: UserRef = { id: 'ada', handle: 'ada', displayName: 'Ada' };
const bo: UserRef = { id: 'bo', handle: 'bo', displayName: 'Bo' };

function call(overrides: Partial<CallWire> = {}): CallWire {
  return {
    id: 'call-1',
    channelId: 'ch-1',
    initiatorId: ada.id,
    status: 'ringing',
    // Fresh by default so a ring is never treated as expired under real timers;
    // tests that need a specific age pass `startedAt` explicitly.
    startedAt: new Date().toISOString(),
    participants: [ada],
    ...overrides,
  };
}

// Active-state shapes matching each driver (extra fields the reducer preserves).
interface WebActive extends BaseActiveCallState {
  remoteAudioTracks: { key: string }[];
}
interface MobileActive extends BaseActiveCallState {
  nativeCallId?: string;
}

function webCtx(channels: Channel[] = []): CallContext {
  return {
    me,
    list: {
      order: CALL_ORDER_ASC,
      normalizeCall: (c) => ({ ...c, participants: enrichParticipants(c.participants, c, me, channels) }),
    },
    participantsFor: (c) => enrichParticipants(withSelf(c, me), c, me, channels),
    policy: WEB_CALL_POLICY,
  };
}

function mobileCtx(): CallContext {
  return {
    me,
    list: { order: CALL_ORDER_DESC, normalizeCall: (c) => c },
    participantsFor: (c) => withSelf(c, me),
    policy: MOBILE_CALL_POLICY,
  };
}

function emptyState<A extends BaseActiveCallState>(over: Partial<CallReducerState<A>> = {}): CallReducerState<A> {
  return { active: null, incoming: null, live: [], dismissed: new Set(), ...over };
}

function webActive(c: CallWire, over: Partial<WebActive> = {}): WebActive {
  return {
    call: c,
    phase: 'connected',
    participants: withSelf(c, me),
    activeSpeakerIds: new Set(),
    muted: false,
    error: null,
    remoteAudioTracks: [],
    ...over,
  };
}

function mobileActive(c: CallWire, over: Partial<MobileActive> = {}): MobileActive {
  return {
    call: c,
    phase: 'connected',
    participants: withSelf(c, me),
    activeSpeakerIds: new Set(),
    muted: false,
    error: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('upsertUser (merge-aware, adopted on both platforms — D7)', () => {
  it('adds an unknown user', () => {
    expect(upsertUser([ada], bo)).toEqual([ada, bo]);
  });
  it('does not let a fallback overwrite a resolved user', () => {
    const fallback: UserRef = { id: 'ada', handle: 'ada', displayName: 'ada' };
    const users = [ada];
    const result = upsertUser(users, fallback);
    expect(result).toBe(users); // unchanged reference — fallback rejected
    expect(result[0]).toEqual(ada);
  });
  it('upgrades a fallback to a resolved user', () => {
    const fallback: UserRef = { id: 'ada', handle: 'ada', displayName: 'ada' };
    expect(upsertUser([fallback], ada)).toEqual([ada]);
  });
  it('returns the same reference when nothing changes', () => {
    const users = [ada];
    expect(upsertUser(users, ada)).toBe(users);
  });
});

describe('sortLiveCalls order is a parameter (R4)', () => {
  const a = call({ id: 'a', startedAt: '2026-07-21T12:00:00.000Z' });
  const b = call({ id: 'b', startedAt: '2026-07-21T12:00:05.000Z' });
  const c = call({ id: 'c', startedAt: '2026-07-21T12:00:10.000Z' });
  it('web ASC = oldest first, id tiebreak', () => {
    expect(sortLiveCalls([c, a, b], CALL_ORDER_ASC).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
  it('mobile DESC = newest first', () => {
    expect(sortLiveCalls([a, c, b], CALL_ORDER_DESC).map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('isExpiredRing at the shared TTL boundary', () => {
  it('is false just under the TTL and true at/over it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T12:00:00.000Z'));
    const fresh = call({ startedAt: new Date(Date.now() - CALL_RING_TTL_MS + 1).toISOString() });
    const dead = call({ startedAt: new Date(Date.now() - CALL_RING_TTL_MS).toISOString() });
    expect(isExpiredRing(fresh)).toBe(false);
    expect(isExpiredRing(dead)).toBe(true);
    expect(ringAgeMs(dead)).toBeGreaterThanOrEqual(CALL_RING_TTL_MS);
    expect(isExpiredRing(call({ status: 'active', startedAt: dead.startedAt }))).toBe(false);
    vi.useRealTimers();
  });
});

describe('enrichParticipants dedupes and resolves via channel membership', () => {
  it('resolves a fallback identity to the channel member and dedupes', () => {
    const channels: Channel[] = [
      {
        id: 'ch-1',
        workspaceId: 'ws',
        name: 'general',
        createdAt: '2026-07-21T12:00:00.000Z',
        archivedAt: null,
        pinned: false,
        kind: 'dm',
        members: [me, ada],
      },
    ];
    const c = call({ participants: [ada] });
    const fallbackAda: UserRef = { id: 'ada', handle: 'ada', displayName: 'ada' };
    const result = enrichParticipants([fallbackAda, fallbackAda], c, me, channels);
    expect(result).toEqual([ada]);
  });
});

// ---------------------------------------------------------------------------
// Reducer — the six lifecycles (design §5). Each divergent branch asserts web
// and mobile separately.
// ---------------------------------------------------------------------------

describe('call.ringing (b/f: incoming ring, overlapping ring)', () => {
  it('surfaces an incoming ring from someone else and emits reportIncoming (both)', () => {
    const ringing = call();
    for (const ctx of [webCtx(), mobileCtx()]) {
      const r = callEventReducer(emptyState(), { type: 'call.ringing', call: ringing }, ctx);
      expect(r.state.incoming?.id).toBe('call-1');
      expect(r.state.live.map((c) => c.id)).toEqual(['call-1']);
      expect(r.effects).toContainEqual({ kind: 'reportIncoming', call: r.state.incoming });
    }
  });

  it('does not surface a self-initiated ring (both) but still tracks it live', () => {
    const own = call({ initiatorId: me.id, participants: [me] });
    for (const ctx of [webCtx(), mobileCtx()]) {
      const r = callEventReducer(emptyState(), { type: 'call.ringing', call: own }, ctx);
      expect(r.state.incoming).toBeNull();
      expect(r.state.live.map((c) => c.id)).toEqual(['call-1']);
      expect(r.effects).toEqual([]);
    }
  });

  it('f: a ring arriving while a call is active is not surfaced (both)', () => {
    const active = mobileActive(call({ id: 'active-call', status: 'active' }));
    const second = call({ id: 'call-2' });
    const rM = callEventReducer(
      emptyState<MobileActive>({ active }),
      { type: 'call.ringing', call: second },
      mobileCtx(),
    );
    expect(rM.state.incoming).toBeNull();

    const wActive = webActive(call({ id: 'active-call', status: 'active' }));
    const rW = callEventReducer(
      emptyState<WebActive>({ active: wActive }),
      { type: 'call.ringing', call: second },
      webCtx(),
    );
    expect(rW.state.incoming).toBeNull();
  });

  it('web: an already-dismissed ring is tracked live but not surfaced (suppressDismissedIncoming)', () => {
    const ringing = call();
    const r = callEventReducer(
      emptyState({ dismissed: new Set(['call-1']) }),
      { type: 'call.ringing', call: ringing },
      webCtx(),
    );
    expect(r.state.incoming).toBeNull();
    expect(r.state.live.map((c) => c.id)).toEqual(['call-1']);
    expect(r.effects).toEqual([]);
  });

  it('mobile: an already-dismissed ring is dropped from live and reported unanswered (guardStaleRing)', () => {
    const ringing = call();
    const r = callEventReducer(
      emptyState({ dismissed: new Set(['call-1']), live: [ringing] }),
      { type: 'call.ringing', call: ringing },
      mobileCtx(),
    );
    expect(r.state.incoming).toBeNull();
    expect(r.state.live).toEqual([]);
    expect(r.effects).toEqual([{ kind: 'reportEnded', callId: 'call-1', reason: 'unanswered' }]);
  });

  it('mobile: an expired ring is dropped and reported unanswered', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T12:10:00.000Z'));
    const stale = call({ startedAt: '2026-07-21T12:00:00.000Z' });
    const r = callEventReducer(emptyState({ live: [stale] }), { type: 'call.ringing', call: stale }, mobileCtx());
    expect(r.state.live).toEqual([]);
    expect(r.effects).toEqual([{ kind: 'reportEnded', callId: 'call-1', reason: 'unanswered' }]);
    vi.useRealTimers();
  });
});

describe('call.accepted / participant_joined (a/b: happy path, answer)', () => {
  const accepted: CallEvent = { type: 'call.accepted', callId: 'call-1', user: bo };

  it('marks the live + active call active and adds the joiner (both)', () => {
    for (const [ctx, mk] of [[webCtx(), webActive] as const, [mobileCtx(), mobileActive] as const]) {
      const active = mk(call({ status: 'ringing', participants: [me] }));
      const r = callEventReducer(emptyState({ active, live: [call({ status: 'ringing' })] }), accepted, ctx);
      expect(r.state.active?.call.status).toBe('active');
      expect(r.state.active?.participants.map((p) => p.id)).toContain('bo');
      expect(r.state.live[0]?.status).toBe('active');
    }
  });

  it('web: clears the incoming banner when ANYONE accepts a matching call', () => {
    const r = callEventReducer(emptyState({ incoming: call() }), accepted, webCtx());
    expect(r.state.incoming).toBeNull();
  });

  it('mobile: keeps (updates) the incoming banner when someone ELSE accepts', () => {
    const r = callEventReducer(emptyState({ incoming: call() }), accepted, mobileCtx());
    expect(r.state.incoming?.status).toBe('active');
    expect(r.state.incoming?.participants.map((p) => p.id)).toContain('bo');
  });

  it('both: clear the incoming banner when I accept', () => {
    const selfAccept: CallEvent = { type: 'call.accepted', callId: 'call-1', user: me };
    for (const ctx of [webCtx(), mobileCtx()]) {
      const r = callEventReducer(emptyState({ incoming: call() }), selfAccept, ctx);
      expect(r.state.incoming).toBeNull();
    }
  });

  it('web: a self-accept clears the call from the dismissed set (clearDismissedOnSelfAccept)', () => {
    const selfAccept: CallEvent = { type: 'call.accepted', callId: 'call-1', user: me };
    const rW = callEventReducer(emptyState({ dismissed: new Set(['call-1']) }), selfAccept, webCtx());
    expect(rW.state.dismissed.has('call-1')).toBe(false);
    const rM = callEventReducer(emptyState({ dismissed: new Set(['call-1']) }), selfAccept, mobileCtx());
    expect(rM.state.dismissed.has('call-1')).toBe(true);
  });
});

describe('call.declined (c: decline)', () => {
  const declineMe: CallEvent = { type: 'call.declined', callId: 'call-1', userId: me.id };

  it('web: clears incoming and adds to the dismissed set', () => {
    const r = callEventReducer(emptyState({ incoming: call(), live: [call()] }), declineMe, webCtx());
    expect(r.state.incoming).toBeNull();
    expect(r.state.dismissed.has('call-1')).toBe(true);
    expect(r.state.live.map((c) => c.id)).toEqual(['call-1']); // web declined does NOT touch live
    expect(r.effects).toEqual([]);
  });

  it('mobile: clears incoming, drops from live, reports declinedElsewhere', () => {
    const r = callEventReducer(emptyState({ incoming: call(), live: [call()] }), declineMe, mobileCtx());
    expect(r.state.incoming).toBeNull();
    expect(r.state.dismissed.has('call-1')).toBe(false);
    expect(r.state.live).toEqual([]);
    expect(r.effects).toEqual([{ kind: 'reportEnded', callId: 'call-1', reason: 'declinedElsewhere' }]);
  });

  it('both: a decline by someone else does not clear my incoming banner', () => {
    const declineOther: CallEvent = { type: 'call.declined', callId: 'call-1', userId: 'someone' };
    for (const ctx of [webCtx(), mobileCtx()]) {
      const r = callEventReducer(emptyState({ incoming: call() }), declineOther, ctx);
      expect(r.state.incoming?.id).toBe('call-1');
    }
  });
});

describe('call.participant_left (d/e: leave, last-leave)', () => {
  const left: CallEvent = { type: 'call.participant_left', callId: 'call-1', userId: bo.id };

  it('removes the participant + speaker and emits activeParticipantLeft (both)', () => {
    const wActive = webActive(call({ status: 'active', participants: [me, bo] }), {
      participants: [me, bo],
      activeSpeakerIds: new Set(['bo']),
    });
    const rW = callEventReducer(emptyState<WebActive>({ active: wActive }), left, webCtx());
    expect(rW.state.active?.participants.map((p) => p.id)).toEqual(['me']);
    expect([...(rW.state.active?.activeSpeakerIds ?? [])]).toEqual([]);
    expect(rW.effects).toContainEqual({ kind: 'activeParticipantLeft', userId: 'bo' });
    // web NEVER reports the last leave
    expect(rW.effects.some((e) => e.kind === 'reportEnded')).toBe(false);
  });

  it('mobile: reports remoteEnded when the last remote participant leaves (reportLastLeave)', () => {
    const mActive = mobileActive(call({ status: 'active', participants: [me, bo] }), { participants: [me, bo] });
    const rM = callEventReducer(emptyState<MobileActive>({ active: mActive }), left, mobileCtx());
    expect(rM.state.active?.participants.map((p) => p.id)).toEqual(['me']);
    expect(rM.effects).toContainEqual({ kind: 'reportEnded', callId: 'call-1', reason: 'remoteEnded' });
  });

  it('mobile: does NOT report remoteEnded while other remotes remain', () => {
    const mActive = mobileActive(call({ status: 'active', participants: [me, ada, bo] }), {
      participants: [me, ada, bo],
    });
    const rM = callEventReducer(emptyState<MobileActive>({ active: mActive }), left, mobileCtx());
    expect(rM.effects.some((e) => e.kind === 'reportEnded')).toBe(false);
  });
});

describe('call.ended (d: drop/hangup terminal)', () => {
  const ended: CallEvent = { type: 'call.ended', callId: 'call-1' };

  it('clears incoming/live/dismissed and tears down the active room (both)', () => {
    for (const [ctx, mk] of [[webCtx(), webActive] as const, [mobileCtx(), mobileActive] as const]) {
      const active = mk(call({ status: 'active' }));
      const r = callEventReducer(
        emptyState({ active, incoming: call(), live: [call()], dismissed: new Set(['call-1']) }),
        ended,
        ctx,
      );
      expect(r.state.active).toBeNull();
      expect(r.state.incoming).toBeNull();
      expect(r.state.live).toEqual([]);
      expect(r.state.dismissed.has('call-1')).toBe(false);
      expect(r.effects).toContainEqual({ kind: 'clearActiveRoom', callId: 'call-1' });
      expect(r.effects).toContainEqual({ kind: 'reportEnded', callId: 'call-1', reason: 'remoteEnded' });
    }
  });

  it('reportEnded is emitted before clearActiveRoom (ordering the mobile driver relies on)', () => {
    const r = callEventReducer(
      emptyState<MobileActive>({ active: mobileActive(call({ status: 'active' })) }),
      ended,
      mobileCtx(),
    );
    const reportIdx = r.effects.findIndex((e) => e.kind === 'reportEnded');
    const clearIdx = r.effects.findIndex((e) => e.kind === 'clearActiveRoom');
    expect(reportIdx).toBeGreaterThanOrEqual(0);
    expect(reportIdx).toBeLessThan(clearIdx);
  });

  it('ending a non-active call does not emit clearActiveRoom', () => {
    const r = callEventReducer(emptyState({ live: [call()] }), ended, webCtx());
    expect(r.effects.some((e) => e.kind === 'clearActiveRoom')).toBe(false);
    expect(r.state.live).toEqual([]);
  });
});
