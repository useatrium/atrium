import { useMemo, useState, type CSSProperties, type ImgHTMLAttributes, type SyntheticEvent } from 'react';

const MAX_DISPLAY_WIDTH_PX = 384;
const MAX_DISPLAY_HEIGHT_PX = 288;
const FALLBACK_ASPECT_RATIO = 4 / 3;
const FALLBACK_DISPLAY_WIDTH = `min(${MAX_DISPLAY_WIDTH_PX}px, 100%)`;

export type TimelineImageDisplayBox = {
  displayWidth: number | string;
  aspectRatio: number;
  source: 'intrinsic' | 'fallback';
};

function positiveDimension(value: number | null | undefined): number | null {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : null;
}

export function getTimelineImageDisplayBox(width?: number | null, height?: number | null): TimelineImageDisplayBox {
  const intrinsicWidth = positiveDimension(width);
  const intrinsicHeight = positiveDimension(height);

  if (intrinsicWidth == null || intrinsicHeight == null) {
    return {
      displayWidth: FALLBACK_DISPLAY_WIDTH,
      aspectRatio: FALLBACK_ASPECT_RATIO,
      source: 'fallback',
    };
  }

  let displayWidth = Math.min(intrinsicWidth, MAX_DISPLAY_WIDTH_PX);
  if (displayWidth * (intrinsicHeight / intrinsicWidth) > MAX_DISPLAY_HEIGHT_PX) {
    displayWidth = MAX_DISPLAY_HEIGHT_PX * (intrinsicWidth / intrinsicHeight);
  }

  return {
    displayWidth,
    aspectRatio: intrinsicWidth / intrinsicHeight,
    source: 'intrinsic',
  };
}

type TimelineImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'alt' | 'height' | 'src' | 'width'> & {
  src: string;
  alt: string;
  width?: number | null;
  height?: number | null;
};

export function TimelineImage({ src, alt, width, height, className, onLoad, style, ...props }: TimelineImageProps) {
  const initialBox = useMemo(() => getTimelineImageDisplayBox(width, height), [width, height]);
  const [naturalSize, setNaturalSize] = useState<{ src: string; width: number; height: number } | null>(null);
  const naturalBox = useMemo(() => {
    if (!naturalSize || naturalSize.src !== src) return null;
    return getTimelineImageDisplayBox(naturalSize.width, naturalSize.height);
  }, [naturalSize, src]);
  const box = initialBox.source === 'intrinsic' ? initialBox : (naturalBox ?? initialBox);
  const intrinsicWidth = positiveDimension(width) ?? undefined;
  const intrinsicHeight = positiveDimension(height) ?? undefined;

  const sizingStyle: CSSProperties = {
    width: box.displayWidth,
    aspectRatio: box.aspectRatio,
  };

  const handleLoad = (event: SyntheticEvent<HTMLImageElement, Event>) => {
    if (initialBox.source === 'fallback') {
      const image = event.currentTarget;
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        setNaturalSize({ src, width: image.naturalWidth, height: image.naturalHeight });
      }
    }
    onLoad?.(event);
  };

  return (
    <img
      src={src}
      alt={alt}
      width={intrinsicWidth}
      height={intrinsicHeight}
      onLoad={handleLoad}
      className={['block max-w-full h-auto bg-surface-raised', className].filter(Boolean).join(' ')}
      style={{ ...style, ...sizingStyle }}
      {...props}
    />
  );
}
