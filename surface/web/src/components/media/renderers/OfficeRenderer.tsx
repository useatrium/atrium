import { useEffect, useMemo, useRef, useState } from 'react';
import { DownloadIcon, FileIcon } from '../Icon';
import type { PreviewFile, MediaPreviewVariant } from '../types';
import { fileExtension, formatBytes, isDocxFile, isPptxFile, officeFileKind } from '../utils';
import { PreviewTable } from './DataRenderer';

type PresentationSlide = { index: number; lines: string[] };

type RenderState =
  | { status: 'idle' | 'loading' | 'ready' }
  | { status: 'sheet-ready'; rows: string[][]; sheetName: string; sheetCount: number }
  | { status: 'slides-ready'; slides: PresentationSlide[] }
  | { status: 'error'; message: string };

function officeLabel(file: PreviewFile) {
  const kind = officeFileKind(file);
  if (kind === 'word') return 'Word document';
  if (kind === 'spreadsheet') return 'Spreadsheet';
  if (kind === 'presentation') return 'Presentation';
  return 'Office document';
}

function cellText(value: unknown) {
  if (value == null) return '';
  if (value instanceof Date) return value.toLocaleDateString();
  return String(value);
}

function firstSheetSummary(rows: string[][]) {
  const rowCount = Math.max(0, rows.length - 1);
  const colCount = rows[0]?.length ?? 0;
  return `${rowCount} rows, ${colCount} columns`;
}

function slideIndex(path: string) {
  return Number(path.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1] ?? 0);
}

function extractSlideLines(xml: string) {
  const document = new DOMParser().parseFromString(xml, 'text/xml');
  const paragraphs = Array.from(document.getElementsByTagName('a:p'));
  const lines = paragraphs
    .map((paragraph) =>
      Array.from(paragraph.getElementsByTagName('a:t'))
        .map((run) => run.textContent ?? '')
        .join('')
        .trim(),
    )
    .filter(Boolean);

  if (lines.length) return lines;

  return Array.from(document.getElementsByTagName('a:t'))
    .map((run) => (run.textContent ?? '').trim())
    .filter(Boolean);
}

function OfficeThumbnail({ file }: { file: PreviewFile }) {
  if (file.thumbnailUrl) {
    return <img src={file.thumbnailUrl} alt={file.name} loading="lazy" className="h-full min-h-0 w-full bg-surface-raised object-cover" />;
  }
  return null;
}

function OfficeFallback({ file, variant, message }: { file: PreviewFile; variant: MediaPreviewVariant; message?: string }) {
  const extension = fileExtension(file.name).toUpperCase() || 'Office';

  if (variant === 'tile') {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 bg-surface-raised/50 p-3 text-center">
        <FileIcon size={26} className="text-fg-muted" />
        <div className="max-w-full truncate text-xs font-semibold text-fg">{file.name}</div>
        <div className="text-3xs uppercase tracking-wide text-fg-muted">{extension}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-72 items-center justify-center p-6">
      <div className="w-[min(440px,100%)] rounded-lg border border-edge bg-surface-raised/55 p-5 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-md border border-edge bg-surface-overlay/70 text-fg-muted">
          <FileIcon size={24} />
        </div>
        <h3 className="mt-3 truncate text-sm font-semibold text-fg" title={file.name}>
          {file.name}
        </h3>
        <p className="mt-2 text-xs leading-relaxed text-fg-muted">
          {message ?? 'Preview is not available for this Office format. Download the file to open it in a desktop app.'}
        </p>
        <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-left text-xs">
          <dt className="text-fg-muted">Kind</dt>
          <dd className="truncate text-fg-secondary">{officeLabel(file)}</dd>
          <dt className="text-fg-muted">MIME</dt>
          <dd className="truncate font-mono text-fg-secondary">{file.mime || 'Unknown'}</dd>
          <dt className="text-fg-muted">Size</dt>
          <dd className="text-fg-secondary">{formatBytes(file.sizeBytes)}</dd>
        </dl>
        <a
          href={file.contentUrl}
          download={file.name}
          className="mt-5 inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-hover"
        >
          <DownloadIcon size={15} />
          Download
        </a>
      </div>
    </div>
  );
}

function LoadingState({ label, variant }: { label: string; variant?: MediaPreviewVariant }) {
  return (
    <div
      className={`flex h-full ${variant === 'tile' ? 'min-h-0' : 'min-h-32'} items-center justify-center bg-surface-raised/35 p-3 text-sm text-fg-muted`}
    >
      {label}
    </div>
  );
}

export function OfficeRenderer({ file, variant }: { file: PreviewFile; variant: MediaPreviewVariant }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const officeKind = officeFileKind(file);
  const [state, setState] = useState<RenderState>({ status: 'idle' });
  const unsupportedMessage = useMemo(() => {
    if (officeKind === 'presentation' && !isPptxFile(file)) {
      return 'Legacy PowerPoint files cannot be rendered in the browser preview. Download the file to view slides.';
    }
    if (officeKind === 'word' && !isDocxFile(file)) {
      return 'Legacy .doc files cannot be rendered in the browser preview. Download the file to view it.';
    }
    return undefined;
  }, [file, officeKind]);

  useEffect(() => {
    if (officeKind !== 'word' || !isDocxFile(file)) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;

    const controller = new AbortController();
    let cancelled = false;
    container.innerHTML = '';
    setState({ status: 'loading' });

    void fetch(file.contentUrl, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load ${file.name}: ${res.status}`);
        return res.blob();
      })
      .then(async (blob) => {
        const docx = await import('docx-preview');
        if (cancelled) return;
        await docx.renderAsync(blob, container, undefined, {
          breakPages: variant === 'full',
          ignoreHeight: variant === 'tile',
          ignoreWidth: variant === 'tile',
          inWrapper: true,
          renderComments: false,
          renderFooters: variant === 'full',
          renderHeaders: variant === 'full',
        });
        if (!cancelled) setState({ status: 'ready' });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !cancelled) {
          setState({ status: 'error', message: error instanceof Error ? error.message : 'Failed to render document' });
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
      container.innerHTML = '';
    };
  }, [file, officeKind, variant]);

  useEffect(() => {
    if (officeKind !== 'presentation' || !isPptxFile(file) || variant !== 'full') return undefined;
    const controller = new AbortController();
    let cancelled = false;
    setState({ status: 'loading' });

    void fetch(file.contentUrl, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load ${file.name}: ${res.status}`);
        return res.arrayBuffer();
      })
      .then(async (buffer) => {
        const JSZip = (await import('jszip')).default;
        if (cancelled) return;
        const zip = await JSZip.loadAsync(buffer);
        const slideFiles = Object.values(zip.files)
          .filter((entry) => !entry.dir && /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
          .sort((a, b) => slideIndex(a.name) - slideIndex(b.name));

        if (!slideFiles.length) throw new Error('Presentation has no readable slides');

        const slides = await Promise.all(
          slideFiles.map(async (entry) => ({
            index: slideIndex(entry.name),
            lines: extractSlideLines(await entry.async('text')),
          })),
        );

        if (!slides.some((slide) => slide.lines.length > 0)) {
          throw new Error('Presentation has no extractable slide text');
        }

        if (!cancelled) setState({ status: 'slides-ready', slides });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !cancelled) {
          setState({ status: 'error', message: error instanceof Error ? error.message : 'Failed to render presentation' });
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file, officeKind, variant]);

  useEffect(() => {
    if (officeKind !== 'spreadsheet') return undefined;
    const controller = new AbortController();
    let cancelled = false;
    setState({ status: 'loading' });

    void fetch(file.contentUrl, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load ${file.name}: ${res.status}`);
        return res.arrayBuffer();
      })
      .then(async (buffer) => {
        const XLSX = await import('xlsx');
        if (cancelled) return;
        const workbook = XLSX.read(buffer, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) throw new Error('Workbook has no sheets');
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) throw new Error('First sheet is unavailable');
        const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { blankrows: false, defval: '', header: 1, raw: false });
        const rows = rawRows.map((row) => row.map(cellText)).filter((row) => row.some((cell) => cell.length > 0));
        if (!rows.length) throw new Error('First sheet is empty');
        setState({ status: 'sheet-ready', rows, sheetName, sheetCount: workbook.SheetNames.length });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !cancelled) {
          setState({ status: 'error', message: error instanceof Error ? error.message : 'Failed to render spreadsheet' });
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file, officeKind]);

  if (variant === 'tile') {
    const thumbnail = <OfficeThumbnail file={file} />;
    if (file.thumbnailUrl) return thumbnail;
    if (officeKind === 'presentation') return <OfficeFallback file={file} variant={variant} message={unsupportedMessage} />;
  }

  if (!officeKind || unsupportedMessage) {
    return <OfficeFallback file={file} variant={variant} message={unsupportedMessage} />;
  }

  if (state.status === 'error') {
    return <OfficeFallback file={file} variant={variant} message={state.message} />;
  }

  if (officeKind === 'spreadsheet') {
    if (state.status !== 'sheet-ready') return <LoadingState label="Loading spreadsheet..." variant={variant} />;
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface">
        {variant === 'full' && (
          <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-edge bg-surface-raised/45 px-3">
            <div className="truncate text-xs font-semibold text-fg">{state.sheetName}</div>
            <div className="shrink-0 text-2xs text-fg-muted">
              {firstSheetSummary(state.rows)}
              {state.sheetCount > 1 ? ` - ${state.sheetCount} sheets` : ''}
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
          <PreviewTable rows={state.rows} compact={variant === 'tile'} />
        </div>
      </div>
    );
  }

  if (officeKind === 'presentation') {
    if (state.status !== 'slides-ready') return <LoadingState label="Loading presentation..." variant={variant} />;
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface">
        <div className="flex shrink-0 flex-col gap-1 border-b border-edge bg-surface-raised/45 px-3 py-2">
          <div className="truncate text-xs font-semibold text-fg" title={file.name}>
            {file.name}
          </div>
          <div className="text-2xs text-fg-muted">Simplified preview - download for full fidelity</div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mx-auto flex max-w-4xl flex-col gap-4">
            {state.slides.map((slide) => (
              <section key={slide.index} className="rounded-lg border border-edge bg-surface-raised/45 p-4">
                <div className="mb-3 inline-flex rounded-md border border-edge bg-surface-overlay/70 px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-fg-muted">
                  Slide {slide.index}
                </div>
                {slide.lines.length ? (
                  <div className="space-y-2 text-sm leading-relaxed text-fg">
                    {slide.lines.map((line, index) => (
                      <p key={`${slide.index}-${index}`} className="whitespace-pre-wrap break-words">
                        {line}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-fg-muted">No extractable text on this slide.</p>
                )}
              </section>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (officeKind === 'word') {
    return (
      <div className={variant === 'tile' ? 'h-full min-h-0 overflow-hidden bg-surface-raised/40 p-2' : 'h-full min-h-0 overflow-auto bg-surface p-4'}>
        {state.status === 'loading' && <LoadingState label="Loading document..." variant={variant} />}
        <div
          ref={containerRef}
          className={
            variant === 'tile'
              ? 'pointer-events-none origin-top-left scale-[0.38] text-fg [width:260%]'
              : 'mx-auto max-w-5xl text-fg [&_.docx-wrapper]:!bg-transparent [&_.docx-wrapper]:!p-0'
          }
        />
      </div>
    );
  }

  return <OfficeFallback file={file} variant={variant} />;
}
