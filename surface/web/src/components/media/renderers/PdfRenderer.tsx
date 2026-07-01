import { useEffect, useRef, useState } from 'react';
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';
import type { PreviewFile, MediaPreviewVariant } from '../types';
import { ChevronLeftIcon, ChevronRightIcon, FileIcon } from '../Icon';

export function PdfRenderer({ file, variant }: { file: PreviewFile; variant: MediaPreviewVariant }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPages(0);
    setPage(1);
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    void import('pdfjs-dist')
      .then(async (pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
        const doc = await pdfjs.getDocument({ url: file.contentUrl }).promise;
        if (cancelled) return;
        setPages(doc.numPages);
        const pdfPage = await doc.getPage(1);
        if (cancelled) return;
        const viewport = pdfPage.getViewport({ scale: variant === 'tile' ? 0.55 : 1.35 });
        const context = canvas.getContext('2d');
        if (!context) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load PDF');
      });

    return () => {
      cancelled = true;
    };
  }, [file, variant]);

  useEffect(() => {
    if (variant === 'tile' || pages === 0) return undefined;
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    void import('pdfjs-dist')
      .then(async (pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
        const doc = await pdfjs.getDocument({ url: file.contentUrl }).promise;
        const pdfPage = await doc.getPage(page);
        if (cancelled) return;
        const viewport = pdfPage.getViewport({ scale: 1.35 });
        const context = canvas.getContext('2d');
        if (!context) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to render PDF page');
      });
    return () => {
      cancelled = true;
    };
  }, [file, page, pages, variant]);

  if (variant === 'tile') {
    return (
      <div className="flex h-full min-h-32 items-center justify-center overflow-hidden bg-surface-raised/40 p-2">
        {error ? (
          <div className="flex flex-col items-center gap-2 text-center text-xs text-fg-muted">
            <FileIcon size={24} />
            <span>PDF</span>
          </div>
        ) : (
          <canvas ref={canvasRef} className="max-h-full max-w-full rounded-sm shadow-sm" />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center justify-center gap-2 border-b border-edge bg-surface-raised/45">
        <button
          type="button"
          className="grid size-7 place-items-center rounded-md text-fg-secondary hover:bg-surface-overlay hover:text-fg disabled:text-fg-faint"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
          aria-label="Previous PDF page"
        >
          <ChevronLeftIcon size={15} />
        </button>
        <span className="min-w-24 text-center text-2xs tabular-nums text-fg-muted">
          Page {page} of {pages || '?'}
        </span>
        <button
          type="button"
          className="grid size-7 place-items-center rounded-md text-fg-secondary hover:bg-surface-overlay hover:text-fg disabled:text-fg-faint"
          onClick={() => setPage((p) => Math.min(pages, p + 1))}
          disabled={pages === 0 || page >= pages}
          aria-label="Next PDF page"
        >
          <ChevronRightIcon size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 text-center">
        {error ? (
          <div className="mt-8 text-sm text-danger-text">{error}</div>
        ) : (
          <canvas ref={canvasRef} className="mx-auto max-w-full rounded-sm shadow-lg shadow-black/20" />
        )}
      </div>
    </div>
  );
}
