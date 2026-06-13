// Voice-call signaling types shared by the web/mobile clients and the server.
//
// Split of responsibilities (see notes/voice-support.md):
//  - Actions are HTTP: POST /api/calls (start), /api/calls/:id/accept|decline|leave.
//  - Receipt/lifecycle is WS: the hub fans out ephemeral `call.*` frames (NOT
//    timeline events, like presence/typing).
//  - Media is LiveKit: clients join the room with the {token,url} the HTTP
//    action returns; the server never proxies audio.

import type { UserRef } from './timeline';

export type CallStatus = 'ringing' | 'active' | 'ended';

export interface CallWire {
  id: string;
  channelId: string;
  initiatorId: string;
  status: CallStatus;
  startedAt: string;
  /** Users currently joined (joined and not yet left). */
  participants: UserRef[];
}

/** Credentials returned from start/accept so the client can join the room. */
export interface CallJoin {
  call: CallWire;
  /** LiveKit access token (JWT) scoped to this room + the caller's identity. */
  token: string;
  /** LiveKit server ws(s):// URL the client connects to. */
  url: string;
}

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
