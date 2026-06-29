import { useCallback } from 'react';
import type {
  AppAction,
  AttachmentRef,
  Channel,
  ChatMessage,
  EnqueueOpInput,
  MsgSendPayload,
  OpType,
  ReactionSetPayload,
  SessionSpawnPayload,
  UserRef,
} from '@atrium/surface-client';
import {
  looksLikeAgentCommand,
  parseAgentTask,
  randomId,
} from '@atrium/surface-client';
import { PENDING_SESSION_PREFIX } from './sessions/types';
import type { SpawnConfig } from './sessions/SpawnDialog';
import {
  pendingMessageFromSendPayload,
  pendingSpawnFromPayload,
  type VoiceMsgSendPayload,
} from './chatQueuedOverlays';
import { showErrorToast } from './components/Toasts';
import type { AttachmentMeta } from '@atrium/surface-client';

export type VoiceSendMeta = { fileId: string; durationMs: number; waveform?: number[] };
export type QueuedVoiceMsgSendPayload = MsgSendPayload & {
  voice?: { durationMs: number; waveform?: number[] };
};

type EnqueueOpOptions = {
  onStored?: () => void;
};

type EnqueueOp = <T extends OpType>(
  input: EnqueueOpInput<T>,
  options?: EnqueueOpOptions,
) => Promise<unknown>;

type DispatchAppAction = (action: AppAction) => void;

export function queuedMessagePayload(payload: VoiceMsgSendPayload): QueuedVoiceMsgSendPayload {
  return {
    ...payload,
    ...(payload.voice
      ? {
          voice: {
            durationMs: payload.voice.durationMs,
            ...(payload.voice.waveform ? { waveform: payload.voice.waveform } : {}),
          },
        }
      : {}),
  };
}

export function useChatMessageActions({
  activeChannel,
  dispatch,
  enqueueOp,
  me,
  onSpawnDialogClose,
}: {
  activeChannel: Channel | null;
  dispatch: DispatchAppAction;
  enqueueOp: EnqueueOp;
  me: UserRef;
  onSpawnDialogClose: () => void;
}) {
  const spawnQueuedSession = useCallback(
    (
      channelId: string,
      task: string,
      threadRootEventId?: number,
      opts?: {
        harness?: string;
        repo?: string;
        branch?: string;
        repos?: { repo: string; ref?: string; subdir?: string }[];
        githubIdentityMode?: 'automatic' | 'app_installation' | 'app_user' | 'pat';
        agentProfileId?: string;
        agentProfileVersionId?: string;
      },
    ) => {
      const harness = opts?.harness?.trim() || 'codex';
      const repo = opts?.repo?.trim();
      const branch = opts?.branch?.trim();
      const repos =
        opts?.repos?.length
          ? opts.repos
          : repo
            ? [{ repo, ...(branch ? { ref: branch } : {}) }]
            : [];
      const clientSpawnId = `${PENDING_SESSION_PREFIX}${randomId()}`;
      const payload: SessionSpawnPayload = {
        channelId,
        task,
        clientSpawnId,
        threadRootEventId,
        harness,
        ...(repo ? { repo } : {}),
        ...(branch ? { branch } : {}),
        ...(repos.length ? { repos } : {}),
        ...(opts?.githubIdentityMode ? { githubIdentityMode: opts.githubIdentityMode } : {}),
        ...(opts?.agentProfileId ? { agentProfileId: opts.agentProfileId } : {}),
        ...(opts?.agentProfileVersionId ? { agentProfileVersionId: opts.agentProfileVersionId } : {}),
        createdAt: new Date().toISOString(),
      };
      const pending = pendingSpawnFromPayload(payload, me);
      void enqueueOp(
        {
          opId: randomId(),
          opType: 'session.spawn',
          payload,
        },
        {
          onStored: () =>
            dispatch({
              type: 'session-spawn-pending',
              channelId,
              message: pending.message,
              session: pending.session,
            }),
        },
      ).catch(() => {
        dispatch({ type: 'session-spawn-failed', channelId, tempId: clientSpawnId });
        showErrorToast("Couldn't queue the agent session.");
      });
    },
    [dispatch, enqueueOp, me],
  );

  const startConfiguredSession = useCallback(
    (config: SpawnConfig) => {
      if (!activeChannel) return;
      // Bind configured spawns to the channel visible when the dialog renders,
      // so display and target cannot diverge.
      onSpawnDialogClose();
      spawnQueuedSession(activeChannel.id, config.task, undefined, {
        harness: config.harness,
        ...(config.repo ? { repo: config.repo } : {}),
        ...(config.branch ? { branch: config.branch } : {}),
        ...(config.repos?.length ? { repos: config.repos } : {}),
        ...(config.githubIdentityMode ? { githubIdentityMode: config.githubIdentityMode } : {}),
        ...(config.agentProfileId ? { agentProfileId: config.agentProfileId } : {}),
        ...(config.agentProfileVersionId ? { agentProfileVersionId: config.agentProfileVersionId } : {}),
      });
    },
    [activeChannel, onSpawnDialogClose, spawnQueuedSession],
  );

  const send = useCallback(
    (
      channelId: string,
      text: string,
      threadRootEventId?: number,
      attachments?: AttachmentMeta[],
      attachmentRefs?: AttachmentRef[],
      voice?: VoiceSendMeta,
    ) => {
      // Attachments cannot ride along on a spawn. Keep "@agent ..." with files
      // as a plain message instead of silently dropping attachments.
      const noAttachments = !attachments || attachments.length === 0;
      if (text && noAttachments) {
        const task = parseAgentTask(text);
        if (task != null) {
          spawnQueuedSession(channelId, task, threadRootEventId);
          return;
        }
        if (looksLikeAgentCommand(text.trim())) {
          showErrorToast('Type @agent followed by the task to run.');
          return;
        }
      }
      const clientMsgId = randomId();
      const pendingPayload: VoiceMsgSendPayload = {
        channelId,
        text,
        clientMsgId,
        threadRootEventId,
        attachments,
        attachmentRefs,
        createdAt: new Date().toISOString(),
        ...(voice
          ? {
              voice: {
                fileId: voice.fileId,
                durationMs: voice.durationMs,
                ...(voice.waveform ? { waveform: voice.waveform } : {}),
              },
            }
          : {}),
      };
      const message = pendingMessageFromSendPayload(pendingPayload, me);
      void enqueueOp(
        {
          opId: randomId(),
          opType: 'msg.send',
          payload: queuedMessagePayload(pendingPayload),
        },
        {
          onStored: () => dispatch({ type: 'send-pending', channelId, message }),
        },
      ).catch(() => {
        dispatch({ type: 'send-failed', channelId, clientMsgId });
        showErrorToast("Couldn't queue the message.");
      });
    },
    [dispatch, enqueueOp, me, spawnQueuedSession],
  );

  const editMessage = useCallback(
    async (m: ChatMessage, text: string): Promise<void> => {
      if (m.id == null) return;
      const eventId = m.id;
      const opId = randomId();
      try {
        await enqueueOp(
          {
            opId,
            opType: 'msg.edit',
            payload: { channelId: m.channelId, eventId, text },
          },
          {
            onStored: () =>
              dispatch({
                type: 'edit-overlay-pending',
                channelId: m.channelId,
                opId,
                targetEventId: eventId,
                text,
              }),
          },
        );
      } catch {
        dispatch({ type: 'overlay-rejected', channelId: m.channelId, opId });
        showErrorToast("Couldn't queue the edit.");
      }
    },
    [dispatch, enqueueOp],
  );

  const removeMessage = useCallback(
    async (m: ChatMessage): Promise<void> => {
      if (m.id == null) return;
      const eventId = m.id;
      const opId = randomId();
      try {
        await enqueueOp(
          {
            opId,
            opType: 'msg.delete',
            payload: { channelId: m.channelId, eventId },
          },
          {
            onStored: () =>
              dispatch({
                type: 'delete-overlay-pending',
                channelId: m.channelId,
                opId,
                targetEventId: eventId,
              }),
          },
        );
      } catch {
        dispatch({ type: 'overlay-rejected', channelId: m.channelId, opId });
        showErrorToast("Couldn't queue the delete.");
      }
    },
    [dispatch, enqueueOp],
  );

  const reactToMessage = useCallback(
    async (m: ChatMessage, emoji: string): Promise<void> => {
      if (m.id == null) return;
      const eventId = m.id;
      const mine = m.reactions?.find((r) => r.emoji === emoji)?.userIds.includes(me.id) === true;
      const action = mine ? 'remove' : 'add';
      const opId = randomId();
      const payload: ReactionSetPayload = {
        channelId: m.channelId,
        eventId,
        emoji,
        action,
        userId: me.id,
      };
      try {
        await enqueueOp(
          { opId, opType: 'reaction.set', payload },
          {
            onStored: () =>
              dispatch({
                type: 'reaction-overlay-pending',
                channelId: m.channelId,
                opId,
                targetEventId: eventId,
                emoji,
                userId: me.id,
                action,
              }),
          },
        );
      } catch {
        dispatch({ type: 'overlay-rejected', channelId: m.channelId, opId });
        showErrorToast("Couldn't queue the reaction.");
      }
    },
    [dispatch, enqueueOp, me.id],
  );

  const retry = useCallback(
    (m: ChatMessage) => {
      if (!m.clientMsgId) return;
      dispatch({ type: 'retry-remove', channelId: m.channelId, clientMsgId: m.clientMsgId });
      if (m.sessionId != null) {
        spawnQueuedSession(m.channelId, m.text, m.threadRootEventId ?? undefined);
        return;
      }
      send(
        m.channelId,
        m.text,
        m.threadRootEventId ?? undefined,
        m.attachments,
        undefined,
        m.voice
          ? { fileId: m.voice.fileId, durationMs: m.voice.durationMs, waveform: m.voice.waveform }
          : undefined,
      );
    },
    [dispatch, send, spawnQueuedSession],
  );

  return {
    editMessage,
    reactToMessage,
    removeMessage,
    retry,
    send,
    spawnQueuedSession,
    startConfiguredSession,
  };
}
