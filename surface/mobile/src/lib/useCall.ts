import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioSession } from '@livekit/react-native';
import { Room, RoomEvent, Track, type Participant, type RemoteParticipant } from 'livekit-client';
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
  CALL_RING_TTL_MS,
  channelLabel,
  type Api,
  type AppState,
  type CallEvent,
  type CallJoin,
  type CallWire,
  type Channel,
  type UserRef,
} from '@atrium/surface-client';
import { NATIVE_CALL_UI } from './nativeCallUi';

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
const CALL_REFRESH_INTERVAL_MS = 45_000;

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
  return call.participants.some((u) => u.id === me.id) ? call.participants : [me, ...call.participants];
}

function sortLiveCalls(calls: CallWire[]): CallWire[] {
  return [...calls]
    .filter((call) => call.status !== 'ended')
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

function upsertLiveCall(calls: CallWire[], call: CallWire): CallWire[] {
  if (call.status === 'ended') return calls.filter((existing) => existing.id !== call.id);
  const index = calls.findIndex((existing) => existing.id === call.id);
  if (index === -1) return sortLiveCalls([call, ...calls]);
  const next = calls.map((existing, i) => (i === index ? call : existing));
  return sortLiveCalls(next);
}

function updateLiveCall(calls: CallWire[], callId: string, update: (call: CallWire) => CallWire): CallWire[] {
  let changed = false;
  const next = calls.map((call) => {
    if (call.id !== callId) return call;
    changed = true;
    return update(call);
  });
  return changed ? sortLiveCalls(next) : calls;
}

function removeLiveCall(calls: CallWire[], callId: string): CallWire[] {
  return calls.filter((call) => call.id !== callId);
}

function ringAgeMs(call: CallWire): number {
  return Date.now() - Date.parse(call.startedAt);
}

function isExpiredRing(call: CallWire): boolean {
  return call.status === 'ringing' && ringAgeMs(call) >= CALL_RING_TTL_MS;
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
  wsStatus,
}: {
  api: Api;
  me: UserRef;
  channels: Channel[];
  wsStatus: AppState['wsStatus'];
}) {
  const [incomingCall, setIncomingCall] = useState<CallWire | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCallState | null>(null);
  const [recoverableCalls, setRecoverableCalls] = useState<CallWire[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [answering, setAnsweringState] = useState(false);
  // Ref mirror so listener-captured callbacks see the live value (not a stale
  // closure) — matches the activeCallRef/incomingCallRef pattern in this hook.
  const answeringRef = useRef(false);
  const setAnswering = useCallback((value: boolean) => {
    answeringRef.current = value;
    setAnsweringState(value);
  }, []);

  const roomRef = useRef<Room | null>(null);
  const activeCallRef = useRef<ActiveCallState | null>(null);
  const incomingCallRef = useRef<CallWire | null>(null);
  const recoverableCallsRef = useRef<CallWire[]>([]);
  const channelsRef = useRef(channels);
  const connectPromiseRef = useRef<Promise<void> | null>(null);
  const detachRoomHandlersRef = useRef<(() => void) | null>(null);
  const intentionalDisconnectRef = useRef(false);
  const nativeIdByCallIdRef = useRef<Record<string, string>>({});
  const callIdByNativeIdRef = useRef<Record<string, string>>({});
  const nativeEndRequestedRef = useRef<Set<string>>(new Set());
  const answeredNativeRequestsRef = useRef<Set<string>>(new Set());
  const nativeIncomingReportPendingRef = useRef<Set<string>>(new Set());
  const nativeIncomingReportedRef = useRef<Set<string>>(new Set());
  const dismissedCallIdsRef = useRef<Set<string>>(new Set());
  const dismissedCallChannelsRef = useRef<Map<string, string>>(new Map());

  activeCallRef.current = activeCall;
  incomingCallRef.current = incomingCall;
  recoverableCallsRef.current = recoverableCalls;
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
    nativeIncomingReportPendingRef.current.delete(callId);
    nativeIncomingReportedRef.current.delete(callId);
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
    // Restore the prior audio session only AFTER deactivation settles, else the
    // CallKit snapshot restores while AVAudioSession is still in call config
    // (wrong output route, broken playback afterward).
    void AudioSession.stopAudioSession()
      .then(() => {
        if (NATIVE_CALL_UI) restoreAudioSession();
      })
      .catch(() => {
        if (NATIVE_CALL_UI) restoreAudioSession();
      });
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
      if (!nativeId) {
        clearNativeMapping(callId);
        return;
      }
      if (!NATIVE_CALL_UI) {
        clearNativeMapping(callId);
        return;
      }
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
          participants: upsertUser(
            current.participants,
            userForCall(current.call, channelsRef.current, participant.identity),
          ),
        }));
      };
      const onParticipantDisconnected = (participant: RemoteParticipant) => {
        updateActiveCall((current) => ({
          ...current,
          participants: removeUser(current.participants, participant.identity),
          activeSpeakerIds: new Set([...current.activeSpeakerIds].filter((id) => id !== participant.identity)),
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
        void AudioSession.stopAudioSession()
          .then(() => {
            if (NATIVE_CALL_UI) restoreAudioSession();
          })
          .catch(() => {
            if (NATIVE_CALL_UI) restoreAudioSession();
          });
        if (intentionalDisconnectRef.current) return;
        const current = activeCallRef.current;
        if (!current) return;
        const callId = current.call.id;
        setActiveCall(null);
        setNotice('Call disconnected.');
        reportNativeEnded(callId, 'failed');
        void api.leaveCall(callId).catch(() => {});
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
    [api, reportNativeEnded, updateActiveCall],
  );

  const applyNativeMute = useCallback(
    async (nativeCallId: string | undefined, muted: boolean) => {
      const room = roomRef.current;
      if (!room) return;
      await room.localParticipant.setMicrophoneEnabled(!muted, AUDIO_CAPTURE_OPTIONS);
      updateActiveCall((active) => ({ ...active, muted }));
      if (NATIVE_CALL_UI && nativeCallId) void setNativeMuted(nativeCallId, muted).catch(() => {});
    },
    [updateActiveCall],
  );

  const connectToCall = useCallback(
    async (join: CallJoin, native?: { id: string; incomingRequestId?: string; outgoing?: boolean }) => {
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

      if (NATIVE_CALL_UI) prepareAudioSessionForCall(false);
      const room = new Room();
      roomRef.current = room;
      setRoomHandlers(room);
      setIncomingCall((call) => (call?.id === join.call.id ? null : call));
      setNotice(null);
      setRecoverableCalls((calls) => upsertLiveCall(calls, join.call));
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
              participants: upsertUser(
                active.participants,
                userForCall(active.call, channelsRef.current, participant.identity),
              ),
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
          if (NATIVE_CALL_UI && native?.incomingRequestId) {
            await fulfillIncomingCallConnected(native.incomingRequestId);
          } else if (NATIVE_CALL_UI && native?.outgoing && native.id) {
            await reportOutgoingCallConnected(native.id);
          }
        } catch (err) {
          clearRoom();
          connectPromiseRef.current = null;
          setActiveCall(null);
          setNotice("Couldn't connect to the call.");
          if (NATIVE_CALL_UI && native?.incomingRequestId && native.id) {
            await failIncomingCallConnected(native.id, native.incomingRequestId).catch(() => {});
          } else if (NATIVE_CALL_UI && native?.id) {
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
      if (!NATIVE_CALL_UI) return;
      if (call.status !== 'ringing') return;
      if (call.initiatorId === me.id || nativeIdByCallIdRef.current[call.id]) return;
      if (nativeIncomingReportPendingRef.current.has(call.id) || nativeIncomingReportedRef.current.has(call.id)) {
        return;
      }
      const caller = userForCall(call, channelsRef.current, call.initiatorId);
      const channelName = labelForCallChannel(call, channelsRef.current, me.id);
      nativeIncomingReportPendingRef.current.add(call.id);
      void (async () => {
        const existingSession = await getActiveCallSession().catch(() => null);
        rememberNativeSession(existingSession);
        if (nativeIdByCallIdRef.current[call.id]) {
          nativeIncomingReportedRef.current.add(call.id);
          return;
        }
        await reportIncomingCall(incomingCallEventFor(call, caller, channelName));
        nativeIncomingReportedRef.current.add(call.id);
        const reportedSession = await getActiveCallSession().catch(() => null);
        rememberNativeSession(reportedSession);
      })()
        .catch((err: unknown) => {
          nativeIncomingReportedRef.current.delete(call.id);
          console.warn('[calls] failed to report incoming call to native UI', err);
        })
        .finally(() => {
          nativeIncomingReportPendingRef.current.delete(call.id);
        });
    },
    [me.id, rememberNativeSession],
  );

  const applyIncomingSnapshot = useCallback(
    (calls: CallWire[], channelId?: string) => {
      const current = incomingCallRef.current;
      const active = activeCallRef.current;
      if (active) {
        if (!channelId || current?.channelId === channelId) setIncomingCall(null);
        return;
      }

      const snapshotIncoming = calls.find((call) => call.status === 'ringing' && call.initiatorId !== me.id) ?? null;
      const updatedCurrent = current
        ? (calls.find((call) => call.id === current.id && call.status === 'ringing') ?? null)
        : null;
      const nextIncoming =
        updatedCurrent ?? (current && channelId && current.channelId !== channelId ? current : snapshotIncoming);

      setIncomingCall(nextIncoming);
      if (nextIncoming) reportIncomingToNative(nextIncoming);
    },
    [me.id, reportIncomingToNative],
  );

  const refreshActiveCalls = useCallback(
    async (opts: { channelId?: string } = {}) => {
      try {
        const snapshot = await api.activeCalls(opts);
        for (const callId of dismissedCallIdsRef.current) {
          const dismissedChannelId = dismissedCallChannelsRef.current.get(callId);
          const coveredBySnapshot = !opts.channelId || dismissedChannelId === opts.channelId;
          if (coveredBySnapshot && !snapshot.calls.some((call) => call.id === callId)) {
            dismissedCallIdsRef.current.delete(callId);
            dismissedCallChannelsRef.current.delete(callId);
          }
        }
        const liveCalls = sortLiveCalls(
          snapshot.calls.filter((call) => !isExpiredRing(call) && !dismissedCallIdsRef.current.has(call.id)),
        );
        setRecoverableCalls((current) =>
          opts.channelId
            ? sortLiveCalls([...current.filter((call) => call.channelId !== opts.channelId), ...liveCalls])
            : liveCalls,
        );
        applyIncomingSnapshot(liveCalls, opts.channelId);
      } catch {
        setNotice("Couldn't refresh active calls.");
      }
    },
    [api, applyIncomingSnapshot],
  );

  const acceptCallById = useCallback(
    async (callId: string, native?: { id: string; requestId?: string }): Promise<void> => {
      if (
        (answeringRef.current && !native?.requestId) ||
        answeredNativeRequestsRef.current.has(native?.requestId ?? '')
      ) {
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
        if (NATIVE_CALL_UI && native?.id && native.requestId) {
          await failIncomingCallConnected(native.id, native.requestId).catch(() => {});
        }
      } finally {
        setAnswering(false);
      }
    },
    [api, connectToCall, setAnswering],
  );

  const handleCallEvent = useCallback(
    (event: CallEvent) => {
      if (event.type === 'call.ringing') {
        if (dismissedCallIdsRef.current.has(event.call.id) || isExpiredRing(event.call)) {
          setIncomingCall((call) => (call?.id === event.call.id ? null : call));
          setRecoverableCalls((calls) => removeLiveCall(calls, event.call.id));
          reportNativeEnded(event.call.id, 'unanswered');
          return;
        }
        setRecoverableCalls((calls) => upsertLiveCall(calls, event.call));
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
          call?.id === event.callId
            ? event.user.id === me.id
              ? null
              : { ...call, status: 'active', participants: upsertUser(call.participants, event.user) }
            : call,
        );
        setRecoverableCalls((calls) =>
          updateLiveCall(calls, event.callId, (call) => ({
            ...call,
            status: 'active',
            participants: upsertUser(call.participants, event.user),
          })),
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
          setRecoverableCalls((calls) => removeLiveCall(calls, event.callId));
        }
        if (event.userId === me.id) reportNativeEnded(event.callId, 'declinedElsewhere');
        return;
      }

      if (event.type === 'call.participant_left') {
        setRecoverableCalls((calls) =>
          updateLiveCall(calls, event.callId, (call) => ({
            ...call,
            participants: removeUser(call.participants, event.userId),
          })),
        );
        let endedByLastLeave = false;
        setActiveCall((current) => {
          if (current?.call.id !== event.callId) return current;
          const participants = removeUser(current.participants, event.userId);
          const remoteCount = participants.filter((p) => p.id !== me.id).length;
          if (current.call.status === 'active' && remoteCount === 0) endedByLastLeave = true;
          return {
            ...current,
            participants,
            activeSpeakerIds: new Set([...current.activeSpeakerIds].filter((id) => id !== event.userId)),
          };
        });
        // Side effect outside the (possibly double-invoked) updater.
        if (endedByLastLeave) reportNativeEnded(event.callId, 'remoteEnded');
        return;
      }

      if (event.type === 'call.ended') {
        dismissedCallIdsRef.current.delete(event.callId);
        dismissedCallChannelsRef.current.delete(event.callId);
        setIncomingCall((call) => (call?.id === event.callId ? null : call));
        setRecoverableCalls((calls) => removeLiveCall(calls, event.callId));
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
        if (NATIVE_CALL_UI) {
          try {
            // The CallKit handle is the channelId (not the per-call id) on purpose:
            // it groups a conversation's calls in the native recents and makes a
            // "call back" target the channel, mirroring how DMs/channels resolve.
            nativeCallId = await startOutgoingCall(
              { id: join.call.channelId, displayName: channelName },
              { hasVideo: false },
            );
            nativeIdByCallIdRef.current[join.call.id] = nativeCallId;
            callIdByNativeIdRef.current[nativeCallId] = join.call.id;
          } catch (err) {
            console.warn('[calls] failed to start native outgoing call', err);
          }
        }
        await connectToCall(join, nativeCallId ? { id: nativeCallId, outgoing: true } : undefined);
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
    if (NATIVE_CALL_UI && nativeId) {
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
    setRecoverableCalls((calls) => removeLiveCall(calls, call.id));
    const nativeId = nativeIdForCall(call.id);
    if (NATIVE_CALL_UI && nativeId) {
      nativeEndRequestedRef.current.add(nativeId);
      void endCall(nativeId).catch(() => {});
      clearNativeMapping(call.id);
    }
    try {
      await api.declineCall(call.id);
    } catch (err) {
      if (callUnavailable(err)) {
        dismissedCallIdsRef.current.add(call.id);
        dismissedCallChannelsRef.current.set(call.id, call.channelId);
        setIncomingCall((current) => (current?.id === call.id ? null : current));
        setRecoverableCalls((calls) => removeLiveCall(calls, call.id));
      }
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
    if (NATIVE_CALL_UI && current.nativeCallId) {
      nativeEndRequestedRef.current.add(current.nativeCallId);
      void endCall(current.nativeCallId).catch(() => {});
      clearNativeMapping(callId);
    }
    clearRoom();
    setActiveCall(null);
    setRecoverableCalls((calls) =>
      updateLiveCall(calls, callId, (call) => ({
        ...call,
        participants: removeUser(call.participants, me.id),
      })),
    );
    try {
      await api.leaveCall(callId);
    } catch (err) {
      if (callUnavailable(err)) {
        dismissedCallIdsRef.current.add(callId);
        dismissedCallChannelsRef.current.set(callId, current.call.channelId);
        setRecoverableCalls((calls) => removeLiveCall(calls, callId));
      }
      setNotice("Couldn't leave the call cleanly.");
    }
  }, [api, clearNativeMapping, clearRoom, me.id]);

  const activeCallId = activeCall?.call.id ?? null;
  const activeCallStatus = activeCall?.call.status ?? null;
  const activeRemoteCount = activeCall
    ? activeCall.participants.filter((participant) => participant.id !== me.id).length
    : 0;

  useEffect(() => {
    if (!activeCallId || activeCallStatus !== 'ringing' || activeRemoteCount !== 0) return;

    const timeout = setTimeout(() => {
      const current = activeCallRef.current;
      const remoteCount = current ? current.participants.filter((participant) => participant.id !== me.id).length : 0;
      if (current?.call.id !== activeCallId || current.call.status !== 'ringing' || remoteCount !== 0) {
        return;
      }
      setNotice('No answer.');
      void leaveActiveCall();
    }, CALL_RING_TTL_MS);

    return () => clearTimeout(timeout);
  }, [activeCallId, activeCallStatus, activeRemoteCount, leaveActiveCall, me.id]);

  const incomingCallId = incomingCall?.id ?? null;
  const incomingCallStatus = incomingCall?.status ?? null;
  const incomingCallStartedAt = incomingCall?.startedAt ?? null;

  useEffect(() => {
    if (!incomingCallId || incomingCallStatus !== 'ringing' || !incomingCallStartedAt) return;
    const age = Date.now() - Date.parse(incomingCallStartedAt);
    const remainingTtl = Number.isFinite(age) ? Math.max(0, CALL_RING_TTL_MS - age) : CALL_RING_TTL_MS;

    const timeout = setTimeout(() => {
      const current = incomingCallRef.current;
      if (current?.id !== incomingCallId || current.status !== 'ringing') return;
      setIncomingCall(null);
      setRecoverableCalls((calls) => removeLiveCall(calls, incomingCallId));
      reportNativeEnded(incomingCallId, 'unanswered');
    }, remainingTtl);

    return () => clearTimeout(timeout);
  }, [incomingCallId, incomingCallStartedAt, incomingCallStatus, reportNativeEnded]);

  const callChromeVisible = Boolean(incomingCall || activeCall || recoverableCalls.length > 0);

  useEffect(() => {
    if (wsStatus === 'open' || !callChromeVisible) return;
    const interval = setInterval(() => {
      void refreshActiveCalls();
    }, CALL_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [callChromeVisible, refreshActiveCalls, wsStatus]);

  const joinRecoverableCall = useCallback(
    async (callId?: string) => {
      const incomingId = incomingCallRef.current?.id;
      const call = callId
        ? recoverableCallsRef.current.find((candidate) => candidate.id === callId)
        : recoverableCallsRef.current.find((candidate) => candidate.id !== incomingId);
      if (!call) return;
      await acceptCallById(call.id);
    },
    [acceptCallById],
  );

  useEffect(() => {
    if (!NATIVE_CALL_UI) return;
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
        setRecoverableCalls((calls) => removeLiveCall(calls, callId));
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

  const recoverableCall = activeCall ? null : (recoverableCalls.find((call) => call.id !== incomingCall?.id) ?? null);

  return {
    incomingCall,
    activeCall,
    recoverableCall,
    recoverableCalls,
    notice,
    starting,
    answering,
    refreshActiveCalls,
    handleCallEvent,
    startCall,
    joinRecoverableCall,
    acceptIncomingCall,
    declineIncomingCall,
    toggleMute,
    leaveActiveCall,
    clearNotice: () => setNotice(null),
  };
}
