import { ApiError, type Api, type ReactionAction } from './api';
import type { AppAction } from './appState';
import { sessionFromWire } from './sessions';
import type { AttachmentMeta, WireEvent } from './timeline';

export type OpType =
  | 'msg.send'
  | 'msg.edit'
  | 'msg.delete'
  | 'reaction.set'
  | 'read.mark'
  | 'mute.set'
  | 'session.spawn'
  | 'session.answer'
  | 'channel.join'
  | 'channel.leave';

export interface QueuedOp {
  opId: string;
  opType: OpType;
  queueKey: string;
  payload: unknown;
  status: 'pending' | 'inflight';
  retryCount: number;
  createdAt: string;
}

export interface OpStorage {
  /** In insertion order. */
  listOps(): Promise<QueuedOp[]>;
  /** Insert or replace by opId. */
  putOp(op: QueuedOp): Promise<void>;
  removeOp(opId: string): Promise<void>;
}

export interface MsgSendPayload {
  channelId: string;
  text: string;
  clientMsgId: string;
  threadRootEventId?: number;
  attachments?: AttachmentMeta[];
  createdAt?: string;
}

export interface MsgEditPayload {
  channelId: string;
  eventId: number;
  text: string;
}

export interface MsgDeletePayload {
  channelId: string;
  eventId: number;
}

export interface ReactionSetPayload {
  channelId: string;
  eventId: number;
  emoji: string;
  action: ReactionAction;
  userId: string;
}

export interface ReadMarkPayload {
  channelId: string;
  lastReadEventId: number;
}

export interface MuteSetPayload {
  channelId: string;
  muted: boolean;
  previousMuted: boolean;
}

export interface SessionSpawnPayload {
  channelId: string;
  task: string;
  clientSpawnId: string;
  threadRootEventId?: number;
  harness?: string;
  createdAt?: string;
}

export interface SessionAnswerPayload {
  sessionId: string;
  questionId: string;
  answers: Record<string, { answers: string[] }>;
}

export interface ChannelJoinPayload {
  channelId: string;
  userId: string;
}

export interface ChannelLeavePayload {
  channelId: string;
  userId: string;
}

export type OpPayloadByType = {
  'msg.send': MsgSendPayload;
  'msg.edit': MsgEditPayload;
  'msg.delete': MsgDeletePayload;
  'reaction.set': ReactionSetPayload;
  'read.mark': ReadMarkPayload;
  'mute.set': MuteSetPayload;
  'session.spawn': SessionSpawnPayload;
  'session.answer': SessionAnswerPayload;
  'channel.join': ChannelJoinPayload;
  'channel.leave': ChannelLeavePayload;
};

type OpResultByType = {
  'msg.send': { event: WireEvent };
  'msg.edit': { event: WireEvent };
  'msg.delete': { event: WireEvent };
  'reaction.set': { event: WireEvent } | { event: null; applied: false };
  'read.mark': { lastReadEventId: number };
  'mute.set': { muted: boolean };
  'session.spawn': Awaited<ReturnType<Api['createAgentSession']>>;
  'session.answer': { ok: true };
  'channel.join': Awaited<ReturnType<Api['addChannelMember']>>;
  'channel.leave': { ok: true };
};

export interface OpHandler<T extends OpType> {
  execute(api: Api, payload: OpPayloadByType[T], op: QueuedOp): Promise<OpResultByType[T]>;
  onConfirmed(
    dispatch: (action: AppAction) => void,
    result: OpResultByType[T],
    payload: OpPayloadByType[T],
    op: QueuedOp,
  ): void;
  onRejected(
    dispatch: (action: AppAction) => void,
    payload: OpPayloadByType[T],
    error: unknown,
    op: QueuedOp,
  ): void;
}

export type OpRegistry = {
  [T in OpType]: OpHandler<T>;
};

export interface EnqueueOpInput<T extends OpType = OpType> {
  opId: string;
  opType: T;
  payload: OpPayloadByType[T];
  createdAt?: string;
}

export function queueKeyForOp<T extends OpType>(opType: T, payload: OpPayloadByType[T]): string {
  switch (opType) {
    case 'msg.send':
      return `msg:${(payload as MsgSendPayload).channelId}`;
    case 'msg.edit': {
      const p = payload as MsgEditPayload;
      return `edit:${p.eventId}`;
    }
    case 'msg.delete':
      return `edit:${(payload as MsgDeletePayload).eventId}`;
    case 'reaction.set':
      return `react:${(payload as ReactionSetPayload).eventId}:${(payload as ReactionSetPayload).emoji}`;
    case 'read.mark':
      return `read:${(payload as ReadMarkPayload).channelId}`;
    case 'mute.set':
      return `mute:${(payload as MuteSetPayload).channelId}`;
    case 'session.spawn':
      return `spawn:${(payload as SessionSpawnPayload).clientSpawnId}`;
    case 'session.answer':
      return `answer:${(payload as SessionAnswerPayload).sessionId}`;
    case 'channel.join': {
      const p = payload as ChannelJoinPayload;
      return `member:${p.channelId}:${p.userId}`;
    }
    case 'channel.leave':
      return `member:${(payload as ChannelLeavePayload).channelId}:${(payload as ChannelLeavePayload).userId}`;
  }
}

export function makeQueuedOp<T extends OpType>(
  input: EnqueueOpInput<T>,
  now = new Date().toISOString(),
): QueuedOp {
  return {
    opId: input.opId,
    opType: input.opType,
    queueKey: queueKeyForOp(input.opType, input.payload),
    payload: input.payload,
    status: 'pending',
    retryCount: 0,
    createdAt: input.createdAt ?? now,
  };
}

export function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError || !(err instanceof ApiError);
}

function isRetryableServerError(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 500 && err.status < 600;
}

function shouldRejectHttp(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500;
}

function retryDelayMs(retryCount: number): number {
  return Math.min(30_000, 500 * 2 ** Math.max(0, retryCount - 1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asPayload<T extends OpType>(op: QueuedOp): OpPayloadByType[T] {
  return op.payload as OpPayloadByType[T];
}

function coalescedPayload(existing: QueuedOp, next: QueuedOp): unknown {
  if (existing.opType === 'mute.set' && next.opType === 'mute.set') {
    const prevPayload = isRecord(existing.payload) ? existing.payload : {};
    const nextPayload = isRecord(next.payload) ? next.payload : {};
    return {
      ...nextPayload,
      previousMuted:
        typeof prevPayload.previousMuted === 'boolean'
          ? prevPayload.previousMuted
          : nextPayload.previousMuted,
    };
  }
  return next.payload;
}

function coalescePendingOps(ops: QueuedOp[], op: QueuedOp): { op: QueuedOp | null; remove: string[] } {
  const pendingSameKey = ops.filter((current) => current.status === 'pending' && current.queueKey === op.queueKey);
  if (op.opType === 'msg.send' || op.opType === 'session.spawn') return { op, remove: [] };

  if (op.opType === 'read.mark') {
    let maxExisting: QueuedOp | null = null;
    for (const current of pendingSameKey) {
      if (current.opType !== 'read.mark' || !isRecord(current.payload)) continue;
      const value = Number(current.payload.lastReadEventId);
      const max = maxExisting && isRecord(maxExisting.payload) ? Number(maxExisting.payload.lastReadEventId) : -Infinity;
      if (Number.isFinite(value) && value > max) maxExisting = current;
    }
    const nextValue = Number((op.payload as ReadMarkPayload).lastReadEventId);
    if (maxExisting && isRecord(maxExisting.payload) && Number(maxExisting.payload.lastReadEventId) >= nextValue) {
      return { op: null, remove: [] };
    }
    return { op, remove: pendingSameKey.filter((current) => current.opType === 'read.mark').map((current) => current.opId) };
  }

  if (op.opType === 'msg.delete') {
    return {
      op,
      remove: pendingSameKey
        .filter((current) => current.opType === 'msg.edit' || current.opType === 'msg.delete')
        .map((current) => current.opId),
    };
  }

  if (
    op.opType === 'msg.edit' ||
    op.opType === 'reaction.set' ||
    op.opType === 'mute.set' ||
    op.opType === 'session.answer' ||
    op.opType === 'channel.join' ||
    op.opType === 'channel.leave'
  ) {
    const remove = pendingSameKey
      .filter((current) => current.opType === op.opType || op.opType === 'channel.join' || op.opType === 'channel.leave')
      .map((current) => current.opId);
    const replaced = pendingSameKey.find((current) => remove.includes(current.opId));
    return {
      op: replaced ? { ...op, payload: coalescedPayload(replaced, op) } : op,
      remove,
    };
  }

  return { op, remove: [] };
}

export class MemoryOpStorage implements OpStorage {
  private readonly ops = new Map<string, QueuedOp>();

  constructor(initial: QueuedOp[] = []) {
    for (const op of initial) this.ops.set(op.opId, structuredClone(op));
  }

  async listOps(): Promise<QueuedOp[]> {
    return [...this.ops.values()].map((op) => structuredClone(op));
  }

  async putOp(op: QueuedOp): Promise<void> {
    this.ops.set(op.opId, structuredClone(op));
  }

  async removeOp(opId: string): Promise<void> {
    this.ops.delete(opId);
  }
}

export interface OpQueueOptions {
  storage: OpStorage;
  api: Api;
  dispatch: (action: AppAction) => void;
  registry?: OpRegistry;
  maxParallelKeys?: number;
  maxServerRetries?: number;
  onRejected?: (op: QueuedOp, error: unknown) => void;
  setTimer?: (cb: () => void, ms: number) => unknown;
}

export class DurableOpQueue {
  private readonly storage: OpStorage;
  private readonly api: Api;
  private readonly dispatch: (action: AppAction) => void;
  private readonly registry: OpRegistry;
  private readonly maxParallelKeys: number;
  private readonly maxServerRetries: number;
  private readonly onRejected?: (op: QueuedOp, error: unknown) => void;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly activeKeys = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  private flushRunning = false;
  private flushAgain = false;

  constructor(options: OpQueueOptions) {
    this.storage = options.storage;
    this.api = options.api;
    this.dispatch = options.dispatch;
    this.registry = options.registry ?? createDefaultOpRegistry();
    this.maxParallelKeys = options.maxParallelKeys ?? 4;
    this.maxServerRetries = options.maxServerRetries ?? 5;
    this.onRejected = options.onRejected;
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  }

  async recoverInflight(): Promise<void> {
    const ops = await this.storage.listOps();
    await Promise.all(
      ops
        .filter((op) => op.status === 'inflight')
        .map((op) => this.storage.putOp({ ...op, status: 'pending' })),
    );
  }

  async enqueue<T extends OpType>(input: EnqueueOpInput<T>): Promise<QueuedOp | null> {
    const next = makeQueuedOp(input);
    const ops = await this.storage.listOps();
    const coalesced = coalescePendingOps(ops, next);
    for (const opId of coalesced.remove) await this.storage.removeOp(opId);
    if (!coalesced.op) return null;
    await this.storage.putOp(coalesced.op);
    return coalesced.op;
  }

  nudge(): void {
    void this.flush().catch((err: unknown) => {
      console.warn('queued op flush failed', err);
    });
  }

  async flush(): Promise<void> {
    if (this.flushRunning) {
      this.flushAgain = true;
      return;
    }
    this.flushRunning = true;
    try {
      do {
        this.flushAgain = false;
        const ops = await this.storage.listOps();
        const due = this.nextDueOps(ops);
        if (due.length === 0) break;
        await Promise.all(due.map((op) => this.runOp(op)));
      } while (this.flushAgain || this.activeKeys.size === 0);
    } finally {
      this.flushRunning = false;
    }
  }

  private nextDueOps(ops: QueuedOp[]): QueuedOp[] {
    const now = Date.now();
    const picked: QueuedOp[] = [];
    const seenKeys = new Set<string>();
    for (const op of ops) {
      if (op.status !== 'pending') continue;
      if (seenKeys.has(op.queueKey) || this.activeKeys.has(op.queueKey)) continue;
      seenKeys.add(op.queueKey);
      const retryAt = this.retryAfter.get(op.opId) ?? 0;
      if (retryAt > now) {
        this.setTimer(() => this.nudge(), retryAt - now);
        continue;
      }
      picked.push(op);
      if (picked.length >= this.maxParallelKeys) break;
    }
    return picked;
  }

  private async runOp(op: QueuedOp): Promise<void> {
    this.activeKeys.add(op.queueKey);
    try {
      const inflight = { ...op, status: 'inflight' as const };
      await this.storage.putOp(inflight);
      const handler = this.registry[op.opType] as OpHandler<OpType>;
      const result = await handler.execute(this.api, asPayload(inflight), inflight);
      await this.storage.removeOp(op.opId);
      this.retryAfter.delete(op.opId);
      handler.onConfirmed(this.dispatch, result, asPayload(inflight), inflight);
    } catch (error) {
      await this.handleFailure(op, error);
    } finally {
      this.activeKeys.delete(op.queueKey);
      this.flushAgain = true;
    }
  }

  private async handleFailure(op: QueuedOp, error: unknown): Promise<void> {
    const retryCount = op.retryCount + 1;
    if (
      isNetworkFailure(error) ||
      (isRetryableServerError(error) && retryCount <= this.maxServerRetries)
    ) {
      const pending = { ...op, status: 'pending' as const, retryCount };
      await this.storage.putOp(pending);
      const delay = retryDelayMs(retryCount);
      this.retryAfter.set(op.opId, Date.now() + delay);
      this.setTimer(() => this.nudge(), delay);
      return;
    }

    if (shouldRejectHttp(error) || isRetryableServerError(error)) {
      await this.storage.removeOp(op.opId);
      const handler = this.registry[op.opType] as OpHandler<OpType>;
      handler.onRejected(this.dispatch, asPayload(op), error, op);
      this.onRejected?.(op, error);
      return;
    }

    const pending = { ...op, status: 'pending' as const, retryCount };
    await this.storage.putOp(pending);
  }
}

export function createDefaultOpRegistry(): OpRegistry {
  return {
    'msg.send': {
      execute: (api, payload) =>
        api.postMessage({
          channelId: payload.channelId,
          text: payload.text,
          clientMsgId: payload.clientMsgId,
          threadRootEventId: payload.threadRootEventId,
          attachments: payload.attachments?.map((a) => a.id),
        }),
      onConfirmed: (dispatch, result) => dispatch({ type: 'server-event', event: result.event }),
      onRejected: (dispatch, payload) =>
        dispatch({
          type: 'send-failed',
          channelId: payload.channelId,
          clientMsgId: payload.clientMsgId,
        }),
    },
    'msg.edit': {
      execute: (api, payload, op) => api.editMessage(payload.eventId, payload.text, { opId: op.opId }),
      onConfirmed: (dispatch, result) => dispatch({ type: 'server-event', event: result.event }),
      onRejected: (dispatch, payload, _error, op) =>
        dispatch({ type: 'overlay-rejected', channelId: payload.channelId, opId: op.opId }),
    },
    'msg.delete': {
      execute: (api, payload, op) => api.deleteMessage(payload.eventId, { opId: op.opId }),
      onConfirmed: (dispatch, result) => dispatch({ type: 'server-event', event: result.event }),
      onRejected: (dispatch, payload, _error, op) =>
        dispatch({ type: 'overlay-rejected', channelId: payload.channelId, opId: op.opId }),
    },
    'reaction.set': {
      execute: (api, payload, op) =>
        api.setReaction(payload.eventId, payload.emoji, payload.action, { opId: op.opId }),
      onConfirmed: (dispatch, result, payload, op) => {
        if (result.event) dispatch({ type: 'server-event', event: result.event });
        else dispatch({ type: 'overlay-confirmed', channelId: payload.channelId, opId: op.opId });
      },
      onRejected: (dispatch, payload, _error, op) =>
        dispatch({ type: 'overlay-rejected', channelId: payload.channelId, opId: op.opId }),
    },
    'read.mark': {
      execute: (api, payload, op) => api.markRead(payload.channelId, payload.lastReadEventId, { opId: op.opId }),
      onConfirmed: (dispatch, result, payload) =>
        dispatch({ type: 'read-cursor', channelId: payload.channelId, lastReadEventId: result.lastReadEventId }),
      onRejected: () => {},
    },
    'mute.set': {
      execute: (api, payload, op) => api.setMute(payload.channelId, payload.muted, { opId: op.opId }),
      onConfirmed: (dispatch, result, payload) =>
        dispatch({ type: 'mute-changed', channelId: payload.channelId, muted: result.muted }),
      onRejected: (dispatch, payload) =>
        dispatch({ type: 'mute-changed', channelId: payload.channelId, muted: payload.previousMuted }),
    },
    'session.spawn': {
      execute: (api, payload, op) =>
        api.createAgentSession({
          channelId: payload.channelId,
          threadRootEventId: payload.threadRootEventId,
          task: payload.task,
          harness: payload.harness,
          clientSpawnId: payload.clientSpawnId,
          opId: op.opId,
        }),
      onConfirmed: (dispatch, result, payload) =>
        dispatch({
          type: 'session-created',
          channelId: payload.channelId,
          tempId: payload.clientSpawnId,
          session: sessionFromWire(result.session),
        }),
      onRejected: (dispatch, payload) =>
        dispatch({
          type: 'session-spawn-failed',
          channelId: payload.channelId,
          tempId: payload.clientSpawnId,
        }),
    },
    'session.answer': {
      execute: (api, payload, op) =>
        api.answerSessionQuestion(payload.sessionId, payload.questionId, payload.answers, { opId: op.opId }),
      onConfirmed: () => {},
      onRejected: () => {},
    },
    'channel.join': {
      execute: (api, payload, op) => api.addChannelMember(payload.channelId, payload.userId, { opId: op.opId }),
      onConfirmed: () => {},
      onRejected: () => {},
    },
    'channel.leave': {
      execute: (api, payload, op) => api.leaveChannelMembership(payload.channelId, { opId: op.opId }),
      onConfirmed: (dispatch, _result, payload) =>
        dispatch({ type: 'channel-removed', channelId: payload.channelId }),
      onRejected: () => {},
    },
  };
}
