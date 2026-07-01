import type { PreviewFile, MediaPreviewVariant } from './types';
import { effectiveMediaKind, isMarkdownFile, isPdfFile } from './utils';
import { AudioRenderer } from './renderers/AudioRenderer';
import { CodeRenderer } from './renderers/CodeRenderer';
import { DataRenderer } from './renderers/DataRenderer';
import { ImageRenderer } from './renderers/ImageRenderer';
import { MarkdownRenderer } from './renderers/MarkdownRenderer';
import { OpaqueRenderer } from './renderers/OpaqueRenderer';
import { PdfRenderer } from './renderers/PdfRenderer';
import { VideoRenderer } from './renderers/VideoRenderer';

export function MediaPreview({ file, variant }: { file: PreviewFile; variant: MediaPreviewVariant }) {
  const kind = effectiveMediaKind(file);

  if (kind === 'image') return <ImageRenderer file={file} variant={variant} />;
  if (kind === 'video') return <VideoRenderer file={file} variant={variant} />;
  if (kind === 'audio') return <AudioRenderer file={file} variant={variant} />;
  if (kind === 'document') {
    return isPdfFile(file) ? <PdfRenderer file={file} variant={variant} /> : <OpaqueRenderer file={file} variant={variant} />;
  }
  if (kind === 'data') return <DataRenderer file={file} variant={variant} />;
  if (kind === 'text') {
    return isMarkdownFile(file) ? <MarkdownRenderer file={file} variant={variant} /> : <CodeRenderer file={file} variant={variant} />;
  }
  if (kind === 'code') return <CodeRenderer file={file} variant={variant} />;
  return <OpaqueRenderer file={file} variant={variant} />;
}
