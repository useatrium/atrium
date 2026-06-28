// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppAction,
  Channel,
  ChatMessage,
  EnqueueOpInput,
  OpType,
  UserRef,
} from '@atrium/surface-client';
import {
  queuedMessagePayload,
  useChatMessageActions,
  type VoiceSendMeta,
} from '../src/useChatMessageActions';

const me: UserRef = { id: 'user-1', handle: 'me', displayName: 'Me User' };
const channel: Channel = {
  id: 'ch-1',
  workspaceId: 'ws-1',
  name: 'general',
  createdAt: '2026-06-28T14:00:00.000Z',
  kind: 'public',
  members: [me],
  latestEventId: 0,
  lastReadEventId: 0,
};

type TestEnqueueOp = <T extends OpType>(
  input: EnqueueOpInput<T>,
  options?: { onStored?: () => void },
) => Promise<unknown>;

function confirmedMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 42,
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: null,
    text: 'hello',
    edited: false,
    author: me,
    createdAt: '2026-06-28T14:00:00.000Z',
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
    ...overrides,
  };
}

function renderActions({
  activeChannel = channel,
  enqueueOp = vi.fn(async () => ({ opId: 'op-1' })),
}: {
  activeChannel?: Channel | null;
  enqueueOp?: ReturnType<typeof vi.fn>;
} = {}) {
  const dispatch = vi.fn<(action: AppAction) => void>();
  const onSpawnDialogClose = vi.fn();
  const view = renderHook(() =>
    useChatMessageActions({
      activeChannel,
      dispatch,
      enqueueOp: enqueueOp as TestEnqueueOp,
      me,
      onSpawnDialogClose,
    }),
  );
  return { ...view, dispatch, enqueueOp, onSpawnDialogClose };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('queuedMessagePayload', () => {
  it('omits local voice file ids from queued msg.send payloads', () => {
    const payload = queuedMessagePayload({
      channelId: 'ch-1',
      text: '',
      clientMsgId: 'client-1',
      createdAt: '2026-06-28T14:00:00.000Z',
      voice: { fileId: 'local-file', durationMs: 900, waveform: [0.2, 0.8] },
    });

    expect(payload.voice).toEqual({ durationMs: 900, waveform: [0.2, 0.8] });
  });
});

describe('useChatMessageActions', () => {
  it('queues plain messages and dispatches the optimistic row when stored', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T15:00:00.000Z'));
    const { result, dispatch, enqueueOp } = renderActions();
    const voice: VoiceSendMeta = { fileId: 'file-local', durationMs: 1200, waveform: [0.1, 0.6] };

    act(() => result.current.send('ch-1', 'hello', undefined, undefined, undefined, voice));

    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'msg.send',
        payload: expect.objectContaining({
          channelId: 'ch-1',
          text: 'hello',
          createdAt: '2026-06-28T15:00:00.000Z',
          voice: { durationMs: 1200, waveform: [0.1, 0.6] },
        }),
      }),
      expect.objectContaining({ onStored: expect.any(Function) }),
    );

    act(() => enqueueOp.mock.calls[0]![1].onStored());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'send-pending',
        channelId: 'ch-1',
        message: expect.objectContaining({
          text: 'hello',
          voice: expect.objectContaining({ fileId: 'file-local', durationMs: 1200 }),
        }),
      }),
    );
  });

  it('routes attachment-free @agent sends to session spawn', () => {
    const { result, enqueueOp } = renderActions();

    act(() => result.current.send('ch-1', '@agent summarize this thread', 7));

    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'session.spawn',
        payload: expect.objectContaining({
          channelId: 'ch-1',
          task: 'summarize this thread',
          threadRootEventId: 7,
          harness: 'codex',
        }),
      }),
      expect.objectContaining({ onStored: expect.any(Function) }),
    );
  });

  it('keeps @agent text as a plain message when attachments are present', () => {
    const { result, enqueueOp } = renderActions();

    act(() =>
      result.current.send('ch-1', '@agent summarize this file', undefined, [
        { id: 'file-1', filename: 'a.txt', contentType: 'text/plain', size: 10 },
      ]),
    );

    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({ opType: 'msg.send' }),
      expect.anything(),
    );
  });

  it('dispatches rejected edit overlays when edit queueing fails', async () => {
    const enqueueOp = vi.fn(async () => {
      throw new Error('offline');
    });
    const { result, dispatch } = renderActions({ enqueueOp });

    await act(async () => {
      await result.current.editMessage(confirmedMessage(), 'updated');
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'overlay-rejected', channelId: 'ch-1' }),
    );
  });

  it('uses the correct reaction action for existing user reactions', async () => {
    const { result, enqueueOp } = renderActions();

    await act(async () => {
      await result.current.reactToMessage(
        confirmedMessage({ reactions: [{ emoji: 'ok', userIds: ['user-1'] }] }),
        'ok',
      );
    });

    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'reaction.set',
        payload: expect.objectContaining({ emoji: 'ok', action: 'remove', userId: 'user-1' }),
      }),
      expect.anything(),
    );
  });

  it('removes failed messages before retrying a plain message', async () => {
    const { result, dispatch, enqueueOp } = renderActions();

    act(() =>
      result.current.retry(
        confirmedMessage({
          id: null,
          clientMsgId: 'failed-1',
          status: 'failed',
          text: 'retry me',
        }),
      ),
    );

    expect(dispatch).toHaveBeenCalledWith({
      type: 'retry-remove',
      channelId: 'ch-1',
      clientMsgId: 'failed-1',
    });
    await waitFor(() =>
      expect(enqueueOp).toHaveBeenCalledWith(
        expect.objectContaining({ opType: 'msg.send' }),
        expect.anything(),
      ),
    );
  });

  it('closes the spawn dialog and queues a configured session into the active channel', () => {
    const { result, enqueueOp, onSpawnDialogClose } = renderActions();

    act(() =>
      result.current.startConfiguredSession({
        task: 'ship it',
        harness: 'codex',
        repo: 'gbasin/atrium',
        branch: 'feature/refactor',
      }),
    );

    expect(onSpawnDialogClose).toHaveBeenCalledOnce();
    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'session.spawn',
        payload: expect.objectContaining({
          channelId: 'ch-1',
          task: 'ship it',
          repo: 'gbasin/atrium',
          branch: 'feature/refactor',
          repos: [{ repo: 'gbasin/atrium', ref: 'feature/refactor' }],
        }),
      }),
      expect.anything(),
    );
  });
});
