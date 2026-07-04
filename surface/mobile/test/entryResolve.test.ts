import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEntryResolver } from '../src/lib/entryResolve';
import type { Session } from '../src/lib/session';

const session: Session = {
  serverUrl: 'https://atrium.example.test',
  token: 'token-1',
  user: { id: 'u-1', handle: 'ada', displayName: 'Ada' },
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Not Found',
    json: () => Promise.resolve(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createEntryResolver', () => {
  it('accepts artifact entries whose actor is null (server returns null for artifacts)', async () => {
    const entry = {
      handle: 'art_c3a45ab0-db97-4757-8187-0d061b42e17d',
      kind: 'artifact',
      actor: null,
      actorLabel: null,
      text: 'welcome.md',
      meta: {},
      targetType: 'artifact',
      sourceRefs: [],
      tombstoned: false,
      location: {
        workspaceId: 'ws-1',
        channelId: 'ch-1',
        channelName: 'general',
        threadRootEventId: null,
        sessionId: null,
        sessionTitle: null,
      },
    };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(entry))));
    const resolve = createEntryResolver(session);
    const resolved = await resolve(entry.handle);
    expect(resolved?.handle).toBe(entry.handle);
  });

  it('fetches the resolve endpoint with native bearer auth and caches hits', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        handle: 'evt_7',
        kind: 'message',
        actor: 'Ada',
        actorLabel: 'Ada',
        text: 'A quoted message',
        meta: {},
        targetType: 'event',
        sourceRefs: [],
        tombstoned: false,
        location: {
          workspaceId: 'ws-1',
          channelId: 'ch-1',
          channelName: 'general',
          threadRootEventId: null,
          sessionId: null,
          sessionTitle: null,
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const resolveEntry = createEntryResolver(session);

    await expect(resolveEntry('evt_7')).resolves.toMatchObject({ handle: 'evt_7' });
    await expect(resolveEntry('evt_7')).resolves.toMatchObject({ handle: 'evt_7' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://atrium.example.test/api/entries/evt_7', {
      credentials: 'same-origin',
      headers: { authorization: 'Bearer token-1' },
    });
  });

  it('caches failed resolves as misses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'not_found' }, false, 404));
    vi.stubGlobal('fetch', fetchMock);

    const resolveEntry = createEntryResolver(session);

    await expect(resolveEntry('evt_404')).resolves.toBeNull();
    await expect(resolveEntry('evt_404')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
