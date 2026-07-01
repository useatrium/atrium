import { FileIcon } from '../Icon';
import type { PreviewFile } from '../types';
import type { MediaPreviewVariant } from '../types';
import { formatBytes, kindLabel, effectiveMediaKind } from '../utils';

export function OpaqueRenderer({ file, variant }: { file: PreviewFile; variant: MediaPreviewVariant }) {
  const kind = effectiveMediaKind(file);
  if (variant === 'tile') {
    return (
      <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 bg-surface-raised/50 p-3 text-center">
        <FileIcon size={26} className="text-fg-muted" />
        <div className="max-w-full truncate text-xs font-semibold text-fg">{file.name}</div>
        <div className="text-3xs uppercase tracking-wide text-fg-muted">{kindLabel(kind)}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-72 items-center justify-center p-6">
      <div className="w-[min(420px,100%)] rounded-lg border border-edge bg-surface-raised/55 p-5 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-md border border-edge bg-surface-overlay/70 text-fg-muted">
          <FileIcon size={24} />
        </div>
        <h3 className="mt-3 truncate text-sm font-semibold text-fg" title={file.name}>
          {file.name}
        </h3>
        <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-left text-xs">
          <dt className="text-fg-muted">Kind</dt>
          <dd className="truncate text-fg-secondary">{kindLabel(kind)}</dd>
          <dt className="text-fg-muted">MIME</dt>
          <dd className="truncate font-mono text-fg-secondary">{file.mime || 'Unknown'}</dd>
          <dt className="text-fg-muted">Size</dt>
          <dd className="text-fg-secondary">{formatBytes(file.sizeBytes)}</dd>
        </dl>
      </div>
    </div>
  );
}
