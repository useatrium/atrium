// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppAction, Channel, EnqueueOpInput } from '@atrium/surface-client';
import { useChannelActions, type ChannelActionsApi } from '../src/useChannelActions';

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-1',
    workspaceId: 'ws-1',
    name: 'general',
    createdAt: '2026-06-28T16:30:00.000Z',
    kind: 'public',
    latestEventId: 0,
    lastReadEventId: 0,
    archivedAt: null,
    pinned: false,
    ...overrides,
  };
}

function renderActions({
  channels = [channel()],
  client = {
    createChannel: vi.fn(async () => ({ channel: channel({ id: 'ch-created', name: 'created' }) })),
    createDmWithUsers: vi.fn(async () => ({ channel: channel({ id: 'dm-1', name: 'dm' }) })),
  } satisfies ChannelActionsApi,
  enqueueOp = vi.fn(async (_input: EnqueueOpInput<'mute.set'>) => ({ opId: 'op-1' })),
}: {
  channels?: Channel[];
  client?: ChannelActionsApi;
  enqueueOp?: ReturnType<typeof vi.fn>;
} = {}) {
  const dispatch = vi.fn<(action: AppAction) => void>();
  const navigateToChannel = vi.fn();
  const view = renderHook(() =>
    useChannelActions({
      client,
      dispatch,
      enqueueOp: enqueueOp as <T extends 'mute.set' | 'channel.archive' | 'channel.pin'>(
        input: EnqueueOpInput<T>,
      ) => Promise<unknown>,
      getChannels: () => channels,
      navigateToChannel,
    }),
  );
  return { ...view, client, dispatch, enqueueOp, navigateToChannel };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useChannelActions', () => {
  it('creates a channel, stores it, and navigates to it', async () => {
    const created = channel({ id: 'ch-created', name: 'private-room', kind: 'private' });
    const client = {
      createChannel: vi.fn(async () => ({ channel: created })),
      createDmWithUsers: vi.fn(),
    };
    const { result, dispatch, navigateToChannel } = renderActions({ client });

    await act(async () => {
      await result.current.createChannel('private-room', true);
    });

    expect(client.createChannel).toHaveBeenCalledWith('private-room', { private: true });
    expect(dispatch).toHaveBeenCalledWith({ type: 'channel-added', channel: created });
    expect(navigateToChannel).toHaveBeenCalledWith('ch-created');
  });

  it('throws when channel creation fails so the sidebar can reset form state', async () => {
    const error = new Error('nope');
    const client = {
      createChannel: vi.fn(async () => {
        throw error;
      }),
      createDmWithUsers: vi.fn(),
    };
    const { result, dispatch, navigateToChannel } = renderActions({ client });

    await expect(result.current.createChannel('bad-room')).rejects.toThrow(error);

    expect(dispatch).not.toHaveBeenCalled();
    expect(navigateToChannel).not.toHaveBeenCalled();
  });

  it('starts a DM, stores it, and navigates to it', async () => {
    const dm = channel({ id: 'dm-1', name: 'dm', kind: 'dm' });
    const client = {
      createChannel: vi.fn(),
      createDmWithUsers: vi.fn(async () => ({ channel: dm })),
    };
    const { result, dispatch, navigateToChannel } = renderActions({ client });

    act(() => result.current.startDm(['user-2']));

    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'channel-added', channel: dm }));
    expect(client.createDmWithUsers).toHaveBeenCalledWith(['user-2']);
    expect(navigateToChannel).toHaveBeenCalledWith('dm-1');
  });

  it('queues optimistic mute changes with rollback metadata', () => {
    const { result, dispatch, enqueueOp } = renderActions({
      channels: [channel({ id: 'ch-1', muted: false })],
    });

    act(() => result.current.setMute('ch-1', true));

    expect(dispatch).toHaveBeenCalledWith({ type: 'mute-changed', channelId: 'ch-1', muted: true });
    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'mute.set',
        payload: { channelId: 'ch-1', muted: true, previousMuted: false },
      }),
    );
  });

  it('rolls mute state back when queueing fails', async () => {
    const enqueueOp = vi.fn(async () => {
      throw new Error('offline');
    });
    const { result, dispatch } = renderActions({
      channels: [channel({ id: 'ch-1', muted: true })],
      enqueueOp,
    });

    act(() => result.current.setMute('ch-1', false));

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({
        type: 'mute-changed',
        channelId: 'ch-1',
        muted: true,
      }),
    );
  });
});
