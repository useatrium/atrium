import { RotateIcon } from '../Icon';
import type { PreviewFile, MediaPreviewVariant } from '../types';
import { useZoomPan } from '../useZoomPan';

export function ImageRenderer({ file, variant }: { file: PreviewFile; variant: MediaPreviewVariant }) {
  const zoom = useZoomPan();

  if (variant === 'tile') {
    return (
      <img
        src={file.contentUrl}
        alt={file.name}
        loading="lazy"
        className="h-full min-h-32 w-full bg-surface-raised object-cover"
      />
    );
  }

  return (
    <div className="relative flex h-full min-h-0 items-center justify-center overflow-hidden bg-surface">
      <div
        className="flex h-full w-full touch-none select-none items-center justify-center overflow-hidden"
        onWheel={zoom.onWheel}
        onPointerDown={zoom.onPointerDown}
        onPointerMove={zoom.onPointerMove}
        onPointerUp={zoom.onPointerUp}
        onPointerCancel={zoom.onPointerCancel}
      >
        <img
          src={file.contentUrl}
          alt={file.name}
          draggable={false}
          className="max-h-full max-w-full object-contain transition-transform duration-150 ease-out"
          style={zoom.transform}
        />
      </div>
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center overflow-hidden rounded-md border border-edge-strong bg-surface-overlay/95 shadow-lg">
        <button
          type="button"
          className="h-8 px-3 text-sm font-semibold text-fg-secondary hover:bg-edge-strong hover:text-fg"
          onClick={zoom.zoomOut}
          aria-label="Zoom out"
          title="Zoom out"
        >
          -
        </button>
        <div className="min-w-14 border-x border-edge px-2 text-center text-2xs tabular-nums text-fg-muted">
          {Math.round(zoom.state.scale * 100)}%
        </div>
        <button
          type="button"
          className="h-8 px-3 text-sm font-semibold text-fg-secondary hover:bg-edge-strong hover:text-fg"
          onClick={zoom.zoomIn}
          aria-label="Zoom in"
          title="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="grid h-8 w-8 place-items-center border-l border-edge text-fg-secondary hover:bg-edge-strong hover:text-fg"
          onClick={zoom.reset}
          aria-label="Reset zoom"
          title="Reset zoom"
        >
          <RotateIcon size={14} />
        </button>
      </div>
    </div>
  );
}
