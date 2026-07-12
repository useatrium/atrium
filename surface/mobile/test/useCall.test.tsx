// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { ApiError, CALL_RING_TTL_MS, type Api, type CallWire, type UserRef } from '@atrium/surface-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCall } from '../src/lib/useCall';

vi.mock('@livekit/react-native', () => ({
  AudioSession: {
    startAudioSession: vi.fn(async () => {}),
    stopAudioSession: vi.fn(async () => {}),
  },
}));

vi.mock('livekit-client', () => ({
  Room: class {
    state = 'disconnected';
    localParticipant = {
      isMicrophoneEnabled: false,
      setMicrophoneEnabled: vi.fn(async () => {}),
    };
    remoteParticipants = new Map();
    on = vi.fn();
    off = vi.fn();
    connect = vi.fn(async () => {});
    disconnect = vi.fn(async () => {});
  },
  RoomEvent: {
    ActiveSpeakersChanged: 'activeSpeakersChanged',
    Disconnected: 'disconnected',
    ParticipantConnected: 'participantConnected',
    ParticipantDisconnected: 'participantDisconnected',
  },
  Track: { Kind: { Audio: 'audio' } },
}));

vi.mock('expo-callkit-telecom', () => ({
  addCallAnsweredListener: vi.fn(() => ({ remove: vi.fn() })),
  addCallEndedListener: vi.fn(() => ({ remove: vi.fn() })),
  addCallSessionAddedListener: vi.fn(() => ({ remove: vi.fn() })),
  addCallSessionUpdatedListener: vi.fn(() => ({ remove: vi.fn() })),
  addSetMutedActionListener: vi.fn(() => ({ remove: vi.fn() })),
  answerCall: vi.fn(async () => {}),
  endCall: vi.fn(async () => {}),
  failIncomingCallConnected: vi.fn(async () => {}),
  fulfillIncomingCallConnected: vi.fn(async () => {}),
  getActiveCallSession: vi.fn(async () => null),
  prepareAudioSessionForCall: vi.fn(),
  reportCallEnded: vi.fn(async () => {}),
  reportIncomingCall: vi.fn(async () => {}),
  reportOutgoingCallConnected: vi.fn(async () => {}),
  restoreAudioSession: vi.fn(),
  setMuted: vi.fn(async () => {}),
  startOutgoingCall: vi.fn(async () => 'native-call-1'),
}));

vi.mock('../src/lib/nativeCallUi', () => ({ NATIVE_CALL_UI: false }));

const me: UserRef = { id: 'me', handle: 'me', displayName: 'Me' };
const caller: UserRef = { id: 'caller', handle: 'caller', displayName: 'Caller' };

function call(id: string, startedAt: string, status: CallWire['status'] = 'ringing'): CallWire {
  return {
    id,
    channelId: 'channel-1',
    initiatorId: caller.id,
    status,
    startedAt,
    participants: [caller],
  };
}

function apiMock(overrides: Partial<Api> = {}): Api {
  return {
    activeCalls: vi.fn(async () => ({ calls: [] })),
    declineCall: vi.fn(async () => ({ ok: true })),
    leaveCall: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } as unknown as Api;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useCall call lifetime defenses', () => {
  it('drops stale snapshot rings and promotes a fresh ring', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T12:00:00.000Z'));
    const stale = call('stale', new Date(Date.now() - CALL_RING_TTL_MS - 1).toISOString());
    const fresh = call('fresh', new Date(Date.now() - 1_000).toISOString());
    const api = apiMock({ activeCalls: vi.fn(async () => ({ calls: [stale, fresh] })) });
    const { result } = renderHook(() => useCall({ api, me, channels: [], wsStatus: 'open' }));

    await act(async () => result.current.refreshActiveCalls());

    expect(result.current.incomingCall?.id).toBe('fresh');
    expect(result.current.recoverableCalls.map((candidate) => candidate.id)).toEqual(['fresh']);
  });

  it('keeps a call dismissed after calls_unconfigured and a repeated snapshot', async () => {
    const ringing = call('ringing', new Date().toISOString());
    const api = apiMock({
      activeCalls: vi.fn(async () => ({ calls: [ringing] })),
      declineCall: vi.fn(async () => {
        throw new ApiError(503, 'calls_unconfigured', 'calls unavailable');
      }),
    });
    const { result } = renderHook(() => useCall({ api, me, channels: [], wsStatus: 'open' }));
    await act(async () => result.current.refreshActiveCalls());

    await act(async () => result.current.declineIncomingCall());
    await act(async () => result.current.refreshActiveCalls());

    expect(result.current.incomingCall).toBeNull();
    expect(result.current.recoverableCalls).toEqual([]);
    expect(result.current.notice).toBe("Couldn't decline the call.");
  });

  it('dismisses an incoming ring when its remaining ttl elapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T12:00:00.000Z'));
    const ringing = call('ringing', new Date(Date.now() - 30_000).toISOString());
    const api = apiMock();
    const { result } = renderHook(() => useCall({ api, me, channels: [], wsStatus: 'open' }));

    act(() => result.current.handleCallEvent({ type: 'call.ringing', call: ringing }));
    act(() => vi.advanceTimersByTime(CALL_RING_TTL_MS - 30_001));
    expect(result.current.incomingCall?.id).toBe('ringing');

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.incomingCall).toBeNull();
    expect(result.current.recoverableCalls).toEqual([]);
  });

  it('polls once per interval only while chrome is visible and the websocket is down', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T12:00:00.000Z'));
    const activeCalls = vi.fn(async () => ({ calls: [] }));
    const api = apiMock({ activeCalls });
    const { result, rerender } = renderHook(
      ({ wsStatus }: { wsStatus: 'connecting' | 'open' | 'closed' }) => useCall({ api, me, channels: [], wsStatus }),
      { initialProps: { wsStatus: 'closed' as 'connecting' | 'open' | 'closed' } },
    );

    act(() => vi.advanceTimersByTime(45_000));
    expect(activeCalls).not.toHaveBeenCalled();

    act(() =>
      result.current.handleCallEvent({
        type: 'call.ringing',
        call: call('ringing', new Date().toISOString()),
      }),
    );
    act(() => vi.advanceTimersByTime(45_000));
    expect(activeCalls).toHaveBeenCalledTimes(1);

    rerender({ wsStatus: 'open' });
    act(() => vi.advanceTimersByTime(90_000));
    expect(activeCalls).toHaveBeenCalledTimes(1);
  });
});
