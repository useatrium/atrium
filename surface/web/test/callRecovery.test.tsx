// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallWire, UserRef } from '@atrium/surface-client';
import type { Channel } from '../src/api';
import { ChannelCallStrip } from '../src/components/CallUI';
import { useCall } from '../src/useCall';

const apiMock = vi.hoisted(() => ({
  activeCalls: vi.fn(),
  acceptCall: vi.fn(),
  declineCall: vi.fn(),
  leaveCall: vi.fn(),
  startCall: vi.fn(),
}));

vi.mock('../src/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError, api: apiMock };
});

vi.mock('livekit-client', () => ({
  Room: vi.fn(() => ({
    state: 'disconnected',
    localParticipant: {
      isMicrophoneEnabled: true,
      setMicrophoneEnabled: vi.fn(async () => {}),
    },
    remoteParticipants: new Map(),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
  })),
  RoomEvent: {
    ParticipantConnected: 'ParticipantConnected',
    ParticipantDisconnected: 'ParticipantDisconnected',
    TrackSubscribed: 'TrackSubscribed',
    TrackUnsubscribed: 'TrackUnsubscribed',
    ActiveSpeakersChanged: 'ActiveSpeakersChanged',
    Disconnected: 'Disconnected',
  },
  Track: { Kind: { Audio: 'audio' } },
}));

const me: UserRef = { id: 'u-me', handle: 'me', displayName: 'Me User' };
const ada: UserRef = { id: 'u-ada', handle: 'ada', displayName: 'Ada Lovelace' };
const grace: UserRef = { id: 'u-grace', handle: 'grace', displayName: 'Grace Hopper' };

function call(overrides: Partial<CallWire> = {}): CallWire {
  return {
    id: 'call-1',
    channelId: 'ch-1',
    initiatorId: 'u-ada',
    status: 'ringing',
    startedAt: '2026-07-03T14:00:00.000Z',
    participants: [ada],
    ...overrides,
  };
}

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-1',
    workspaceId: 'ws-1',
    name: 'general',
    createdAt: '2026-07-03T14:00:00.000Z',
    kind: 'public',
    members: [me, ada, grace],
    muted: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.activeCalls.mockResolvedValue({ calls: [] });
});

afterEach(() => {
  cleanup();
});

describe('call recovery', () => {
  it('recovers live calls from the active-call snapshot', async () => {
    apiMock.activeCalls.mockResolvedValueOnce({ calls: [call({ status: 'active' })] });
    const { result } = renderHook(() => useCall(me, [channel()]));

    await act(async () => {
      await result.current.refreshActiveCalls();
    });

    expect(result.current.liveCalls).toHaveLength(1);
    expect(result.current.liveCallForChannel('ch-1')?.id).toBe('call-1');
    expect(result.current.liveCallForChannel('missing')).toBeNull();
  });

  it('shows a dismissible notice when active-call recovery fails', async () => {
    apiMock.activeCalls.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useCall(me, [channel()]));

    await act(async () => {
      await result.current.refreshActiveCalls();
    });

    expect(result.current.notice).toBe("Couldn't refresh active calls.");
    act(() => result.current.clearNotice());
    expect(result.current.notice).toBeNull();
  });

  it('folds call lifecycle events into live call state', () => {
    const { result } = renderHook(() => useCall(me, [channel()]));

    act(() => {
      result.current.handleCallEvent({ type: 'call.ringing', call: call() });
    });
    expect(result.current.liveCallForChannel('ch-1')?.status).toBe('ringing');
    expect(result.current.incomingCall?.id).toBe('call-1');

    act(() => {
      result.current.handleCallEvent({
        type: 'call.accepted',
        callId: 'call-1',
        user: grace,
      });
    });
    expect(result.current.liveCallForChannel('ch-1')?.status).toBe('active');
    expect(result.current.liveCallForChannel('ch-1')?.participants.map((u) => u.id)).toEqual([
      'u-ada',
      'u-grace',
    ]);
    expect(result.current.incomingCall).toBeNull();

    act(() => {
      result.current.handleCallEvent({
        type: 'call.participant_left',
        callId: 'call-1',
        userId: 'u-grace',
      });
    });
    expect(result.current.liveCallForChannel('ch-1')?.participants.map((u) => u.id)).toEqual([
      'u-ada',
    ]);

    act(() => {
      result.current.handleCallEvent({ type: 'call.ended', callId: 'call-1' });
    });
    expect(result.current.liveCallForChannel('ch-1')).toBeNull();
  });
});

describe('ChannelCallStrip', () => {
  it('offers accept and decline for a ringing call from someone else', () => {
    render(
      <ChannelCallStrip
        call={call()}
        caller={ada}
        channelName="#general"
        meId={me.id}
        joining={false}
        onJoin={() => {}}
        onDecline={() => {}}
      />,
    );

    expect(screen.getByText('Ada Lovelace is calling')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
  });

  it('labels a lost local room as rejoin when the viewer is still a participant', () => {
    render(
      <ChannelCallStrip
        call={call({ status: 'active', participants: [ada, me] })}
        caller={ada}
        channelName="#general"
        meId={me.id}
        joining={false}
        onJoin={() => {}}
        onDecline={() => {}}
      />,
    );

    expect(screen.getByText('Live call')).toBeTruthy();
    expect(screen.getByText('Ada Lovelace, You')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rejoin' })).toBeTruthy();
  });
});
