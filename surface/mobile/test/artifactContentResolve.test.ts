import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArtifactContentResolver } from '../src/lib/entryResolve';
import type { Session } from '../src/lib/session';

const session: Session = {
  serverUrl: 'https://atrium.example.test/',
  token: 'tok_123',
  user: { id: 'u1', handle: 'gary', displayName: 'Gary' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createArtifactContentResolver', () => {
  it('fetches artifact content with auth, caps text, and caches requests', async () => {
    const longText = 'x'.repeat(70 * 1024);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(longText),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const resolve = createArtifactContentResolver(session);
    const first = await resolve('art-1');
    const second = await resolve('art-1');

    expect(first).toHaveLength(64 * 1024);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://atrium.example.test/api/files/artifact/art-1/content', {
      credentials: 'same-origin',
      headers: { authorization: 'Bearer tok_123' },
    });
  });
});
