// Pure client-side timeline state. No React imports — unit tested directly.

import { Schema } from 'effect';
import { eventIdFromTarget } from './handle.js';

const NullableNumberSchema = Schema.Union(Schema.Number, Schema.Null);
const NullableStringSchema = Schema.Union(Schema.String, Schema.Null);

export const UserRefSchema = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    handle: Schema.String,
    displayName: Schema.String,
  }),
);

export interface UserRef {
  id: string;
  handle: string;
  displayName: string;
}

export const FILES_CHANGED_EVENT_TYPE = 'files.changed';

export interface WireEvent {
  id: number;
  workspaceId: string;
  channelId: string | null;
  threadRootEventId: number | null;
  type: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  author: UserRef | null;
  replyCount?: number;
  lastReplyId?: number;
  // === foundation additions: thread broadcast ===
  broadcast?: boolean;
}

export const WireEventSchema = Schema.mutable(
  Schema.Struct({
    id: Schema.Number,
    workspaceId: Schema.String,
    channelId: NullableStringSchema,
    threadRootEventId: NullableNumberSchema,
    type: Schema.String,
    actorId: NullableStringSchema,
    payload: Schema.mutable(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
    createdAt: Schema.String,
    author: Schema.Union(UserRefSchema, Schema.Null),
    replyCount: Schema.optionalWith(Schema.Number, { exact: true }),
    lastReplyId: Schema.optionalWith(Schema.Number, { exact: true }),
    broadcast: Schema.optionalWith(Schema.Boolean, { exact: true }),
  }),
);

export const MessageHistoryResponseSchema = Schema.mutable(
  Schema.Struct({
    events: Schema.mutable(Schema.Array(WireEventSchema)),
    hasMore: Schema.Boolean,
  }),
);

export const ThreadMessagesResponseSchema = Schema.mutable(
  Schema.Struct({
    events: Schema.mutable(Schema.Array(WireEventSchema)),
  }),
);

export function filesChangedWorkspaceId(ev: WireEvent): string | null {
  if (ev.type !== FILES_CHANGED_EVENT_TYPE) return null;
  const workspaceId = ev.payload.workspaceId;
  return typeof workspaceId === 'string' ? workspaceId : ev.workspaceId;
}

export type MessageStatus = 'pending' | 'failed' | 'confirmed';

/** One emoji's reactors on a message, insertion-ordered. */
export interface MessageReaction {
  emoji: string;
  userIds: string[];
}

/** File attached to a message; the body is fetched via /api/files/:id. */
export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  /** Present for images — lets rows reserve space before the image loads. */
  width?: number;
  height?: number;
}

/** Async speech-to-text result for a voice message. Starts `pending`; a
 * `voice.transcribed` modifier event flips it to `done`/`failed`. */
export interface VoiceTranscript {
  status: 'pending' | 'done' | 'failed';
  text?: string;
  lang?: string;
}

/** Voice-message metadata carried in a `message.posted` payload's `voice`
 * block. The audio body is one of the message's `attachments` (fileId). */
export interface VoiceMeta {
  fileId: string;
  durationMs: number;
  /** 0..1 peaks for the scrubber (≈40-64 buckets). */
  waveform?: number[];
  transcript: VoiceTranscript;
}

/** Timeline-card events emitted by an agent session. `replied` uses the same
 * row path today so clients can safely receive it before dedicated reply UI
 * ships. */
export type SessionEventRowType = 'question_requested' | 'question_answered' | 'question_resolved' | 'replied';

export interface ChatMessage {
  /** Server event id; null while pending/failed. */
  id: number | null;
  clientMsgId: string | null;
  channelId: string;
  threadRootEventId: number | null;
  text: string;
  edited: boolean;
  /** Local edit queued but not yet confirmed by message.edited. */
  pendingEdit?: boolean;
  /** Tombstoned: hidden in the timeline unless it anchors a thread. */
  deleted?: boolean;
  /** Local delete queued but not yet confirmed by message.deleted. */
  pendingDelete?: boolean;
  /** Complete set of unfurl keys hidden by the message author for everyone. */
  suppressedUnfurls?: string[];
  reactions?: MessageReaction[];
  attachments?: AttachmentMeta[];
  /** Present on voice messages; transcript fills in asynchronously. */
  voice?: VoiceMeta;
  author: UserRef;
  createdAt: string;
  replyCount: number;
  /** Highest reply event id already included in replyCount. */
  lastReplyId: number;
  /** Pending thread replies only: this overlay's optimistic +1 is included in
   * the root row's current replyCount. Lets the confirm (or a server count
   * that already covered the send) settle the bump exactly instead of
   * guessing — a queued op restored after reload may confirm into an event
   * the server counted before the page ever loaded. */
  countedInRoot?: boolean;
  // === foundation additions: thread broadcast ===
  broadcast?: boolean;
  status: MessageStatus;
  /** Set for agent-session rows (type session.spawned / optimistic spawns):
   * the row renders as a SessionCard looked up by this id. */
  sessionId?: string;
  /** Spawn rows only: the ask, verbatim, rendered as the spawner's own message
   * above the card. Falls back to the 80-char title on pre-`task` events. */
  sessionTask?: string;
  sessionEventType?: SessionEventRowType;
  sessionEventPayload?: Record<string, unknown>;
  /** Thread-visible steer/suggestion provenance for future chips. */
  steeredSessionId?: string;
  suggestedSessionId?: string;
  suggestionId?: string;
  /** session.spawned only: the client's optimistic id echoed by the server —
   * reconciles a spawn whose POST response was lost (see upsertConfirmed). */
  spawnClientId?: string;
}

export interface ChannelTimeline {
  /** Root messages: confirmed sorted by id asc, then pending/failed in send order. */
  main: ChatMessage[];
  /** Loaded threads keyed by root event id, replies oldest-first. */
  threads: Record<number, ChatMessage[]>;
  /** Every server event id already applied (dedupe across WS + POST + refetch). */
  seenIds: ReadonlySet<number>;
  /** Local overlays for queued edit/delete/reaction ops, keyed by opId. */
  localOverlays: TimelineOverlay[];
  /** Max applied event id; used as after_id on reconnect catch-up. */
  lastEventId: number;
  hasMoreBefore: boolean;
  loaded: boolean;
}

export const emptyTimeline: ChannelTimeline = {
  main: [],
  threads: {},
  seenIds: new Set(),
  localOverlays: [],
  lastEventId: 0,
  hasMoreBefore: false,
  loaded: false,
};

interface TextOverlaySnapshot {
  text: string;
  edited: boolean;
  deleted?: boolean;
}

export type TimelineOverlay =
  | {
      kind: 'edit';
      opId: string;
      targetEventId: number;
      text: string;
      previous: TextOverlaySnapshot;
    }
  | {
      kind: 'delete';
      opId: string;
      targetEventId: number;
      previous: TextOverlaySnapshot;
    }
  | {
      kind: 'reaction';
      opId: string;
      targetEventId: number;
      emoji: string;
      userId: string;
      action: 'add' | 'remove';
      previousHad: boolean;
    };

/** Event types that produce a timeline row. */
function isRowEvent(type: string): boolean {
  return (
    type === 'message.posted' ||
    type === 'session.spawned' ||
    type === 'session.replied' ||
    type === 'session.question_requested' ||
    type === 'session.question_answered' ||
    type === 'session.question_resolved'
  );
}

/** Event types that mutate an existing row instead of producing one. */
function isModifierEvent(type: string): boolean {
  return (
    type === 'message.edited' ||
    type === 'message.unfurls_suppressed' ||
    type === 'message.deleted' ||
    type === 'reaction.added' ||
    type === 'reaction.removed' ||
    type === 'voice.transcribed'
  );
}

export function messageFromEvent(ev: WireEvent): ChatMessage {
  const payload = ev.payload ?? {};
  const sessionId = ev.type.startsWith('session.')
    ? typeof payload.sessionId === 'string'
      ? payload.sessionId
      : typeof payload.session_id === 'string'
        ? payload.session_id
        : undefined
    : undefined;
  const spawnClientId =
    ev.type === 'session.spawned' && typeof payload.client_spawn_id === 'string' ? payload.client_spawn_id : undefined;
  const sessionTask =
    ev.type === 'session.spawned'
      ? typeof payload.task === 'string' && payload.task.trim()
        ? payload.task
        : typeof payload.title === 'string'
          ? payload.title
          : undefined
      : undefined;
  const text =
    typeof payload.text === 'string'
      ? payload.text
      : typeof payload.title === 'string'
        ? payload.title
        : ev.type === 'session.question_requested'
          ? 'Agent asked a question'
          : ev.type === 'session.question_answered'
            ? 'Question answered'
            : ev.type === 'session.question_resolved'
              ? 'Question resolved'
              : ev.type === 'session.replied'
                ? 'Agent replied'
                : '';
  const sessionEventType =
    ev.type === 'session.question_requested'
      ? 'question_requested'
      : ev.type === 'session.question_answered'
        ? 'question_answered'
        : ev.type === 'session.question_resolved'
          ? 'question_resolved'
          : ev.type === 'session.replied'
            ? 'replied'
            : undefined;
  const voice = parseVoice(payload.voice);
  const reactions = parseReactions(payload.reactions);
  const attachments = parseAttachments(payload.attachments);
  const suppressedUnfurls = parseSuppressedUnfurls(payload.suppressed_unfurls);
  const broadcast = ev.broadcast === true || payload.broadcast === true;
  return {
    id: ev.id,
    clientMsgId: typeof payload.client_msg_id === 'string' ? payload.client_msg_id : null,
    channelId: ev.channelId ?? '',
    threadRootEventId: ev.threadRootEventId,
    text,
    edited: payload.edited === true,
    deleted: payload.deleted === true,
    ...(suppressedUnfurls !== undefined ? { suppressedUnfurls } : {}),
    ...(reactions !== undefined ? { reactions } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(voice !== undefined ? { voice } : {}),
    author:
      ev.author ??
      // Agent utterances fall back to the agent persona, never "Unknown" —
      // the row renderer replaces this with the session title + AGENT chip.
      (ev.type === 'session.replied' || ev.type === 'session.question_requested'
        ? { id: sessionId ? `agent:${sessionId}` : 'agent', handle: 'agent', displayName: 'Agent' }
        : { id: ev.actorId ?? 'unknown', handle: 'unknown', displayName: 'Unknown' }),
    createdAt: ev.createdAt,
    replyCount: ev.replyCount ?? 0,
    lastReplyId: ev.lastReplyId ?? 0,
    ...(broadcast ? { broadcast: true } : {}),
    status: 'confirmed',
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(sessionTask !== undefined ? { sessionTask } : {}),
    ...(sessionEventType !== undefined ? { sessionEventType, sessionEventPayload: payload } : {}),
    ...(typeof payload.steered_session_id === 'string' ? { steeredSessionId: payload.steered_session_id } : {}),
    ...(typeof payload.suggested_session_id === 'string' ? { suggestedSessionId: payload.suggested_session_id } : {}),
    ...(typeof payload.suggestion_id === 'string' ? { suggestionId: payload.suggestion_id } : {}),
    ...(spawnClientId !== undefined ? { spawnClientId } : {}),
  };
}

export function parseAttachments(v: unknown): AttachmentMeta[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: AttachmentMeta[] = [];
  for (const a of v) {
    const r = a as Partial<AttachmentMeta>;
    if (typeof r.id === 'string' && typeof r.filename === 'string') {
      out.push({
        id: r.id,
        filename: r.filename,
        contentType: typeof r.contentType === 'string' ? r.contentType : 'application/octet-stream',
        size: Number(r.size) || 0,
        ...(Number(r.width) > 0 ? { width: Number(r.width) } : {}),
        ...(Number(r.height) > 0 ? { height: Number(r.height) } : {}),
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Decode-with-default: malformed suppression payloads are ignored. */
function parseSuppressedUnfurls(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length > 100) return undefined;
  if (v.some((key) => typeof key !== 'string' || key.length === 0 || key.length > 2048)) return undefined;
  const keys = v as string[];
  return new Set(keys).size === keys.length ? keys : undefined;
}

function parseTranscript(v: unknown): VoiceTranscript | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const status = r.status === 'done' || r.status === 'failed' ? r.status : 'pending';
  return {
    status,
    ...(typeof r.text === 'string' ? { text: r.text } : {}),
    ...(typeof r.lang === 'string' ? { lang: r.lang } : {}),
  };
}

function parseVoice(v: unknown): VoiceMeta | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.fileId !== 'string') return undefined;
  const waveform = Array.isArray(r.waveform)
    ? r.waveform.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : undefined;
  return {
    fileId: r.fileId,
    durationMs: Number(r.durationMs) || 0,
    ...(waveform && waveform.length > 0 ? { waveform } : {}),
    transcript: parseTranscript(r.transcript) ?? { status: 'pending' },
  };
}

function parseReactions(v: unknown): MessageReaction[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: MessageReaction[] = [];
  for (const r of v) {
    const emoji = (r as { emoji?: unknown }).emoji;
    const userIds = (r as { userIds?: unknown }).userIds;
    if (typeof emoji === 'string' && Array.isArray(userIds)) {
      out.push({ emoji, userIds: userIds.filter((u): u is string => typeof u === 'string') });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Toggle one user's emoji on a message (pure; used by the reaction fold). */
export function foldReaction(m: ChatMessage, emoji: string, userId: string, add: boolean): ChatMessage {
  const list = m.reactions ?? [];
  const i = list.findIndex((r) => r.emoji === emoji);
  if (add) {
    if (i < 0) return { ...m, reactions: [...list, { emoji, userIds: [userId] }] };
    if (list[i]!.userIds.includes(userId)) return m;
    const next = [...list];
    next[i] = { emoji, userIds: [...next[i]!.userIds, userId] };
    return { ...m, reactions: next };
  }
  if (i < 0 || !list[i]!.userIds.includes(userId)) return m;
  const userIds = list[i]!.userIds.filter((u) => u !== userId);
  const next = userIds.length > 0 ? [...list] : list.filter((_, j) => j !== i);
  if (userIds.length > 0) next[i] = { emoji, userIds };
  return { ...m, reactions: next };
}

/** Confirmed messages sorted by id asc; pending/failed keep send order at the end. */
function resort(list: ChatMessage[]): ChatMessage[] {
  const confirmed = list.filter((m) => m.status === 'confirmed').sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const rest = list.filter((m) => m.status !== 'confirmed');
  return [...confirmed, ...rest];
}

/**
 * Insert a confirmed message: if a pending message with the same clientMsgId
 * (or, for session rows, the same sessionId) exists it is replaced in-place
 * (optimistic reconciliation — no dupes, and because pendings sit at the tail
 * and new ids are maximal, no reorder flicker).
 */
function upsertConfirmed(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const i = list.findIndex(
    (m) =>
      m.status !== 'confirmed' &&
      ((msg.clientMsgId != null && m.clientMsgId === msg.clientMsgId) ||
        (msg.sessionId != null && m.sessionId === msg.sessionId) ||
        // Spawn whose POST response was lost: the WS event carries the
        // optimistic id the pending row is still keyed by.
        (msg.spawnClientId != null && m.sessionId === msg.spawnClientId)),
  );
  if (i >= 0) {
    const copy = [...list];
    // Preserve optimistic reply count bookkeeping if the pending had none.
    copy[i] = msg;
    return resort(copy);
  }
  return resort([...list, msg]);
}

/** Refresh a confirmed row's reply watermark from a materialized history
 * snapshot. ONLY the (replyCount, lastReplyId) pair moves: the snapshot's
 * text/reactions/voice are as of the fetch, and an acked modifier (an offline
 * edit that flushed on reconnect, say) can fold into the row between the fetch
 * and this merge — its event id is already seen, so the modifier replay below
 * would never heal a clobber. Modifier state has no watermark to race on;
 * leave it to the events that own it. */
function refreshConfirmedFromHistory(
  list: ChatMessage[],
  msg: ChatMessage,
): { list: ChatMessage[]; serverReplyWatermarkWon: boolean } {
  const i = list.findIndex((m) => m.status === 'confirmed' && m.id === msg.id);
  // Seen but not confirmed in main: something local removed it on purpose (a
  // folded delete, a snapshot reset). Re-inserting the fetch-time row would
  // resurrect it; the unseen path already covers genuinely-new rows.
  if (i < 0) return { list, serverReplyWatermarkWon: false };

  const current = list[i]!;
  // A WS reply can land after the history fetch but before this merge. Keep
  // whichever complete (replyCount, lastReplyId) pair has the newer
  // watermark; mixing the fields would violate applyEvent's count invariant.
  const serverReplyWatermarkWon = msg.lastReplyId >= current.lastReplyId;
  if (!serverReplyWatermarkWon || (msg.replyCount === current.replyCount && msg.lastReplyId === current.lastReplyId)) {
    return { list, serverReplyWatermarkWon };
  }
  const copy = [...list];
  copy[i] = { ...current, replyCount: msg.replyCount, lastReplyId: msg.lastReplyId };
  return { list: copy, serverReplyWatermarkWon };
}

function upsertPending(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const i = list.findIndex(
    (m) => msg.clientMsgId != null && m.status !== 'confirmed' && m.clientMsgId === msg.clientMsgId,
  );
  if (i < 0) return [...list, msg];
  const copy = [...list];
  copy[i] = msg;
  return copy;
}

function dropUnconfirmedByClientMsgId(list: ChatMessage[], clientMsgId: string | null): ChatMessage[] {
  if (clientMsgId == null) return list;
  return list.filter((m) => !(m.status !== 'confirmed' && m.clientMsgId === clientMsgId));
}

function findPendingReply(t: ChannelTimeline, msg: ChatMessage): ChatMessage | null {
  if (msg.clientMsgId == null || msg.threadRootEventId == null) return null;
  const matches = (m: ChatMessage) =>
    m.status !== 'confirmed' && m.clientMsgId === msg.clientMsgId && m.threadRootEventId === msg.threadRootEventId;
  // Thread copy first: mergeThread stamps countedInRoot there.
  return t.threads[msg.threadRootEventId]?.find(matches) ?? t.main.find(matches) ?? null;
}

function hasConfirmedByClientMsgId(t: ChannelTimeline, msg: ChatMessage): boolean {
  if (msg.clientMsgId == null) return false;
  const matches = (m: ChatMessage) => m.status === 'confirmed' && m.clientMsgId === msg.clientMsgId;
  if (t.main.some(matches)) return true;
  if (msg.threadRootEventId == null) return false;
  return t.threads[msg.threadRootEventId]?.some(matches) ?? false;
}

/** Optimistic +1 for a new pending reply; the confirm settles it exactly. */
function bumpRootReplyCount(main: ChatMessage[], rootId: number): ChatMessage[] {
  return main.map((m) => (m.id === rootId ? { ...m, replyCount: m.replyCount + 1 } : m));
}

export function addPending(t: ChannelTimeline, msg: ChatMessage): ChannelTimeline {
  // A queued op re-materialized after reload can trail its own confirmation:
  // if the send already landed (history or WS delivered the confirmed row
  // first), overlaying it again would render a phantom duplicate and bump the
  // root's reply count for a reply the server already counted.
  if (hasConfirmedByClientMsgId(t, msg)) return t;
  if (msg.threadRootEventId != null) {
    const existingPending = findPendingReply(t, msg);
    const rootPresent = t.main.some((m) => m.id === msg.threadRootEventId);
    const bumped = existingPending == null && rootPresent;
    const pending: ChatMessage = {
      ...msg,
      countedInRoot: bumped || existingPending?.countedInRoot === true,
    };
    const main = existingPending != null ? t.main : bumpRootReplyCount(t.main, msg.threadRootEventId);
    const existing = t.threads[msg.threadRootEventId] ?? [];
    return {
      ...t,
      main: msg.broadcast === true ? upsertPending(main, pending) : main,
      threads: { ...t.threads, [msg.threadRootEventId]: upsertPending(existing, pending) },
    };
  }
  return { ...t, main: upsertPending(t.main, msg) };
}

export function markFailed(t: ChannelTimeline, clientMsgId: string): ChannelTimeline {
  const mark = (list: ChatMessage[]) =>
    list.map((m) =>
      m.clientMsgId === clientMsgId && m.status === 'pending' ? { ...m, status: 'failed' as const } : m,
    );
  const threads: Record<number, ChatMessage[]> = {};
  for (const [k, v] of Object.entries(t.threads)) threads[Number(k)] = mark(v);
  return { ...t, main: mark(t.main), threads };
}

/**
 * POST /api/sessions resolved: point the optimistic spawn row (sessionId ===
 * tempId) at the real session id — unless the WS `session.spawned` event beat
 * the response, in which case the confirmed row already exists and the
 * optimistic one is dropped.
 */
export function resolveSpawn(t: ChannelTimeline, tempId: string, sessionId: string): ChannelTimeline {
  const hasConfirmed = (list: ChatMessage[]) => list.some((m) => m.status === 'confirmed' && m.sessionId === sessionId);
  const confirmed = hasConfirmed(t.main) || Object.values(t.threads).some(hasConfirmed);
  const fix = (list: ChatMessage[]) =>
    confirmed
      ? list.filter((m) => !(m.sessionId === tempId && m.status !== 'confirmed'))
      : list.map((m) => (m.sessionId === tempId ? { ...m, sessionId } : m));
  const threads: Record<number, ChatMessage[]> = {};
  for (const [k, v] of Object.entries(t.threads)) threads[Number(k)] = fix(v);
  return { ...t, main: fix(t.main), threads };
}

export function removeByClientMsgId(t: ChannelTimeline, clientMsgId: string): ChannelTimeline {
  const drop = (list: ChatMessage[]) =>
    list.filter((m) => !(m.clientMsgId === clientMsgId && m.status !== 'confirmed'));
  const threads: Record<number, ChatMessage[]> = {};
  for (const [k, v] of Object.entries(t.threads)) threads[Number(k)] = drop(v);
  return { ...t, main: drop(t.main), threads };
}

function bumpLastEvent(t: ChannelTimeline, id: number): ChannelTimeline {
  return id > t.lastEventId ? { ...t, lastEventId: id } : t;
}

function textSnapshot(m: ChatMessage): TextOverlaySnapshot {
  return {
    text: m.text,
    edited: m.edited,
    ...(m.deleted !== undefined ? { deleted: m.deleted } : {}),
  };
}

function hasReaction(m: ChatMessage, emoji: string, userId: string): boolean {
  return m.reactions?.find((r) => r.emoji === emoji)?.userIds.includes(userId) === true;
}

function mapTargetMessage(
  t: ChannelTimeline,
  targetEventId: number,
  map: (m: ChatMessage) => ChatMessage,
): ChannelTimeline {
  const fold = (list: ChatMessage[]) => list.map((m) => (m.id === targetEventId ? map(m) : m));
  const threads: Record<number, ChatMessage[]> = {};
  for (const [k, v] of Object.entries(t.threads)) threads[Number(k)] = fold(v);
  return { ...t, main: fold(t.main), threads };
}

function findTargetMessage(t: ChannelTimeline, targetEventId: number): ChatMessage | null {
  for (const m of t.main) if (m.id === targetEventId) return m;
  for (const thread of Object.values(t.threads)) {
    for (const m of thread) if (m.id === targetEventId) return m;
  }
  return null;
}

function overlaysForTarget(t: ChannelTimeline, targetEventId: number): TimelineOverlay[] {
  return t.localOverlays.filter((overlay) => overlay.targetEventId === targetEventId);
}

function rematerializeTarget(t: ChannelTimeline, targetEventId: number): ChannelTimeline {
  const overlays = overlaysForTarget(t, targetEventId);
  return mapTargetMessage(t, targetEventId, (m) => {
    let next: ChatMessage = { ...m, pendingEdit: false, pendingDelete: false };
    for (const overlay of overlays) {
      if (overlay.kind === 'edit') {
        next = { ...next, text: overlay.text, pendingEdit: true };
      } else if (overlay.kind === 'delete') {
        next = {
          ...next,
          text: '',
          deleted: true,
          pendingDelete: true,
          pendingEdit: false,
        };
      } else {
        next = foldReaction(next, overlay.emoji, overlay.userId, overlay.action === 'add');
      }
    }
    return next;
  });
}

function rematerializeAll(t: ChannelTimeline): ChannelTimeline {
  let next = t;
  for (const targetEventId of new Set(t.localOverlays.map((overlay) => overlay.targetEventId))) {
    next = rematerializeTarget(next, targetEventId);
  }
  return next;
}

function rebaseTextSnapshot(previous: TextOverlaySnapshot, ev: WireEvent): TextOverlaySnapshot {
  if (ev.type === 'message.deleted') return { ...previous, text: '', deleted: true };
  if (ev.type === 'message.edited') {
    return { ...previous, text: String((ev.payload ?? {}).text ?? previous.text), edited: true };
  }
  return previous;
}

function reconcileLocalOverlays(t: ChannelTimeline, ev: WireEvent, targetEventId: number): ChannelTimeline {
  let changed = false;
  const text = typeof (ev.payload ?? {}).text === 'string' ? String((ev.payload ?? {}).text) : null;
  const emoji = typeof (ev.payload ?? {}).emoji === 'string' ? String((ev.payload ?? {}).emoji) : '';
  const userId = ev.actorId;
  const action = ev.type === 'reaction.added' ? 'add' : ev.type === 'reaction.removed' ? 'remove' : null;

  const localOverlays = t.localOverlays.flatMap((overlay): TimelineOverlay[] => {
    if (overlay.targetEventId !== targetEventId) return [overlay];
    if (overlay.kind === 'edit' && ev.type === 'message.edited' && text === overlay.text) {
      changed = true;
      return [];
    }
    if (overlay.kind === 'delete' && ev.type === 'message.deleted') {
      changed = true;
      return [];
    }
    if (
      overlay.kind === 'reaction' &&
      action === overlay.action &&
      emoji === overlay.emoji &&
      userId === overlay.userId
    ) {
      changed = true;
      return [];
    }
    if (overlay.kind === 'edit' || overlay.kind === 'delete') {
      const previous = rebaseTextSnapshot(overlay.previous, ev);
      if (previous !== overlay.previous) changed = true;
      return [{ ...overlay, previous }];
    }
    return [overlay];
  });

  const next = changed ? { ...t, localOverlays } : t;
  return rematerializeTarget(next, targetEventId);
}

export function applyLocalEditOverlay(
  t: ChannelTimeline,
  opId: string,
  targetEventId: number,
  text: string,
): ChannelTimeline {
  const target = findTargetMessage(t, targetEventId);
  if (!target) return t;
  const existing = t.localOverlays.find(
    (overlay) => overlay.kind === 'edit' && overlay.targetEventId === targetEventId,
  ) as Extract<TimelineOverlay, { kind: 'edit' }> | undefined;
  const overlay: TimelineOverlay = {
    kind: 'edit',
    opId,
    targetEventId,
    text,
    previous: existing?.previous ?? textSnapshot(target),
  };
  const localOverlays = [
    ...t.localOverlays.filter((current) => !(current.kind === 'edit' && current.targetEventId === targetEventId)),
    overlay,
  ];
  return rematerializeTarget({ ...t, localOverlays }, targetEventId);
}

export function applyLocalDeleteOverlay(t: ChannelTimeline, opId: string, targetEventId: number): ChannelTimeline {
  const target = findTargetMessage(t, targetEventId);
  if (!target) return t;
  const previousEdit = t.localOverlays.find(
    (overlay) => overlay.kind === 'edit' && overlay.targetEventId === targetEventId,
  ) as Extract<TimelineOverlay, { kind: 'edit' }> | undefined;
  const previousDelete = t.localOverlays.find(
    (overlay) => overlay.kind === 'delete' && overlay.targetEventId === targetEventId,
  ) as Extract<TimelineOverlay, { kind: 'delete' }> | undefined;
  const overlay: TimelineOverlay = {
    kind: 'delete',
    opId,
    targetEventId,
    previous: previousDelete?.previous ?? previousEdit?.previous ?? textSnapshot(target),
  };
  const localOverlays = [
    ...t.localOverlays.filter(
      (current) => current.targetEventId !== targetEventId || (current.kind !== 'edit' && current.kind !== 'delete'),
    ),
    overlay,
  ];
  return rematerializeTarget({ ...t, localOverlays }, targetEventId);
}

export function applyLocalReactionOverlay(
  t: ChannelTimeline,
  opId: string,
  targetEventId: number,
  emoji: string,
  userId: string,
  action: 'add' | 'remove',
): ChannelTimeline {
  const target = findTargetMessage(t, targetEventId);
  if (!target) return t;
  const existing = t.localOverlays.find(
    (overlay) =>
      overlay.kind === 'reaction' &&
      overlay.targetEventId === targetEventId &&
      overlay.emoji === emoji &&
      overlay.userId === userId,
  ) as Extract<TimelineOverlay, { kind: 'reaction' }> | undefined;
  const overlay: TimelineOverlay = {
    kind: 'reaction',
    opId,
    targetEventId,
    emoji,
    userId,
    action,
    previousHad: existing?.previousHad ?? hasReaction(target, emoji, userId),
  };
  const localOverlays = [
    ...t.localOverlays.filter(
      (current) =>
        !(
          current.kind === 'reaction' &&
          current.targetEventId === targetEventId &&
          current.emoji === emoji &&
          current.userId === userId
        ),
    ),
    overlay,
  ];
  return rematerializeTarget({ ...t, localOverlays }, targetEventId);
}

export function confirmLocalOverlay(t: ChannelTimeline, opId: string): ChannelTimeline {
  const overlay = t.localOverlays.find((current) => current.opId === opId);
  if (!overlay) return t;
  const localOverlays = t.localOverlays.filter((current) => current.opId !== opId);
  return rematerializeTarget({ ...t, localOverlays }, overlay.targetEventId);
}

export function rejectLocalOverlay(t: ChannelTimeline, opId: string): ChannelTimeline {
  const overlay = t.localOverlays.find((current) => current.opId === opId);
  if (!overlay) return t;
  let next: ChannelTimeline = {
    ...t,
    localOverlays: t.localOverlays.filter((current) => current.opId !== opId),
  };
  next = mapTargetMessage(next, overlay.targetEventId, (m) => {
    if (overlay.kind === 'reaction') {
      return foldReaction(m, overlay.emoji, overlay.userId, overlay.previousHad);
    }
    return {
      ...m,
      text: overlay.previous.text,
      edited: overlay.previous.edited,
      deleted: overlay.previous.deleted === true,
      pendingEdit: false,
      pendingDelete: false,
    };
  });
  return rematerializeTarget(next, overlay.targetEventId);
}

/**
 * Apply one server event (from WS, POST response, or catch-up fetch).
 * Idempotent by event id.
 */
export function applyEvent(t: ChannelTimeline, ev: WireEvent): ChannelTimeline {
  if (t.seenIds.has(ev.id)) {
    // Re-delivery of a known event — usually a queued op restored after
    // reload whose re-send the server deduped by clientMsgId into an event
    // history already delivered. The row is confirmed; a pending overlay from
    // the restored op may still sit next to it, so drop that instead of
    // returning a timeline with a phantom duplicate. A seen event is already
    // reflected in its root's count, so an overlay that optimistically
    // bumped it is surplus — take that bump back with the row.
    if (isRowEvent(ev.type)) {
      const msg = messageFromEvent(ev);
      if (msg.clientMsgId != null) {
        const pending = findPendingReply(t, msg);
        let next = removeByClientMsgId(t, msg.clientMsgId);
        if (pending?.countedInRoot === true && msg.threadRootEventId != null) {
          const rootId = msg.threadRootEventId;
          next = {
            ...next,
            main: next.main.map((m) => (m.id === rootId ? { ...m, replyCount: Math.max(0, m.replyCount - 1) } : m)),
          };
        }
        return bumpLastEvent(next, ev.id);
      }
    }
    return bumpLastEvent(t, ev.id);
  }

  if (ev.type === 'message.edited' || ev.type === 'message.unfurls_suppressed' || ev.type === 'message.deleted') {
    const p = ev.payload ?? {};
    const targetId = typeof p.target === 'string' ? eventIdFromTarget(p.target) : null;
    const seenIds = new Set(t.seenIds).add(ev.id);
    if (targetId == null) {
      return bumpLastEvent({ ...t, seenIds }, ev.id);
    }
    const fold = (list: ChatMessage[]) =>
      list.map((m) => {
        if (m.id !== targetId) return m;
        if (ev.type === 'message.deleted') return { ...m, text: '', deleted: true };
        if (ev.type === 'message.unfurls_suppressed') {
          const suppressedUnfurls = parseSuppressedUnfurls(p.suppressed);
          if (suppressedUnfurls !== undefined) return { ...m, suppressedUnfurls };
          const { suppressedUnfurls: _malformed, ...withoutSuppression } = m;
          return withoutSuppression;
        }
        return { ...m, text: String((ev.payload ?? {}).text ?? m.text), edited: true };
      });
    const threads: Record<number, ChatMessage[]> = {};
    for (const [k, v] of Object.entries(t.threads)) threads[Number(k)] = fold(v);
    let main = fold(t.main);
    // Deleting a thread reply: the root's visible reply count shrinks by one.
    if (ev.type === 'message.deleted' && ev.threadRootEventId != null) {
      main = main.map((m) => (m.id === ev.threadRootEventId ? { ...m, replyCount: Math.max(0, m.replyCount - 1) } : m));
    }
    return bumpLastEvent(reconcileLocalOverlays({ ...t, main, threads, seenIds }, ev, targetId), ev.id);
  }

  if (ev.type === 'reaction.added' || ev.type === 'reaction.removed') {
    const p = ev.payload ?? {};
    const targetId = typeof p.target === 'string' ? eventIdFromTarget(p.target) : null;
    const emoji = typeof p.emoji === 'string' ? p.emoji : '';
    const uid = ev.actorId;
    const seenIds = new Set(t.seenIds).add(ev.id);
    if (!emoji || !uid || targetId == null) {
      return bumpLastEvent({ ...t, seenIds }, ev.id);
    }
    const add = ev.type === 'reaction.added';
    const fold = (list: ChatMessage[]) => list.map((m) => (m.id === targetId ? foldReaction(m, emoji, uid, add) : m));
    const threads: Record<number, ChatMessage[]> = {};
    for (const [k, v] of Object.entries(t.threads)) threads[Number(k)] = fold(v);
    return bumpLastEvent(reconcileLocalOverlays({ ...t, main: fold(t.main), threads, seenIds }, ev, targetId), ev.id);
  }

  if (ev.type === 'voice.transcribed') {
    const p = ev.payload ?? {};
    const targetId = typeof p.target === 'string' ? eventIdFromTarget(p.target) : null;
    const seenIds = new Set(t.seenIds).add(ev.id);
    const transcript = parseTranscript(p.transcript);
    if (targetId == null || !transcript) {
      return bumpLastEvent({ ...t, seenIds }, ev.id);
    }
    const fold = (list: ChatMessage[]) =>
      list.map((m) => (m.id === targetId && m.voice ? { ...m, voice: { ...m.voice, transcript } } : m));
    const threads: Record<number, ChatMessage[]> = {};
    for (const [k, v] of Object.entries(t.threads)) threads[Number(k)] = fold(v);
    return bumpLastEvent({ ...t, main: fold(t.main), threads, seenIds }, ev.id);
  }

  if (!isRowEvent(ev.type)) {
    return bumpLastEvent({ ...t, seenIds: new Set(t.seenIds).add(ev.id) }, ev.id);
  }

  const msg = messageFromEvent(ev);
  const seenIds = new Set(t.seenIds).add(ev.id);

  if (msg.threadRootEventId != null) {
    // Thread reply: settle the root's reply count exactly. The server keeps
    // the watermark invariant (replyCount covers reply ids <= lastReplyId),
    // and countedInRoot records whether a pending overlay's optimistic +1 is
    // in the current count — together they decide bump / no-op / un-bump for
    // every ordering, including a queue op restored after reload whose
    // re-send dedupes into an event the loaded root already counted.
    const rootId = msg.threadRootEventId;
    const optimisticallyCounted = findPendingReply(t, msg)?.countedInRoot === true;
    const main = t.main.map((m) => {
      if (m.id !== rootId) return m;
      if (ev.id <= m.lastReplyId) {
        return optimisticallyCounted ? { ...m, replyCount: Math.max(0, m.replyCount - 1) } : m;
      }
      return {
        ...m,
        replyCount: optimisticallyCounted ? m.replyCount : m.replyCount + 1,
        lastReplyId: ev.id,
      };
    });
    const threads = { ...t.threads };
    const thread = threads[rootId];
    if (thread) threads[rootId] = upsertConfirmed(thread, msg);
    const withBroadcast =
      msg.broadcast === true ? upsertConfirmed(main, msg) : dropUnconfirmedByClientMsgId(main, msg.clientMsgId);
    return bumpLastEvent({ ...t, main: withBroadcast, threads, seenIds }, ev.id);
  }

  return bumpLastEvent({ ...t, main: upsertConfirmed(t.main, msg), seenIds }, ev.id);
}

/** Merge a fetched page of root messages (initial load or before_id pagination). */
export function mergeHistory(
  t: ChannelTimeline,
  events: WireEvent[],
  opts: { hasMoreBefore: boolean },
): ChannelTimeline {
  let main = t.main;
  let threads = t.threads;
  const seenIds = new Set(t.seenIds);
  // Server history pages materialize edits/deletes/reactions into the row
  // payloads, so they carry row events only. The IndexedDB cache instead
  // accumulates raw events from the ack/WS path — message.posted with its
  // original text plus separate modifier events — so a cached hydrate must
  // re-apply those modifiers or acked edits/reactions silently vanish on
  // reload.
  const modifiers: WireEvent[] = [];
  for (const ev of events) {
    const alreadySeen = seenIds.has(ev.id);
    // Preserve modifier dedupe exactly: unlike row events, a modifier must
    // never replay on top of a server-materialized row that already includes
    // it.
    if (alreadySeen && !isRowEvent(ev.type)) continue;
    if (isModifierEvent(ev.type)) {
      modifiers.push(ev);
      continue;
    }
    if (!isRowEvent(ev.type)) continue;
    if (ev.threadRootEventId != null) {
      // A thread reply in the page still moves its root's watermark, exactly
      // as applyEvent would have. This is what keeps a WARM reload honest: a
      // healthy cache is replayed through here and never triggers a history
      // refetch (hydration repairs only broken caches), so the raw root — from
      // before its replies existed — is the only root row this fold will ever
      // see. The id guard makes re-merges and materialized server roots (whose
      // pair already covers this reply) no-ops.
      main = main.map((m) =>
        m.id === ev.threadRootEventId && ev.id > m.lastReplyId
          ? { ...m, replyCount: m.replyCount + 1, lastReplyId: ev.id }
          : m,
      );
      // Non-broadcast replies still stay out of the main feed.
      if (ev.broadcast !== true) continue;
    }
    const msg = messageFromEvent(ev);
    if (alreadySeen) {
      const refreshed = refreshConfirmedFromHistory(main, msg);
      main = refreshed.list;
      if (msg.threadRootEventId == null && refreshed.serverReplyWatermarkWon) {
        // Replacing the root's count with a server snapshot removes the local
        // origin of any optimistic +1s. Clear their claims (as resetToLatest
        // does) so a later confirmation at/below the server watermark cannot
        // subtract from the authoritative count.
        const clearCountedInRoot = (m: ChatMessage): ChatMessage =>
          m.status !== 'confirmed' && m.threadRootEventId === msg.id && m.countedInRoot === true
            ? { ...m, countedInRoot: false }
            : m;
        main = main.map(clearCountedInRoot);
        const refreshedThreads: Record<number, ChatMessage[]> = {};
        for (const [k, rows] of Object.entries(threads)) {
          refreshedThreads[Number(k)] = rows.map(clearCountedInRoot);
        }
        threads = refreshedThreads;
      }
      continue;
    }
    seenIds.add(ev.id);
    main = upsertConfirmed(main, msg);
  }
  const maxId = events.reduce((acc, e) => Math.max(acc, e.id), t.lastEventId);
  let next = rematerializeAll({
    ...t,
    main,
    threads,
    seenIds,
    lastEventId: maxId,
    hasMoreBefore: opts.hasMoreBefore,
    loaded: true,
  });
  // Ascending id order: a cached reaction can precede the edit of the same
  // message (server commit order), and applyEvent is idempotent by event id.
  for (const ev of [...modifiers].sort((a, b) => a.id - b.id)) {
    next = applyEvent(next, ev);
  }
  return next;
}

/**
 * Snapshot repair: replace the timeline with the latest history page when
 * catch-up fell too far behind to page through the gap. Confirmed rows older
 * than the snapshot are dropped — keeping them would render a silent hole
 * between them and the snapshot that pagination (which fetches before the
 * oldest row) could never fill. Pending/failed local rows survive, as do
 * confirmed rows newer than the snapshot (a WS event can land between the
 * fetch and this dispatch). seenIds is rebuilt from the kept rows so paging
 * back re-applies the dropped events.
 */
export function resetToLatest(
  t: ChannelTimeline,
  events: WireEvent[],
  opts: { hasMoreBefore: boolean },
): ChannelTimeline {
  const maxPageId = events.reduce((acc, e) => Math.max(acc, e.id), 0);
  // Roots at or below the snapshot horizon get rebuilt from server rows whose
  // counts don't carry local optimistic bumps — the surviving overlays'
  // countedInRoot claims are stale for those roots.
  const clearStaleCountFlags = (m: ChatMessage): ChatMessage =>
    m.status !== 'confirmed' &&
    m.countedInRoot === true &&
    m.threadRootEventId != null &&
    m.threadRootEventId <= maxPageId
      ? { ...m, countedInRoot: false }
      : m;
  let main = t.main
    .filter((m) => m.status !== 'confirmed' || (m.id != null && m.id > maxPageId))
    .map(clearStaleCountFlags);
  const threads: Record<number, ChatMessage[]> = {};
  for (const [k, v] of Object.entries(t.threads)) threads[Number(k)] = v.map(clearStaleCountFlags);
  const seenIds = new Set<number>();
  for (const m of main) if (m.id != null) seenIds.add(m.id);
  for (const ev of events) {
    if (!isRowEvent(ev.type) || (ev.threadRootEventId != null && ev.broadcast !== true)) continue;
    if (seenIds.has(ev.id)) continue;
    seenIds.add(ev.id);
    main = upsertConfirmed(main, messageFromEvent(ev));
  }
  return rematerializeAll({
    ...t,
    main,
    threads,
    seenIds,
    lastEventId: Math.max(t.lastEventId, maxPageId),
    hasMoreBefore: opts.hasMoreBefore,
    loaded: true,
  });
}

/** Merge a fetched thread (replies oldest-first). */
export function mergeThread(t: ChannelTimeline, rootEventId: number, events: WireEvent[]): ChannelTimeline {
  const seenIds = new Set(t.seenIds);
  let thread = t.threads[rootEventId] ?? [];
  let mainRows = t.main;
  for (const ev of events) {
    if (!isRowEvent(ev.type)) continue;
    const msg = messageFromEvent(ev);
    if (!(seenIds.has(ev.id) && thread.some((m) => m.id === ev.id))) {
      seenIds.add(ev.id);
      thread = upsertConfirmed(thread, msg);
    }
    // A broadcast reply is a main-timeline row too (mirrors applyEvent). The
    // thread fetch marks the id seen, so if it lands before the channel
    // history page, mergeHistory would never fold the row into main.
    if (ev.broadcast === true && !mainRows.some((m) => m.id === ev.id)) {
      mainRows = upsertConfirmed(mainRows, msg);
    }
  }
  // Thread fetch is authoritative for the root's count (tombstones excluded):
  // server-confirmed replies plus local overlays. Math.max here could never
  // heal an overcount — e.g. a phantom bump left by a queue op restored after
  // its send already landed — so recompute instead of only raising.
  const confirmedCount = thread.filter((m) => m.status === 'confirmed' && !m.deleted).length;
  const overlayCount = thread.filter((m) => m.status !== 'confirmed' && !m.deleted).length;
  // The recomputed count includes those overlays — stamp them so their
  // confirms don't bump again.
  thread = thread.map((m) =>
    m.status !== 'confirmed' && !m.deleted && m.countedInRoot !== true ? { ...m, countedInRoot: true } : m,
  );
  const maxReplyId = thread.reduce((acc, m) => Math.max(acc, m.id ?? 0), 0);
  const main = mainRows.map((m) =>
    m.id === rootEventId
      ? {
          ...m,
          replyCount: confirmedCount + overlayCount,
          lastReplyId: Math.max(m.lastReplyId, maxReplyId),
        }
      : m,
  );
  const maxId = events.reduce((acc, e) => Math.max(acc, e.id), t.lastEventId);
  return rematerializeAll({
    ...t,
    main,
    threads: { ...t.threads, [rootEventId]: thread },
    seenIds,
    lastEventId: maxId,
  });
}
