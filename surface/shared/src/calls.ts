// Voice-call signaling types shared by the web/mobile clients and the server.
//
// Split of responsibilities (see docs/archive/notes/voice-support.md):
//  - Actions are HTTP: POST /api/calls (start), /api/calls/:id/accept|decline|leave.
//  - Receipt/lifecycle is WS: the hub fans out ephemeral `call.*` frames (NOT
//    timeline events, like presence/typing).
//  - Media is LiveKit: clients join the room with the {token,url} the HTTP
//    action returns; the server never proxies audio.

import { Schema } from 'effect';

export const CallStatusSchema = Schema.Literal('ringing', 'active', 'ended');
export type CallStatus = Schema.Schema.Type<typeof CallStatusSchema>;

export const CallUserRefSchema = Schema.mutable(Schema.Struct({
  id: Schema.String,
  handle: Schema.String,
  displayName: Schema.String,
}));
type UserRef = Schema.Schema.Type<typeof CallUserRefSchema>;

export const CallWireSchema = Schema.mutable(Schema.Struct({
  id: Schema.String,
  channelId: Schema.String,
  initiatorId: Schema.String,
  status: CallStatusSchema,
  startedAt: Schema.String,
  /** Users currently joined (joined and not yet left). */
  participants: Schema.mutable(Schema.Array(CallUserRefSchema)),
}));
export type CallWire = Schema.Schema.Type<typeof CallWireSchema>;

/** Credentials returned from start/accept so the client can join the room. */
export const CallJoinSchema = Schema.mutable(Schema.Struct({
  call: CallWireSchema,
  /** LiveKit access token (JWT) scoped to this room + the caller's identity. */
  token: Schema.String,
  /** LiveKit server ws(s):// URL the client connects to. */
  url: Schema.String,
}));
export type CallJoin = Schema.Schema.Type<typeof CallJoinSchema>;

/** Recoverable snapshot of currently live calls visible to the viewer. */
export const ActiveCallSnapshotSchema = Schema.mutable(Schema.Struct({
  calls: Schema.mutable(Schema.Array(CallWireSchema)),
}));
export type ActiveCallSnapshot = Schema.Schema.Type<typeof ActiveCallSnapshotSchema>;

// Loose on purpose: the server preserves route-specific channelId/id
// responses after this boundary decode.
export const ActiveCallsQuerySchema = Schema.Struct({
  channelId: Schema.optional(Schema.Unknown),
});

export const StartCallBodySchema = Schema.Struct({
  channelId: Schema.optional(Schema.Unknown),
  opId: Schema.optional(Schema.Unknown),
});

export const CallIdParamsSchema = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
});

/** Server→client WS frames for call lifecycle, fanned out via the hub. */
export type CallEvent =
  | { type: 'call.ringing'; call: CallWire }
  | { type: 'call.accepted'; callId: string; user: UserRef }
  | { type: 'call.declined'; callId: string; userId: string }
  | { type: 'call.participant_joined'; callId: string; user: UserRef }
  | { type: 'call.participant_left'; callId: string; userId: string }
  | { type: 'call.ended'; callId: string };

/** True for any `call.*` WS frame (route these to the call state, not the timeline). */
export function isCallEvent(frame: { type?: unknown }): frame is CallEvent {
  return typeof frame?.type === 'string' && frame.type.startsWith('call.');
}
