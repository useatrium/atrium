import { useEffect, useState } from 'react';
import { containsCriticMarkup } from '@atrium/surface-client';
import { CriticMarkupView } from '../../CriticMarkupView';
import { SessionMarkdown } from '../../../sessions/Markdown';
import type { PreviewFile, MediaPreviewVariant } from '../types';
import { fetchText } from '../utils';

export function MarkdownRenderer({ file, variant }: { file: PreviewFile; variant: MediaPreviewVariant }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; text: string }>({
    status: 'loading',
    text: '',
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', text: '' });
    fetchText(file, controller.signal)
      .then((text) => setState({ status: 'ready', text }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', text: error instanceof Error ? error.message : 'Failed to load' });
      });
    return () => controller.abort();
  }, [file]);

  if (variant === 'tile') {
    return (
      <div className="h-full min-h-0 overflow-hidden bg-surface-raised/40 p-3">
        <div className="mb-2 truncate text-xs font-semibold text-fg">{file.name}</div>
        <div className="line-clamp-5 whitespace-pre-wrap text-xs leading-relaxed text-fg-muted">
          {state.status === 'ready' ? state.text : state.status === 'loading' ? 'Loading markdown...' : state.text}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-surface px-6 py-5">
      {state.status === 'loading' ? (
        <div className="text-sm text-fg-muted">Loading markdown...</div>
      ) : state.status === 'error' ? (
        <div className="text-sm text-danger-text">{state.text}</div>
      ) : (
        <div className="mx-auto max-w-3xl">
          {containsCriticMarkup(state.text) ? <CriticMarkupView text={state.text} /> : <SessionMarkdown text={state.text} />}
        </div>
      )}
    </div>
  );
}
