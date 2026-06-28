import { useCallback } from 'react';
import {
  randomId,
  type AppAction,
  type Channel,
  type EnqueueOpInput,
} from '@atrium/surface-client';
import { api } from './api';
import { showErrorToast } from './components/Toasts';

type DispatchAppAction = (action: AppAction) => void;
type MuteEnqueue = (input: EnqueueOpInput<'mute.set'>) => Promise<unknown>;

export type ChannelActionsApi = Pick<typeof api, 'createChannel' | 'createDmWithUsers'>;

export function useChannelActions({
  client = api,
  dispatch,
  enqueueOp,
  getChannels,
  selectChannel,
}: {
  client?: ChannelActionsApi;
  dispatch: DispatchAppAction;
  enqueueOp: MuteEnqueue;
  getChannels: () => readonly Channel[];
  selectChannel: (channelId: string) => void;
}) {
  const createChannel = useCallback(
    async (name: string, isPrivate = false) => {
      try {
        const { channel } = await client.createChannel(name, { private: isPrivate });
        dispatch({ type: 'channel-added', channel });
        selectChannel(channel.id);
      } catch (err) {
        showErrorToast("Couldn't create the channel — try again.");
        throw err;
      }
    },
    [client, dispatch, selectChannel],
  );

  const startDm = useCallback(
    (userIds: string[]) => {
      client
        .createDmWithUsers(userIds)
        .then(({ channel }) => {
          dispatch({ type: 'channel-added', channel });
          selectChannel(channel.id);
        })
        .catch(() => showErrorToast("Couldn't start the conversation — try again."));
    },
    [client, dispatch, selectChannel],
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

  return { createChannel, setMute, startDm };
}
