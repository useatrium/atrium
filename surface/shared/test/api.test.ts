import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  NETWORK_UNREACHABLE_CODE,
  connectionAwareError,
  createApi,
  decodeActiveCallSnapshotResponse,
  decodeCallJoinResponse,
  decodeSessionListResponse,
  decodeSessionResponse,
  decodeSyncResponse,
  isNetworkFailure,
} from '../src/api';
import type { CallJoin, CallWire } from '../src/calls';
import type { SessionListItem, SessionWire } from '../src/sessions';
import type { SyncResponse } from '../src/sync';
import type { WireEvent } from '../src/timeline';

function sessionWire(overrides: Partial<SessionWire> = {}): SessionWire {
  return {
    id: 'sess-1',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    title: 'Investigate the issue',
    status: 'running',
    harness: 'codex',
    spawnedBy: 'u-1',
    driverId: 'u-1',
    costUsd: 0,
    resultText: null,
    createdAt: '2026-07-04T12:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 12,
    permalink: '/s/sess-1',
    ...overrides,
  };
}

function listItem(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: 'sess-1',
    channelId: 'ch-1',
    channelName: 'general',
    title: 'Investigate the issue',
    status: 'running',
    harness: 'codex',
    spawnedBy: 'u-1',
    spawnerName: 'Ada',
    costUsd: 0,
    createdAt: '2026-07-04T12:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    needsAttention: false,
    attentionReason: null,
    resultText: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function callWire(overrides: Partial<CallWire> = {}): CallWire {
  return {
    id: 'call-1',
    channelId: 'ch-1',
    initiatorId: 'u-1',
    status: 'ringing',
    startedAt: '2026-07-04T12:00:00.000Z',
    participants: [{ id: 'u-1', handle: 'ada', displayName: 'Ada' }],
    ...overrides,
  };
}

function callJoin(overrides: Partial<CallJoin> = {}): CallJoin {
  return {
    call: callWire(),
    token: 'token',
    url: 'ws://livekit.test',
    ...overrides,
  };
}

function wireEvent(overrides: Partial<WireEvent> = {}): WireEvent {
  return {
    id: 1,
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    type: 'message.posted',
    actorId: 'u-1',
    payload: { text: 'Hello', clientMsgId: 'client-1' },
    createdAt: '2026-07-04T12:00:00.000Z',
    author: { id: 'u-1', handle: 'ada', displayName: 'Ada' },
    ...overrides,
  };
}

function syncResponse(overrides: Partial<SyncResponse> = {}): SyncResponse {
  return {
    events: [wireEvent()],
    nextCursor: 2,
    limited: false,
    state: {
      readCursors: { 'ch-1': 1 },
      mutes: ['ch-2'],
      prefs: {
        theme: 'system',
        accent: 'indigo',
        motion: 'system',
        fontScale: 1,
        highContrast: false,
        notifications: { messages: 'dm_mention', sessions: true, calls: true },
      },
      drafts: {
        'ch-1': { text: 'Draft text', updatedAt: '2026-07-04T12:01:00.000Z', agentIntent: false },
        'ch-2': { text: 'fix the build', updatedAt: '2026-07-04T12:03:00.000Z', agentIntent: true },
      },
      draftDeletions: {
        'ch-2': '2026-07-04T12:02:00.000Z',
      },
      channels: [
        {
          id: 'ch-1',
          workspaceId: 'ws-1',
          name: 'general',
          createdAt: '2026-07-04T12:00:00.000Z',
          archivedAt: null,
          pinned: false,
          lastReadEventId: 1,
          latestEventId: 2,
          muted: false,
          mentionedSinceRead: true,
          kind: 'public',
          memberCount: 3,
        },
      ],
    },
    ...overrides,
  };
}

describe('session API response decoding', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('decodes valid session response payloads', () => {
    expect(
      decodeSessionResponse({
        session: sessionWire({
          repos: [{ repo: 'atrium', ref: 'main', private: true }],
          driver: { userId: 'u-1', displayName: 'Ada' },
          pendingSeatRequests: [{ userId: 'u-2', displayName: 'Grace' }],
          viewerCount: 2,
          suggestions: [
            {
              id: 'sug-1',
              authorId: 'u-2',
              authorName: 'Grace',
              text: 'Run the tests',
              status: 'pending',
              resolvedBy: null,
              resolvedByName: null,
              sentText: null,
              note: null,
              createdAt: '2026-07-04T12:01:00.000Z',
              resolvedAt: null,
            },
          ],
          answerProposals: [
            {
              id: 'prop-1',
              questionId: 'q-1',
              authorId: 'u-2',
              authorName: 'Grace',
              answers: { 'q-1': { answers: ['Yes'] } },
              status: 'pending',
              resolvedBy: null,
              resolvedByName: null,
              note: null,
              createdAt: '2026-07-04T12:02:00.000Z',
              resolvedAt: null,
            },
          ],
        }),
      }),
    ).toMatchObject({
      session: {
        id: 'sess-1',
        repos: [{ repo: 'atrium', ref: 'main', private: true }],
        driver: { userId: 'u-1', displayName: 'Ada' },
        viewerCount: 2,
        suggestions: [{ id: 'sug-1', resolvedBy: null, resolvedAt: null }],
        answerProposals: [{ id: 'prop-1', resolvedBy: null, resolvedAt: null }],
      },
    });
  });

  it('decodes valid session list payloads', () => {
    expect(decodeSessionListResponse({ sessions: [listItem()] })).toEqual({
      sessions: [listItem()],
    });
  });

  it('rejects malformed session payloads as bad_response', () => {
    expect(() => decodeSessionResponse({ session: { id: 123 } })).toThrowError(
      new ApiError(502, 'bad_response', 'invalid server response'),
    );
  });

  it('rejects malformed getSession responses from createApi', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ session: { id: 123 } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createApi().getSession('sess-1')).rejects.toMatchObject({
      status: 502,
      code: 'bad_response',
      message: 'invalid server response',
    });
  });

  it('returns decoded session responses from createApi', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ session: sessionWire() }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createApi().getSession('sess-1')).resolves.toEqual({ session: sessionWire() });
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/sess-1', expect.any(Object));
  });
});

describe('API transport failures', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('wraps fetch transport failures in a typed network error', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')));

    const error = await createApi()
      .me()
      .catch((err: unknown) => err);

    expect(error).toMatchObject({ status: 0, code: NETWORK_UNREACHABLE_CODE });
    expect(isNetworkFailure(error)).toBe(true);
    expect(connectionAwareError(error, 'fallback', 'server unavailable')).toBe('server unavailable');
  });
});

describe('call API response decoding', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('decodes valid call join and active-call payloads', () => {
    expect(decodeCallJoinResponse(callJoin())).toEqual(callJoin());
    expect(decodeActiveCallSnapshotResponse({ calls: [callWire({ status: 'active' })] })).toEqual({
      calls: [callWire({ status: 'active' })],
    });
  });

  it('rejects malformed activeCalls responses from createApi', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ calls: [{ id: 'call-1' }] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createApi().activeCalls()).rejects.toMatchObject({
      status: 502,
      code: 'bad_response',
      message: 'invalid server response',
    });
  });

  it('returns decoded call join responses from createApi', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(callJoin()));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createApi().startCall('ch-1')).resolves.toEqual(callJoin());
    expect(fetchMock).toHaveBeenCalledWith('/api/calls', expect.any(Object));
  });
});

describe('wire event response decoding', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('decodes valid sync response payloads', () => {
    expect(decodeSyncResponse(syncResponse())).toEqual(syncResponse());
  });

  it('carries the draft agent intent through the wire, defaulting to chat when absent', () => {
    const wire = syncResponse();
    // Deploy skew / pre-076 server: no flag at all. It must decode as chat, not vanish.
    delete (wire.state.drafts['ch-1'] as { agentIntent?: boolean }).agentIntent;

    const decoded = decodeSyncResponse(wire);

    expect(decoded.state.drafts['ch-1']?.agentIntent).toBe(false);
    expect(decoded.state.drafts['ch-2']?.agentIntent).toBe(true);
  });

  it('rejects malformed sync event envelopes from createApi', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ...syncResponse(),
        events: [{ ...wireEvent(), id: 'event-1' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(createApi().sync(1, { limit: 10 })).rejects.toMatchObject({
      status: 502,
      code: 'bad_response',
      message: 'invalid server response',
    });
  });

  it('returns decoded message history responses from createApi', async () => {
    const history = { events: [wireEvent({ id: 3 })], hasMore: true };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(history));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createApi().messages('ch-1', { beforeId: 10, limit: 5 })).resolves.toEqual(history);
    expect(fetchMock).toHaveBeenCalledWith('/api/channels/ch-1/messages?before_id=10&limit=5', expect.any(Object));
  });

  it('rejects malformed message history responses from createApi', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        events: [{ ...wireEvent(), createdAt: null }],
        hasMore: false,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(createApi().messages('ch-1')).rejects.toMatchObject({
      status: 502,
      code: 'bad_response',
      message: 'invalid server response',
    });
  });

  it('returns decoded thread history responses from createApi', async () => {
    const history = { events: [wireEvent({ id: 4, threadRootEventId: 1 })] };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(history));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createApi().thread(1)).resolves.toEqual(history);
    expect(fetchMock).toHaveBeenCalledWith('/api/threads/1/messages', expect.any(Object));
  });

  it('rejects malformed thread history responses from createApi', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        events: [{ ...wireEvent({ threadRootEventId: 1 }), payload: null }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(createApi().thread(1)).rejects.toMatchObject({
      status: 502,
      code: 'bad_response',
      message: 'invalid server response',
    });
  });
});
