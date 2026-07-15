// @vitest-environment jsdom

import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_CATEGORIES, type HubFile } from '@atrium/surface-client';
import { clearPreviewTextCache } from '../components/media/previewTextCache';
import {
  Gallery,
  galleryApiSearchParams,
  galleryPathForScope,
  galleryQuerySearch,
  galleryStateFromSearch,
} from './Gallery';

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

function mockGalleryFetch(
  files: HubFile[],
  contentByArtifactId: Record<string, string> = {},
  locatorByArtifactId: Record<string, HubFile> = {},
) {
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

    const locatorMatch = /^\/api\/files\/([^/]+)\/locator$/.exec(path);
    if (locatorMatch) {
      const artifactId = decodeURIComponent(locatorMatch[1]!);
      const file = locatorByArtifactId[artifactId];
      if (file) return jsonResponse(file);
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
    clearPreviewTextCache();
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
    expect(
      fetchMock.mock.calls.some(([input]) => requestPath(input) === '/api/files/artifact/art_markdown/content'),
    ).toBe(true);
  });

  it('waits to fetch text previews until their cards approach the viewport', async () => {
    let observerCallback: IntersectionObserverCallback | undefined;
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    class MockIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds = [];

      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }

      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
      takeRecords = () => [];
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    const fetchMock = mockGalleryFetch(
      [
        galleryFile({
          artifactId: 'art_lazy',
          path: 'docs/lazy.md',
          name: 'lazy.md',
          sizeBytes: 96,
        }),
      ],
      { art_lazy: 'Loaded near the viewport' },
    );

    const view = render(createElement(Gallery, { workspaceId: WORKSPACE_ID }));

    await screen.findByRole('button', { name: /lazy\.md/ });
    await waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
    expect(
      fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/files/artifact/art_lazy/content'),
    ).toHaveLength(0);

    const target = view.container.querySelector<HTMLElement>('[data-gallery-preview-id="art_lazy"]');
    expect(target).not.toBeNull();
    act(() => {
      observerCallback?.(
        [{ isIntersecting: true, target }] as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
    });

    expect(await screen.findByText('Loaded near the viewport')).toBeTruthy();
    expect(unobserve).toHaveBeenCalledWith(target);
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
    expect(
      fetchMock.mock.calls.some(([input]) => requestPath(input) === '/api/files/artifact/art_large_markdown/content'),
    ).toBe(false);
  });

  it('does not reload the gallery listing when lightbox-only URL state changes', async () => {
    const files = ['one', 'two', 'three'].map((name, index) =>
      galleryFile({
        artifactId: `art_${name}`,
        path: `images/${name}.png`,
        name: `${name}.png`,
        mime: 'image/png',
        mediaKind: 'image',
        isText: false,
        sizeBytes: 2048 + index,
        thumbnailUrl: `/thumb/${name}`,
      }),
    );
    const fetchMock = mockGalleryFetch(files);

    render(createElement(Gallery, { workspaceId: WORKSPACE_ID }));

    const firstImage = await screen.findByRole('img', { name: 'one.png' });
    fireEvent.click(firstImage.closest('button')!);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next file' }));

    await waitFor(() => expect(window.location.search).toContain('file=art_two'));
    const listRequests = fetchMock.mock.calls.filter(
      ([input]) => requestPath(input) === `/api/workspaces/${WORKSPACE_ID}/files`,
    );
    expect(listRequests).toHaveLength(1);
  });

  it('reveals a deep-linked file outside the listing without reloading the listing', async () => {
    const listed = galleryFile({
      artifactId: 'art_listed',
      path: 'images/listed.png',
      name: 'listed.png',
      mime: 'image/png',
      mediaKind: 'image',
      isText: false,
      thumbnailUrl: '/thumb/listed',
    });
    const hidden = galleryFile({
      artifactId: 'art_hidden',
      path: 'images/hidden.png',
      name: 'hidden.png',
      mime: 'image/png',
      mediaKind: 'image',
      isText: false,
      thumbnailUrl: '/thumb/hidden',
    });
    window.history.replaceState(null, '', '/files?file=art_hidden');
    const fetchMock = mockGalleryFetch([listed], {}, { art_hidden: hidden });

    render(createElement(Gallery, { workspaceId: WORKSPACE_ID }));

    expect(await screen.findByRole('heading', { name: 'hidden.png' })).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(([input]) => requestPath(input) === `/api/workspaces/${WORKSPACE_ID}/files`),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/files/art_hidden/locator'),
    ).toHaveLength(1);
  });

  it('reuses cached card previews while moving between files', async () => {
    const files = ['one', 'two', 'three'].map((name, index) =>
      galleryFile({
        artifactId: `art_${name}`,
        path: `docs/${name}.txt`,
        name: `${name}.txt`,
        mime: 'text/plain',
        mediaKind: 'text',
        sizeBytes: 100 + index,
      }),
    );
    const fetchMock = mockGalleryFetch(files, {
      art_one: 'one body',
      art_two: 'two body',
      art_three: 'three body',
    });

    render(createElement(Gallery, { workspaceId: WORKSPACE_ID }));

    const firstCard = await screen.findByRole('button', { name: /one\.txt/ });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) => requestPath(input).includes('/api/files/artifact/')),
      ).toHaveLength(3),
    );
    fetchMock.mockClear();
    fireEvent.click(firstCard);
    expect(await screen.findByRole('heading', { name: 'one.txt' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next file' }));
    expect(await screen.findByRole('heading', { name: 'two.txt' })).toBeTruthy();
    await waitFor(() => expect(window.location.search).toContain('file=art_two'));
    expect(fetchMock.mock.calls.filter(([input]) => requestPath(input).includes('/api/files/artifact/'))).toHaveLength(
      0,
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => requestPath(input) === `/api/workspaces/${WORKSPACE_ID}/files`),
    ).toHaveLength(0);
  });

  it('does not refetch unchanged text previews after a files event reload', async () => {
    const file = galleryFile({
      artifactId: 'art_refresh',
      path: 'docs/refresh.txt',
      name: 'refresh.txt',
      mime: 'text/plain',
      mediaKind: 'text',
      sizeBytes: 100,
      versionSeq: 7,
    });
    const fetchMock = mockGalleryFetch([file], { art_refresh: 'cached body' });
    const view = render(createElement(Gallery, { workspaceId: WORKSPACE_ID, filesEventSeq: 0 }));

    expect(await screen.findByText('cached body')).toBeTruthy();
    view.rerender(createElement(Gallery, { workspaceId: WORKSPACE_ID, filesEventSeq: 1 }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) => requestPath(input) === `/api/workspaces/${WORKSPACE_ID}/files`),
      ).toHaveLength(2),
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/files/artifact/art_refresh/content'),
    ).toHaveLength(1);
  });
});

describe('Gallery query helpers', () => {
  it('excludes lightbox and unrelated presentation state from the server query key', () => {
    expect(galleryQuerySearch('?q=logo&file=art_1&panel=info&preview=demo')).toBe('q=logo');
  });

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
