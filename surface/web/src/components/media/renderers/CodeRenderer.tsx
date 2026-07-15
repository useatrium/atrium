import { useEffect, useMemo, useState } from 'react';
import { containsCriticMarkup } from '@atrium/surface-client';
import { CriticMarkupView } from '../../CriticMarkupView';
import type { PreviewFile, MediaPreviewVariant } from '../types';
import { usePreviewText } from '../previewTextCache';
import { languageForFile } from '../utils';

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function fallbackHtml(text: string) {
  const rows = text.split('\n').map((line, idx) => {
    const n = String(idx + 1);
    return `<span class="line"><span class="mr-4 inline-block w-10 select-none text-right text-fg-faint">${n}</span>${escapeHtml(line) || ' '}</span>`;
  });
  return `<pre class="m-0 overflow-x-auto p-4 font-mono text-xs leading-relaxed text-fg-body"><code>${rows.join('\n')}</code></pre>`;
}

export function CodeRenderer({ file, variant }: { file: PreviewFile; variant: MediaPreviewVariant }) {
  const state = usePreviewText(file);
  const [html, setHtml] = useState<string | null>(null);
  const language = useMemo(() => languageForFile(file), [file]);

  useEffect(() => {
    if (variant === 'tile' || state.status !== 'ready') {
      setHtml(null);
      return;
    }
    let active = true;
    setHtml(null);
    void import('shiki')
      .then((shiki) =>
        shiki.codeToHtml(state.text, {
          lang: language,
          theme: 'github-dark',
          transformers: [
            {
              line(node: { properties?: Record<string, unknown>; children?: unknown[] }, line: number) {
                node.properties = {
                  ...node.properties,
                  class: `${String(node.properties?.class ?? '')} block min-w-max`,
                };
                node.children = [
                  {
                    type: 'element',
                    tagName: 'span',
                    properties: {
                      class: 'mr-4 inline-block w-10 select-none text-right text-fg-faint',
                    },
                    children: [{ type: 'text', value: String(line) }],
                  },
                  ...(node.children ?? []),
                ];
              },
            },
          ],
        }),
      )
      .then((highlighted) => {
        if (active) setHtml(highlighted);
      })
      .catch(() => {
        if (active) setHtml(fallbackHtml(state.text));
      });
    return () => {
      active = false;
    };
  }, [language, state, variant]);

  if (variant === 'tile') {
    return (
      <div className="h-full min-h-0 overflow-hidden bg-surface-raised/40 p-3">
        <div className="mb-2 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-fg">{file.name}</div>
          <div className="rounded border border-edge px-1.5 py-0.5 text-3xs uppercase tracking-wide text-fg-muted">
            {language}
          </div>
        </div>
        <pre className="line-clamp-6 whitespace-pre-wrap font-mono text-2xs leading-relaxed text-fg-muted">
          {state.status === 'ready' ? state.text : state.status === 'loading' ? 'Loading code...' : state.text}
        </pre>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-surface">
      <div className="sticky top-0 z-sticky flex items-center gap-2 border-b border-edge bg-surface/95 px-4 py-2 backdrop-blur-sm">
        <span className="truncate font-mono text-xs font-semibold text-fg">{file.name}</span>
        <span className="rounded border border-edge px-1.5 py-0.5 text-3xs uppercase tracking-wide text-fg-muted">
          {language}
        </span>
      </div>
      {state.status === 'loading' ? (
        <div className="p-4 text-sm text-fg-muted">Loading code...</div>
      ) : state.status === 'error' ? (
        <div className="p-4 text-sm text-danger-text">{state.text}</div>
      ) : html == null ? (
        <div className="p-4 text-sm text-fg-muted">Highlighting code...</div>
      ) : containsCriticMarkup(state.text) ? (
        <div className="p-4">
          <CriticMarkupView text={state.text} />
        </div>
      ) : (
        <div
          className="media-code-view [&_.shiki]:m-0 [&_.shiki]:min-h-full [&_.shiki]:overflow-x-auto [&_.shiki]:bg-surface! [&_.shiki]:p-4 [&_.shiki]:font-mono [&_.shiki]:text-xs [&_.shiki]:leading-relaxed"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is produced by shiki from the file bytes; shiki HTML-escapes the code tokens, so this is highlighter output, not untrusted markup.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
