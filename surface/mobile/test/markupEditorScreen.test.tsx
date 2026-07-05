// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import React, { forwardRef, useImperativeHandle } from 'react';
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
    },
    serverUrl: 'https://atrium.test',
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
      sourceText: null,
      mode: { kind: 'reply', channelId: 'ch-1', threadRootEventId: 42 },
    });
    routeParams = { draftId };

    renderWithTheme(<MarkupEditorScreen />);
    emitWebView({ type: 'markup-shell-ready' });

    expect(postMessageToWebView).toHaveBeenCalledWith(
      JSON.stringify({ type: 'markup-init', markdown: 'Body', commentAuthor: 'gary' }),
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
});
