import { ApiError, type AttachmentMeta, type WireEvent } from '@atrium/surface-client';
import type { OutboxMessage } from './cache';

export interface OutboxStorage {
  listOutbox: () => Promise<OutboxMessage[]>;
  removeOutbox: (clientMsgId: string) => Promise<void>;
}

export interface OutboxPostBody {
  channelId: string;
  text: string;
  clientMsgId: string;
  threadRootEventId?: number;
  attachments?: string[];
}

export function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError || !(err instanceof ApiError);
}

export async function flushOutbox({
  storage,
  postMessage,
  onConfirmed,
  onRejected,
}: {
  storage: OutboxStorage;
  postMessage: (body: OutboxPostBody) => Promise<{ event: WireEvent }>;
  onConfirmed: (event: WireEvent) => void;
  onRejected: (msg: OutboxMessage) => void;
}): Promise<void> {
  const queued = await storage.listOutbox();
  for (const msg of queued) {
    try {
      // Known caveat: the server does not dedupe by client_msg_id yet. If the
      // original request landed but its response was lost, this retry can
      // produce a duplicate server row. Keeping the original clientMsgId still
      // reconciles the local pending message for the normal retry case.
      const { event } = await postMessage({
        channelId: msg.channelId,
        text: msg.text,
        clientMsgId: msg.clientMsgId,
        threadRootEventId: msg.threadRootEventId,
        attachments: msg.attachments?.map((a) => a.id),
      });
      await storage.removeOutbox(msg.clientMsgId);
      onConfirmed(event);
    } catch (err) {
      if (isNetworkFailure(err)) return;
      await storage.removeOutbox(msg.clientMsgId);
      onRejected(msg);
    }
  }
}

export function outboxMessageFromSend({
  clientMsgId,
  channelId,
  text,
  threadRootEventId,
  attachments,
  createdAt,
}: {
  clientMsgId: string;
  channelId: string;
  text: string;
  threadRootEventId?: number;
  attachments?: AttachmentMeta[];
  createdAt: string;
}): OutboxMessage {
  return {
    clientMsgId,
    channelId,
    text,
    ...(threadRootEventId != null ? { threadRootEventId } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    createdAt,
  };
}

export function createDraftChangeDebouncer(
  save: (key: string, text: string) => void,
  delayMs = 400,
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const clear = (key: string) => {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  };

  return {
    schedule(key: string, text: string) {
      clear(key);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          save(key, text);
        }, delayMs),
      );
    },
    saveNow(key: string, text: string) {
      clear(key);
      save(key, text);
    },
    cancel(key?: string) {
      if (key) {
        clear(key);
        return;
      }
      for (const draftKey of [...timers.keys()]) clear(draftKey);
    },
  };
}
