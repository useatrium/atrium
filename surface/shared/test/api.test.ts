import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createApi,
  decodeSessionListResponse,
  decodeSessionResponse,
} from '../src/api';
import type { SessionListItem, SessionWire } from '../src/sessions';

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
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
