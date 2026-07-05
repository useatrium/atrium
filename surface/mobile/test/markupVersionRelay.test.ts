import type { HubFileVersion } from '@atrium/surface-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMarkupVersionRequest, type MarkupVersionRelayDeps } from '../src/lib/markupVersionRelay';

const version: HubFileVersion = {
  seq: 2,
  author: 'human:u-1',
  kind: 'modified',
  status: 'normal',
  createdAt: '2026-07-05T12:00:00.000Z',
  sizeBytes: 128,
  mime: 'text/markdown',
  isLatest: true,
};

function makeDeps(apiOverrides: Partial<MarkupVersionRelayDeps['api']> = {}): MarkupVersionRelayDeps {
  return {
    api: {
      listFileVersions: vi.fn(async () => ({ versions: [version] })),
      revertFileVersion: vi.fn(async (artifactId: string, seq: number) => ({
        artifactId,
        seq,
        tombstoned: false as const,
      })),
      restoreFile: vi.fn(async (artifactId: string) => ({
        artifactId,
        tombstoned: false as const,
      })),
      ...apiOverrides,
    },
    serverUrl: 'https://atrium.test/',
    fileHeaders: { authorization: 'Bearer t' },
    artifactId: 'artifact/one',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runMarkupVersionRequest', () => {
  it('lists file versions through the authenticated api client', async () => {
    const listFileVersions = vi.fn(async () => ({ versions: [version] }));
    const result = await runMarkupVersionRequest(makeDeps({ listFileVersions }), {
      reqId: 'req-list',
      op: 'list',
    });

    expect(listFileVersions).toHaveBeenCalledWith('artifact/one');
    expect(result).toEqual({ reqId: 'req-list', ok: true, versions: [version] });
  });

  it('fetches version content with file headers and an at-seq query', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      text: async () => 'Version two',
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await runMarkupVersionRequest(makeDeps(), {
      reqId: 'req-content',
      op: 'content',
      seq: 2,
    });

    expect(fetchMock).toHaveBeenCalledWith('https://atrium.test/api/files/artifact/artifact%2Fone/content?at=2', {
      headers: { authorization: 'Bearer t' },
    });
    expect(result).toEqual({ reqId: 'req-content', ok: true, content: 'Version two' });
  });

  it('reverts to a requested version through the api client', async () => {
    const revertFileVersion = vi.fn(async (artifactId: string, _seq: number) => ({
      artifactId,
      seq: 4,
      tombstoned: false as const,
    }));

    const result = await runMarkupVersionRequest(makeDeps({ revertFileVersion }), {
      reqId: 'req-revert',
      op: 'revert',
      seq: 1,
    });

    expect(revertFileVersion).toHaveBeenCalledWith('artifact/one', 1);
    expect(result).toEqual({ reqId: 'req-revert', ok: true, seq: 4 });
  });

  it('restores a tombstoned file and relays an optional seq when returned', async () => {
    const restoreFile = vi.fn(async (artifactId: string) => ({
      artifactId,
      tombstoned: false as const,
      seq: 5,
    }));

    const result = await runMarkupVersionRequest(makeDeps({ restoreFile }), {
      reqId: 'req-restore',
      op: 'restore',
    });

    expect(restoreFile).toHaveBeenCalledWith('artifact/one');
    expect(result).toEqual({ reqId: 'req-restore', ok: true, seq: 5 });
  });

  it('returns an error payload when an operation throws', async () => {
    const listFileVersions = vi.fn(async () => {
      throw new Error('version list failed');
    });

    await expect(
      runMarkupVersionRequest(makeDeps({ listFileVersions }), {
        reqId: 'req-error',
        op: 'list',
      }),
    ).resolves.toEqual({ reqId: 'req-error', ok: false, error: 'version list failed' });
  });
});
