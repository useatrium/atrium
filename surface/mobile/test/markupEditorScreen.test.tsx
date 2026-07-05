// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import React, { forwardRef, useImperativeHandle } from 'react';
import type { HubFileVersion } from '@atrium/surface-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MarkupEditorScreen from '../app/(app)/markup-editor';
import { putPendingMarkupDraft } from '../src/lib/markupAuthoring';
import { renderWithTheme } from './rnTestUtils';

let routeParams: { draftId?: string } = {};
let lastWebViewProps: { onMessage?: (event: { nativeEvent: { data: string } }) => void } = {};
const postMessageToWebView = vi.fn();
const routerBack = vi.fn();
const routerReplace = vi.fn();
const saveTextFile = vi.fn(async () => ({ seq: 4, status: 'normal' as const }));
const postThreadMessage = vi.fn(async () => ({ event: {} }));
const listFileVersions = vi.fn(async () => ({ versions: [] as HubFileVersion[] }));
const revertFileVersion = vi.fn(async (artifactId: string, seq: number) => ({
  artifactId,
  seq,
  tombstoned: false as const,
}));
const restoreFile = vi.fn(async (artifactId: string) => ({
  artifactId,
  tombstoned: false as const,
}));

const version: HubFileVersion = {
  seq: 3,
  author: 'human:u-1',
  kind: 'modified',
  status: 'normal',
  createdAt: '2026-07-05T12:00:00.000Z',
  sizeBytes: 42,
  mime: 'text/markdown',
  isLatest: true,
};

vi.mock('expo-router', () => ({
  Stack: {
    Screen: ({ options }: { options?: { headerLeft?: () => React.ReactNode; headerRight?: () => React.ReactNode } }) => (
      <>
        {options?.headerLeft?.()}
        {options?.headerRight?.()}
      </>
    ),
  },
  router: {
    back: () => routerBack(),
    replace: (value: unknown) => routerReplace(value),
  },
  useFocusEffect: (callback: () => void | (() => void)) => {
    callback();
  },
  useLocalSearchParams: () => routeParams,
}));

vi.mock('expo-router/react-navigation', () => ({
  useHeaderHeight: () => 0,
}));

vi.mock('../src/lib/chat', () => ({
  useChat: () => ({
    api: {
      saveTextFile,
      postMessage: postThreadMessage,
      sendArtifactFeedback: vi.fn(),
      listFileVersions,
      revertFileVersion,
      restoreFile,
    },
    serverUrl: 'https://atrium.test',
    fileHeaders: { authorization: 'Bearer token' },
    me: { id: 'u-1', handle: 'gary', displayName: 'Gary' },
  }),
}));

vi.mock('react-native-webview', () => ({
  WebView: forwardRef(function MockWebView(props: { onMessage?: (event: { nativeEvent: { data: string } }) => void }, ref) {
    lastWebViewProps = props;
    useImperativeHandle(ref, () => ({
      postMessage: postMessageToWebView,
    }));
    return <button>Mock WebView</button>;
  }),
}));

function emitWebView(data: unknown) {
  act(() => {
    lastWebViewProps.onMessage?.({ nativeEvent: { data: JSON.stringify(data) } });
  });
}

describe('MarkupEditorScreen', () => {
  beforeEach(() => {
    postMessageToWebView.mockClear();
    routerBack.mockClear();
    routerReplace.mockClear();
    saveTextFile.mockClear();
    postThreadMessage.mockClear();
    listFileVersions.mockClear();
    revertFileVersion.mockClear();
    restoreFile.mockClear();
    lastWebViewProps = {};
    routeParams = {};
  });

  afterEach(() => {
    cleanup();
  });

  it('initializes the WebView shell and sends serialized reply markup natively', async () => {
    const draftId = putPendingMarkupDraft({
      artifactId: 'a-1',
      path: 'entry.md',
      seq: 3,
      workspaceId: 'ws-1',
      frontmatter: '',
      body: 'Body',
      sourceText: 'Original source',
      mode: { kind: 'reply', channelId: 'ch-1', threadRootEventId: 42 },
    });
    routeParams = { draftId };

    renderWithTheme(<MarkupEditorScreen />);
    emitWebView({ type: 'markup-shell-ready' });

    expect(postMessageToWebView).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'markup-init',
        markdown: 'Body',
        commentAuthor: 'gary',
        sourceText: 'Original source',
        artifactId: 'a-1',
        path: 'entry.md',
        artifactSeq: 3,
      }),
    );

    emitWebView({ type: 'markup-dirty', dirty: true });
    fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }));
    expect(postMessageToWebView).toHaveBeenCalledWith(JSON.stringify({ type: 'markup-request-serialize' }));

    emitWebView({ type: 'markup-serialized', markdown: 'Marked' });
    await act(async () => {});

    expect(saveTextFile).toHaveBeenCalledWith('a-1', 'Marked', 3, 'text/markdown; charset=utf-8');
    expect(postThreadMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'ch-1',
        threadRootEventId: 42,
        text: '/e/art_a-1',
      }),
    );
    expect(routerReplace).toHaveBeenCalledWith({
      pathname: '/thread/[rootId]',
      params: { rootId: '42', channelId: 'ch-1' },
    });
  });

  it('relays version-history requests back to the WebView while waiting to serialize', async () => {
    listFileVersions.mockResolvedValueOnce({ versions: [version] });
    const draftId = putPendingMarkupDraft({
      artifactId: 'a-2',
      path: 'entry.md',
      seq: 3,
      workspaceId: 'ws-1',
      frontmatter: '',
      body: 'Body',
      sourceText: null,
      mode: { kind: 'reply', channelId: 'ch-1', threadRootEventId: 42 },
    });
    routeParams = { draftId };

    renderWithTheme(<MarkupEditorScreen />);
    emitWebView({ type: 'markup-shell-ready' });
    emitWebView({ type: 'markup-dirty', dirty: true });
    fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }));
    expect(postMessageToWebView).toHaveBeenCalledWith(JSON.stringify({ type: 'markup-request-serialize' }));

    emitWebView({ type: 'markup-vh-request', reqId: 'vh-1', op: 'list' });

    await waitFor(() => {
      expect(postMessageToWebView).toHaveBeenCalledWith(
        JSON.stringify({ type: 'markup-vh-response', reqId: 'vh-1', ok: true, versions: [version] }),
      );
    });
    expect(listFileVersions).toHaveBeenCalledWith('a-2');
  });
});
