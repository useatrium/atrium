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
import {
  AUDIO_CAPTURE_OPTIONS,
  type BaseActiveCallState,
  CALL_ORDER_ASC,
  CALL_RING_TTL_MS,
  type CallContext,
  type CallEvent,
  callEventReducer,
  type CallJoin,
  type CallListContext,
  type CallWire,
  enrichParticipants,
  isLiveCall,
  normalizeLiveCalls,
  removeUser,
  updateLiveCall,
  upsertLiveCall,
  upsertUser,
  type UserRef,
  userFromIdentity,
  WEB_CALL_POLICY,
  withSelf,
} from '@atrium/surface-client';
import { ApiError, api, type Channel } from './api';
import { desktopApiOptions } from './desktop';

export interface RemoteAudioTrackRef {
  key: string;
  track: RemoteTrack;
}

// Web adds its autoplay-attachment slice (`remoteAudioTracks`) to the shared
// six-field base; the shared reducer preserves it untouched.
export interface ActiveCallState extends BaseActiveCallState {
  remoteAudioTracks: RemoteAudioTrackRef[];
}

function callLeavePath(callId: string): string {
  return `/api/calls/${encodeURIComponent(callId)}/leave`;
}

function callUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503 && err.code === 'calls_unconfigured';
}

export function useCall(me: UserRef, channels: Channel[]) {
  const channelsRef = useRef(channels);

  channelsRef.current = channels;

  // Live channels + `me` drive the enrichment the web UI wants. Built fresh per
  // call so the reducer/helpers always see the current channel roster.
  const listContext = useCallback(
    (): CallListContext => ({
      order: CALL_ORDER_ASC,
      normalizeCall: (call) => ({
        ...call,
        participants: enrichParticipants(call.participants, call, me, channelsRef.current),
      }),
    }),
    [me],
  );
  const participantsForCall = useCallback(
    (call: CallWire): UserRef[] => enrichParticipants(withSelf(call, me), call, me, channelsRef.current),
    [me],
  );
  const buildContext = useCallback(
    (): CallContext => ({ me, list: listContext(), participantsFor: participantsForCall, policy: WEB_CALL_POLICY }),
    [listContext, me, participantsForCall],
  );

  const [incomingCall, setIncomingCall] = useState<CallWire | null>(null);
  const [liveCalls, setLiveCalls] = useState<CallWire[]>([]);
  const [dismissedCallIds, setDismissedCallIds] = useState<Set<string>>(() => new Set());
  const [activeCall, setActiveCall] = useState<ActiveCallState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [answering, setAnswering] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const activeCallRef = useRef<ActiveCallState | null>(null);
  const incomingCallRef = useRef<CallWire | null>(null);
  const liveCallsRef = useRef<CallWire[]>([]);
  const dismissedCallIdsRef = useRef(dismissedCallIds);
  const connectPromiseRef = useRef<Promise<void> | null>(null);
  const detachRoomHandlersRef = useRef<(() => void) | null>(null);
  const intentionalDisconnectRef = useRef(false);

  activeCallRef.current = activeCall;
  incomingCallRef.current = incomingCall;
  liveCallsRef.current = liveCalls;
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
    setIncomingCall((current) => (current ? listContext().normalizeCall(current) : current));
    setLiveCalls((current) => normalizeLiveCalls(current, listContext()));
  }, [channels, me, listContext]);

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
          participants: upsertUser(
            current.participants,
            userFromIdentity(participant.identity, current.call, me, channelsRef.current, current.participants),
          ),
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
          participants: speakerIds.reduce(
            (participants, id) =>
              upsertUser(participants, userFromIdentity(id, current.call, me, channelsRef.current, participants)),
            current.participants,
          ),
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
      setLiveCalls((calls) => upsertLiveCall(calls, join.call, listContext()));
      const room = new Room();
      roomRef.current = room;
      setRoomHandlers(room);
      setIncomingCall((call) => (call?.id === join.call.id ? null : call));
      setNotice(null);
      setActiveCall({
        call: join.call,
        phase: 'connecting',
        participants: participantsForCall(join.call),
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
              participants: upsertUser(
                active.participants,
                userFromIdentity(participant.identity, active.call, me, channelsRef.current, active.participants),
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
    [addRemoteAudioTrack, clearRoom, listContext, me, participantsForCall, setRoomHandlers, updateActiveCall],
  );

  const refreshActiveCalls = useCallback(async () => {
    try {
      const snapshot = await api.activeCalls();
      const refreshed = normalizeLiveCalls(snapshot.calls, listContext());
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
              participants: participantsForCall(next),
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
  }, [clearRoom, listContext, me, participantsForCall]);

  const liveCallForChannel = useCallback(
    (channelId: string): CallWire | null =>
      liveCalls.find((call) => call.channelId === channelId && isLiveCall(call) && !dismissedCallIds.has(call.id)) ??
      null,
    [dismissedCallIds, liveCalls],
  );

  const handleCallEvent = useCallback(
    (event: CallEvent) => {
      const prev = {
        active: activeCallRef.current,
        incoming: incomingCallRef.current,
        live: liveCallsRef.current,
        dismissed: dismissedCallIdsRef.current,
      };
      const { state: next, effects } = callEventReducer<ActiveCallState>(prev, event, buildContext());

      // Fold web's remoteAudioTracks pruning into the single active update.
      let nextActive = next.active;
      for (const effect of effects) {
        if (effect.kind === 'activeParticipantLeft' && nextActive) {
          nextActive = {
            ...nextActive,
            remoteAudioTracks: nextActive.remoteAudioTracks.filter((t) => !t.key.startsWith(`${effect.userId}:`)),
          };
        }
      }

      // Advance the refs before React renders: a second CallEvent can arrive
      // before the re-render syncs them, and reading stale refs would drop
      // this transition (the old functional-updater form was immune to that).
      activeCallRef.current = nextActive;
      incomingCallRef.current = next.incoming;
      liveCallsRef.current = next.live;
      dismissedCallIdsRef.current = next.dismissed;

      if (nextActive !== prev.active) setActiveCall(nextActive);
      if (next.incoming !== prev.incoming) setIncomingCall(next.incoming);
      if (next.live !== prev.live) setLiveCalls(next.live);
      if (next.dismissed !== prev.dismissed) setDismissedCallIds(next.dismissed);

      for (const effect of effects) {
        // Web only cares about room teardown; reportIncoming/reportEnded are
        // CallKit intents the mobile driver acts on.
        if (effect.kind === 'clearActiveRoom') clearRoom();
      }
    },
    [buildContext, clearRoom],
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
        listContext(),
      ),
    );
    try {
      await api.leaveCall(callId);
    } catch {
      setNotice("Couldn't leave the call cleanly.");
    }
  }, [clearRoom, listContext, me]);

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

    // Unified on the shared server-agreed TTL (60s). Web previously used a 45s
    // local constant that disagreed with the sweeper — see design D4/R5.
    const timeout = window.setTimeout(() => {
      const current = activeCallRef.current;
      const remoteCount = current ? current.participants.filter((participant) => participant.id !== me.id).length : 0;
      if (current?.call.id !== activeCallId || current.call.status !== 'ringing' || remoteCount !== 0) {
        return;
      }
      setNotice('No answer.');
      void leaveActiveCall();
    }, CALL_RING_TTL_MS);

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
