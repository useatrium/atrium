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

function fallbackUser(identity: string): UserRef {
  return { id: identity, handle: identity, displayName: identity };
}

function isFallbackUser(user: UserRef): boolean {
  return user.handle === user.id && user.displayName === user.id;
}

function mergeUser(existing: UserRef, next: UserRef): UserRef {
  if (isFallbackUser(next) && !isFallbackUser(existing)) return existing;
  if (
    existing.handle === next.handle &&
    existing.displayName === next.displayName &&
    existing.id === next.id
  ) {
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
  const candidates = [channelMember, callParticipant, knownUser].filter(
    (user): user is UserRef => user != null,
  );
  return (
    candidates.find((user) => !isFallbackUser(user)) ??
    candidates[0] ??
    fallbackUser(identity)
  );
}

function enrichParticipants(
  users: UserRef[],
  call: CallWire,
  me: UserRef,
  channels: Channel[],
): UserRef[] {
  return dedupeUsers(users.map((user) => userFromIdentity(user.id, call, me, channels, users)));
}

function participantsFor(call: CallWire, me: UserRef, channels: Channel[]): UserRef[] {
  const participants = call.participants.some((u) => u.id === me.id)
    ? call.participants
    : [me, ...call.participants];
  return enrichParticipants(participants, call, me, channels);
}

function upsertIdentityParticipant(
  current: ActiveCallState,
  identity: string,
  me: UserRef,
  channels: Channel[],
): UserRef[] {
  return upsertUser(
    current.participants,
    userFromIdentity(identity, current.call, me, channels, current.participants),
  );
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
  const [activeCall, setActiveCall] = useState<ActiveCallState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [answering, setAnswering] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const activeCallRef = useRef<ActiveCallState | null>(null);
  const connectPromiseRef = useRef<Promise<void> | null>(null);
  const detachRoomHandlersRef = useRef<(() => void) | null>(null);
  const intentionalDisconnectRef = useRef(false);

  activeCallRef.current = activeCall;

  useEffect(() => {
    setActiveCall((current) =>
      current
        ? {
            ...current,
            participants: enrichParticipants(
              current.participants,
              current.call,
              me,
              channels,
            ),
          }
        : current,
    );
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
          participants: upsertIdentityParticipant(
            current,
            participant.identity,
            me,
            currentChannels(),
          ),
        }));
      };
      const onParticipantDisconnected = (participant: RemoteParticipant) => {
        updateActiveCall((current) => ({
          ...current,
          participants: removeUser(current.participants, participant.identity),
          activeSpeakerIds: new Set(
            [...current.activeSpeakerIds].filter((id) => id !== participant.identity),
          ),
          remoteAudioTracks: current.remoteAudioTracks.filter(
            (t) => !t.key.startsWith(`${participant.identity}:`),
          ),
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
        updateActiveCall((current) => ({
          ...current,
          phase: 'ended',
          remoteAudioTracks: [],
          error: 'Call disconnected.',
        }));
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
              participants: upsertIdentityParticipant(
                active,
                participant.identity,
                me,
                currentChannels(),
              ),
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

  const handleCallEvent = useCallback(
    (event: CallEvent) => {
      if (event.type === 'call.ringing') {
        if (event.call.initiatorId !== me.id && !activeCallRef.current) {
          setIncomingCall(event.call);
        }
        setActiveCall((current) =>
          current?.call.id === event.call.id
            ? {
                ...current,
                call: event.call,
                participants: participantsFor(event.call, me, currentChannels()),
              }
            : current,
        );
        return;
      }

      if (event.type === 'call.accepted' || event.type === 'call.participant_joined') {
        setIncomingCall((call) =>
          call?.id === event.callId && event.user.id === me.id ? null : call,
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
        setIncomingCall((call) =>
          call?.id === event.callId && event.userId === me.id ? null : call,
        );
        return;
      }

      if (event.type === 'call.participant_left') {
        setActiveCall((current) =>
          current?.call.id === event.callId
            ? {
                ...current,
                participants: removeUser(current.participants, event.userId),
                activeSpeakerIds: new Set(
                  [...current.activeSpeakerIds].filter((id) => id !== event.userId),
                ),
                remoteAudioTracks: current.remoteAudioTracks.filter(
                  (t) => !t.key.startsWith(`${event.userId}:`),
                ),
              }
            : current,
        );
        return;
      }

      if (event.type === 'call.ended') {
        setIncomingCall((call) => (call?.id === event.callId ? null : call));
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

  const acceptIncomingCall = useCallback(async () => {
    const call = incomingCall;
    if (!call || answering) return;
    setAnswering(true);
    setNotice(null);
    try {
      const join = await api.acceptCall(call.id);
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
  }, [answering, connectToCall, incomingCall]);

  const declineIncomingCall = useCallback(async () => {
    const call = incomingCall;
    if (!call) return;
    setIncomingCall(null);
    try {
      await api.declineCall(call.id);
    } catch {
      setNotice("Couldn't decline the call.");
    }
  }, [incomingCall]);

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
    try {
      await api.leaveCall(callId);
    } catch {
      setNotice("Couldn't leave the call cleanly.");
    }
  }, [clearRoom]);

  useEffect(() => () => clearRoom(), [clearRoom]);

  return {
    incomingCall,
    activeCall,
    notice,
    starting,
    answering,
    handleCallEvent,
    startCall,
    acceptIncomingCall,
    declineIncomingCall,
    toggleMute,
    leaveActiveCall,
    clearNotice: () => setNotice(null),
  };
}
