import { FileIcon } from '../Icon';
import type { PreviewFile, MediaPreviewVariant } from '../types';

export function VideoRenderer({ file, variant }: { file: PreviewFile; variant: MediaPreviewVariant }) {
  if (variant === 'tile') {
    const thumbnailUrl = file.thumbnailUrl;
    return (
      <div className="relative h-full min-h-0 bg-surface-raised">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt={file.name} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <video src={file.contentUrl} className="h-full w-full object-cover" muted playsInline preload="metadata" />
        )}
        <div className="absolute inset-0 grid place-items-center bg-surface/10">
          <div className="grid size-10 place-items-center rounded-full border border-edge-strong bg-surface-overlay/90 text-fg">
            <FileIcon size={18} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 items-center justify-center p-4" data-lightbox-backdrop>
      <video src={file.contentUrl} className="max-h-full max-w-full rounded-md shadow-2xl" controls preload="metadata">
        <track kind="captions" />
      </video>
    </div>
  );
}
