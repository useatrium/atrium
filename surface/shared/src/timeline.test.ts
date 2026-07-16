import { describe, expect, it } from 'vitest';
import {
  addPending,
  isAgentVoiceBroadcast,
  isHumanBroadcastReply,
  applyEvent,
  emptyTimeline,
  mergeHistory,
  mergeThread,
  messageFromEvent,
  type ChannelTimeline,
  type ChatMessage,
  type WireEvent,
} from './timeline';
import { encodeEventHandle } from './handle';
import { expectNoDuplicateConfirmedIds } from './timelineTestUtils';

const me = { id: 'u1', handle: 'tester', displayName: 'Tester' };

function postedEvent(
  id: number,
  text: string,
  opts: {
    clientMsgId?: string;
    threadRootEventId?: number;
    broadcast?: boolean;
    replyCount?: number;
    lastReplyId?: number;
    lastModifierId?: number;
    edited?: boolean;
  } = {},
): WireEvent {
  return {
    id,
    workspaceId: 'w1',
    channelId: 'c1',
    threadRootEventId: opts.threadRootEventId ?? null,
    type: 'message.posted',
    actorId: me.id,
    payload: {
      text,
      ...(opts.clientMsgId ? { client_msg_id: opts.clientMsgId } : {}),
      ...(opts.edited === true ? { edited: true } : {}),
    },
    createdAt: '2026-07-12T00:00:00.000Z',
    author: me,
    ...(opts.replyCount != null ? { replyCount: opts.replyCount } : {}),
    ...(opts.lastReplyId != null ? { lastReplyId: opts.lastReplyId } : {}),
    ...(opts.lastModifierId != null ? { lastModifierId: opts.lastModifierId } : {}),
    ...(opts.broadcast ? { broadcast: true } : {}),
  };
}

function pendingReply(clientMsgId: string, rootId: number, opts: { broadcast?: boolean } = {}): ChatMessage {
  return {
    id: null,
    clientMsgId,
    channelId: 'c1',
    threadRootEventId: rootId,
    text: `pending ${clientMsgId}`,
    edited: false,
    author: me,
    createdAt: '2026-07-12T00:00:01.000Z',
    replyCount: 0,
    lastReplyId: 0,
    status: 'pending',
    ...(opts.broadcast ? { broadcast: true } : {}),
  };
}

function rootRow(t: ChannelTimeline, rootId: number): ChatMessage {
  const row = t.main.find((m) => m.id === rootId);
  if (!row) throw new Error(`root ${rootId} not in main`);
  return row;
}

function rowsWithClientMsgId(t: ChannelTimeline, clientMsgId: string): ChatMessage[] {
  return [
    ...t.main.filter((m) => m.clientMsgId === clientMsgId),
    ...Object.values(t.threads).flatMap((list) => list.filter((m) => m.clientMsgId === clientMsgId)),
  ];
}

/**
 * The reload-resurrection scenario behind the chronic thread-broadcast e2e
 * flake: a broadcast reply's send op survives a reload (the WS confirm beat
 * the HTTP response that would have removed it), history already delivered
 * the confirmed reply, and the restored op re-materializes an overlay and
 * re-sends into a server-side clientMsgId dedupe.
 */
describe('queued send restored after its confirmation landed', () => {
  const rootEvent = postedEvent(10, 'root', { replyCount: 1, lastReplyId: 11 });
  const confirmedReply = postedEvent(11, 'pending cm-1', {
    clientMsgId: 'cm-1',
    threadRootEventId: 10,
    broadcast: true,
  });

  function timelineAfterReload(): ChannelTimeline {
    // History page: root (count already includes the reply) + broadcast reply.
    return mergeHistory(emptyTimeline, [rootEvent, confirmedReply], { hasMoreBefore: false });
  }

  it('addPending skips the overlay when a confirmed copy already exists', () => {
    const t = timelineAfterReload();
    const next = addPending(t, pendingReply('cm-1', 10, { broadcast: true }));
    expect(next).toBe(t);
    expect(rowsWithClientMsgId(next, 'cm-1')).toHaveLength(1);
    expect(rootRow(next, 10).replyCount).toBe(1);
    expectNoDuplicateConfirmedIds(next);
  });

  it('re-delivery of a seen event drops a lingering pending copy', () => {
    // Overlay materialized before history marked the event seen (reverse
    // ordering): the phantom is present when the deduped re-send confirms.
    let t = addPending(emptyTimeline, pendingReply('cm-1', 10, { broadcast: true }));
    t = mergeHistory(t, [rootEvent, confirmedReply], { hasMoreBefore: false });
    // mergeHistory folds the pending main copy; simulate a leftover thread
    // copy plus the confirm re-delivery.
    const redelivered = applyEvent(t, confirmedReply);
    const copies = rowsWithClientMsgId(redelivered, 'cm-1');
    expect(copies).toHaveLength(1);
    expect(copies[0]!.status).toBe('confirmed');
    expect(rootRow(redelivered, 10).replyCount).toBe(1);
    expectNoDuplicateConfirmedIds(redelivered);
  });

  it('confirm of a server-counted reply takes back the optimistic bump', () => {
    // Non-broadcast variant: history carries the root (count includes the
    // reply) but not the reply row itself, so the restored overlay bumps.
    let t = mergeHistory(emptyTimeline, [rootEvent], { hasMoreBefore: false });
    t = addPending(t, pendingReply('cm-1', 10));
    expect(rootRow(t, 10).replyCount).toBe(2); // phantom bump while queued
    const confirmed = applyEvent(
      t,
      postedEvent(11, 'pending cm-1', {
        clientMsgId: 'cm-1',
        threadRootEventId: 10,
      }),
    );
    expect(rootRow(confirmed, 10).replyCount).toBe(1);
    expect(rowsWithClientMsgId(confirmed, 'cm-1').every((m) => m.status === 'confirmed')).toBe(true);
    expectNoDuplicateConfirmedIds(confirmed);
  });
});

describe('fresh optimistic reply counting', () => {
  const rootEvent = postedEvent(10, 'root', { replyCount: 0, lastReplyId: 0 });

  it('bumps on addPending and does not double-count on confirm', () => {
    let t = mergeHistory(emptyTimeline, [rootEvent], { hasMoreBefore: false });
    t = addPending(t, pendingReply('cm-2', 10));
    expect(rootRow(t, 10).replyCount).toBe(1);
    const confirmed = applyEvent(
      t,
      postedEvent(12, 'pending cm-2', {
        clientMsgId: 'cm-2',
        threadRootEventId: 10,
      }),
    );
    expect(rootRow(confirmed, 10).replyCount).toBe(1);
    expect(rootRow(confirmed, 10).lastReplyId).toBe(12);
  });

  it('counts a reply whose overlay never materialized', () => {
    const t = mergeHistory(emptyTimeline, [rootEvent], { hasMoreBefore: false });
    const confirmed = applyEvent(
      t,
      postedEvent(12, 'someone else', {
        clientMsgId: 'cm-3',
        threadRootEventId: 10,
      }),
    );
    expect(rootRow(confirmed, 10).replyCount).toBe(1);
  });
});

describe('message unfurl suppression', () => {
  it('folds a live suppression event into the target message', () => {
    const timeline = mergeHistory(emptyTimeline, [postedEvent(10, 'linked entry')], { hasMoreBefore: false });
    const next = applyEvent(timeline, {
      ...postedEvent(11, ''),
      type: 'message.unfurls_suppressed',
      payload: { target: 'evt_10', suppressed: ['evt_123', 'https://example.com'] },
    });

    expect(rootRow(next, 10).suppressedUnfurls).toEqual(['evt_123', 'https://example.com']);
  });

  it('degrades malformed suppression payloads to undefined', () => {
    const timeline = mergeHistory(emptyTimeline, [postedEvent(10, 'linked entry')], { hasMoreBefore: false });
    const next = applyEvent(timeline, {
      ...postedEvent(11, ''),
      type: 'message.unfurls_suppressed',
      payload: { target: 'evt_10', suppressed: ['evt_123', 42] },
    });

    expect(rootRow(next, 10).suppressedUnfurls).toBeUndefined();
  });
});

describe('mergeHistory refreshes materialized rows already seen from the raw cache', () => {
  it('refreshes a stale cached reply watermark from the server row', () => {
    const cached = applyEvent(emptyTimeline, postedEvent(10, 'stale root'));
    const refreshed = mergeHistory(
      cached,
      [postedEvent(10, 'server-materialized root', { replyCount: 2, lastReplyId: 12 })],
      { hasMoreBefore: false },
    );

    expect(rootRow(refreshed, 10).replyCount).toBe(2);
    expect(rootRow(refreshed, 10).lastReplyId).toBe(12);
    // ONLY the watermark pair refreshes — modifier state (text, reactions)
    // belongs to the events that own it; see the offline-edit race below.
    expect(rootRow(refreshed, 10).text).toBe('stale root');
    expect(refreshed.main.filter((m) => m.id === 10)).toHaveLength(1);
  });

  // The reload race that broke `offline edit … survive reload` in e2e: an
  // offline edit flushes on reconnect and folds into the cached row via its
  // acked modifier event, while a history fetch started earlier still carries
  // the pre-edit snapshot. The modifier's id is already seen, so if the merge
  // replaced the row wholesale nothing would ever put the edit back.
  it('never clobbers a modifier that folded in after the history fetch', () => {
    let cached = applyEvent(emptyTimeline, postedEvent(10, 'original text'));
    cached = applyEvent(cached, {
      id: 11,
      workspaceId: 'w1',
      channelId: 'c1',
      threadRootEventId: null,
      type: 'message.edited',
      actorId: me.id,
      payload: { target: encodeEventHandle(10), text: 'edited after fetch' },
      createdAt: '2026-07-12T00:00:01.000Z',
      author: me,
    });
    expect(rootRow(cached, 10).text).toBe('edited after fetch');

    const refreshed = mergeHistory(cached, [postedEvent(10, 'original text', { replyCount: 3, lastReplyId: 9 })], {
      hasMoreBefore: false,
    });

    expect(rootRow(refreshed, 10).text).toBe('edited after fetch');
    expect(rootRow(refreshed, 10).replyCount).toBe(3);
  });

  it('does not resurrect a locally deleted row from a fetch-time snapshot', () => {
    let cached = applyEvent(emptyTimeline, postedEvent(10, 'root'));
    cached = applyEvent(cached, {
      id: 11,
      workspaceId: 'w1',
      channelId: 'c1',
      threadRootEventId: null,
      type: 'message.deleted',
      actorId: me.id,
      payload: { target: encodeEventHandle(10) },
      createdAt: '2026-07-12T00:00:01.000Z',
      author: me,
    });
    const deletedBefore = refreshedRow(cached);

    const refreshed = mergeHistory(cached, [postedEvent(10, 'root', { replyCount: 1, lastReplyId: 12 })], {
      hasMoreBefore: false,
    });
    expect(refreshedRow(refreshed)).toEqual(deletedBefore);

    function refreshedRow(t: ChannelTimeline) {
      const m = t.main.find((row) => row.id === 10);
      return m ? { text: m.text, deleted: m.deleted } : null;
    }
  });

  it('keeps a cached watermark that already includes a newer WS reply', () => {
    let cached = applyEvent(emptyTimeline, postedEvent(10, 'root'));
    cached = applyEvent(cached, postedEvent(20, 'newer reply', { threadRootEventId: 10 }));

    const refreshed = mergeHistory(cached, [postedEvent(10, 'root', { replyCount: 0, lastReplyId: 15 })], {
      hasMoreBefore: false,
    });

    expect(rootRow(refreshed, 10).replyCount).toBe(1);
    expect(rootRow(refreshed, 10).lastReplyId).toBe(20);
  });

  // The warm-reload path: a healthy IndexedDB cache is replayed through
  // mergeHistory and hydration never refetches a history page, so the raw
  // root (cached before its replies existed) is the only root row available.
  // The replies in the same replay must move its watermark themselves.
  it('folds cached thread replies into the raw root on a warm reload', () => {
    const refreshed = mergeHistory(
      emptyTimeline,
      [postedEvent(4, 'root'), postedEvent(5, 'reply from cache', { threadRootEventId: 4 })],
      { hasMoreBefore: false },
    );

    expect(rootRow(refreshed, 4).replyCount).toBe(1);
    expect(rootRow(refreshed, 4).lastReplyId).toBe(5);
    // …without leaking the non-broadcast reply into the main feed.
    expect(refreshed.main.some((m) => m.id === 5)).toBe(false);

    const again = mergeHistory(
      refreshed,
      [postedEvent(4, 'root'), postedEvent(5, 'reply from cache', { threadRootEventId: 4 })],
      { hasMoreBefore: false },
    );
    expect(rootRow(again, 4).replyCount).toBe(1);
  });

  it('does not double count a reply a materialized root already covers', () => {
    const refreshed = mergeHistory(
      emptyTimeline,
      [postedEvent(4, 'root', { replyCount: 1, lastReplyId: 5 }), postedEvent(5, 'reply', { threadRootEventId: 4 })],
      { hasMoreBefore: false },
    );

    expect(rootRow(refreshed, 4).replyCount).toBe(1);
    expect(rootRow(refreshed, 4).lastReplyId).toBe(5);
  });

  it('is idempotent when the same server page is merged twice', () => {
    const cached = applyEvent(emptyTimeline, postedEvent(10, 'stale root'));
    const page = [postedEvent(10, 'fresh root', { replyCount: 2, lastReplyId: 12 })];

    const once = mergeHistory(cached, page, { hasMoreBefore: false });
    const twice = mergeHistory(once, page, { hasMoreBefore: false });

    expect(twice).toEqual(once);
  });

  it('does not double count a pending reply already covered by the server watermark', () => {
    let cached = applyEvent(emptyTimeline, postedEvent(10, 'root'));
    cached = addPending(cached, pendingReply('cm-covered', 10));
    expect(rootRow(cached, 10).replyCount).toBe(1);

    const refreshed = mergeHistory(cached, [postedEvent(10, 'root', { replyCount: 1, lastReplyId: 11 })], {
      hasMoreBefore: false,
    });
    expect(rootRow(refreshed, 10).replyCount).toBe(1);
    const pending = rowsWithClientMsgId(refreshed, 'cm-covered');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe('pending');
    expect(pending[0]!.countedInRoot).toBe(false);

    const confirmed = applyEvent(
      refreshed,
      postedEvent(11, 'pending cm-covered', {
        clientMsgId: 'cm-covered',
        threadRootEventId: 10,
      }),
    );
    expect(rootRow(confirmed, 10).replyCount).toBe(1);
  });
});

describe('mergeThread count authority', () => {
  it('heals an overcount down instead of only raising', () => {
    const rootEvent = postedEvent(10, 'root', { replyCount: 2, lastReplyId: 11 });
    const t = mergeHistory(emptyTimeline, [rootEvent], { hasMoreBefore: false });
    // Server says the thread truly has one reply.
    const healed = mergeThread(t, 10, [postedEvent(11, 'only reply', { clientMsgId: 'cm-4', threadRootEventId: 10 })]);
    expect(rootRow(healed, 10).replyCount).toBe(1);
    expectNoDuplicateConfirmedIds(healed);
  });

  it('counts local overlays exactly once across fetch and confirm', () => {
    const rootEvent = postedEvent(10, 'root', { replyCount: 0, lastReplyId: 0 });
    let t = mergeHistory(emptyTimeline, [rootEvent], { hasMoreBefore: false });
    t = addPending(t, pendingReply('cm-5', 10));
    const fetched = mergeThread(t, 10, []);
    expect(rootRow(fetched, 10).replyCount).toBe(1); // the pending overlay
    const confirmed = applyEvent(
      fetched,
      postedEvent(13, 'pending cm-5', {
        clientMsgId: 'cm-5',
        threadRootEventId: 10,
      }),
    );
    expect(rootRow(confirmed, 10).replyCount).toBe(1);
    expectNoDuplicateConfirmedIds(confirmed);
  });

  it('refreshes an already-seen reply from a newer materialized thread row', () => {
    const rootEvent = postedEvent(10, 'root', { replyCount: 1, lastReplyId: 11 });
    let t = mergeHistory(emptyTimeline, [rootEvent], { hasMoreBefore: false });
    t = mergeThread(t, 10, [
      postedEvent(11, 'stale reply', { threadRootEventId: 10, lastModifierId: 20, edited: true }),
    ]);

    expect(t.seenIds.has(11)).toBe(true);
    expect(t.threads[10]?.some((row) => row.id === 11)).toBe(true);

    const refreshed = mergeThread(t, 10, [
      postedEvent(11, 'fresh server edit', { threadRootEventId: 10, lastModifierId: 21, edited: true }),
    ]);

    expect(refreshed.threads[10]).toHaveLength(1);
    expect(refreshed.threads[10]?.[0]).toMatchObject({
      id: 11,
      text: 'fresh server edit',
      edited: true,
      lastModifierId: 21,
    });
    expectNoDuplicateConfirmedIds(refreshed);
  });
});

// === agent-identity seam ===
// The spawn event carries the ask verbatim so the feed can render it as the
// spawner's own message and the card never has to echo it back. Sessions
// spawned before `task` existed must keep working off the 80-char title.
describe('spawn rows carry the verbatim ask', () => {
  function spawnEvent(payload: Record<string, unknown>): WireEvent {
    return {
      id: 7,
      workspaceId: 'w1',
      channelId: 'c1',
      threadRootEventId: null,
      type: 'session.spawned',
      actorId: me.id,
      payload: { sessionId: 's1', ...payload },
      createdAt: '2026-07-13T00:00:00.000Z',
      author: me,
    };
  }

  it('prefers the full task over the truncated title', () => {
    const task = 'Build a weather dashboard, and make the alerts pane collapsible.';
    const msg = messageFromEvent(spawnEvent({ task, title: task.slice(0, 20) }));
    expect(msg.sessionTask).toBe(task);
  });

  it('falls back to the title for events written before `task` existed', () => {
    const msg = messageFromEvent(spawnEvent({ title: 'Build a weather dash' }));
    expect(msg.sessionTask).toBe('Build a weather dash');
  });

  it('ignores an empty task rather than rendering a blank ask', () => {
    const msg = messageFromEvent(spawnEvent({ task: '   ', title: 'Build a weather dash' }));
    expect(msg.sessionTask).toBe('Build a weather dash');
  });
});

// The answer is the point of the run: a broadcast session.replied has to reach
// the main channel timeline, not stay buried in the session thread.
describe('the final agent reply reaches the channel', () => {
  it('puts a broadcast reply on the main timeline', () => {
    const reply: WireEvent = {
      id: 9,
      workspaceId: 'w1',
      channelId: 'c1',
      threadRootEventId: 7,
      type: 'session.replied',
      actorId: null,
      payload: { session_id: 's1', text: 'Done — shipped the dashboard.', broadcast: true },
      createdAt: '2026-07-13T00:01:00.000Z',
      author: { id: 'agent:s1', handle: 'agent', displayName: 'Agent' },
      broadcast: true,
    };
    const t = applyEvent(emptyTimeline, reply);
    const main = t.main.filter((m) => m.id === 9);
    expect(main).toHaveLength(1);
    expect(main[0]!.text).toBe('Done — shipped the dashboard.');
    expect(main[0]!.sessionEventType).toBe('replied');
  });

  it('folds the newest live reply into the root preview', () => {
    let timeline = applyEvent(emptyTimeline, postedEvent(7, 'Root'));
    timeline = applyEvent(timeline, {
      id: 9,
      workspaceId: 'w1',
      channelId: 'c1',
      threadRootEventId: 7,
      type: 'message.posted',
      actorId: 'u2',
      payload: { text: 'Newest reply' },
      createdAt: '2026-07-13T00:01:00.000Z',
      author: { id: 'u2', handle: 'bea', displayName: 'Bea' },
    });

    expect(rootRow(timeline, 7).lastReply).toMatchObject({ id: 9, text: 'Newest reply' });
  });

  it('parses the server-materialized last reply preview on a cold feed row', () => {
    const root = postedEvent(7, 'Root', { replyCount: 1, lastReplyId: 9 });
    root.lastReply = {
      id: 9,
      authorId: 'agent:s1',
      authorDisplayName: 'Agent',
      text: 'Finished.',
      createdAt: '2026-07-13T00:01:00.000Z',
      agentVoice: true,
      eventType: 'session.replied',
    };

    const parsed = messageFromEvent(root);
    expect(parsed.lastReply).toMatchObject({ id: 9, text: 'Finished.', sessionEventType: 'replied' });
  });
});

describe('broadcast classification', () => {
  const base: ChatMessage = {
    id: 9,
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: 1,
    text: 'hi',
    edited: false,
    author: { id: 'u-1', handle: 'ada', displayName: 'Ada' },
    createdAt: '2026-07-15T12:00:00.000Z',
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
  };

  it('classifies a human "also send to channel" reply', () => {
    const m: ChatMessage = { ...base, broadcast: true };
    expect(isHumanBroadcastReply(m)).toBe(true);
    expect(isAgentVoiceBroadcast(m)).toBe(false);
  });

  it('classifies an agent answer as agent-voice', () => {
    const m: ChatMessage = { ...base, broadcast: true, sessionId: 's-1', sessionEventType: 'replied' };
    expect(isAgentVoiceBroadcast(m)).toBe(true);
    expect(isHumanBroadcastReply(m)).toBe(false);
  });

  it('classifies a broadcast spawn row (sessionId, no event type) as agent-voice', () => {
    const m: ChatMessage = { ...base, broadcast: true, sessionId: 's-1' };
    expect(isAgentVoiceBroadcast(m)).toBe(true);
    expect(isHumanBroadcastReply(m)).toBe(false);
  });

  it('non-broadcast messages are neither', () => {
    expect(isAgentVoiceBroadcast(base)).toBe(false);
    expect(isHumanBroadcastReply(base)).toBe(false);
  });
});
