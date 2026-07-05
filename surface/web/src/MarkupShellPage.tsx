import { useEffect, useMemo, useRef, useState } from 'react';
import { MarkupEditor, type MarkupEditorHandle } from './markup/MarkupEditor';
import { parseMarkupShellMessage, postMarkupShellMessage, type ReactNativeWebViewBridge } from './MarkupShellBridge';
import { MarkupDivergenceBanner } from './components/MarkupDivergenceBanner';
import { MarkupVersionHistory } from './components/MarkupVersionHistory';
import { createBridgeVersionTransport } from './markup/markupVersionBridge';

declare global {
  interface Window {
    ReactNativeWebView?: ReactNativeWebViewBridge;
  }
}

type ShellInit = {
  markdown: string;
  sourceText: string | null;
  commentAuthor: string | null;
  artifactId?: string;
  path?: string;
  artifactSeq?: number;
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
  const [showingSource, setShowingSource] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const hasNativeBridge = typeof window !== 'undefined' && window.ReactNativeWebView != null;
  const vh = useMemo(() => createBridgeVersionTransport(window.ReactNativeWebView), []);
  const diverged = init != null && init.sourceText != null && init.sourceText.trimEnd() !== init.markdown.trimEnd();
  const activeMarkdown = init ? (showingSource ? (init.sourceText ?? init.markdown) : init.markdown) : '';

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
        setShowingSource(false);
        setInit((current) => ({
          markdown: message.markdown,
          sourceText: message.sourceText ?? null,
          commentAuthor: message.commentAuthor ?? null,
          artifactId: message.artifactId,
          path: message.path,
          artifactSeq: message.artifactSeq,
          seq: (current?.seq ?? 0) + 1,
        }));
        return;
      }
      if (message.type === 'markup-vh-response') {
        vh.handleResponse(message);
        return;
      }
      postMarkupShellMessage(window.ReactNativeWebView, {
        type: 'markup-serialized',
        markdown: editorRef.current?.serialize() ?? initMarkdownRef.current,
      });
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [vh]);

  useEffect(() => {
    initMarkdownRef.current = activeMarkdown;
  }, [activeMarkdown]);

  return (
    <main className="markup-shell-page">
      {init ? (
        <div className="relative flex min-h-0 flex-1 flex-col gap-3 p-3">
          {init.artifactId && (
            <div className="flex shrink-0 items-center justify-end">
              <button
                type="button"
                onClick={() => setShowHistory((showing) => !showing)}
                aria-pressed={showHistory}
                className="rounded-md border border-edge-strong px-2.5 py-1 text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg"
              >
                History
              </button>
            </div>
          )}
          <MarkupDivergenceBanner
            diverged={diverged}
            showingSource={showingSource}
            onReset={() => setShowingSource(true)}
            onBackToLatest={() => setShowingSource(false)}
          />
          <MarkupEditor
            key={`${init.seq}:${showingSource ? 'source' : 'latest'}`}
            ref={editorRef}
            initialMarkdown={activeMarkdown}
            commentAuthor={init.commentAuthor}
            onDirtyChange={(dirty) =>
              postMarkupShellMessage(window.ReactNativeWebView, { type: 'markup-dirty', dirty })
            }
            className="markup-shell-editor"
          />
          {showHistory && init.artifactId && (
            <div className="absolute inset-0 z-10 flex min-h-0 justify-end overflow-hidden bg-surface/95">
              <MarkupVersionHistory
                artifactId={init.artifactId}
                path={init.path ?? init.artifactId}
                currentSeq={init.artifactSeq ?? 0}
                canManage
                transport={vh.transport}
                onReverted={() => setShowHistory(false)}
                onClose={() => setShowHistory(false)}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="markup-shell-hint">
          {hasNativeBridge ? 'Loading markup editor...' : 'Open this page from the Atrium mobile app to author markup.'}
        </div>
      )}
    </main>
  );
}
