import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TEXT_SNIPPET_CACHE_CHARS,
  canPreviewTextSnippet,
  clearArtifactTextSnippetCache,
  fetchArtifactTextSnippet,
} from '../src/lib/artifactTextSnippets';

beforeEach(() => {
  clearArtifactTextSnippetCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('artifact text snippets', () => {
  it('fetches snippets once per artifact version and serves cache hits', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('first line\nsecond line'),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const args = {
      artifactId: 'art-1',
      versionSeq: 4,
      fileContentUrl: (artifactId: string) => `https://atrium.example.test/files/${artifactId}`,
      fileHeaders: { authorization: 'Bearer token' },
    };
    const first = await fetchArtifactTextSnippet(args);
    const second = await fetchArtifactTextSnippet(args);

    expect(first).toBe('first line\nsecond line');
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://atrium.example.test/files/art-1', {
      headers: { authorization: 'Bearer token' },
    });
  });

  it('caps retained snippet text', async () => {
    const longText = 'x'.repeat(TEXT_SNIPPET_CACHE_CHARS + 100);
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(longText),
      } as Response),
    );

    const snippet = await fetchArtifactTextSnippet({
      artifactId: 'art-2',
      versionSeq: 1,
      fileContentUrl: (artifactId) => `https://atrium.example.test/files/${artifactId}`,
    });

    expect(snippet).toHaveLength(TEXT_SNIPPET_CACHE_CHARS);
  });

  it('returns and caches fallback null on fetch errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      text: () => Promise.resolve('not used'),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const args = {
      artifactId: 'art-3',
      versionSeq: 2,
      fileContentUrl: (artifactId: string) => `https://atrium.example.test/files/${artifactId}`,
    };

    await expect(fetchArtifactTextSnippet(args)).resolves.toBeNull();
    await expect(fetchArtifactTextSnippet(args)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('only enables small text, markdown, or code files', () => {
    expect(
      canPreviewTextSnippet({
        isText: true,
        mediaKind: 'text',
        mime: 'text/plain',
        name: 'notes.txt',
        path: 'notes.txt',
        sizeBytes: 512 * 1024,
        tombstoned: false,
      }),
    ).toBe(true);
    expect(
      canPreviewTextSnippet({
        isText: true,
        mediaKind: 'text',
        mime: 'text/plain',
        name: 'large.txt',
        path: 'large.txt',
        sizeBytes: 512 * 1024 + 1,
        tombstoned: false,
      }),
    ).toBe(false);
    expect(
      canPreviewTextSnippet({
        isText: false,
        mediaKind: 'image',
        mime: 'image/png',
        name: 'image.png',
        path: 'image.png',
        sizeBytes: 100,
        tombstoned: false,
      }),
    ).toBe(false);
  });
});
