import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import type { CallEvent, CallJoin, CallWire, UserRef } from '@atrium/surface-client';
import { ApiError, api, type Channel } from './api';
import { desktopApiOptions } from './desktop';

export interface RemoteAudioTrackRef {
  key: string;
  track: RemoteTrack;
}

export interface ActiveCallState {
  call: CallWire;
  phase: 'connecting' | 'connected' | 'ended';
  participants: UserRef[];
  remoteAudioTracks: RemoteAudioTrackRef[];
  activeSpeakerIds: Set<string>;
  muted: boolean;
  error: string | null;
}

const AUDIO_CAPTURE_OPTIONS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};
const RING_TIMEOUT_MS = 45_000;

function callLeavePath(callId: string): string {
  return `/api/calls/${encodeURIComponent(callId)}/leave`;
}

function fallbackUser(identity: string): UserRef {
  return { id: identity, handle: identity, displayName: identity };
}

function isFallbackUser(user: UserRef): boolean {
  return user.handle === user.id && user.displayName === user.id;
}

function mergeUser(existing: UserRef, next: UserRef): UserRef {
  if (isFallbackUser(next) && !isFallbackUser(existing)) return existing;
  if (existing.handle === next.handle && existing.displayName === next.displayName && existing.id === next.id) {
    return existing;
  }
  return next;
}

function upsertUser(users: UserRef[], user: UserRef): UserRef[] {
  const index = users.findIndex((u) => u.id === user.id);
  if (index === -1) return [...users, user];
  const existing = users[index];
  if (!existing) return users;
  const next = mergeUser(existing, user);
  if (next === existing) return users;
  return users.map((u, i) => (i === index ? next : u));
}

function dedupeUsers(users: UserRef[]): UserRef[] {
  return users.reduce<UserRef[]>((acc, user) => upsertUser(acc, user), []);
}

function userFromIdentity(
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

function enrichParticipants(users: UserRef[], call: CallWire, me: UserRef, channels: Channel[]): UserRef[] {
  return dedupeUsers(users.map((user) => userFromIdentity(user.id, call, me, channels, users)));
}

function participantsFor(call: CallWire, me: UserRef, channels: Channel[]): UserRef[] {
  const participants = call.participants.some((u) => u.id === me.id) ? call.participants : [me, ...call.participants];
  return enrichParticipants(participants, call, me, channels);
}

function upsertIdentityParticipant(
  current: ActiveCallState,
  identity: string,
  me: UserRef,
  channels: Channel[],
): UserRef[] {
  return upsertUser(current.participants, userFromIdentity(identity, current.call, me, channels, current.participants));
}

function upsertIdentityParticipants(
  current: ActiveCallState,
  identities: string[],
  me: UserRef,
  channels: Channel[],
): UserRef[] {
  return identities.reduce(
    (participants, identity) =>
      upsertUser(participants, userFromIdentity(identity, current.call, me, channels, participants)),
    current.participants,
  );
}

function removeUser(users: UserRef[], userId: string): UserRef[] {
  return users.filter((u) => u.id !== userId);
}

function isLiveCall(call: CallWire): boolean {
  return call.status !== 'ended';
}

function sortLiveCalls(calls: CallWire[]): CallWire[] {
  return [...calls].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

function normalizeCall(call: CallWire, me: UserRef, channels: Channel[]): CallWire {
  return {
    ...call,
    participants: enrichParticipants(call.participants, call, me, channels),
  };
}

function normalizeLiveCalls(calls: CallWire[], me: UserRef, channels: Channel[]): CallWire[] {
  return sortLiveCalls(calls.filter(isLiveCall).map((call) => normalizeCall(call, me, channels)));
}

function upsertLiveCall(calls: CallWire[], call: CallWire, me: UserRef, channels: Channel[]): CallWire[] {
  if (!isLiveCall(call)) return calls.filter((current) => current.id !== call.id);
  const next = normalizeCall(call, me, channels);
  const index = calls.findIndex((current) => current.id === next.id);
  if (index === -1) return sortLiveCalls([...calls, next]);
  return sortLiveCalls(calls.map((current, i) => (i === index ? next : current)));
}

function updateLiveCall(
  calls: CallWire[],
  callId: string,
  update: (call: CallWire) => CallWire,
  me: UserRef,
  channels: Channel[],
): CallWire[] {
  let found = false;
  const next = calls.flatMap((call) => {
    if (call.id !== callId) return [call];
    found = true;
    const updated = update(call);
    return isLiveCall(updated) ? [normalizeCall(updated, me, channels)] : [];
  });
  return found ? sortLiveCalls(next) : calls;
}

function callUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503 && err.code === 'calls_unconfigured';
}

export function useCall(me: UserRef, channels: Channel[]) {
  const channelsRef = useRef(channels);

  channelsRef.current = channels;

  function currentChannels(): Channel[] {
    return channelsRef.current;
  }

  const [incomingCall, setIncomingCall] = useState<CallWire | null>(null);
  const [liveCalls, setLiveCalls] = useState<CallWire[]>([]);
  const [dismissedCallIds, setDismissedCallIds] = useState<Set<string>>(() => new Set());
  const [activeCall, setActiveCall] = useState<ActiveCallState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [answering, setAnswering] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const activeCallRef = useRef<ActiveCallState | null>(null);
  const dismissedCallIdsRef = useRef(dismissedCallIds);
  const connectPromiseRef = useRef<Promise<void> | null>(null);
  const detachRoomHandlersRef = useRef<(() => void) | null>(null);
  const intentionalDisconnectRef = useRef(false);

  activeCallRef.current = activeCall;
  dismissedCallIdsRef.current = dismissedCallIds;

  useEffect(() => {
    setActiveCall((current) =>
      current
        ? {
            ...current,
            participants: enrichParticipants(current.participants, current.call, me, channels),
          }
        : current,
    );
    setIncomingCall((current) => (current ? normalizeCall(current, me, channels) : current));
    setLiveCalls((current) => normalizeLiveCalls(current, me, channels));
  }, [channels, me]);

  const updateActiveCall = useCallback((fn: (current: ActiveCallState) => ActiveCallState) => {
    setActiveCall((current) => (current ? fn(current) : current));
  }, []);

  const clearRoom = useCallback(() => {
    intentionalDisconnectRef.current = true;
    detachRoomHandlersRef.current?.();
    detachRoomHandlersRef.current = null;
    const room = roomRef.current;
    roomRef.current = null;
    // Reset the intentional-disconnect flag only after disconnect settles, so a
    // late Disconnected event isn't misread as an unexpected drop.
    if (room && room.state !== 'disconnected') {
      void room.disconnect().finally(() => {
        intentionalDisconnectRef.current = false;
      });
    } else {
      intentionalDisconnectRef.current = false;
    }
  }, []);

  const addRemoteAudioTrack = useCallback(
    (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const key = `${participant.identity}:${publication.trackSid}`;
      updateActiveCall((current) => ({
        ...current,
        remoteAudioTracks: current.remoteAudioTracks.some((t) => t.key === key)
          ? current.remoteAudioTracks
          : [...current.remoteAudioTracks, { key, track }],
      }));
    },
    [updateActiveCall],
  );

  const removeRemoteAudioTrack = useCallback(
    (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      const key = `${participant.identity}:${publication.trackSid}`;
      updateActiveCall((current) => ({
        ...current,
        remoteAudioTracks: current.remoteAudioTracks.filter((t) => t.key !== key),
      }));
    },
    [updateActiveCall],
  );

  const setRoomHandlers = useCallback(
    (room: Room) => {
      const onParticipantConnected = (participant: RemoteParticipant) => {
        updateActiveCall((current) => ({
          ...current,
          participants: upsertIdentityParticipant(current, participant.identity, me, currentChannels()),
        }));
      };
      const onParticipantDisconnected = (participant: RemoteParticipant) => {
        updateActiveCall((current) => ({
          ...current,
          participants: removeUser(current.participants, participant.identity),
          activeSpeakerIds: new Set([...current.activeSpeakerIds].filter((id) => id !== participant.identity)),
          remoteAudioTracks: current.remoteAudioTracks.filter((t) => !t.key.startsWith(`${participant.identity}:`)),
        }));
      };
      const onTrackSubscribed = (
        track: RemoteTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => addRemoteAudioTrack(track, publication, participant);
      const onTrackUnsubscribed = (
        _track: RemoteTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => removeRemoteAudioTrack(publication, participant);
      const onActiveSpeakersChanged = (speakers: Participant[]) => {
        const speakerIds = speakers.map((speaker) => speaker.identity);
        updateActiveCall((current) => ({
          ...current,
          participants: upsertIdentityParticipants(current, speakerIds, me, currentChannels()),
          activeSpeakerIds: new Set(speakerIds),
        }));
      };
      const onDisconnected = () => {
        detachRoomHandlersRef.current?.();
        detachRoomHandlersRef.current = null;
        roomRef.current = null;
        connectPromiseRef.current = null;
        if (intentionalDisconnectRef.current) return;
        const current = activeCallRef.current;
        if (current) void api.leaveCall(current.call.id).catch(() => {});
        setActiveCall(null);
        setNotice('Call disconnected.');
      };

      room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
      room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
      room.on(RoomEvent.ActiveSpeakersChanged, onActiveSpeakersChanged);
      room.on(RoomEvent.Disconnected, onDisconnected);

      detachRoomHandlersRef.current = () => {
        room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
        room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
        room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
        room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
        room.off(RoomEvent.ActiveSpeakersChanged, onActiveSpeakersChanged);
        room.off(RoomEvent.Disconnected, onDisconnected);
      };
    },
    [addRemoteAudioTrack, me, removeRemoteAudioTrack, updateActiveCall],
  );

  const connectToCall = useCallback(
    async (join: CallJoin) => {
      const current = activeCallRef.current;
      if (current?.call.id === join.call.id && (roomRef.current || connectPromiseRef.current)) {
        return connectPromiseRef.current ?? Promise.resolve();
      }
      if (current && current.call.id !== join.call.id) {
        setNotice('Leave the current call before joining another.');
        return;
      }

      setDismissedCallIds((ids) => {
        if (!ids.has(join.call.id)) return ids;
        const next = new Set(ids);
        next.delete(join.call.id);
        return next;
      });
      setLiveCalls((calls) => upsertLiveCall(calls, join.call, me, currentChannels()));
      const room = new Room();
      roomRef.current = room;
      setRoomHandlers(room);
      setIncomingCall((call) => (call?.id === join.call.id ? null : call));
      setNotice(null);
      setActiveCall({
        call: join.call,
        phase: 'connecting',
        participants: participantsFor(join.call, me, currentChannels()),
        remoteAudioTracks: [],
        activeSpeakerIds: new Set(),
        muted: false,
        error: null,
      });

      const work = (async () => {
        try {
          await room.connect(join.url, join.token);
          await room.localParticipant.setMicrophoneEnabled(true, AUDIO_CAPTURE_OPTIONS);
          for (const participant of room.remoteParticipants.values()) {
            updateActiveCall((active) => ({
              ...active,
              participants: upsertIdentityParticipant(active, participant.identity, me, currentChannels()),
            }));
            for (const publication of participant.trackPublications.values()) {
              const track = publication.track;
              if (track && track.kind === Track.Kind.Audio) {
                addRemoteAudioTrack(track, publication, participant);
              }
            }
          }
          updateActiveCall((active) => ({
            ...active,
            phase: 'connected',
            muted: !room.localParticipant.isMicrophoneEnabled,
          }));
        } catch (err) {
          clearRoom();
          connectPromiseRef.current = null;
          setActiveCall(null);
          setNotice("Couldn't connect to the call.");
          void api.leaveCall(join.call.id).catch(() => {});
          throw err;
        }
      })();

      connectPromiseRef.current = work.finally(() => {
        connectPromiseRef.current = null;
      });
      return connectPromiseRef.current;
    },
    [addRemoteAudioTrack, clearRoom, me, setRoomHandlers, updateActiveCall],
  );

  const refreshActiveCalls = useCallback(async () => {
    try {
      const snapshot = await api.activeCalls();
      const refreshed = normalizeLiveCalls(snapshot.calls, me, currentChannels());
      const refreshedIds = new Set(refreshed.map((call) => call.id));

      setLiveCalls(refreshed);
      setDismissedCallIds((ids) => {
        const next = new Set([...ids].filter((id) => refreshedIds.has(id)));
        return next.size === ids.size ? ids : next;
      });
      setIncomingCall((call) => {
        if (!call) return call;
        const next = refreshed.find((candidate) => candidate.id === call.id);
        if (
          !next ||
          next.status !== 'ringing' ||
          next.initiatorId === me.id ||
          dismissedCallIdsRef.current.has(next.id)
        ) {
          return null;
        }
        return next;
      });

      const current = activeCallRef.current;
      if (!current) return;
      const next = refreshed.find((call) => call.id === current.call.id);
      if (!next) {
        clearRoom();
        setActiveCall(null);
        return;
      }
      setActiveCall((active) =>
        active?.call.id === next.id
          ? {
              ...active,
              call: next,
              participants: participantsFor(next, me, currentChannels()),
            }
          : active,
      );
    } catch (err) {
      if (callUnavailable(err)) {
        setNotice("Calls aren't available.");
      } else {
        setNotice("Couldn't refresh active calls.");
      }
    }
  }, [clearRoom, me]);

  const liveCallForChannel = useCallback(
    (channelId: string): CallWire | null =>
      liveCalls.find((call) => call.channelId === channelId && isLiveCall(call) && !dismissedCallIds.has(call.id)) ??
      null,
    [dismissedCallIds, liveCalls],
  );

  const handleCallEvent = useCallback(
    (event: CallEvent) => {
      if (event.type === 'call.ringing') {
        const nextCall = normalizeCall(event.call, me, currentChannels());
        setLiveCalls((calls) => upsertLiveCall(calls, nextCall, me, currentChannels()));
        if (nextCall.initiatorId !== me.id && !activeCallRef.current && !dismissedCallIdsRef.current.has(nextCall.id)) {
          setIncomingCall(nextCall);
        }
        setActiveCall((current) =>
          current?.call.id === nextCall.id
            ? {
                ...current,
                call: nextCall,
                participants: participantsFor(nextCall, me, currentChannels()),
              }
            : current,
        );
        return;
      }

      if (event.type === 'call.accepted' || event.type === 'call.participant_joined') {
        if (event.user.id === me.id) {
          setDismissedCallIds((ids) => {
            if (!ids.has(event.callId)) return ids;
            const next = new Set(ids);
            next.delete(event.callId);
            return next;
          });
        }
        setIncomingCall((call) => (call?.id === event.callId ? null : call));
        setLiveCalls((calls) =>
          updateLiveCall(
            calls,
            event.callId,
            (call) => ({
              ...call,
              status: 'active',
              participants: upsertUser(call.participants, event.user),
            }),
            me,
            currentChannels(),
          ),
        );
        setActiveCall((current) =>
          current?.call.id === event.callId
            ? {
                ...current,
                call: { ...current.call, status: 'active' },
                participants: upsertUser(current.participants, event.user),
              }
            : current,
        );
        return;
      }

      if (event.type === 'call.declined') {
        setIncomingCall((call) => (call?.id === event.callId && event.userId === me.id ? null : call));
        if (event.userId === me.id) {
          setDismissedCallIds((ids) => new Set(ids).add(event.callId));
        }
        return;
      }

      if (event.type === 'call.participant_left') {
        setLiveCalls((calls) =>
          updateLiveCall(
            calls,
            event.callId,
            (call) => ({
              ...call,
              participants: removeUser(call.participants, event.userId),
            }),
            me,
            currentChannels(),
          ),
        );
        setActiveCall((current) =>
          current?.call.id === event.callId
            ? {
                ...current,
                participants: removeUser(current.participants, event.userId),
                activeSpeakerIds: new Set([...current.activeSpeakerIds].filter((id) => id !== event.userId)),
                remoteAudioTracks: current.remoteAudioTracks.filter((t) => !t.key.startsWith(`${event.userId}:`)),
              }
            : current,
        );
        return;
      }

      if (event.type === 'call.ended') {
        setIncomingCall((call) => (call?.id === event.callId ? null : call));
        setLiveCalls((calls) => calls.filter((call) => call.id !== event.callId));
        setDismissedCallIds((ids) => {
          if (!ids.has(event.callId)) return ids;
          const next = new Set(ids);
          next.delete(event.callId);
          return next;
        });
        if (activeCallRef.current?.call.id === event.callId) {
          clearRoom();
          setActiveCall(null);
        }
      }
    },
    [clearRoom, me],
  );

  const startCall = useCallback(
    async (channelId: string) => {
      if (starting || activeCallRef.current) return;
      setStarting(true);
      setNotice(null);
      try {
        const join = await api.startCall(channelId);
        await connectToCall(join);
      } catch (err) {
        if (callUnavailable(err)) {
          setNotice("Calls aren't available.");
        } else {
          setNotice("Couldn't start the call.");
        }
      } finally {
        setStarting(false);
      }
    },
    [connectToCall, starting],
  );

  const joinCall = useCallback(
    async (callId: string) => {
      if (answering) return;
      const current = activeCallRef.current;
      if (current?.call.id === callId && (roomRef.current || connectPromiseRef.current)) {
        return connectPromiseRef.current ?? Promise.resolve();
      }
      if (current && current.call.id !== callId) {
        setNotice('Leave the current call before joining another.');
        return;
      }
      setAnswering(true);
      setNotice(null);
      try {
        const join = await api.acceptCall(callId);
        await connectToCall(join);
      } catch (err) {
        if (callUnavailable(err)) {
          setNotice("Calls aren't available.");
        } else {
          setNotice("Couldn't join the call.");
        }
      } finally {
        setAnswering(false);
      }
    },
    [answering, connectToCall],
  );

  const acceptIncomingCall = useCallback(async () => {
    const call = incomingCall;
    if (!call) return;
    await joinCall(call.id);
  }, [incomingCall, joinCall]);

  const declineCall = useCallback(async (callId: string) => {
    setIncomingCall((call) => (call?.id === callId ? null : call));
    setDismissedCallIds((ids) => new Set(ids).add(callId));
    try {
      await api.declineCall(callId);
    } catch {
      setNotice("Couldn't decline the call.");
    }
  }, []);

  const declineIncomingCall = useCallback(async () => {
    const call = incomingCall;
    if (!call) return;
    await declineCall(call.id);
  }, [declineCall, incomingCall]);

  const toggleMute = useCallback(async () => {
    const room = roomRef.current;
    const current = activeCallRef.current;
    if (!room || !current || current.phase === 'ended') return;
    const nextMuted = !current.muted;
    try {
      await room.localParticipant.setMicrophoneEnabled(!nextMuted, AUDIO_CAPTURE_OPTIONS);
      updateActiveCall((active) => ({ ...active, muted: nextMuted }));
    } catch {
      // Re-sync the UI to the real mic state — the toggle may not have applied.
      updateActiveCall((active) => ({
        ...active,
        muted: !room.localParticipant.isMicrophoneEnabled,
      }));
      setNotice("Couldn't update microphone state.");
    }
  }, [updateActiveCall]);

  const leaveActiveCall = useCallback(async () => {
    const current = activeCallRef.current;
    if (!current) return;
    const callId = current.call.id;
    clearRoom();
    setActiveCall(null);
    setLiveCalls((calls) =>
      updateLiveCall(
        calls,
        callId,
        (call) => ({ ...call, participants: removeUser(call.participants, me.id) }),
        me,
        currentChannels(),
      ),
    );
    try {
      await api.leaveCall(callId);
    } catch {
      setNotice("Couldn't leave the call cleanly.");
    }
  }, [clearRoom, me]);

  const activeCallId = activeCall?.call.id ?? null;
  const activeCallStatus = activeCall?.call.status ?? null;
  const activeRemoteCount = activeCall
    ? activeCall.participants.filter((participant) => participant.id !== me.id).length
    : 0;

  useEffect(() => {
    if (!activeCallId) return;

    const leaveOnPageHide = () => {
      const options = desktopApiOptions();
      const base = (options?.baseUrl ?? '').replace(/\/+$/, '');
      const token = options?.getToken?.() ?? null;
      const url = `${base}${callLeavePath(activeCallId)}`;
      const body = '{}';

      if (!token && typeof navigator.sendBeacon === 'function') {
        const payload = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(url, payload)) return;
      }

      void fetch(url, {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        body,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      }).catch(() => {});
    };

    window.addEventListener('pagehide', leaveOnPageHide);
    return () => window.removeEventListener('pagehide', leaveOnPageHide);
  }, [activeCallId]);

  useEffect(() => {
    if (!activeCallId || activeCallStatus !== 'ringing' || activeRemoteCount !== 0) return;

    const timeout = window.setTimeout(() => {
      const current = activeCallRef.current;
      const remoteCount = current ? current.participants.filter((participant) => participant.id !== me.id).length : 0;
      if (current?.call.id !== activeCallId || current.call.status !== 'ringing' || remoteCount !== 0) {
        return;
      }
      setNotice('No answer.');
      void leaveActiveCall();
    }, RING_TIMEOUT_MS);

    return () => window.clearTimeout(timeout);
  }, [activeCallId, activeCallStatus, activeRemoteCount, leaveActiveCall, me.id]);

  useEffect(() => () => clearRoom(), [clearRoom]);

  return {
    incomingCall,
    liveCalls,
    activeCall,
    notice,
    starting,
    answering,
    handleCallEvent,
    liveCallForChannel,
    refreshActiveCalls,
    startCall,
    joinCall,
    acceptIncomingCall,
    declineCall,
    declineIncomingCall,
    toggleMute,
    leaveActiveCall,
    clearNotice: () => setNotice(null),
  };
}
