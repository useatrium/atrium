import { useCallback } from 'react';
import { randomId, type AppAction, type Channel, type EnqueueOpInput } from '@atrium/surface-client';
import { api } from './api';
import { showErrorToast } from './components/Toasts';

type DispatchAppAction = (action: AppAction) => void;
type ChannelOpType = 'mute.set' | 'channel.archive' | 'channel.pin';
type MuteEnqueue = <T extends ChannelOpType>(input: EnqueueOpInput<T>) => Promise<unknown>;

export type ChannelActionsApi = Pick<typeof api, 'createChannel' | 'createDmWithUsers'>;

export function useChannelActions({
  client = api,
  dispatch,
  enqueueOp,
  getChannels,
  navigateToChannel,
}: {
  client?: ChannelActionsApi;
  dispatch: DispatchAppAction;
  enqueueOp: MuteEnqueue;
  getChannels: () => readonly Channel[];
  navigateToChannel: (channelId: string) => void;
}) {
  const createChannel = useCallback(
    async (name: string, isPrivate = false) => {
      try {
        const { channel } = await client.createChannel(name, { private: isPrivate });
        dispatch({ type: 'channel-added', channel });
        navigateToChannel(channel.id);
      } catch (err) {
        showErrorToast("Couldn't create the channel — try again.");
        throw err;
      }
    },
    [client, dispatch, navigateToChannel],
  );

  const startDm = useCallback(
    (userIds: string[]) => {
      client
        .createDmWithUsers(userIds)
        .then(({ channel }) => {
          dispatch({ type: 'channel-added', channel });
          navigateToChannel(channel.id);
        })
        .catch(() => showErrorToast("Couldn't start the conversation — try again."));
    },
    [client, dispatch, navigateToChannel],
  );

  const setMute = useCallback(
    (channelId: string, muted: boolean) => {
      const previousMuted = getChannels().find((c) => c.id === channelId)?.muted === true;
      dispatch({ type: 'mute-changed', channelId, muted });
      void enqueueOp({
        opId: randomId(),
        opType: 'mute.set',
        payload: { channelId, muted, previousMuted },
      }).catch(() => {
        dispatch({ type: 'mute-changed', channelId, muted: previousMuted });
        showErrorToast("Couldn't queue the mute change.");
      });
    },
    [dispatch, enqueueOp, getChannels],
  );

  const setArchived = useCallback(
    (channelId: string, archived: boolean) => {
      const previousArchivedAt = getChannels().find((c) => c.id === channelId)?.archivedAt ?? null;
      dispatch({
        type: 'channel-archive-changed',
        channelId,
        archivedAt: archived ? new Date().toISOString() : null,
      });
      void enqueueOp({
        opId: randomId(),
        opType: 'channel.archive',
        payload: { channelId, archived, previousArchivedAt },
      }).catch(() => {
        dispatch({ type: 'channel-archive-changed', channelId, archivedAt: previousArchivedAt });
        showErrorToast("Couldn't queue the archive change.");
      });
    },
    [dispatch, enqueueOp, getChannels],
  );

  const setPinned = useCallback(
    (channelId: string, pinned: boolean) => {
      const previousPinned = getChannels().find((c) => c.id === channelId)?.pinned === true;
      dispatch({ type: 'channel-pin-changed', channelId, pinned });
      void enqueueOp({
        opId: randomId(),
        opType: 'channel.pin',
        payload: { channelId, pinned, previousPinned },
      }).catch(() => {
        dispatch({ type: 'channel-pin-changed', channelId, pinned: previousPinned });
        showErrorToast("Couldn't queue the pin change.");
      });
    },
    [dispatch, enqueueOp, getChannels],
  );

  return { createChannel, setArchived, setMute, setPinned, startDm };
}
