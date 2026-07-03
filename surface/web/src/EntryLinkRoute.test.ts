import { describe, expect, it } from 'vitest';
import {
  destinationForEntry,
  entryHandleFromPath,
  entryParamFromSearch,
  threadRootParamFromSearch,
  type EntryLinkDestination,
} from './EntryLinkRoute';
import type { NormalizedEntry } from './api';

function entry(overrides: Partial<NormalizedEntry>): NormalizedEntry {
  return {
    handle: 'evt_1',
    kind: 'message.posted',
    actor: null,
    actorLabel: null,
    text: '',
    meta: {},
    targetType: 'event',
    sourceRefs: [],
    tombstoned: false,
    location: {
      workspaceId: 'ws_1',
      channelId: 'ch_1',
      channelName: 'general',
      threadRootEventId: null,
      sessionId: null,
      sessionTitle: null,
    },
    ...overrides,
  };
}

describe('EntryLinkRoute helpers', () => {
  it('parses /e/:handle path segments', () => {
    expect(entryHandleFromPath('/e/evt_123')).toBe('evt_123');
    expect(entryHandleFromPath('/e/rec_record%2D1')).toBe('rec_record-1');
    expect(entryHandleFromPath('/s/session-1')).toBeNull();
  });

  it('routes records to session permalinks with entry params', () => {
    expect(
      destinationForEntry(
        entry({
          handle: 'rec_turn_1',
          targetType: 'record',
          location: {
            workspaceId: 'ws_1',
        channelId: 'ch_1',
        channelName: 'general',
        threadRootEventId: null,
        sessionId: 'sess_1',
        sessionTitle: 'Run',
      },
    }),
      ),
    ).toMatchObject<Partial<EntryLinkDestination>>({
      pathname: '/s/sess_1',
      search: 'entry=rec_turn_1',
      initialSessionId: 'sess_1',
      initialChannelId: null,
      initialEntryHandle: 'rec_turn_1',
      targetType: 'record',
    });
  });

  it('routes events and artifacts to the channel shell with entry params', () => {
    expect(destinationForEntry(entry({ handle: 'evt_9' }))).toMatchObject({
      pathname: '/',
      search: 'entry=evt_9',
      initialChannelId: 'ch_1',
      initialSessionId: null,
    });
    expect(destinationForEntry(entry({ handle: 'art_00000000-0000-0000-0000-000000000001', targetType: 'artifact' })))
      .toMatchObject({
        pathname: '/',
        search: 'entry=art_00000000-0000-0000-0000-000000000001',
        initialChannelId: 'ch_1',
        initialSessionId: null,
      });
  });

  it('preserves event thread roots for reply destinations', () => {
    expect(
      destinationForEntry(
        entry({
          handle: 'evt_42',
          location: {
            workspaceId: 'ws_1',
            channelId: 'ch_1',
            channelName: 'general',
            sessionId: null,
            sessionTitle: null,
            threadRootEventId: 7,
          } as NormalizedEntry['location'],
        }),
      ),
    ).toMatchObject({
      pathname: '/',
      search: 'entry=evt_42&threadRoot=7',
      initialChannelId: 'ch_1',
      initialThreadRootEventId: 7,
      initialEntryHandle: 'evt_42',
    });
  });

  it('extracts entry query params', () => {
    expect(entryParamFromSearch('?entry=evt_7&x=1')).toBe('evt_7');
    expect(entryParamFromSearch('?x=1')).toBeNull();
    expect(threadRootParamFromSearch('?entry=evt_7&threadRoot=9')).toBe(9);
    expect(threadRootParamFromSearch('?entry=evt_7&threadRoot=nope')).toBeNull();
  });
});
