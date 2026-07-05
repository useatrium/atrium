// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HubFileVersion } from '@atrium/surface-client';
import { MarkupVersionHistory } from './MarkupVersionHistory';

function version(seq: number, isLatest: boolean): HubFileVersion {
  return {
    seq,
    author: 'user:gary',
    kind: isLatest ? 'modified' : 'created',
    status: 'normal',
    createdAt: '2026-07-03T00:00:00.000Z',
    sizeBytes: null,
    mime: 'text/markdown',
    isLatest,
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function textBlob(text: string): Blob {
  return { size: text.length, text: async () => text } as unknown as Blob;
}

function markdownResponse(text: string): Response {
  return { ok: true, blob: async () => textBlob(text) } as Response;
}

function mockFetch(revertedSeq = 3) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url === '/api/files/artifact-1/versions') {
      return jsonResponse({ versions: [version(2, true), version(1, false)] });
    }
    if (url === '/api/files/artifact/artifact-1/content?at=1') {
      return markdownResponse('Earlier draft');
    }
    if (url === '/api/files/artifact/artifact-1/content') {
      return markdownResponse('Latest draft');
    }
    if (url === '/api/files/artifact-1/revert' && init?.method === 'POST') {
      return jsonResponse({ artifactId: 'artifact-1', seq: revertedSeq, tombstoned: false });
    }
    if (url === '/api/files/artifact-1/restore' && init?.method === 'POST') {
      return jsonResponse({ artifactId: 'artifact-1', seq: revertedSeq, tombstoned: false });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MarkupVersionHistory', () => {
  it('loads markup artifact versions and lists a prior version', async () => {
    const fetchMock = mockFetch();

    render(<MarkupVersionHistory artifactId="artifact-1" path="docs/plan.md" currentSeq={2} />);

    expect(screen.getByRole('heading', { name: 'Version history' })).toBeTruthy();
    expect(await screen.findByText('v1')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Restore this version' })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === '/api/files/artifact-1/versions')).toBe(true);
  });

  it('posts a revert and reports the new head seq', async () => {
    const fetchMock = mockFetch(4);
    const onReverted = vi.fn();

    render(<MarkupVersionHistory artifactId="artifact-1" path="docs/plan.md" currentSeq={2} onReverted={onReverted} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Restore this version' }));

    await waitFor(() => expect(onReverted).toHaveBeenCalledWith(4));
    const revertCall = fetchMock.mock.calls.find(([input]) => requestUrl(input) === '/api/files/artifact-1/revert');
    expect(revertCall?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    });
    expect(revertCall?.[1]?.body).toBe(JSON.stringify({ seq: 1 }));
  });
});
