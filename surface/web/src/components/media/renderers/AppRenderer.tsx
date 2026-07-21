import { useMemo, useState } from 'react';
import { FileIcon } from '../Icon';
import type { PreviewFile, MediaPreviewVariant } from '../types';
import { fileExtension } from '../utils';

const APP_PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals';

function appRendererFor(file: PreviewFile) {
  const ext = fileExtension(file.name);
  return ext === 'jsx' || ext === 'tsx' ? 'react-jsx' : 'html-app';
}

export function AppRenderer({ file, variant }: { file: PreviewFile; variant: MediaPreviewVariant }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const renderer = useMemo(() => appRendererFor(file), [file]);
  const src = useMemo(() => {
    const params = new URLSearchParams({ renderer, at: 'latest' });
    return `/api/files/${encodeURIComponent(file.id)}/preview?${params.toString()}`;
  }, [file.id, renderer]);

  if (variant === 'tile') {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 bg-surface-raised/50 p-3 text-center">
        <FileIcon size={26} className="text-fg-muted" />
        <div className="max-w-full truncate text-xs font-semibold text-fg">{file.name}</div>
        <div className="text-3xs uppercase tracking-wide text-fg-muted">Web app</div>
      </div>
    );
  }

  return (
    <div className="h-full p-4 md:p-6" data-lightbox-backdrop>
      <div className="relative h-full min-h-0 overflow-hidden rounded-xl border border-edge bg-surface shadow-2xl">
        {state === 'loading' && (
          <div className="absolute inset-0 z-raised flex items-center justify-center bg-surface text-sm text-fg-muted">
            <span className="mr-2 h-3 w-3 animate-spin rounded-full border-2 border-edge-strong border-t-transparent" />
            Loading web app...
          </div>
        )}
        {state === 'error' && (
          <div className="absolute inset-0 z-raised flex items-center justify-center bg-surface p-6 text-center">
            <div className="w-[min(360px,100%)] rounded-lg border border-danger-border/60 bg-danger-tint/20 p-4 text-sm text-danger-text">
              Failed to load web app preview.
            </div>
          </div>
        )}
        <iframe
          title={`Web app preview: ${file.name}`}
          src={src}
          sandbox={APP_PREVIEW_SANDBOX}
          className="h-full w-full border-0 bg-white"
          onLoad={() => setState('ready')}
          onError={() => setState('error')}
        />
      </div>
    </div>
  );
}
