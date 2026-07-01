import { FileIcon } from '../Icon';
import type { PreviewFile, MediaPreviewVariant } from '../types';

export function VideoRenderer({ file, variant }: { file: PreviewFile; variant: MediaPreviewVariant }) {
  if (variant === 'tile') {
    return (
      <div className="relative h-full min-h-32 bg-surface-raised">
        <video src={file.contentUrl} className="h-full w-full object-cover" muted playsInline preload="metadata" />
        <div className="absolute inset-0 grid place-items-center bg-surface/10">
          <div className="grid size-10 place-items-center rounded-full border border-edge-strong bg-surface-overlay/90 text-fg">
            <FileIcon size={18} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-surface p-4">
      <video src={file.contentUrl} className="max-h-full max-w-full rounded-md" controls preload="metadata" />
    </div>
  );
}
