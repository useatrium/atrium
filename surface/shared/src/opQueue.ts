import { ApiError, type AgentAttachmentRef, type Api, type ReactionAction } from './api';
import type { AppAction } from './appState';
import type { UserPrefs } from './prefs';
import { sessionFromWire, type SessionRepoSpec } from './sessions';
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
  'session.steer',
  'session.cancel',
  'session.stop_turn',
  'prefs.set',
  'draft.set',
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
  // === foundation additions: thread broadcast ===
  broadcast?: boolean;
  voice?: { durationMs: number; waveform?: number[] };
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
  /** Spawn-dialog git metadata (optional). */
  repo?: string;
  branch?: string;
  repos?: SessionRepoSpec[];
  githubIdentityMode?: 'automatic' | 'app_installation' | 'app_user' | 'pat';
  githubIdentityId?: string;
  agentProfileId?: string;
  agentProfileVersionId?: string;
  attachments?: AttachmentMeta[];
  /** Queued upload refs; resolved to uploaded file ids before the HTTP call. */
  attachmentRefs?: AttachmentRef[];
  /** Existing artifact refs; sent through once a picker can populate them. */
  existingAttachmentRefs?: AgentAttachmentRef[];
  createdAt?: string;
}

export interface SessionAnswerPayload {
  sessionId: string;
  questionId: string;
  answers: Record<string, { answers: string[] }>;
}

export interface SessionSteerPayload {
  sessionId: string;
  text: string;
  /** Per-turn reasoning-effort override (codex only). */
  effort?: string;
  attachments?: AttachmentMeta[];
  /** Queued upload refs; resolved to uploaded file ids before the HTTP call. */
  attachmentRefs?: AttachmentRef[];
  /** Existing artifact refs; sent through once a picker can populate them. */
  existingAttachmentRefs?: AgentAttachmentRef[];
}

export interface SessionCancelPayload {
  sessionId: string;
}

export interface SessionStopTurnPayload {
  sessionId: string;
}

export type PrefsSetPayload = Partial<UserPrefs>;

export interface DraftSetPayload {
  draftKey: string;
  text: string;
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
  'session.steer': SessionSteerPayload;
  'session.cancel': SessionCancelPayload;
  'session.stop_turn': SessionStopTurnPayload;
  'prefs.set': PrefsSetPayload;
  'draft.set': DraftSetPayload;
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
  'session.steer': { ok: true };
  'session.cancel': { ok: true };
  'session.stop_turn': { ok: true };
  'prefs.set': Awaited<ReturnType<Api['patchPrefs']>>;
  'draft.set': { ok: true };
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
  execute(api: Api, payload: OpPayloadByType[T], op: QueuedOp, context: OpExecuteContext): Promise<OpResultByType[T]>;
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
    case 'session.steer':
      return `steer:${(payload as SessionSteerPayload).sessionId}`;
    case 'session.cancel':
      return `cancel:${(payload as SessionCancelPayload).sessionId}`;
    case 'session.stop_turn':
      return `stop_turn:${(payload as SessionStopTurnPayload).sessionId}`;
    case 'prefs.set':
      return 'prefs:me';
    case 'draft.set':
      return `draft:${(payload as DraftSetPayload).draftKey}`;
    case 'channel.join': {
      const p = payload as ChannelJoinPayload;
      return `member:${p.channelId}:${p.userId}`;
    }
    case 'channel.leave':
      return `member:${(payload as ChannelLeavePayload).channelId}:${(payload as ChannelLeavePayload).userId}`;
  }
}

interface AttachmentPayload {
  attachments?: AttachmentMeta[];
  attachmentRefs?: AttachmentRef[];
}

function attachmentUploadDependencies(payload: AttachmentPayload): string[] {
  return payload.attachmentRefs?.map((ref) => `upload:${ref.uploadKey}`) ?? [];
}

async function resolvedAttachmentIds(
  payload: AttachmentPayload,
  context: OpExecuteContext,
): Promise<string[] | undefined> {
  if (payload.attachmentRefs && payload.attachmentRefs.length > 0) {
    const ops = await context.listOps();
    return payload.attachmentRefs.map((ref) => {
      const uploadOp = ops.find((candidate) => candidate.queueKey === `upload:${ref.uploadKey}`);
      const uploadPayload = uploadOp?.payload as Partial<UploadPayload> | undefined;
      if (uploadOp?.status !== 'completed' || !uploadPayload?.uploaded || !uploadPayload.fileId) {
        throw new TypeError(`upload ${ref.uploadKey} is not ready`);
      }
      return uploadPayload.fileId;
    });
  }
  return payload.attachments?.map((attachment) => attachment.id);
}

export function makeQueuedOp<T extends OpType>(input: EnqueueOpInput<T>, now = new Date().toISOString()): QueuedOp {
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

function isOpInFlight(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === 'op_in_flight';
}

function shouldRejectHttp(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500 && !isOpInFlight(err);
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
        typeof prevPayload.previousMuted === 'boolean' ? prevPayload.previousMuted : nextPayload.previousMuted,
    };
  }
  if (existing.opType === 'prefs.set' && next.opType === 'prefs.set') {
    const prevPayload = isRecord(existing.payload) ? existing.payload : {};
    const nextPayload = isRecord(next.payload) ? next.payload : {};
    return { ...prevPayload, ...nextPayload };
  }
  return next.payload;
}

function coalescePendingOps(ops: QueuedOp[], op: QueuedOp): { op: QueuedOp | null; remove: string[] } {
  const pendingSameKey = ops.filter((current) => current.status === 'pending' && current.queueKey === op.queueKey);
  if (op.opType === 'msg.send' || op.opType === 'session.spawn' || op.opType === 'session.steer') {
    return { op, remove: [] };
  }

  if (op.opType === 'read.mark') {
    let maxExisting: QueuedOp | null = null;
    for (const current of pendingSameKey) {
      if (current.opType !== 'read.mark' || !isRecord(current.payload)) continue;
      const value = Number(current.payload.lastReadEventId);
      const max =
        maxExisting && isRecord(maxExisting.payload) ? Number(maxExisting.payload.lastReadEventId) : -Infinity;
      if (Number.isFinite(value) && value > max) maxExisting = current;
    }
    const nextValue = Number((op.payload as ReadMarkPayload).lastReadEventId);
    if (maxExisting && isRecord(maxExisting.payload) && Number(maxExisting.payload.lastReadEventId) >= nextValue) {
      return { op: null, remove: [] };
    }
    return {
      op,
      remove: pendingSameKey.filter((current) => current.opType === 'read.mark').map((current) => current.opId),
    };
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
    op.opType === 'session.cancel' ||
    op.opType === 'session.stop_turn' ||
    op.opType === 'prefs.set' ||
    op.opType === 'draft.set' ||
    op.opType === 'channel.join' ||
    op.opType === 'channel.leave'
  ) {
    const remove = pendingSameKey
      .filter(
        (current) => current.opType === op.opType || op.opType === 'channel.join' || op.opType === 'channel.leave',
      )
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
  lockProvider?: OpQueueLockProvider;
}

export interface OpQueueLockProvider {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

function optionalProp<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

export class DurableOpQueue {
  private readonly storage: OpStorage;
  private readonly api: Api;
  private readonly dispatch: (action: AppAction) => void;
  private readonly registry: OpRegistry;
  private readonly maxParallelKeys: number;
  private readonly maxServerRetries: number;
  private readonly onRejected: ((op: QueuedOp, error: unknown) => void) | undefined;
  private readonly uploadFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly readUploadBody: (payload: UploadPayload) => Promise<BodyInit>;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly lockProvider: OpQueueLockProvider | undefined;
  private readonly activeKeys = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  private storageChain: Promise<void> = Promise.resolve();
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
    this.lockProvider = options.lockProvider;
  }

  async recoverInflight(): Promise<void> {
    const ops = await this.storage.listOps();
    await Promise.all(
      ops.filter((op) => op.status === 'inflight').map((op) => this.storage.putOp({ ...op, status: 'pending' })),
    );
    await this.rejectOrphanedPendingDependents();
  }

  async enqueue<T extends OpType>(input: EnqueueOpInput<T>): Promise<QueuedOp | null> {
    return this.withStorageLock(async () => {
      const next = makeQueuedOp(input);
      const ops = await this.storage.listOps();
      const coalesced = coalescePendingOps(ops, next);
      for (const opId of coalesced.remove) await this.storage.removeOp(opId);
      if (!coalesced.op) return null;
      await this.storage.putOp(coalesced.op);
      return coalesced.op;
    });
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
      if (this.lockProvider) {
        await this.lockProvider.request('atrium:queue-writer', () => this.flushUnlocked());
      } else {
        await this.flushUnlocked();
      }
    } finally {
      this.flushRunning = false;
    }
  }

  private async flushUnlocked(): Promise<void> {
    do {
      this.flushAgain = false;
      const ops = await this.storage.listOps();
      const due = this.nextDueOps(ops);
      if (due.length === 0) break;
      await Promise.all(due.map((op) => this.runOp(op)));
    } while (this.flushAgain || this.activeKeys.size === 0);
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
      await this.withStorageLock(async () => {
        await this.storage.putOp(currentOp);
      });
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
      isOpInFlight(error) ||
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

  private withStorageLock<T>(work: () => Promise<T>): Promise<T> {
    const run = this.storageChain.then(work, work);
    this.storageChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
      const dependency = ops.find((candidate) => candidate.queueKey === queueKey && candidate.status === 'completed');
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

  private async rejectDependents(failedQueueKey: string, error: unknown, visited = new Set<string>()): Promise<void> {
    if (visited.has(failedQueueKey)) return;
    visited.add(failedQueueKey);
    const ops = await this.storage.listOps();
    const dependents = ops.filter((candidate) => this.dependenciesFor(candidate).includes(failedQueueKey));
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
      execute: async (api, payload, op, context) => {
        const attachments = await resolvedAttachmentIds(payload, context);
        return api.postMessage({
          channelId: payload.channelId,
          text: payload.text,
          clientMsgId: payload.clientMsgId,
          ...optionalProp('threadRootEventId', payload.threadRootEventId),
          ...optionalProp('broadcast', payload.broadcast),
          ...optionalProp('attachments', attachments),
          ...optionalProp('voice', payload.voice),
          opId: op.opId,
        });
      },
      dependsOn: attachmentUploadDependencies,
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
            ...optionalProp('width', payload.width),
            ...optionalProp('height', payload.height),
            ...optionalProp('contentHash', payload.contentHash),
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
      execute: (api, payload, op) => api.setReaction(payload.eventId, payload.emoji, payload.action, { opId: op.opId }),
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
      execute: async (api, payload, op, context) => {
        const attachments = await resolvedAttachmentIds(payload, context);
        return api.createAgentSession({
          channelId: payload.channelId,
          task: payload.task,
          ...optionalProp('threadRootEventId', payload.threadRootEventId),
          ...optionalProp('harness', payload.harness),
          ...optionalProp('repo', payload.repo),
          ...optionalProp('branch', payload.branch),
          ...optionalProp('repos', payload.repos),
          ...optionalProp('githubIdentityMode', payload.githubIdentityMode),
          ...optionalProp('githubIdentityId', payload.githubIdentityId),
          ...optionalProp('agentProfileId', payload.agentProfileId),
          ...optionalProp('agentProfileVersionId', payload.agentProfileVersionId),
          clientSpawnId: payload.clientSpawnId,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          ...(payload.existingAttachmentRefs && payload.existingAttachmentRefs.length > 0
            ? { attachmentRefs: payload.existingAttachmentRefs }
            : {}),
          opId: op.opId,
        });
      },
      dependsOn: attachmentUploadDependencies,
      removeDependenciesOnSettled: true,
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
    'session.steer': {
      execute: async (api, payload, op, context) => {
        const attachments = await resolvedAttachmentIds(payload, context);
        return api.steerSession(
          payload.sessionId,
          payload.text,
          { opId: op.opId },
          {
            ...(payload.effort ? { effort: payload.effort } : {}),
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
            ...(payload.existingAttachmentRefs && payload.existingAttachmentRefs.length > 0
              ? { attachmentRefs: payload.existingAttachmentRefs }
              : {}),
          },
        );
      },
      dependsOn: attachmentUploadDependencies,
      removeDependenciesOnSettled: true,
      onConfirmed: () => {},
      onRejected: () => {},
    },
    'session.cancel': {
      execute: (api, payload, op) => api.cancelSession(payload.sessionId, { opId: op.opId }),
      onConfirmed: () => {},
      onRejected: () => {},
    },
    'session.stop_turn': {
      execute: (api, payload, op) => api.stopTurn(payload.sessionId, { opId: op.opId }),
      onConfirmed: () => {},
      onRejected: () => {},
    },
    'prefs.set': {
      execute: (api, payload, op) => api.patchPrefs(payload, { opId: op.opId }),
      onConfirmed: () => {},
      onRejected: () => {},
    },
    'draft.set': {
      execute: (api, payload, op) => api.setDraft(payload.draftKey, payload.text, { opId: op.opId }),
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
      onConfirmed: (dispatch, _result, payload) => dispatch({ type: 'channel-removed', channelId: payload.channelId }),
      onRejected: () => {},
    },
  };
}
