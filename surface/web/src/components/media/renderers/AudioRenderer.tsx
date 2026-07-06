import { FileIcon } from '../Icon';
import type { PreviewFile, MediaPreviewVariant } from '../types';

export function AudioRenderer({ file, variant }: { file: PreviewFile; variant: MediaPreviewVariant }) {
  if (variant === 'tile') {
    return (
      <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 bg-surface-raised/50 p-3">
        <FileIcon size={26} className="text-fg-muted" />
        <div className="max-w-full truncate text-xs font-semibold text-fg">{file.name}</div>
        <div className="text-3xs uppercase tracking-wide text-fg-muted">Audio</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-72 items-center justify-center bg-surface p-6">
      <div className="w-[min(560px,100%)] rounded-lg border border-edge bg-surface-raised/55 p-5">
        <div className="mb-3 truncate text-sm font-semibold text-fg">{file.name}</div>
        <audio src={file.contentUrl} className="w-full" controls preload="metadata">
          <track kind="captions" />
        </audio>
      </div>
    </div>
  );
}
