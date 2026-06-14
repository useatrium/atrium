import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioSession } from '@livekit/react-native';
import {
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
} from 'livekit-client';
import {
  addCallAnsweredListener,
  addCallEndedListener,
  addCallSessionAddedListener,
  addCallSessionUpdatedListener,
  addSetMutedActionListener,
  answerCall,
  endCall,
  failIncomingCallConnected,
  fulfillIncomingCallConnected,
  getActiveCallSession,
  prepareAudioSessionForCall,
  reportCallEnded,
  reportIncomingCall,
  reportOutgoingCallConnected,
  restoreAudioSession,
  setMuted as setNativeMuted,
  startOutgoingCall,
  type CallSession,
  type IncomingCallEvent,
} from 'expo-callkit-telecom';
import {
  ApiError,
  channelLabel,
  type Api,
  type CallEvent,
  type CallJoin,
  type CallWire,
  type Channel,
  type UserRef,
} from '@atrium/surface-client';

export interface ActiveCallState {
  call: CallWire;
  phase: 'connecting' | 'connected' | 'ended';
  participants: UserRef[];
  activeSpeakerIds: Set<string>;
  muted: boolean;
  error: string | null;
  nativeCallId?: string;
}

const AUDIO_CAPTURE_OPTIONS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

function userFromIdentity(identity: string): UserRef {
  return { id: identity, handle: identity, displayName: identity };
}

function fallbackUser(id: string): UserRef {
  return { id, handle: id, displayName: id };
}

function upsertUser(users: UserRef[], user: UserRef): UserRef[] {
  return users.some((u) => u.id === user.id) ? users : [...users, user];
}

function removeUser(users: UserRef[], userId: string): UserRef[] {
  return users.filter((u) => u.id !== userId);
}

function participantsFor(call: CallWire, me: UserRef): UserRef[] {
  return call.participants.some((u) => u.id === me.id)
    ? call.participants
    : [me, ...call.participants];
}

function callUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503 && err.code === 'calls_unconfigured';
}

function userForCall(call: CallWire, channels: Channel[], userId: string): UserRef {
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

function incomingCallEventFor(call: CallWire, caller: UserRef, channelName: string): IncomingCallEvent {
  return {
    eventId: call.id,
    serverCallId: call.id,
    hasVideo: false,
    startedAt: call.startedAt,
    caller: {
      id: caller.id,
      displayName: caller.displayName || caller.handle || caller.id,
    },
    metadata: {
      channelId: call.channelId,
      channelName,
      room: `call:${call.id}`,
    },
  };
}

function serverCallIdFromSession(session: CallSession | null | undefined): string | null {
  return session?.incomingCallEvent?.serverCallId ?? null;
}

export function useCall({
  api,
  me,
  channels,
}: {
  api: Api;
  me: UserRef;
  channels: Channel[];
}) {
  const [incomingCall, setIncomingCall] = useState<CallWire | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCallState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [answering, setAnswering] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const activeCallRef = useRef<ActiveCallState | null>(null);
  const incomingCallRef = useRef<CallWire | null>(null);
  const channelsRef = useRef(channels);
  const connectPromiseRef = useRef<Promise<void> | null>(null);
  const detachRoomHandlersRef = useRef<(() => void) | null>(null);
  const intentionalDisconnectRef = useRef(false);
  const nativeIdByCallIdRef = useRef<Record<string, string>>({});
  const callIdByNativeIdRef = useRef<Record<string, string>>({});
  const nativeEndRequestedRef = useRef<Set<string>>(new Set());
  const answeredNativeRequestsRef = useRef<Set<string>>(new Set());

  activeCallRef.current = activeCall;
  incomingCallRef.current = incomingCall;
  channelsRef.current = channels;

  const rememberNativeSession = useCallback((session: CallSession | null | undefined) => {
    const callId = serverCallIdFromSession(session);
    if (!session || !callId) return;
    nativeIdByCallIdRef.current[callId] = session.id;
    callIdByNativeIdRef.current[session.id] = callId;
  }, []);

  const nativeIdForCall = useCallback((callId: string): string | undefined => {
    return nativeIdByCallIdRef.current[callId];
  }, []);

  const clearNativeMapping = useCallback((callId: string) => {
    const nativeId = nativeIdByCallIdRef.current[callId];
    if (nativeId) delete callIdByNativeIdRef.current[nativeId];
    delete nativeIdByCallIdRef.current[callId];
  }, []);

  const updateActiveCall = useCallback((fn: (current: ActiveCallState) => ActiveCallState) => {
    setActiveCall((current) => (current ? fn(current) : current));
  }, []);

  const clearRoom = useCallback(() => {
    intentionalDisconnectRef.current = true;
    detachRoomHandlersRef.current?.();
    detachRoomHandlersRef.current = null;
    const room = roomRef.current;
    roomRef.current = null;
    void AudioSession.stopAudioSession().catch(() => {});
    restoreAudioSession();
    if (room && room.state !== 'disconnected') {
      void room.disconnect().finally(() => {
        intentionalDisconnectRef.current = false;
      });
    } else {
      intentionalDisconnectRef.current = false;
    }
  }, []);

  const reportNativeEnded = useCallback(
    (callId: string, reason: 'remoteEnded' | 'failed' | 'declinedElsewhere' | 'unanswered') => {
      const nativeId = nativeIdForCall(callId);
      if (!nativeId) return;
      void reportCallEnded(nativeId, reason).catch(() => {});
      clearNativeMapping(callId);
    },
    [clearNativeMapping, nativeIdForCall],
  );

  const setRoomHandlers = useCallback(
    (room: Room) => {
      const onParticipantConnected = (participant: RemoteParticipant) => {
        updateActiveCall((current) => ({
          ...current,
          participants: upsertUser(current.participants, userFromIdentity(participant.identity)),
        }));
      };
      const onParticipantDisconnected = (participant: RemoteParticipant) => {
        updateActiveCall((current) => ({
          ...current,
          participants: removeUser(current.participants, participant.identity),
          activeSpeakerIds: new Set(
            [...current.activeSpeakerIds].filter((id) => id !== participant.identity),
          ),
        }));
      };
      const onActiveSpeakersChanged = (speakers: Participant[]) => {
        updateActiveCall((current) => ({
          ...current,
          activeSpeakerIds: new Set(speakers.map((speaker) => speaker.identity)),
        }));
      };
      const onDisconnected = () => {
        detachRoomHandlersRef.current?.();
        detachRoomHandlersRef.current = null;
        roomRef.current = null;
        connectPromiseRef.current = null;
        void AudioSession.stopAudioSession().catch(() => {});
        restoreAudioSession();
        if (intentionalDisconnectRef.current) return;
        updateActiveCall((current) => ({
          ...current,
          phase: 'ended',
          error: 'Call disconnected.',
        }));
      };

      room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
      room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      room.on(RoomEvent.ActiveSpeakersChanged, onActiveSpeakersChanged);
      room.on(RoomEvent.Disconnected, onDisconnected);

      detachRoomHandlersRef.current = () => {
        room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
        room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
        room.off(RoomEvent.ActiveSpeakersChanged, onActiveSpeakersChanged);
        room.off(RoomEvent.Disconnected, onDisconnected);
      };
    },
    [updateActiveCall],
  );

  const applyNativeMute = useCallback(
    async (nativeCallId: string | undefined, muted: boolean) => {
      const room = roomRef.current;
      if (!room) return;
      await room.localParticipant.setMicrophoneEnabled(!muted, AUDIO_CAPTURE_OPTIONS);
      updateActiveCall((active) => ({ ...active, muted }));
      if (nativeCallId) void setNativeMuted(nativeCallId, muted).catch(() => {});
    },
    [updateActiveCall],
  );

  const connectToCall = useCallback(
    async (
      join: CallJoin,
      native?: { id: string; incomingRequestId?: string; outgoing?: boolean },
    ) => {
      const current = activeCallRef.current;
      if (current?.call.id === join.call.id && (roomRef.current || connectPromiseRef.current)) {
        return connectPromiseRef.current ?? Promise.resolve();
      }
      if (current && current.call.id !== join.call.id) {
        setNotice('Leave the current call before joining another.');
        return;
      }

      if (native?.id) {
        nativeIdByCallIdRef.current[join.call.id] = native.id;
        callIdByNativeIdRef.current[native.id] = join.call.id;
      }

      prepareAudioSessionForCall(false);
      const room = new Room();
      roomRef.current = room;
      setRoomHandlers(room);
      setIncomingCall((call) => (call?.id === join.call.id ? null : call));
      setNotice(null);
      setActiveCall({
        call: join.call,
        phase: 'connecting',
        participants: participantsFor(join.call, me),
        activeSpeakerIds: new Set(),
        muted: false,
        error: null,
        nativeCallId: native?.id,
      });

      const work = (async () => {
        try {
          await AudioSession.startAudioSession();
          await room.connect(join.url, join.token);
          await room.localParticipant.setMicrophoneEnabled(true, AUDIO_CAPTURE_OPTIONS);
          for (const participant of room.remoteParticipants.values()) {
            updateActiveCall((active) => ({
              ...active,
              participants: upsertUser(active.participants, userFromIdentity(participant.identity)),
            }));
            for (const publication of participant.trackPublications.values()) {
              const track = publication.track;
              if (track?.kind === Track.Kind.Audio) {
                void publication.setSubscribed(true);
              }
            }
          }
          updateActiveCall((active) => ({
            ...active,
            phase: 'connected',
            muted: !room.localParticipant.isMicrophoneEnabled,
          }));
          if (native?.incomingRequestId) {
            await fulfillIncomingCallConnected(native.incomingRequestId);
          } else if (native?.outgoing && native.id) {
            await reportOutgoingCallConnected(native.id);
          }
        } catch (err) {
          clearRoom();
          connectPromiseRef.current = null;
          setActiveCall(null);
          setNotice("Couldn't connect to the call.");
          if (native?.incomingRequestId && native.id) {
            await failIncomingCallConnected(native.id, native.incomingRequestId).catch(() => {});
          } else if (native?.id) {
            await reportCallEnded(native.id, 'failed').catch(() => {});
          }
          clearNativeMapping(join.call.id);
          void api.leaveCall(join.call.id).catch(() => {});
          throw err;
        }
      })();

      connectPromiseRef.current = work.finally(() => {
        connectPromiseRef.current = null;
      });
      return connectPromiseRef.current;
    },
    [api, clearNativeMapping, clearRoom, me, setRoomHandlers, updateActiveCall],
  );

  const reportIncomingToNative = useCallback(
    (call: CallWire) => {
      if (call.initiatorId === me.id || nativeIdByCallIdRef.current[call.id]) return;
      const caller = userForCall(call, channelsRef.current, call.initiatorId);
      const channelName = labelForCallChannel(call, channelsRef.current, me.id);
      void reportIncomingCall(incomingCallEventFor(call, caller, channelName))
        .then(async () => {
          const session = await getActiveCallSession().catch(() => null);
          rememberNativeSession(session);
        })
        .catch((err: unknown) => {
          console.warn('[calls] failed to report incoming call to native UI', err);
        });
    },
    [me.id, rememberNativeSession],
  );

  const acceptCallById = useCallback(
    async (
      callId: string,
      native?: { id: string; requestId?: string },
    ): Promise<void> => {
      if ((answering && !native?.requestId) || answeredNativeRequestsRef.current.has(native?.requestId ?? '')) {
        return;
      }
      if (native?.requestId) answeredNativeRequestsRef.current.add(native.requestId);
      setAnswering(true);
      setNotice(null);
      try {
        const join = await api.acceptCall(callId);
        await connectToCall(join, native?.id ? { id: native.id, incomingRequestId: native.requestId } : undefined);
      } catch (err) {
        if (callUnavailable(err)) {
          setNotice("Calls aren't available.");
        } else {
          setNotice("Couldn't join the call.");
        }
        if (native?.id && native.requestId) {
          await failIncomingCallConnected(native.id, native.requestId).catch(() => {});
        }
      } finally {
        setAnswering(false);
      }
    },
    [api, answering, connectToCall],
  );

  const handleCallEvent = useCallback(
    (event: CallEvent) => {
      if (event.type === 'call.ringing') {
        if (event.call.initiatorId !== me.id && !activeCallRef.current) {
          setIncomingCall(event.call);
          reportIncomingToNative(event.call);
        }
        setActiveCall((current) =>
          current?.call.id === event.call.id
            ? {
                ...current,
                call: event.call,
                participants: participantsFor(event.call, me),
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
        if (event.userId === me.id) reportNativeEnded(event.callId, 'declinedElsewhere');
        return;
      }

      if (event.type === 'call.participant_left') {
        setActiveCall((current) => {
          if (current?.call.id !== event.callId) return current;
          const participants = removeUser(current.participants, event.userId);
          const remoteCount = participants.filter((p) => p.id !== me.id).length;
          if (current.call.status === 'active' && remoteCount === 0) {
            reportNativeEnded(event.callId, 'remoteEnded');
          }
          return {
            ...current,
            participants,
            activeSpeakerIds: new Set(
              [...current.activeSpeakerIds].filter((id) => id !== event.userId),
            ),
          };
        });
        return;
      }

      if (event.type === 'call.ended') {
        setIncomingCall((call) => (call?.id === event.callId ? null : call));
        reportNativeEnded(event.callId, 'remoteEnded');
        if (activeCallRef.current?.call.id === event.callId) {
          clearRoom();
          setActiveCall(null);
        }
      }
    },
    [clearRoom, me, reportIncomingToNative, reportNativeEnded],
  );

  const startCall = useCallback(
    async (channelId: string) => {
      if (starting || activeCallRef.current) return;
      setStarting(true);
      setNotice(null);
      try {
        const join = await api.startCall(channelId);
        let nativeCallId: string | undefined;
        const channelName = labelForCallChannel(join.call, channelsRef.current, me.id);
        try {
          nativeCallId = await startOutgoingCall(
            { id: join.call.channelId, displayName: channelName },
            { hasVideo: false },
          );
          nativeIdByCallIdRef.current[join.call.id] = nativeCallId;
          callIdByNativeIdRef.current[nativeCallId] = join.call.id;
        } catch (err) {
          console.warn('[calls] failed to start native outgoing call', err);
        }
        await connectToCall(
          join,
          nativeCallId ? { id: nativeCallId, outgoing: true } : undefined,
        );
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
    [api, connectToCall, me.id, starting],
  );

  const acceptIncomingCall = useCallback(async () => {
    const call = incomingCallRef.current;
    if (!call || answering) return;
    const nativeId = nativeIdForCall(call.id);
    if (nativeId) {
      setAnswering(true);
      try {
        await answerCall(nativeId);
      } catch {
        setAnswering(false);
        await acceptCallById(call.id);
      }
      return;
    }
    await acceptCallById(call.id);
  }, [acceptCallById, answering, nativeIdForCall]);

  const declineIncomingCall = useCallback(async () => {
    const call = incomingCallRef.current;
    if (!call) return;
    setIncomingCall(null);
    const nativeId = nativeIdForCall(call.id);
    if (nativeId) {
      nativeEndRequestedRef.current.add(nativeId);
      void endCall(nativeId).catch(() => {});
      clearNativeMapping(call.id);
    }
    try {
      await api.declineCall(call.id);
    } catch {
      setNotice("Couldn't decline the call.");
    }
  }, [api, clearNativeMapping, nativeIdForCall]);

  const toggleMute = useCallback(async () => {
    const current = activeCallRef.current;
    if (!current || current.phase === 'ended') return;
    const nextMuted = !current.muted;
    try {
      await applyNativeMute(current.nativeCallId, nextMuted);
    } catch {
      const room = roomRef.current;
      updateActiveCall((active) => ({
        ...active,
        muted: room ? !room.localParticipant.isMicrophoneEnabled : active.muted,
      }));
      setNotice("Couldn't update microphone state.");
    }
  }, [applyNativeMute, updateActiveCall]);

  const leaveActiveCall = useCallback(async () => {
    const current = activeCallRef.current;
    if (!current) return;
    const callId = current.call.id;
    if (current.nativeCallId) {
      nativeEndRequestedRef.current.add(current.nativeCallId);
      void endCall(current.nativeCallId).catch(() => {});
      clearNativeMapping(callId);
    }
    clearRoom();
    setActiveCall(null);
    try {
      await api.leaveCall(callId);
    } catch {
      setNotice("Couldn't leave the call cleanly.");
    }
  }, [api, clearNativeMapping, clearRoom]);

  useEffect(() => {
    const added = addCallSessionAddedListener((event) => rememberNativeSession(event.session));
    const updated = addCallSessionUpdatedListener((event) => rememberNativeSession(event.session));
    const answered = addCallAnsweredListener((event) => {
      void (async () => {
        let callId = callIdByNativeIdRef.current[event.id];
        if (!callId) {
          const session = await getActiveCallSession().catch(() => null);
          rememberNativeSession(session);
          callId = callIdByNativeIdRef.current[event.id] ?? serverCallIdFromSession(session) ?? '';
        }
        if (!callId) {
          await failIncomingCallConnected(event.id, event.requestId).catch(() => {});
          return;
        }
        await acceptCallById(callId, { id: event.id, requestId: event.requestId });
      })();
    });
    const ended = addCallEndedListener((event) => {
      const callId = callIdByNativeIdRef.current[event.id];
      if (!callId) return;
      clearNativeMapping(callId);
      if (nativeEndRequestedRef.current.delete(event.id)) return;
      if (activeCallRef.current?.call.id === callId) {
        clearRoom();
        setActiveCall(null);
        void api.leaveCall(callId).catch(() => {});
      } else {
        setIncomingCall((call) => (call?.id === callId ? null : call));
        void api.declineCall(callId).catch(() => {});
      }
    });
    const muted = addSetMutedActionListener((event) => {
      void applyNativeMute(event.id, event.isMuted).catch(() => {});
    });
    void getActiveCallSession()
      .then((session) => rememberNativeSession(session))
      .catch(() => {});
    return () => {
      added.remove();
      updated.remove();
      answered.remove();
      ended.remove();
      muted.remove();
    };
  }, [acceptCallById, api, applyNativeMute, clearNativeMapping, clearRoom, rememberNativeSession]);

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
