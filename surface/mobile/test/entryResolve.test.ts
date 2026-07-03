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
  it('fetches the resolve endpoint with native bearer auth and caches hits', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        handle: 'evt_7',
        kind: 'message',
        actor: 'Ada',
        text: 'A quoted message',
        targetType: 'event',
        tombstoned: false,
        location: {
          workspaceId: 'ws-1',
          channelId: 'ch-1',
          channelName: 'general',
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
