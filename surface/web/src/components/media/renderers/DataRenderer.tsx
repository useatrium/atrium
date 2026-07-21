import { useMemo } from 'react';
import Papa from 'papaparse';
import { SessionMarkdown } from '../../../sessions/Markdown';
import type { PreviewFile, MediaPreviewVariant } from '../types';
import { usePreviewText } from '../previewTextCache';
import { isCsvFile, isNotebookFile } from '../utils';

type NotebookCell = {
  cell_type?: string;
  source?: string | string[];
  outputs?: Array<{ output_type?: string; text?: string | string[]; data?: Record<string, string | string[]> }>;
};

type NotebookOutput = NonNullable<NotebookCell['outputs']>[number];

function sourceText(source?: string | string[]) {
  return Array.isArray(source) ? source.join('') : (source ?? '');
}

function outputText(output: NotebookOutput) {
  if (!output) return '';
  if (output.text) return sourceText(output.text);
  const text = output.data?.['text/plain'];
  return Array.isArray(text) ? text.join('') : (text ?? '');
}

export function PreviewTable({ rows, compact }: { rows: string[][]; compact: boolean }) {
  const visibleRows = useMemo(() => rows.slice(0, compact ? 8 : 500), [compact, rows]);
  const headers = visibleRows[0] ?? [];
  const body = visibleRows.slice(1);

  return (
    <div className="h-full overflow-auto">
      <table className="min-w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 z-sticky bg-surface-raised">
          <tr>
            {headers.map((header, idx) => (
              <th key={`${header}-${idx}`} className="border-b border-r border-edge px-2 py-1.5 font-semibold text-fg">
                {header || `Column ${idx + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIdx) => (
            <tr key={rowIdx} className="odd:bg-surface-raised/25">
              {headers.map((_, colIdx) => (
                <td
                  key={colIdx}
                  className="max-w-64 border-b border-r border-edge/80 px-2 py-1.5 align-top text-fg-body"
                >
                  <span className="line-clamp-3 break-words">{row[colIdx] ?? ''}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CsvTable({ text, compact }: { text: string; compact: boolean }) {
  const rows = useMemo(() => {
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
    return parsed.data;
  }, [compact, text]);

  return <PreviewTable rows={rows} compact={compact} />;
}

function NotebookView({ text, compact }: { text: string; compact: boolean }) {
  let cells: NotebookCell[] = [];
  try {
    const parsed = JSON.parse(text) as { cells?: NotebookCell[] };
    cells = parsed.cells ?? [];
  } catch {
    return <pre className="whitespace-pre-wrap p-3 font-mono text-xs text-danger-text">Invalid notebook JSON</pre>;
  }
  const visibleCells = compact ? cells.slice(0, 3) : cells;

  return (
    <div className={compact ? 'space-y-2 p-3' : 'space-y-3'}>
      {visibleCells.map((cell, idx) => {
        const textValue = sourceText(cell.source);
        return (
          <section key={idx} className="rounded-md border border-edge bg-surface-raised/40">
            <div className="border-b border-edge px-3 py-1 text-3xs font-semibold uppercase tracking-wide text-fg-muted">
              {cell.cell_type ?? 'cell'} {idx + 1}
            </div>
            <div className="px-3 py-2">
              {cell.cell_type === 'markdown' ? (
                <SessionMarkdown text={textValue} />
              ) : (
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-fg-body">
                  {textValue}
                </pre>
              )}
              {!compact &&
                cell.outputs?.map((output, outputIdx) => {
                  const rendered = outputText(output);
                  return rendered ? (
                    <pre
                      key={outputIdx}
                      className="mt-2 overflow-x-auto whitespace-pre-wrap rounded border border-edge bg-surface px-2 py-1.5 font-mono text-2xs text-fg-muted"
                    >
                      {rendered}
                    </pre>
                  ) : null;
                })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function DataRenderer({ file, variant }: { file: PreviewFile; variant: MediaPreviewVariant }) {
  const state = usePreviewText(file);

  if (state.status !== 'ready') {
    if (variant === 'tile') {
      return (
        <div className="flex h-full min-h-0 items-center justify-center bg-surface-raised/35 p-3 text-sm text-fg-muted">
          {state.status === 'loading' ? 'Loading data...' : state.text}
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-32 items-center justify-center p-3 text-sm text-white/70">
        {state.status === 'loading' ? 'Loading data...' : state.text}
      </div>
    );
  }

  if (isNotebookFile(file)) {
    if (variant === 'tile') return <NotebookView text={state.text} compact />;
    return (
      <div className="h-full overflow-y-auto px-4 py-6 md:px-8" data-lightbox-backdrop>
        <div className="mx-auto max-w-4xl rounded-xl border border-edge bg-surface p-5 shadow-2xl">
          <NotebookView text={state.text} compact={false} />
        </div>
      </div>
    );
  }
  if (isCsvFile(file)) {
    if (variant === 'tile') return <CsvTable text={state.text} compact />;
    return (
      <div className="h-full p-4 md:p-6" data-lightbox-backdrop>
        <div className="h-full overflow-hidden rounded-xl border border-edge bg-surface shadow-2xl">
          <CsvTable text={state.text} compact={false} />
        </div>
      </div>
    );
  }

  let pretty = state.text;
  try {
    pretty = JSON.stringify(JSON.parse(state.text), null, 2);
  } catch {
    pretty = state.text;
  }

  if (variant === 'tile') {
    return (
      <pre className="h-full overflow-auto whitespace-pre-wrap bg-surface p-4 font-mono text-xs leading-relaxed text-fg-body">
        {pretty}
      </pre>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-8" data-lightbox-backdrop>
      <pre className="mx-auto max-w-4xl whitespace-pre-wrap rounded-xl border border-edge bg-surface p-5 font-mono text-xs leading-relaxed text-fg-body shadow-2xl">
        {pretty}
      </pre>
    </div>
  );
}
