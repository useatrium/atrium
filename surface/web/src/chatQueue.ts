import {
  createDefaultOpRegistry,
  type MsgSendPayload,
  type OpQueueLockProvider,
  type OpRegistry,
  type OpType,
  type UploadPayload,
  type VoiceMeta,
} from '@atrium/surface-client';

export const QUEUE_NUDGE_KEY = 'atrium:queue-nudge';

type VoiceMsgSendPayload = MsgSendPayload & {
  voice?: Pick<VoiceMeta, 'durationMs' | 'waveform'>;
};

export function createQueueLockProvider(): OpQueueLockProvider | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const locks = (
    navigator as Navigator & {
      locks?: {
        request<T>(name: string, callback: () => T | PromiseLike<T>): Promise<T>;
      };
    }
  ).locks;
  if (!locks) return undefined;
  return {
    request: <T,>(name: string, callback: () => Promise<T>) => locks.request<T>(name, callback),
  };
}

export function broadcastQueueNudge(): void {
  try {
    window.localStorage.setItem(QUEUE_NUDGE_KEY, `${Date.now()}:${Math.random()}`);
  } catch {
    // Best-effort multi-tab wake-up only.
  }
}

export function queuedFailureMessage(opType: OpType): string {
  switch (opType) {
    case 'msg.send':
      return "Couldn't send the message.";
    case 'upload':
      return "Couldn't upload the file.";
    case 'msg.edit':
      return "Couldn't save the edit.";
    case 'msg.delete':
      return "Couldn't delete the message.";
    case 'reaction.set':
      return "Couldn't update the reaction.";
    case 'read.mark':
      return "Couldn't mark the channel read.";
    case 'mute.set':
      return "Couldn't update the mute setting.";
    case 'session.spawn':
      return "Couldn't start the agent session.";
    case 'session.answer':
      return "Couldn't submit the answer.";
    case 'session.steer':
      return "Couldn't send the session message.";
    case 'session.cancel':
      return "Couldn't cancel the session.";
    case 'prefs.set':
      return "Couldn't sync settings.";
    case 'draft.set':
      return "Couldn't sync the draft.";
    case 'channel.join':
      return "Couldn't add the person.";
    case 'channel.leave':
      return "Couldn't leave the channel.";
  }
}

export function createChatOpRegistry(): OpRegistry {
  const registry = createDefaultOpRegistry();
  const baseSend = registry['msg.send'];
  registry['msg.send'] = {
    ...baseSend,
    execute: async (apiClient, payload, op, context) => {
      const voicePayload = (payload as VoiceMsgSendPayload).voice;
      let attachments = payload.attachments?.map((attachment) => attachment.id);
      if (payload.attachmentRefs && payload.attachmentRefs.length > 0) {
        const ops = await context.listOps();
        attachments = payload.attachmentRefs.map((ref) => {
          const uploadOp = ops.find((candidate) => candidate.queueKey === `upload:${ref.uploadKey}`);
          const uploadPayload = uploadOp?.payload as Partial<UploadPayload> | undefined;
          if (uploadOp?.status !== 'completed' || !uploadPayload?.uploaded || !uploadPayload.fileId) {
            throw new TypeError(`upload ${ref.uploadKey} is not ready`);
          }
          return uploadPayload.fileId;
        });
      }
      return apiClient.postMessage({
        channelId: payload.channelId,
        text: payload.text,
        clientMsgId: payload.clientMsgId,
        threadRootEventId: payload.threadRootEventId,
        attachments,
        ...(voicePayload ? { voice: voicePayload } : {}),
        opId: op.opId,
      });
    },
  };
  return registry;
}
