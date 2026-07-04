import { describe, expect, it } from 'vitest';
import { decodeNormalizedEntry, parseEntryReferenceMap } from './entry-contracts';

describe('entry contract schemas', () => {
  it('decodes the normalized entry wire shape', () => {
    const entry = decodeNormalizedEntry({
      handle: 'evt_42',
      kind: 'message.posted',
      actor: 'user-1',
      actorLabel: 'Ada',
      text: 'hello',
      meta: { text: 'hello' },
      targetType: 'event',
      sourceRefs: ['rec_alpha'],
      tombstoned: false,
      location: {
        workspaceId: 'workspace-1',
        channelId: 'channel-1',
        channelName: 'general',
        threadRootEventId: null,
        sessionId: null,
        sessionTitle: null,
      },
    });

    expect(entry?.handle).toBe('evt_42');
    expect(entry?.sourceRefs).toEqual(['rec_alpha']);
  });

  it('parses valid entry reference summaries and drops invalid handles', () => {
    expect(
      parseEntryReferenceMap({
        references: {
          rec_good: {
            count: 1,
            latest: [
              {
                eventId: 10,
                handle: 'evt_10',
                channelId: 'channel-1',
                threadRootEventId: null,
                actorLabel: null,
                excerpt: 'See this',
                ts: '2026-07-04T17:00:00.000Z',
              },
            ],
          },
          rec_bad: { count: '1', latest: [] },
          rec_fractional_event: {
            count: 1,
            latest: [
              {
                eventId: 10.5,
                handle: 'evt_10',
                channelId: 'channel-1',
                threadRootEventId: null,
                actorLabel: null,
                excerpt: 'See this',
                ts: '2026-07-04T17:00:00.000Z',
              },
            ],
          },
          rec_negative_count: { count: -1, latest: [] },
          rec_unsafe_thread: {
            count: 1,
            latest: [
              {
                eventId: 10,
                handle: 'evt_10',
                channelId: 'channel-1',
                threadRootEventId: Number.MAX_SAFE_INTEGER + 1,
                actorLabel: null,
                excerpt: 'See this',
                ts: '2026-07-04T17:00:00.000Z',
              },
            ],
          },
        },
      }),
    ).toEqual({
      rec_good: {
        count: 1,
        latest: [
          {
            eventId: 10,
            handle: 'evt_10',
            channelId: 'channel-1',
            threadRootEventId: null,
            actorLabel: null,
            excerpt: 'See this',
            ts: '2026-07-04T17:00:00.000Z',
          },
        ],
      },
    });
  });
});
