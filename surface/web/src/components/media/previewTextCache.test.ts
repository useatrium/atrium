// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewFile } from './types';
import { clearPreviewTextCache, loadPreviewText, usePreviewText } from './previewTextCache';

function preview(id: string, versionSeq = 1): PreviewFile {
  return {
    id,
    versionSeq,
    name: `${id}.txt`,
    mime: 'text/plain',
    mediaKind: 'text',
    contentUrl: `/api/files/artifact/${id}/content`,
  };
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  clearPreviewTextCache();
  vi.unstubAllGlobals();
});

describe('preview text cache', () => {
  it('deduplicates a version and reloads when the version changes', async () => {
    const fetchMock = vi.fn(async () => new Response('body'));
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([loadPreviewText(preview('art_1')), loadPreviewText(preview('art_1'))]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await loadPreviewText(preview('art_1', 2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('limits concurrent content requests', async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const loads = Array.from({ length: 8 }, (_, index) => loadPreviewText(preview(`art_${index}`)));
    expect(fetchMock).toHaveBeenCalledTimes(4);

    for (const resolve of pending.splice(0)) resolve(new Response('body'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
    for (const resolve of pending.splice(0)) resolve(new Response('body'));
    await Promise.all(loads);
  });

  it('removes a queued preview when its last consumer unmounts', async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const hooks = Array.from({ length: 5 }, (_, index) => renderHook(() => usePreviewText(preview(`art_${index}`))));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    hooks[4]!.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));

    for (const resolve of pending.splice(0)) resolve(new Response('body'));
    await waitFor(() => expect(hooks[0]!.result.current.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('releases a failed entry so the next load can retry', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network failed'))
      .mockResolvedValueOnce(new Response('body'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadPreviewText(preview('art_retry'))).rejects.toThrow('network failed');
    await expect(loadPreviewText(preview('art_retry'))).resolves.toBe('body');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('times out a hung request so it cannot hold a scheduler slot forever', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const load = loadPreviewText(preview('art_hung'));
    const timedOut = expect(load).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(30_000);

    await timedOut;
  });
});
