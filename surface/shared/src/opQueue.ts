import { ApiError, type Api, type ReactionAction } from './api';
import type { AppAction } from './appState';
import { sessionFromWire } from './sessions';
import type { AttachmentMeta, WireEvent } from './timeline';

export const VALID_OP_TYPES = [
  'msg.send',
  'upload',
  'msg.edit',
  'msg.delete',
  'reaction.set',
  'read.mark',
  'mute.set',
  'session.spawn',
  'session.answer',
  'channel.join',
  'channel.leave',
] as const;

export type OpType = (typeof VALID_OP_TYPES)[number];

export const VALID_OP_STATUSES = ['pending', 'inflight', 'completed'] as const;

export type QueuedOpStatus = (typeof VALID_OP_STATUSES)[number];

export interface QueuedOp {
  opId: string;
  opType: OpType;
  queueKey: string;
  payload: unknown;
  status: QueuedOpStatus;
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
  attachmentRefs?: AttachmentRef[];
  createdAt?: string;
}

export interface AttachmentRef {
  uploadKey: string;
}

export interface UploadPayload {
  uploadKey: string;
  localUri: string;
  contentHash?: string;
  filename: string;
  contentType: string;
  size: number;
  width?: number;
  height?: number;
  fileId?: string;
  uploaded?: boolean;
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
  upload: UploadPayload;
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
  upload: { fileId: string };
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

export interface OpExecuteContext {
  listOps(): Promise<QueuedOp[]>;
  putOp(op: QueuedOp): Promise<void>;
  uploadFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  readUploadBody(payload: UploadPayload): Promise<BodyInit>;
}

export interface OpHandler<T extends OpType> {
  execute(
    api: Api,
    payload: OpPayloadByType[T],
    op: QueuedOp,
    context: OpExecuteContext,
  ): Promise<OpResultByType[T]>;
  dependsOn?(payload: OpPayloadByType[T], op: QueuedOp): string[];
  completedOp?(op: QueuedOp, result: OpResultByType[T]): QueuedOp | null;
  removeDependenciesOnSettled?: boolean;
  onConfirmed(
    dispatch: (action: AppAction) => void,
    result: OpResultByType[T],
    payload: OpPayloadByType[T],
    op: QueuedOp,
  ): void | Promise<void>;
  onRejected(
    dispatch: (action: AppAction) => void,
    payload: OpPayloadByType[T],
    error: unknown,
    op: QueuedOp,
  ): void | Promise<void>;
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
    case 'upload':
      return `upload:${(payload as UploadPayload).uploadKey}`;
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

function isPayloadRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`invalid ${key}`);
  return value;
}

function numberField(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`invalid ${key}`);
  return value;
}

const validOpTypeSet = new Set<OpType>(VALID_OP_TYPES);
const validOpStatusSet = new Set<QueuedOpStatus>(VALID_OP_STATUSES);

export function parseQueuedOp(row: unknown): QueuedOp {
  if (!isRecord(row)) throw new Error('invalid op row');
  const opType = stringField(row, 'opType') as OpType;
  const status = stringField(row, 'status') as QueuedOpStatus;
  const payload = row.payload;
  if (!validOpTypeSet.has(opType)) throw new Error('invalid opType');
  if (!validOpStatusSet.has(status)) throw new Error('invalid op status');
  if (!isPayloadRecord(payload)) throw new Error('invalid op payload');
  return {
    opId: stringField(row, 'opId'),
    opType,
    queueKey: stringField(row, 'queueKey'),
    payload: structuredClone(payload),
    status,
    retryCount: numberField(row, 'retryCount'),
    createdAt: stringField(row, 'createdAt'),
  };
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
  uploadFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readUploadBody?: (payload: UploadPayload) => Promise<BodyInit>;
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
  private readonly uploadFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly readUploadBody: (payload: UploadPayload) => Promise<BodyInit>;
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
    this.uploadFetch = options.uploadFetch ?? ((input, init) => fetch(input, init));
    this.readUploadBody =
      options.readUploadBody ??
      (async (payload) => {
        const res = await fetch(payload.localUri);
        if (!res.ok) throw new Error(`read upload body failed (${res.status})`);
        return res.blob();
      });
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  }

  async recoverInflight(): Promise<void> {
    const ops = await this.storage.listOps();
    await Promise.all(
      ops
        .filter((op) => op.status === 'inflight')
        .map((op) => this.storage.putOp({ ...op, status: 'pending' })),
    );
    await this.rejectOrphanedPendingDependents();
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
      if (!this.dependenciesSatisfied(op, ops)) continue;
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
    let currentOp: QueuedOp = op;
    try {
      const inflight = { ...op, status: 'inflight' as const };
      currentOp = inflight;
      await this.storage.putOp(currentOp);
      const handler = this.registry[op.opType] as OpHandler<OpType>;
      const context: OpExecuteContext = {
        listOps: () => this.storage.listOps(),
        putOp: async (next) => {
          currentOp = next;
          await this.storage.putOp(next);
        },
        uploadFetch: this.uploadFetch,
        readUploadBody: this.readUploadBody,
      };
      const result = await handler.execute(this.api, asPayload(currentOp), currentOp, context);
      const completed = handler.completedOp?.(currentOp, result) ?? null;
      if (completed) {
        currentOp = completed;
        await this.storage.putOp(completed);
      } else {
        await this.storage.removeOp(op.opId);
      }
      this.retryAfter.delete(op.opId);
      await handler.onConfirmed(this.dispatch, result, asPayload(currentOp), currentOp);
      if (handler.removeDependenciesOnSettled) {
        await this.removeDependencies(currentOp);
      }
    } catch (error) {
      await this.handleFailure(currentOp, error);
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
      await this.rejectOpAndDependentsBeforeRemove(op, error);
      return;
    }

    const pending = { ...op, status: 'pending' as const, retryCount };
    await this.storage.putOp(pending);
  }

  private dependenciesFor(op: QueuedOp): string[] {
    const handler = this.registry[op.opType] as OpHandler<OpType>;
    return handler.dependsOn?.(asPayload(op), op) ?? [];
  }

  private dependenciesSatisfied(op: QueuedOp, ops: QueuedOp[]): boolean {
    const dependencies = this.dependenciesFor(op);
    if (dependencies.length === 0) return true;
    for (const queueKey of dependencies) {
      const dependency = ops.find((candidate) => candidate.queueKey === queueKey);
      if (!dependency || dependency.status !== 'completed') return false;
    }
    return true;
  }

  private async removeDependencies(op: QueuedOp): Promise<void> {
    for (const queueKey of this.dependenciesFor(op)) {
      const ops = await this.storage.listOps();
      const dependency = ops.find(
        (candidate) => candidate.queueKey === queueKey && candidate.status === 'completed',
      );
      if (dependency) await this.storage.removeOp(dependency.opId);
    }
  }

  private async rejectOpAndDependentsBeforeRemove(
    op: QueuedOp,
    error: unknown,
    visited = new Set<string>(),
  ): Promise<void> {
    const handler = this.registry[op.opType] as OpHandler<OpType>;
    await handler.onRejected(this.dispatch, asPayload(op), error, op);
    this.onRejected?.(op, error);
    await this.rejectDependents(op.queueKey, error, visited);
    if (handler.removeDependenciesOnSettled) {
      await this.removeDependencies(op);
    }
    await this.storage.removeOp(op.opId);
  }

  private async rejectDependents(
    failedQueueKey: string,
    error: unknown,
    visited = new Set<string>(),
  ): Promise<void> {
    if (visited.has(failedQueueKey)) return;
    visited.add(failedQueueKey);
    const ops = await this.storage.listOps();
    const dependents = ops.filter((candidate) =>
      this.dependenciesFor(candidate).includes(failedQueueKey),
    );
    for (const dependent of dependents) {
      await this.rejectOpAndDependentsBeforeRemove(dependent, error, visited);
    }
  }

  private async rejectOrphanedPendingDependents(): Promise<void> {
    for (;;) {
      const ops = await this.storage.listOps();
      const queueKeys = new Set(ops.map((op) => op.queueKey));
      const orphan = ops.find((op) => {
        if (op.status !== 'pending') return false;
        return this.dependenciesFor(op).some((queueKey) => !queueKeys.has(queueKey));
      });
      if (!orphan) return;
      const missing = this.dependenciesFor(orphan).filter((queueKey) => !queueKeys.has(queueKey));
      await this.rejectOpAndDependentsBeforeRemove(
        orphan,
        new Error(`queued op dependency missing: ${missing.join(', ')}`),
      );
    }
  }
}

export function createDefaultOpRegistry(): OpRegistry {
  return {
    'msg.send': {
      execute: async (api, payload, _op, context) => {
        let attachments = payload.attachments?.map((a) => a.id);
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
        return api.postMessage({
          channelId: payload.channelId,
          text: payload.text,
          clientMsgId: payload.clientMsgId,
          threadRootEventId: payload.threadRootEventId,
          attachments,
        });
      },
      dependsOn: (payload) =>
        payload.attachmentRefs?.map((ref) => `upload:${ref.uploadKey}`) ?? [],
      removeDependenciesOnSettled: true,
      onConfirmed: (dispatch, result) => dispatch({ type: 'server-event', event: result.event }),
      onRejected: (dispatch, payload) =>
        dispatch({
          type: 'send-failed',
          channelId: payload.channelId,
          clientMsgId: payload.clientMsgId,
        }),
    },
    upload: {
      execute: async (api, payload, op, context) => {
        let currentPayload = payload;
        let fileId = payload.fileId;
        let uploadUrl: string;
        if (!fileId) {
          const created = await api.createUpload({
            filename: payload.filename,
            contentType: payload.contentType,
            size: payload.size,
            width: payload.width,
            height: payload.height,
            contentHash: payload.contentHash,
          });
          fileId = created.fileId;
          currentPayload = { ...payload, fileId };
          await context.putOp({ ...op, payload: currentPayload });
          uploadUrl = created.uploadUrl;
        } else {
          const refreshed = await api.refreshUpload(fileId);
          uploadUrl = refreshed.uploadUrl;
        }

        const put = async (url: string) =>
          context.uploadFetch(url, {
            method: 'PUT',
            headers: { 'content-type': currentPayload.contentType },
            body: await context.readUploadBody(currentPayload),
          });

        let res = await put(uploadUrl);
        if (res.status === 403) {
          const refreshed = await api.refreshUpload(fileId);
          res = await put(refreshed.uploadUrl);
        }
        if (!res.ok) {
          throw new ApiError(res.status, 'upload_failed', `upload failed (${res.status})`);
        }
        return { fileId };
      },
      completedOp: (op, result) => {
        const payload = op.payload as UploadPayload;
        return {
          ...op,
          status: 'completed',
          retryCount: 0,
          payload: { ...payload, fileId: result.fileId, uploaded: true },
        };
      },
      onConfirmed: () => {},
      onRejected: () => {},
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
