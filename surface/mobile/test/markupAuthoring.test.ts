import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, WireEvent } from '@atrium/surface-client';
import {
  buildMarkupShellUrl,
  composeMarkupContent,
  loadMarkupDraftFromEntry,
  messageEntryHandleForMarkup,
  parseMarkupWebViewMessage,
  splitMarkdownFrontmatter,
  submitMarkupDraft,
} from '../src/lib/markupAuthoring';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 42,
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: null,
    text: 'Heading\n\nBody',
    edited: false,
    author: { id: 'u-1', handle: 'ada', displayName: 'Ada' },
    createdAt: '2026-07-03T12:00:00.000Z',
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
    ...overrides,
  };
}

function wireEvent(): WireEvent {
  return {
    id: 44,
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: 42,
    type: 'message.posted',
    actorId: 'u-1',
    payload: {},
    createdAt: '2026-07-03T12:00:00.000Z',
    author: { id: 'u-1', handle: 'ada', displayName: 'Ada' },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('markupAuthoring helpers', () => {
  it('uses the same structured-message gate as web markup reply', () => {
    expect(messageEntryHandleForMarkup(message())).toBe('evt_42');
    expect(messageEntryHandleForMarkup(message({ text: '# Title' }))).toBe('evt_42');
    expect(messageEntryHandleForMarkup(message({ text: 'one line' }))).toBeNull();
    expect(messageEntryHandleForMarkup(message({ deleted: true }))).toBeNull();
    expect(messageEntryHandleForMarkup(message({ status: 'pending' }))).toBeNull();
    expect(messageEntryHandleForMarkup(message({ sessionId: 's-1' }))).toBeNull();
  });

  it('splits and recomposes markdown frontmatter', () => {
    const content = '---\ntitle: Draft\n---\n\n# Body';

    expect(splitMarkdownFrontmatter(content)).toEqual({
      frontmatter: '---\ntitle: Draft\n---\n',
      body: '# Body',
    });
    expect(composeMarkupContent('---\ntitle: Draft\n---\n', '# Body')).toBe(
      '---\ntitle: Draft\n---\n\n# Body',
    );
  });

  it('parses WebView bridge messages and builds the shell URL', () => {
    expect(parseMarkupWebViewMessage('{"type":"markup-shell-ready"}')).toEqual({
      type: 'markup-shell-ready',
    });
    expect(parseMarkupWebViewMessage({ type: 'markup-dirty', dirty: true })).toEqual({
      type: 'markup-dirty',
      dirty: true,
    });
    expect(parseMarkupWebViewMessage('{"type":"markup-serialized","markdown":"Body"}')).toEqual({
      type: 'markup-serialized',
      markdown: 'Body',
    });
    expect(parseMarkupWebViewMessage('{"type":"markup-dirty"}')).toBeNull();
    expect(buildMarkupShellUrl('https://atrium.test/', 'dark')).toBe('https://atrium.test/markup/shell?theme=dark');
  });

  it('extracts an entry through native auth and fetches artifact content', async () => {
    const extractEntry = vi.fn(async () => ({
      artifactId: 'a-1',
      path: 'entry.md',
      seq: 3,
      workspaceId: 'ws-1',
      sourceText: null,
    }));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => '---\ntitle: Entry\n---\n\nBody',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      loadMarkupDraftFromEntry({
        api: { extractEntry },
        serverUrl: 'https://atrium.test/',
        fileHeaders: { authorization: 'Bearer t' },
        handle: 'evt_42',
        mode: { kind: 'steer', sessionId: 's-1' },
      }),
    ).resolves.toMatchObject({
      artifactId: 'a-1',
      seq: 3,
      body: 'Body',
      mode: { kind: 'steer', sessionId: 's-1' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://atrium.test/api/files/artifact/a-1/content',
      { headers: { authorization: 'Bearer t' } },
    );
  });

  it('submits reply mode by saving content then posting a thread message', async () => {
    const saveTextFile = vi.fn(async () => ({ seq: 4, status: 'normal' as const }));
    const postMessage = vi.fn(async () => ({ event: wireEvent() }));

    await expect(
      submitMarkupDraft({
        api: { saveTextFile, postMessage, sendArtifactFeedback: vi.fn() },
        serverUrl: 'https://atrium.test',
        draft: {
          artifactId: 'a-1',
          path: 'entry.md',
          seq: 3,
          workspaceId: 'ws-1',
          frontmatter: '',
          body: 'Body',
          sourceText: null,
          mode: { kind: 'reply', channelId: 'ch-1', threadRootEventId: 42 },
        },
        markdown: 'Marked',
        note: 'Note',
      }),
    ).resolves.toBe('reply');

    expect(saveTextFile).toHaveBeenCalledWith('a-1', 'Marked', 3, 'text/markdown; charset=utf-8');
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'ch-1',
        threadRootEventId: 42,
        text: 'Note\n/e/art_a-1',
      }),
    );
  });

  it('submits steer mode through artifact feedback and preserves 409 handling for the caller', async () => {
    const sendArtifactFeedback = vi.fn(async () => ({ seq: 4, status: 'normal' as const, steered: true as const }));

    await expect(
      submitMarkupDraft({
        api: { saveTextFile: vi.fn(), postMessage: vi.fn(), sendArtifactFeedback },
        serverUrl: 'https://atrium.test',
        draft: {
          artifactId: 'a-1',
          path: 'entry.md',
          seq: 3,
          workspaceId: 'ws-1',
          frontmatter: '---\ntitle: Entry\n---\n',
          body: 'Body',
          sourceText: null,
          mode: { kind: 'steer', sessionId: 's-1' },
        },
        markdown: 'Marked',
        note: 'Note',
      }),
    ).resolves.toBe('steer');

    expect(sendArtifactFeedback).toHaveBeenCalledWith(
      'a-1',
      expect.objectContaining({
        content: '---\ntitle: Entry\n---\n\nMarked',
        baseSeq: 3,
        sessionId: 's-1',
        note: 'Note',
      }),
    );
  });
});
