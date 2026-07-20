import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionWire } from '@atrium/surface-client';
import { sessionsApi } from '../src/sessions/api';

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
    archivedAt: null,
    pinned: false,
    costUsd: 0,
    resultText: null,
    failureClass: null,
    failureReason: null,
    createdAt: '2026-07-04T12:00:00.000Z',
    completedAt: null,
    lastEventId: 12,
    permalink: '/s/sess-1',
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('sessionsApi response decoding', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns decoded session responses', async () => {
    const wire = sessionWire({
      viewerCount: 1,
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
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ session: wire }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sessionsApi.get('sess-1')).resolves.toEqual({ session: wire });
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/sess-1', expect.any(Object));
  });

  it('rejects malformed session responses as bad_response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ session: { id: 123 } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sessionsApi.get('sess-1')).rejects.toMatchObject({
      status: 502,
      code: 'bad_response',
      message: 'invalid server response',
    });
  });
});
