// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_CATEGORIES, type HubFile } from '@atrium/surface-client';
import { Gallery, galleryApiSearchParams, galleryPathForScope, galleryStateFromSearch } from './Gallery';

const WORKSPACE_ID = 'ws_gallery';
const TEXT_TILE_PREVIEW_SIZE_LIMIT_BYTES = 512 * 1024;

function galleryFile(overrides: Partial<HubFile> = {}): HubFile {
  return {
    artifactId: 'art_memo',
    workspaceId: WORKSPACE_ID,
    path: 'docs/memo.md',
    name: 'memo.md',
    mime: 'text/markdown',
    mediaKind: 'text',
    isText: true,
    sizeBytes: 120,
    origin: 'agent',
    uploader: { id: 'agent_1', name: 'Agent' },
    channelId: null,
    sessionId: null,
    sourceMessageId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    versionSeq: 1,
    labels: [],
    starred: false,
    tombstoned: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

function requestPath(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : String(input);
  return new URL(raw, window.location.origin).pathname;
}

function mockGalleryFetch(files: HubFile[], contentByArtifactId: Record<string, string> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const path = requestPath(input);
    if (path === `/api/workspaces/${WORKSPACE_ID}/files`) {
      return jsonResponse({ files, nextCursor: null });
    }

    const contentMatch = /^\/api\/files\/artifact\/([^/]+)\/content$/.exec(path);
    if (contentMatch) {
      const artifactId = decodeURIComponent(contentMatch[1]!);
      const content = contentByArtifactId[artifactId];
      if (content != null) return new Response(content);
    }

    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Gallery tiles', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/files');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('uses MediaPreview image tiles with content URL fallback when no thumbnail exists', async () => {
    const fetchMock = mockGalleryFetch([
      galleryFile({
        artifactId: 'art_image',
        path: 'images/diagram.png',
        name: 'diagram.png',
        mime: 'image/png',
        mediaKind: 'image',
        isText: false,
        sizeBytes: 2048,
        thumbnailUrl: null,
      }),
    ]);

    render(createElement(Gallery, { workspaceId: WORKSPACE_ID }));

    const image = (await screen.findByRole('img', { name: 'diagram.png' })) as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('/api/files/artifact/art_image/content');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders small markdown files as fetched snippet tiles', async () => {
    const fetchMock = mockGalleryFetch(
      [
        galleryFile({
          artifactId: 'art_markdown',
          path: 'docs/brief.md',
          name: 'brief.md',
          sizeBytes: 96,
        }),
      ],
      {
        art_markdown: 'First line of the brief\nSecond line of the brief',
      },
    );

    render(createElement(Gallery, { workspaceId: WORKSPACE_ID }));

    expect(await screen.findByText(/First line of the brief/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/api/files/artifact/art_markdown/content')).toBe(true);
  });

  it('keeps the type chip fallback for oversized text-like files', async () => {
    const fetchMock = mockGalleryFetch(
      [
        galleryFile({
          artifactId: 'art_large_markdown',
          path: 'docs/large.md',
          name: 'large.md',
          sizeBytes: TEXT_TILE_PREVIEW_SIZE_LIMIT_BYTES + 1,
        }),
      ],
      {
        art_large_markdown: 'This content should not be fetched for the tile.',
      },
    );

    render(createElement(Gallery, { workspaceId: WORKSPACE_ID }));

    expect(await screen.findByText('large.md')).toBeTruthy();
    expect(screen.getByText('MD')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/api/files/artifact/art_large_markdown/content')).toBe(false);
  });
});

describe('Gallery query helpers', () => {
  it('defaults to workspace scope with explicit safe API defaults', () => {
    const state = galleryStateFromSearch('', { channelId: 'ch_1', sessionId: 'sess_1' });
    const params = galleryApiSearchParams(state);

    expect(state.scope).toBe('everything');
    expect(state.sort).toBe('recent');
    expect(state.includeScratch).toBe(false);
    expect(state.includeDeleted).toBe(false);
    expect(params.get('sort')).toBe('recent');
    expect(params.get('includeScratch')).toBe('false');
    expect(params.get('includeDeleted')).toBe('false');
    expect(params.has('channelId')).toBe(false);
    expect(params.has('sessionId')).toBe(false);
  });

  it('maps category, search, and channel scope into list params', () => {
    const category = FILE_CATEGORIES[0]!.key;
    const state = galleryStateFromSearch(
      `?q=logo&category=${category}&channelId=ch_1&sort=name&includeScratch=true&includeDeleted=true&starred=true&label=final`,
    );
    const params = galleryApiSearchParams(state);

    expect(state.scope).toBe('channel');
    expect(params.get('q')).toBe('logo');
    expect(params.get('category')).toBe(category);
    expect(params.get('channelId')).toBe('ch_1');
    expect(params.get('sort')).toBe('name');
    expect(params.get('includeScratch')).toBe('true');
    expect(params.get('includeDeleted')).toBe('true');
    expect(params.get('starred')).toBe('true');
    expect(params.get('label')).toBe('final');
  });

  it('prefers session scope over channel scope and builds session gallery links', () => {
    const state = galleryStateFromSearch('?channelId=ch_1&sessionId=sess_1');
    const params = galleryApiSearchParams(state);

    expect(state.scope).toBe('session');
    expect(params.get('sessionId')).toBe('sess_1');
    expect(params.has('channelId')).toBe(false);
    expect(galleryPathForScope({ sessionId: 'sess_1' })).toBe('/files?sessionId=sess_1');
  });
});
