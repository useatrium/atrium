// Pure client-side timeline state. No React imports — unit tested directly.

export interface UserRef {
  id: string;
  handle: string;
  displayName: string;
}

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
}

export type MessageStatus = 'pending' | 'failed' | 'confirmed';

export interface ChatMessage {
  /** Server event id; null while pending/failed. */
  id: number | null;
  clientMsgId: string | null;
  channelId: string;
  threadRootEventId: number | null;
  text: string;
  edited: boolean;
  author: UserRef;
  createdAt: string;
  replyCount: number;
  /** Highest reply event id already included in replyCount. */
  lastReplyId: number;
  status: MessageStatus;
}

export interface ChannelTimeline {
  /** Root messages: confirmed sorted by id asc, then pending/failed in send order. */
  main: ChatMessage[];
  /** Loaded threads keyed by root event id, replies oldest-first. */
  threads: Record<number, ChatMessage[]>;
  /** Every server event id already applied (dedupe across WS + POST + refetch). */
  seenIds: ReadonlySet<number>;
  /** Max applied event id; used as after_id on reconnect catch-up. */
  lastEventId: number;
  hasMoreBefore: boolean;
  loaded: boolean;
}

export const emptyTimeline: ChannelTimeline = {
  main: [],
  threads: {},
  seenIds: new Set(),
  lastEventId: 0,
  hasMoreBefore: false,
  loaded: false,
};

export function messageFromEvent(ev: WireEvent): ChatMessage {
  const payload = ev.payload ?? {};
  return {
    id: ev.id,
    clientMsgId: typeof payload.client_msg_id === 'string' ? payload.client_msg_id : null,
    channelId: ev.channelId ?? '',
    threadRootEventId: ev.threadRootEventId,
    text: typeof payload.text === 'string' ? payload.text : '',
    edited: payload.edited === true,
    author: ev.author ?? { id: ev.actorId ?? 'unknown', handle: 'unknown', displayName: 'Unknown' },
    createdAt: ev.createdAt,
    replyCount: ev.replyCount ?? 0,
    lastReplyId: ev.lastReplyId ?? 0,
    status: 'confirmed',
  };
}

/** Confirmed messages sorted by id asc; pending/failed keep send order at the end. */
function resort(list: ChatMessage[]): ChatMessage[] {
  const confirmed = list
    .filter((m) => m.status === 'confirmed')
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const rest = list.filter((m) => m.status !== 'confirmed');
  return [...confirmed, ...rest];
}

/**
 * Insert a confirmed message: if a pending message with the same clientMsgId
 * exists it is replaced in-place (optimistic reconciliation — no dupes, and
 * because pendings sit at the tail and new ids are maximal, no reorder flicker).
 */
function upsertConfirmed(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  if (msg.clientMsgId) {
    const i = list.findIndex(
      (m) => m.status !== 'confirmed' && m.clientMsgId === msg.clientMsgId,
    );
    if (i >= 0) {
      const copy = [...list];
      // Preserve optimistic reply count bookkeeping if the pending had none.
      copy[i] = msg;
      return resort(copy);
    }
  }
  return resort([...list, msg]);
}

export function addPending(t: ChannelTimeline, msg: ChatMessage): ChannelTimeline {
  if (msg.threadRootEventId != null) {
    const existing = t.threads[msg.threadRootEventId] ?? [];
    return {
      ...t,
      threads: { ...t.threads, [msg.threadRootEventId]: [...existing, msg] },
    };
  }
  return { ...t, main: [...t.main, msg] };
}

export function markFailed(t: ChannelTimeline, clientMsgId: string): ChannelTimeline {
  const mark = (list: ChatMessage[]) =>
    list.map((m) =>
      m.clientMsgId === clientMsgId && m.status === 'pending'
        ? { ...m, status: 'failed' as const }
        : m,
    );
  const threads: Record<number, ChatMessage[]> = {};
  for (const [k, v] of Object.entries(t.threads)) threads[Number(k)] = mark(v);
  return { ...t, main: mark(t.main), threads };
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

/**
 * Apply one server event (from WS, POST response, or catch-up fetch).
 * Idempotent by event id.
 */
export function applyEvent(t: ChannelTimeline, ev: WireEvent): ChannelTimeline {
  if (t.seenIds.has(ev.id)) return bumpLastEvent(t, ev.id);

  if (ev.type === 'message.edited') {
    const targetId = Number((ev.payload ?? {}).target_event_id);
    const edit = (list: ChatMessage[]) =>
      list.map((m) =>
        m.id === targetId ? { ...m, text: String((ev.payload ?? {}).text ?? m.text), edited: true } : m,
      );
    const threads: Record<number, ChatMessage[]> = {};
    for (const [k, v] of Object.entries(t.threads)) threads[Number(k)] = edit(v);
    return bumpLastEvent(
      { ...t, main: edit(t.main), threads, seenIds: new Set(t.seenIds).add(ev.id) },
      ev.id,
    );
  }

  if (ev.type !== 'message.posted') {
    return bumpLastEvent({ ...t, seenIds: new Set(t.seenIds).add(ev.id) }, ev.id);
  }

  const msg = messageFromEvent(ev);
  const seenIds = new Set(t.seenIds).add(ev.id);

  if (msg.threadRootEventId != null) {
    // Thread reply: update the root's reply count (guarded by lastReplyId so
    // counts computed server-side and live increments never double-count),
    // and insert into the thread list if that thread is loaded.
    const rootId = msg.threadRootEventId;
    const main = t.main.map((m) => {
      if (m.id !== rootId) return m;
      if (ev.id <= m.lastReplyId) return m;
      return { ...m, replyCount: m.replyCount + 1, lastReplyId: ev.id };
    });
    const threads = { ...t.threads };
    const thread = threads[rootId];
    if (thread) threads[rootId] = upsertConfirmed(thread, msg);
    return bumpLastEvent({ ...t, main, threads, seenIds }, ev.id);
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
  const seenIds = new Set(t.seenIds);
  for (const ev of events) {
    if (ev.type !== 'message.posted' || ev.threadRootEventId != null) continue;
    if (seenIds.has(ev.id)) continue;
    seenIds.add(ev.id);
    main = upsertConfirmed(main, messageFromEvent(ev));
  }
  const maxId = events.reduce((acc, e) => Math.max(acc, e.id), t.lastEventId);
  return {
    ...t,
    main,
    seenIds,
    lastEventId: maxId,
    hasMoreBefore: opts.hasMoreBefore,
    loaded: true,
  };
}

/** Merge a fetched thread (replies oldest-first). */
export function mergeThread(
  t: ChannelTimeline,
  rootEventId: number,
  events: WireEvent[],
): ChannelTimeline {
  const seenIds = new Set(t.seenIds);
  let thread = t.threads[rootEventId] ?? [];
  for (const ev of events) {
    if (seenIds.has(ev.id)) continue;
    seenIds.add(ev.id);
    thread = upsertConfirmed(thread, messageFromEvent(ev));
  }
  // Thread fetch is authoritative for the root's count.
  const confirmedCount = thread.filter((m) => m.status === 'confirmed').length;
  const maxReplyId = thread.reduce((acc, m) => Math.max(acc, m.id ?? 0), 0);
  const main = t.main.map((m) =>
    m.id === rootEventId
      ? {
          ...m,
          replyCount: Math.max(m.replyCount, confirmedCount),
          lastReplyId: Math.max(m.lastReplyId, maxReplyId),
        }
      : m,
  );
  const maxId = events.reduce((acc, e) => Math.max(acc, e.id), t.lastEventId);
  return {
    ...t,
    main,
    threads: { ...t.threads, [rootEventId]: thread },
    seenIds,
    lastEventId: maxId,
  };
}
