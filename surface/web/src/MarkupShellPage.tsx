import { useEffect, useRef, useState } from 'react';
import { MarkupEditor, type MarkupEditorHandle } from './markup/MarkupEditor';
import {
  parseMarkupShellMessage,
  postMarkupShellMessage,
  type ReactNativeWebViewBridge,
} from './MarkupShellBridge';

declare global {
  interface Window {
    ReactNativeWebView?: ReactNativeWebViewBridge;
  }
}

type ShellInit = {
  markdown: string;
  commentAuthor: string | null;
  seq: number;
};

export function isMarkupShellRoute(pathname: string): boolean {
  return pathname === '/markup/shell';
}

export function markupShellThemeFromSearch(search: string): 'light' | 'dark' {
  const theme = new URLSearchParams(search).get('theme');
  return theme === 'light' ? 'light' : 'dark';
}

export function MarkupShellPage() {
  const editorRef = useRef<MarkupEditorHandle | null>(null);
  const initMarkdownRef = useRef('');
  const [init, setInit] = useState<ShellInit | null>(null);
  const hasNativeBridge = typeof window !== 'undefined' && window.ReactNativeWebView != null;

  useEffect(() => {
    const root = document.documentElement;
    const previousTheme = root.dataset.theme;
    root.dataset.theme = markupShellThemeFromSearch(location.search);
    return () => {
      if (previousTheme) root.dataset.theme = previousTheme;
      else delete root.dataset.theme;
    };
  }, []);

  useEffect(() => {
    postMarkupShellMessage(window.ReactNativeWebView, { type: 'markup-shell-ready' });

    function onMessage(event: MessageEvent) {
      const message = parseMarkupShellMessage(event.data);
      if (!message) return;
      if (message.type === 'markup-init') {
        setInit((current) => ({
          markdown: message.markdown,
          commentAuthor: message.commentAuthor ?? null,
          seq: (current?.seq ?? 0) + 1,
        }));
        return;
      }
      postMarkupShellMessage(window.ReactNativeWebView, {
        type: 'markup-serialized',
        markdown: editorRef.current?.serialize() ?? initMarkdownRef.current,
      });
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    initMarkdownRef.current = init?.markdown ?? '';
  }, [init?.markdown]);

  return (
    <main className="markup-shell-page">
      {init ? (
        <MarkupEditor
          key={init.seq}
          ref={editorRef}
          initialMarkdown={init.markdown}
          commentAuthor={init.commentAuthor}
          onDirtyChange={(dirty) => postMarkupShellMessage(window.ReactNativeWebView, { type: 'markup-dirty', dirty })}
          className="markup-shell-editor"
        />
      ) : (
        <div className="markup-shell-hint">
          {hasNativeBridge ? 'Loading markup editor...' : 'Open this page from the Atrium mobile app to author markup.'}
        </div>
      )}
    </main>
  );
}
