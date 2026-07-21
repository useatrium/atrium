import { containsCriticMarkup } from '@atrium/surface-client';
import { CriticMarkupView } from '../../CriticMarkupView';
import { SessionMarkdown } from '../../../sessions/Markdown';
import type { PreviewFile, MediaPreviewVariant } from '../types';
import { usePreviewText } from '../previewTextCache';

export function MarkdownRenderer({ file, variant }: { file: PreviewFile; variant: MediaPreviewVariant }) {
  const state = usePreviewText(file);

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
    <div className="h-full overflow-y-auto px-4 py-6 md:px-8" data-lightbox-backdrop>
      {state.status === 'loading' ? (
        <div className="flex h-full items-center justify-center text-sm text-white/70">Loading markdown...</div>
      ) : state.status === 'error' ? (
        <div className="flex h-full items-center justify-center">
          <div className="rounded-md border border-danger-border bg-danger-tint px-4 py-3 text-sm text-danger-text">
            {state.text}
          </div>
        </div>
      ) : (
        <div className="mx-auto max-w-3xl rounded-xl border border-edge bg-surface p-6 shadow-2xl md:p-10">
          {containsCriticMarkup(state.text) ? (
            <CriticMarkupView text={state.text} />
          ) : (
            <SessionMarkdown text={state.text} />
          )}
        </div>
      )}
    </div>
  );
}
