import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEntryReferenceQuery } from '../src/lib/entryReferences';
import type { Session } from '../src/lib/session';

const session: Session = {
  serverUrl: 'https://atrium.example.test/',
  token: 'token-1',
  user: { id: 'u-1', handle: 'ada', displayName: 'Ada' },
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Request',
    json: () => Promise.resolve(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createEntryReferenceQuery', () => {
  it('posts unique handles with native bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        references: {
          rec_a: {
            count: 1,
            latest: [
              {
                eventId: 10,
                handle: 'evt_10',
                channelId: 'ch-1',
                threadRootEventId: 7,
                actorLabel: 'Ada',
                excerpt: 'See this entry',
                ts: '2026-07-03T12:00:00.000Z',
              },
            ],
          },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const query = createEntryReferenceQuery(session);
    await expect(query(['rec_a', 'rec_a', 'rec_b'])).resolves.toMatchObject({
      rec_a: { count: 1, latest: [{ channelId: 'ch-1', threadRootEventId: 7 }] },
    });

    expect(fetchMock).toHaveBeenCalledWith('https://atrium.example.test/api/entries/references/query', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        authorization: 'Bearer token-1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ handles: ['rec_a', 'rec_b'] }),
    });
  });

  it('returns an empty map for invalid entries in the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ references: { rec_bad: { count: '1' } } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createEntryReferenceQuery(session)(['rec_bad'])).resolves.toEqual({});
  });
});
