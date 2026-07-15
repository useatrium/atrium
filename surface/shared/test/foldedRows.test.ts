import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyEvent,
  applyLocalEditOverlay,
  applyLocalReactionOverlay,
  createApi,
  decodeMessageHistoryResponse,
  emptyTimeline,
  mergeHistory,
  mergeThread,
  type WireEvent,
} from '../src/index';

const CH = 'ch-folded';
const alice = { id: 'u-alice', handle: 'alice', displayName: 'Alice' };
const bob = { id: 'u-bob', handle: 'bob', displayName: 'Bob' };

function row(
  id: number,
  text: string,
  opts: {
    lastModifierId?: number;
    threadRoot?: number;
    replyCount?: number;
    lastReplyId?: number;
    edited?: boolean;
    deleted?: boolean;
    reactions?: unknown[];
    voice?: Record<string, unknown>;
    broadcast?: boolean;
  } = {},
): WireEvent {
  return {
    id,
    workspaceId: 'ws-folded',
    channelId: CH,
    threadRootEventId: opts.threadRoot ?? null,
    type: 'message.posted',
    actorId: alice.id,
    payload: {
      text,
      ...(opts.edited === true ? { edited: true } : {}),
      ...(opts.deleted === true ? { deleted: true } : {}),
      ...(opts.reactions ? { reactions: opts.reactions } : {}),
      ...(opts.voice ? { voice: opts.voice } : {}),
    },
    createdAt: new Date(id * 1000).toISOString(),
    author: alice,
    ...(opts.lastModifierId !== undefined ? { lastModifierId: opts.lastModifierId } : {}),
    ...(opts.replyCount !== undefined ? { replyCount: opts.replyCount } : {}),
    ...(opts.lastReplyId !== undefined ? { lastReplyId: opts.lastReplyId } : {}),
    ...(opts.broadcast === true ? { broadcast: true } : {}),
  };
}

function modifier(
  id: number,
  type: 'message.edited' | 'message.deleted' | 'reaction.added' | 'reaction.removed' | 'voice.transcribed',
  target: number,
  payload: Record<string, unknown> = {},
  threadRootEventId: number | null = null,
): WireEvent {
  return {
    ...row(id, ''),
    type,
    threadRootEventId,
    actorId: bob.id,
    payload: { target: `evt_${target}`, ...payload },
    author: bob,
  };
}

describe('folded row application', () => {
  it('heals an offline row wholesale and rematerializes local overlays', () => {
    let timeline = applyEvent(emptyTimeline, row(5, 'old', { lastModifierId: 5 }));
    timeline = applyLocalEditOverlay(timeline, 'edit-op', 5, 'local pending edit');
    timeline = applyLocalReactionOverlay(timeline, 'reaction-op', 5, '🎉', alice.id, 'add');

    timeline = applyEvent(
      timeline,
      row(5, 'server edited', {
        lastModifierId: 20,
        edited: true,
        replyCount: 2,
        lastReplyId: 19,
        reactions: [{ emoji: '👍', userIds: [bob.id] }],
      }),
    );

    expect(timeline.main[0]).toMatchObject({
      text: 'local pending edit',
      pendingEdit: true,
      edited: true,
      replyCount: 2,
      lastReplyId: 19,
      lastModifierId: 20,
    });
    expect(timeline.main[0]!.reactions).toEqual([
      { emoji: '👍', userIds: [bob.id] },
      { emoji: '🎉', userIds: [alice.id] },
    ]);
  });

  it('refuses a stale folded root after a newer live reply', () => {
    let timeline = applyEvent(emptyTimeline, row(1, 'root', { lastModifierId: 30, replyCount: 2, lastReplyId: 30 }));
    timeline = applyEvent(timeline, row(32, 'live reply', { threadRoot: 1 }));
    timeline = applyEvent(timeline, row(1, 'stale root', { lastModifierId: 31, replyCount: 1, lastReplyId: 31 }));

    expect(timeline.main[0]).toMatchObject({
      text: 'root',
      replyCount: 3,
      lastReplyId: 32,
      lastModifierId: 32,
    });
  });

  it('skips a raw reply delete already covered by folded tombstone and root rows', () => {
    let timeline = applyEvent(emptyTimeline, row(1, 'root', { lastModifierId: 20 }));
    timeline = mergeThread(timeline, 1, []);
    timeline = applyEvent(timeline, row(2, '', { threadRoot: 1, deleted: true, lastModifierId: 31 }));
    timeline = applyEvent(timeline, row(1, 'root', { lastModifierId: 31, replyCount: 1, lastReplyId: 30 }));

    timeline = applyEvent(timeline, modifier(31, 'message.deleted', 2, {}, 1));

    expect(timeline.main[0]!.replyCount).toBe(1);
    expect(timeline.threads[1]![0]).toMatchObject({ deleted: true, lastModifierId: 31 });
    expect(timeline.seenIds.has(31)).toBe(true);
  });

  it('bumps both reply and root watermarks for a reply modifier', () => {
    let timeline = applyEvent(emptyTimeline, row(1, 'root'));
    timeline = mergeThread(timeline, 1, [row(2, 'reply', { threadRoot: 1 })]);

    timeline = applyEvent(timeline, modifier(8, 'reaction.added', 2, { emoji: '👍' }, 1));

    expect(timeline.main[0]!.lastModifierId).toBe(8);
    expect(timeline.threads[1]![0]!.lastModifierId).toBe(8);
  });

  it('does not replay a cached raw modifier over a folded history row', () => {
    const timeline = mergeHistory(
      emptyTimeline,
      [row(3, 'folded edit', { lastModifierId: 5 }), modifier(5, 'message.edited', 3, { text: 'stale cached edit' })],
      { hasMoreBefore: false, nextCursor: 9 },
    );

    expect(timeline.main[0]).toMatchObject({ text: 'folded edit', lastModifierId: 5 });
    expect(timeline.seenIds.has(5)).toBe(true);
    expect(timeline.lastEventId).toBe(9);
  });

  it('keeps folded tombstone replies out of unloaded threads and inserts them into loaded threads', () => {
    const tombstone = row(2, '', { threadRoot: 1, deleted: true, lastModifierId: 10 });
    const root = row(1, 'root', { lastModifierId: 10, replyCount: 0, lastReplyId: 2 });

    const unloaded = applyEvent(applyEvent(emptyTimeline, root), tombstone);
    expect(unloaded.threads[1]).toBeUndefined();
    expect(unloaded.main[0]!.replyCount).toBe(0);

    let loaded = mergeThread(applyEvent(emptyTimeline, root), 1, []);
    loaded = applyEvent(loaded, tombstone);
    expect(loaded.threads[1]![0]).toMatchObject({ id: 2, deleted: true, lastModifierId: 10 });

    loaded = mergeThread(loaded, 1, [tombstone]);
    expect(loaded.main[0]!.replyCount).toBe(0);
  });

  it('uses nextCursor and never derives folded-mode progress from row ids', () => {
    const start = { ...emptyTimeline, lastEventId: 50 };
    const unchangedCursor = mergeHistory(start, [row(75, 'old row', { lastModifierId: 180 })], {
      hasMoreBefore: false,
      nextCursor: 50,
    });
    expect(unchangedCursor.lastEventId).toBe(50);

    const advancedCursor = mergeHistory(unchangedCursor, [row(75, 'new fold', { lastModifierId: 200 })], {
      hasMoreBefore: false,
      nextCursor: 200,
    });
    expect(advancedCursor.lastEventId).toBe(200);
  });

  it('folds raw voice transcripts without touching the row watermark', () => {
    let timeline = applyEvent(
      emptyTimeline,
      row(5, 'voice', {
        lastModifierId: 5,
        voice: { fileId: 'voice-1', durationMs: 1000, transcript: { status: 'pending' } },
      }),
    );

    timeline = applyEvent(
      timeline,
      modifier(20, 'voice.transcribed', 5, { transcript: { status: 'done', text: 'hello' } }),
    );

    expect(timeline.main[0]!.voice?.transcript).toEqual({ status: 'done', text: 'hello' });
    expect(timeline.main[0]!.lastModifierId).toBe(5);
    expect(timeline.lastEventId).toBe(20);
  });

  it('never inserts a healing re-ship of an old row the client no longer holds', () => {
    // Client holds rows 100.. (older rows evicted); a folded delta at cursor 90
    // re-ships changed old row 5. Inserting it would open a silent hole that
    // loadEarlier (which pages before the oldest held row) could never fill.
    let timeline = applyEvent(emptyTimeline, row(100, 'frontier', { lastModifierId: 100 }));
    const before = timeline;
    timeline = applyEvent(timeline, row(5, 'edited old row', { lastModifierId: 95, edited: true }), {
      catchupCursor: 90,
    });

    expect(timeline).toBe(before);
    expect(timeline.main.map((m) => m.id)).toEqual([100]);
    // Deliberately unseen: a later history page must still deliver row 5.
    expect(timeline.seenIds.has(5)).toBe(false);
    const paged = mergeHistory(timeline, [row(5, 'edited old row', { lastModifierId: 95, edited: true })], {
      hasMoreBefore: false,
    });
    expect(paged.main.map((m) => m.id)).toEqual([5, 100]);
  });

  it('still inserts genuinely new folded rows past the catch-up cursor and advances lastEventId', () => {
    let timeline = applyEvent(emptyTimeline, row(100, 'frontier', { lastModifierId: 100 }));
    timeline = applyEvent(timeline, row(120, 'new while offline', { lastModifierId: 120 }), { catchupCursor: 110 });

    expect(timeline.main.map((m) => m.id)).toEqual([100, 120]);
    expect(timeline.lastEventId).toBe(120);
  });

  it('applies the cursor skip through mergeHistory without marking the row seen', () => {
    const held = applyEvent(emptyTimeline, row(100, 'frontier', { lastModifierId: 100 }));
    const merged = mergeHistory(
      held,
      [row(5, 'old heal', { lastModifierId: 95 }), row(120, 'new', { lastModifierId: 120 })],
      {
        hasMoreBefore: false,
        nextCursor: 120,
        catchupCursor: 90,
      },
    );

    expect(merged.main.map((m) => m.id)).toEqual([100, 120]);
    expect(merged.seenIds.has(5)).toBe(false);
    expect(merged.seenIds.has(120)).toBe(true);
    expect(merged.lastEventId).toBe(120);
  });

  it('replaces a held old row even when it is at or below the catch-up cursor', () => {
    let timeline = applyEvent(emptyTimeline, row(5, 'stale', { lastModifierId: 5 }));
    timeline = applyEvent(timeline, row(5, 'healed', { lastModifierId: 95, edited: true }), { catchupCursor: 90 });

    expect(timeline.main[0]).toMatchObject({ id: 5, text: 'healed', edited: true, lastModifierId: 95 });
  });

  it('confirms a lingering local overlay when the skip-guard swallows its lost-ack redelivery', () => {
    let timeline = applyEvent(emptyTimeline, row(5, 'original', { lastModifierId: 5 }));
    timeline = applyLocalEditOverlay(timeline, 'edit-op', 5, 'my edit');
    // The folded row already includes the edit (lm 20 covers raw event 20).
    timeline = applyEvent(timeline, row(5, 'my edit', { lastModifierId: 20, edited: true }));
    expect(timeline.localOverlays).toHaveLength(1);

    // Lost-ack redelivery of the raw edit: skip-guarded for state, but the
    // matching overlay must still confirm away.
    timeline = applyEvent(timeline, modifier(20, 'message.edited', 5, { text: 'my edit' }));

    expect(timeline.localOverlays).toHaveLength(0);
    expect(timeline.main[0]).toMatchObject({ text: 'my edit', edited: true, pendingEdit: false });
  });

  it('preserves legacy response and raw-event behavior when folded fields are absent', () => {
    const posted = row(1, 'legacy');
    const edited = modifier(2, 'message.edited', 1, { text: 'legacy edited' });
    const decoded = decodeMessageHistoryResponse({ events: [posted], hasMore: false });
    const timeline = mergeHistory(emptyTimeline, [posted, edited], { hasMoreBefore: false });

    expect(decoded).toEqual({ events: [posted], hasMore: false });
    expect(decoded.readCursor).toBeUndefined();
    expect(timeline.main[0]).toMatchObject({ text: 'legacy edited', edited: true, lastModifierId: 2 });
    expect(timeline.lastEventId).toBe(2);
  });
});

describe('folded API opt-in', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds wire=folded only when requested and decodes the channel cursor', async () => {
    const response = {
      events: [row(3, 'folded', { lastModifierId: 8 })],
      hasMore: false,
      nextCursor: 8,
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(createApi().messages(CH, { afterId: 2, folded: true })).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(`/api/channels/${CH}/messages?after_id=2&wire=folded`, expect.any(Object));
  });

  it('adds wire=folded to sync requests', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createApi().sync(7, { limit: 10, folded: true })).rejects.toMatchObject({ code: 'bad_response' });
    expect(fetchMock).toHaveBeenCalledWith('/api/sync?after=7&limit=10&wire=folded', expect.any(Object));
  });
});
