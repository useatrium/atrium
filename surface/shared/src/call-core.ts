// @atrium/surface-client/call-core — the platform-independent brain for voice
// calls, shared by the web and mobile `useCall` drivers.
//
// This module is deliberately **LiveKit-free and CallKit-free**: it never
// imports `livekit-client`, `@livekit/react-native`, or `expo-callkit-telecom`.
// The two platform drivers own the LiveKit `Room` and (on mobile) the CallKit /
// AudioSession call sites; they translate `RoomEvent`s into `CallEvent`s and
// interpret the pure `callEventReducer`'s state + effect output. See
// docs/archive/notes/2026-07-21-call-core-design.md (Design A).
//
// Two behaviour changes were made deliberately during consolidation and are
// documented at their call sites below:
//  1. `upsertUser` is merge-aware on BOTH platforms (previously mobile was
//     add-only). Fallback identities never overwrite real users; real users
//     upgrade fallbacks. (design D7)
//  2. The ring TTL is unified on the shared `CALL_RING_TTL_MS` (60s). Web
//     previously hard-coded a 45s outgoing "No answer" timeout that disagreed
//     with the server sweeper — the drivers now import the shared constant.
//     (design D4/R5) — the constant lives in ./calls; this module re-uses it.

import { CALL_RING_TTL_MS } from './calls';
import type { CallEvent, CallWire } from './calls';
import type { Channel } from './api';
import type { UserRef } from './timeline';
import { channelLabel } from './util';

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export type CallPhase = 'connecting' | 'connected' | 'ended';

/**
 * The six fields common to both platforms' active-call state. Each app
 * intersects this with its own extra field: web adds `remoteAudioTracks`
 * (its autoplay-attachment slice), mobile adds `nativeCallId` (the CallKit
 * session handle). The reducer is generic over `A extends BaseActiveCallState`
 * and only ever touches the common fields — it preserves the extra fields by
 * spreading the current active object.
 */
export interface BaseActiveCallState {
  call: CallWire;
  phase: CallPhase;
  participants: UserRef[];
  activeSpeakerIds: Set<string>;
  muted: boolean;
  error: string | null;
}

/** Shared capture constraints for the local mic track. */
export const AUDIO_CAPTURE_OPTIONS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

// ---------------------------------------------------------------------------
// User helpers (enrichment)
// ---------------------------------------------------------------------------

export function fallbackUser(identity: string): UserRef {
  return { id: identity, handle: identity, displayName: identity };
}

export function isFallbackUser(user: UserRef): boolean {
  return user.handle === user.id && user.displayName === user.id;
}

export function mergeUser(existing: UserRef, next: UserRef): UserRef {
  if (isFallbackUser(next) && !isFallbackUser(existing)) return existing;
  if (existing.handle === next.handle && existing.displayName === next.displayName && existing.id === next.id) {
    return existing;
  }
  return next;
}

/**
 * Merge-aware upsert (adopted on BOTH platforms — design D7). A fallback
 * identity never clobbers an already-resolved user; a real user upgrades a
 * fallback. Returns the same array reference when nothing changed.
 */
export function upsertUser(users: UserRef[], user: UserRef): UserRef[] {
  const index = users.findIndex((u) => u.id === user.id);
  if (index === -1) return [...users, user];
  const existing = users[index];
  if (!existing) return users;
  const next = mergeUser(existing, user);
  if (next === existing) return users;
  return users.map((u, i) => (i === index ? next : u));
}

export function removeUser(users: UserRef[], userId: string): UserRef[] {
  return users.filter((u) => u.id !== userId);
}

export function dedupeUsers(users: UserRef[]): UserRef[] {
  return users.reduce<UserRef[]>((acc, user) => upsertUser(acc, user), []);
}

/**
 * Resolve a single identity to the richest known `UserRef`, preferring a
 * non-fallback record from the call participants, channel membership, or the
 * already-known users, and falling back to an identity-shaped user.
 */
export function userFromIdentity(
  identity: string,
  call: CallWire,
  me: UserRef,
  channels: Channel[],
  knownUsers: UserRef[] = [],
): UserRef {
  if (identity === me.id) return me;
  const channelMember = channels
    .find((channel) => channel.id === call.channelId)
    ?.members?.find((u) => u.id === identity);
  const callParticipant = call.participants.find((u) => u.id === identity);
  const knownUser = knownUsers.find((u) => u.id === identity);
  const candidates = [channelMember, callParticipant, knownUser].filter((user): user is UserRef => user != null);
  return candidates.find((user) => !isFallbackUser(user)) ?? candidates[0] ?? fallbackUser(identity);
}

export function enrichParticipants(users: UserRef[], call: CallWire, me: UserRef, channels: Channel[]): UserRef[] {
  return dedupeUsers(users.map((user) => userFromIdentity(user.id, call, me, channels, users)));
}

/** The participants array with `me` prepended when not already present. */
export function withSelf(call: CallWire, me: UserRef): UserRef[] {
  return call.participants.some((u) => u.id === me.id) ? call.participants : [me, ...call.participants];
}

// ---------------------------------------------------------------------------
// Presentation helpers (formerly duplicated in web/callPresentation.ts and
// mobile/useCall.ts — one copy now).
// ---------------------------------------------------------------------------

/**
 * The simplest caller/participant resolution used by the banners: call
 * participants first, then channel membership, then an identity-shaped
 * fallback. (This is the presentation-layer resolver, distinct from the
 * richer `userFromIdentity` used inside the active-call enrichment.)
 */
export function userForCall(call: CallWire, channels: Channel[], userId: string): UserRef {
  return (
    call.participants.find((u) => u.id === userId) ??
    channels.find((c) => c.id === call.channelId)?.members?.find((u) => u.id === userId) ??
    fallbackUser(userId)
  );
}

export function labelForCallChannel(call: CallWire, channels: Channel[], meId: string): string {
  const channel = channels.find((c) => c.id === call.channelId);
  if (!channel) return 'Unknown channel';
  return channel.kind === 'private' ? `#${channel.name}` : channelLabel(channel, meId);
}

// ---------------------------------------------------------------------------
// Ring lifetime
// ---------------------------------------------------------------------------

export function ringAgeMs(call: CallWire): number {
  return Date.now() - Date.parse(call.startedAt);
}

/** A ringing call older than the shared TTL is dead and must never surface. */
export function isExpiredRing(call: CallWire): boolean {
  return call.status === 'ringing' && ringAgeMs(call) >= CALL_RING_TTL_MS;
}

export function isLiveCall(call: CallWire): boolean {
  return call.status !== 'ended';
}

// ---------------------------------------------------------------------------
// Live-call list bookkeeping
// ---------------------------------------------------------------------------

export type CallComparator = (a: CallWire, b: CallWire) => number;

/**
 * Web's stable total order: ascending `startedAt`, id tiebreak. Because it is a
 * total order the pre-sort insertion position is irrelevant.
 */
export const CALL_ORDER_ASC: CallComparator = (a, b) =>
  a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id);

/**
 * Mobile's order: descending `startedAt` (newest first), no tiebreak. This is
 * NOT a total order, so ties preserve input order under a stable sort — new
 * calls must be inserted at the front to reproduce mobile's behaviour.
 */
export const CALL_ORDER_DESC: CallComparator = (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt);

/**
 * Sort a live-call list. The comparator is a parameter so each UI keeps its
 * existing order: web passes `CALL_ORDER_ASC`, mobile passes `CALL_ORDER_DESC`
 * — the consolidation must not silently flip either. (design D1/R4)
 */
export function sortLiveCalls(calls: CallWire[], compare: CallComparator): CallWire[] {
  return [...calls].sort(compare);
}

/**
 * Context the live-list helpers and the reducer need: the platform's sort
 * order and how it normalizes a call before storing it. Web enriches
 * participants (`normalizeCall`); mobile stores raw (identity `normalizeCall`).
 */
export interface CallListContext {
  order: CallComparator;
  /** Enrich (web) or identity (mobile). Applied whenever a call enters state. */
  normalizeCall: (call: CallWire) => CallWire;
}

export function normalizeLiveCalls(calls: CallWire[], ctx: CallListContext): CallWire[] {
  return sortLiveCalls(calls.filter(isLiveCall).map(ctx.normalizeCall), ctx.order);
}

export function upsertLiveCall(calls: CallWire[], call: CallWire, ctx: CallListContext): CallWire[] {
  if (!isLiveCall(call)) return calls.filter((current) => current.id !== call.id);
  const next = ctx.normalizeCall(call);
  const index = calls.findIndex((current) => current.id === next.id);
  // Prepend on insert: byte-identical to mobile's newest-first list, and
  // irrelevant to web's total-order sort.
  if (index === -1) return sortLiveCalls([next, ...calls], ctx.order);
  return sortLiveCalls(
    calls.map((current, i) => (i === index ? next : current)),
    ctx.order,
  );
}

export function updateLiveCall(
  calls: CallWire[],
  callId: string,
  update: (call: CallWire) => CallWire,
  ctx: CallListContext,
): CallWire[] {
  let found = false;
  const next = calls.flatMap((call) => {
    if (call.id !== callId) return [call];
    found = true;
    const updated = update(call);
    return isLiveCall(updated) ? [ctx.normalizeCall(updated)] : [];
  });
  return found ? sortLiveCalls(next, ctx.order) : calls;
}

export function removeLiveCall(calls: CallWire[], callId: string): CallWire[] {
  return calls.filter((call) => call.id !== callId);
}

// ---------------------------------------------------------------------------
// The CallEvent reducer
// ---------------------------------------------------------------------------

/** Reasons the mobile driver reports a call ended to CallKit. */
export type NativeEndReason = 'remoteEnded' | 'failed' | 'declinedElsewhere' | 'unanswered';

/**
 * Intent effects the reducer emits. Each driver interprets the subset it cares
 * about and ignores the rest: web acts on `clearActiveRoom` /
 * `activeParticipantLeft`; mobile acts on `clearActiveRoom` / `reportIncoming`
 * / `reportEnded`.
 */
export type CallEffect =
  | { kind: 'reportIncoming'; call: CallWire }
  | { kind: 'reportEnded'; callId: string; reason: NativeEndReason }
  | { kind: 'clearActiveRoom'; callId: string }
  | { kind: 'activeParticipantLeft'; userId: string };

/**
 * Platform policy pinning the branches where web and mobile legitimately
 * diverge today (design §3). Characterization tests fix each platform's
 * expected value through these flags rather than silently unifying behaviour.
 */
export interface CallPolicy {
  /** mobile: drop an already-dismissed/expired ring (and report `unanswered`). */
  guardStaleRing: boolean;
  /** web: also require not-dismissed before surfacing the incoming banner. */
  suppressDismissedIncoming: boolean;
  /** mobile: keep (and update) the incoming banner when someone else accepts. */
  keepIncomingOnOtherAccept: boolean;
  /** web `dismiss` (add to dismissed set) vs mobile `removeLive` (+ report). */
  declineByMe: 'dismiss' | 'removeLive';
  /** web: a self-accept clears the call from the dismissed set. */
  clearDismissedOnSelfAccept: boolean;
  /** mobile: report `remoteEnded` when the last remote participant leaves. */
  reportLastLeave: boolean;
}

export const WEB_CALL_POLICY: CallPolicy = {
  guardStaleRing: false,
  suppressDismissedIncoming: true,
  keepIncomingOnOtherAccept: false,
  declineByMe: 'dismiss',
  clearDismissedOnSelfAccept: true,
  reportLastLeave: false,
};

export const MOBILE_CALL_POLICY: CallPolicy = {
  guardStaleRing: true,
  suppressDismissedIncoming: false,
  keepIncomingOnOtherAccept: true,
  declineByMe: 'removeLive',
  clearDismissedOnSelfAccept: false,
  reportLastLeave: true,
};

/**
 * Everything the reducer needs beyond the atoms: the local user, the live-list
 * context (order + normalize), a participant resolver for the active call, and
 * the platform policy.
 */
export interface CallContext {
  me: UserRef;
  list: CallListContext;
  /** web enriches + prepends self; mobile prepends self only. */
  participantsFor: (call: CallWire) => UserRef[];
  policy: CallPolicy;
}

/** The three reactive atoms plus the dismissed-id set. */
export interface CallReducerState<A extends BaseActiveCallState> {
  active: A | null;
  incoming: CallWire | null;
  live: CallWire[];
  dismissed: Set<string>;
}

export interface CallReducerResult<A extends BaseActiveCallState> {
  state: CallReducerState<A>;
  effects: CallEffect[];
}

/**
 * Pure `(state, event, ctx) → { state, effects }` transition. Returns the same
 * atom references when unchanged so drivers can skip needless `setState`s. All
 * platform-specific side effects (LiveKit room teardown, CallKit reports, web
 * audio-track pruning) are expressed as `effects` the driver interprets.
 */
export function callEventReducer<A extends BaseActiveCallState>(
  state: CallReducerState<A>,
  event: CallEvent,
  ctx: CallContext,
): CallReducerResult<A> {
  const { me, policy } = ctx;
  let { active, incoming, live, dismissed } = state;
  const effects: CallEffect[] = [];

  const done = (): CallReducerResult<A> => ({ state: { active, incoming, live, dismissed }, effects });

  if (event.type === 'call.ringing') {
    const call = event.call;
    if (policy.guardStaleRing && (dismissed.has(call.id) || isExpiredRing(call))) {
      if (incoming?.id === call.id) incoming = null;
      live = removeLiveCall(live, call.id);
      effects.push({ kind: 'reportEnded', callId: call.id, reason: 'unanswered' });
      return done();
    }
    const normalized = ctx.list.normalizeCall(call);
    live = upsertLiveCall(live, call, ctx.list);
    const surfaceIncoming =
      normalized.initiatorId !== me.id &&
      !active &&
      (!policy.suppressDismissedIncoming || !dismissed.has(normalized.id));
    if (surfaceIncoming) {
      incoming = normalized;
      effects.push({ kind: 'reportIncoming', call: normalized });
    }
    if (active && active.call.id === normalized.id) {
      active = { ...active, call: normalized, participants: ctx.participantsFor(normalized) };
    }
    return done();
  }

  if (event.type === 'call.accepted' || event.type === 'call.participant_joined') {
    if (policy.clearDismissedOnSelfAccept && event.user.id === me.id && dismissed.has(event.callId)) {
      const next = new Set(dismissed);
      next.delete(event.callId);
      dismissed = next;
    }
    if (incoming && incoming.id === event.callId) {
      if (event.user.id === me.id) {
        incoming = null;
      } else if (policy.keepIncomingOnOtherAccept) {
        incoming = { ...incoming, status: 'active', participants: upsertUser(incoming.participants, event.user) };
      } else {
        incoming = null;
      }
    }
    live = updateLiveCall(
      live,
      event.callId,
      (call) => ({ ...call, status: 'active', participants: upsertUser(call.participants, event.user) }),
      ctx.list,
    );
    if (active && active.call.id === event.callId) {
      active = {
        ...active,
        call: { ...active.call, status: 'active' },
        participants: upsertUser(active.participants, event.user),
      };
    }
    return done();
  }

  if (event.type === 'call.declined') {
    if (incoming && incoming.id === event.callId && event.userId === me.id) incoming = null;
    if (event.userId === me.id) {
      if (policy.declineByMe === 'dismiss') {
        dismissed = new Set(dismissed).add(event.callId);
      } else {
        live = removeLiveCall(live, event.callId);
        effects.push({ kind: 'reportEnded', callId: event.callId, reason: 'declinedElsewhere' });
      }
    }
    return done();
  }

  if (event.type === 'call.participant_left') {
    live = updateLiveCall(
      live,
      event.callId,
      (call) => ({ ...call, participants: removeUser(call.participants, event.userId) }),
      ctx.list,
    );
    if (active && active.call.id === event.callId) {
      const participants = removeUser(active.participants, event.userId);
      const remoteCount = participants.filter((p) => p.id !== me.id).length;
      const endedByLastLeave = active.call.status === 'active' && remoteCount === 0;
      active = {
        ...active,
        participants,
        activeSpeakerIds: new Set([...active.activeSpeakerIds].filter((id) => id !== event.userId)),
      };
      effects.push({ kind: 'activeParticipantLeft', userId: event.userId });
      if (policy.reportLastLeave && endedByLastLeave) {
        effects.push({ kind: 'reportEnded', callId: event.callId, reason: 'remoteEnded' });
      }
    }
    return done();
  }

  if (event.type === 'call.ended') {
    if (dismissed.has(event.callId)) {
      const next = new Set(dismissed);
      next.delete(event.callId);
      dismissed = next;
    }
    if (incoming && incoming.id === event.callId) incoming = null;
    live = removeLiveCall(live, event.callId);
    effects.push({ kind: 'reportEnded', callId: event.callId, reason: 'remoteEnded' });
    if (active && active.call.id === event.callId) {
      effects.push({ kind: 'clearActiveRoom', callId: event.callId });
      active = null;
    }
    return done();
  }

  return done();
}
