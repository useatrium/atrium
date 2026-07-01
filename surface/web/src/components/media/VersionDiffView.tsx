import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { HubFileVersion } from '@atrium/surface-client';
import { DiffView } from '../../sessions/fileChangeView';
import type { PreviewFile } from './types';
import { effectiveMediaKind, fileExtension, formatBytes, isNotebookFile } from './utils';

type LineOp = { kind: 'context' | 'remove' | 'add'; text: string };
type Segment = { kind: 'same' | 'changed'; text: string };

const TEXT_MIME_PARTS = ['json', 'yaml', 'xml', 'javascript', 'typescript', 'markdown', 'csv'];

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

function simpleLineOps(oldText: string, newText: string): LineOp[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const out: LineOp[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i += 1) {
    if (oldLines[i] === newLines[i]) out.push({ kind: 'context', text: oldLines[i] ?? '' });
    else {
      if (oldLines[i] !== undefined) out.push({ kind: 'remove', text: oldLines[i] ?? '' });
      if (newLines[i] !== undefined) out.push({ kind: 'add', text: newLines[i] ?? '' });
    }
  }
  return out;
}

function lineOps(oldText: string, newText: string): LineOp[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length * newLines.length > 250_000) return simpleLineOps(oldText, newText);

  const dp = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      out.push({ kind: 'context', text: oldLines[i] ?? '' });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: 'remove', text: oldLines[i] ?? '' });
      i += 1;
    } else {
      out.push({ kind: 'add', text: newLines[j] ?? '' });
      j += 1;
    }
  }
  while (i < oldLines.length) {
    out.push({ kind: 'remove', text: oldLines[i] ?? '' });
    i += 1;
  }
  while (j < newLines.length) {
    out.push({ kind: 'add', text: newLines[j] ?? '' });
    j += 1;
  }
  return out;
}

function unifiedDiff(oldText: string, newText: string): string {
  return lineOps(oldText, newText)
    .map((op) => `${op.kind === 'add' ? '+' : op.kind === 'remove' ? '-' : ' '}${op.text}`)
    .join('\n');
}

function compactInlineSegments(oldLine: string, newLine: string): { oldSegments: Segment[]; newSegments: Segment[] } {
  let prefix = 0;
  while (prefix < oldLine.length && prefix < newLine.length && oldLine[prefix] === newLine[prefix]) prefix += 1;

  let oldSuffix = oldLine.length - 1;
  let newSuffix = newLine.length - 1;
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLine[oldSuffix] === newLine[newSuffix]) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const oldSegments: Segment[] = [];
  const newSegments: Segment[] = [];
  if (prefix > 0) {
    oldSegments.push({ kind: 'same', text: oldLine.slice(0, prefix) });
    newSegments.push({ kind: 'same', text: newLine.slice(0, prefix) });
  }
  if (oldSuffix >= prefix) oldSegments.push({ kind: 'changed', text: oldLine.slice(prefix, oldSuffix + 1) });
  if (newSuffix >= prefix) newSegments.push({ kind: 'changed', text: newLine.slice(prefix, newSuffix + 1) });
  if (oldSuffix + 1 < oldLine.length) {
    oldSegments.push({ kind: 'same', text: oldLine.slice(oldSuffix + 1) });
    newSegments.push({ kind: 'same', text: newLine.slice(newSuffix + 1) });
  }
  return { oldSegments, newSegments };
}

function replacementPairs(oldText: string, newText: string): Array<{ oldLine: string; newLine: string }> {
  const ops = lineOps(oldText, newText);
  const pairs: Array<{ oldLine: string; newLine: string }> = [];
  let removed: string[] = [];
  let added: string[] = [];

  const flush = () => {
    const count = Math.min(removed.length, added.length, 30 - pairs.length);
    for (let i = 0; i < count; i += 1) pairs.push({ oldLine: removed[i] ?? '', newLine: added[i] ?? '' });
    removed = [];
    added = [];
  };

  for (const op of ops) {
    if (op.kind === 'remove') removed.push(op.text);
    else if (op.kind === 'add') added.push(op.text);
    else flush();
    if (pairs.length >= 30) break;
  }
  flush();
  return pairs;
}

function InlineLine({ label, tone, children }: { label: string; tone: 'old' | 'new'; children: ReactNode }) {
  const labelClass = tone === 'old' ? 'text-danger-text' : 'text-success-text';
  return (
    <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-2">
      <span className={labelClass}>{label}</span>
      <code className="whitespace-pre-wrap break-words font-mono text-fg-body">{children}</code>
    </div>
  );
}

function InlineChangedLines({ oldText, newText }: { oldText: string; newText: string }) {
  const pairs = useMemo(() => replacementPairs(oldText, newText), [newText, oldText]);
  if (pairs.length === 0) return null;

  return (
    <div className="border-t border-edge bg-surface-raised/35 px-3 py-2">
      <div className="mb-1 text-3xs font-semibold uppercase tracking-wide text-fg-muted">Inline changes</div>
      <div className="space-y-2 text-2xs">
        {pairs.map((pair, index) => {
          const { oldSegments, newSegments } = compactInlineSegments(pair.oldLine, pair.newLine);
          return (
            <div
              key={`${index}-${pair.oldLine}-${pair.newLine}`}
              className="rounded border border-edge bg-surface px-2 py-1.5"
            >
              <InlineLine label="old" tone="old">
                {oldSegments.map((segment, segmentIndex) => (
                  <span
                    key={segmentIndex}
                    className={
                      segment.kind === 'changed' ? 'rounded-sm bg-danger-tint px-0.5 text-danger-text' : undefined
                    }
                  >
                    {segment.text || ' '}
                  </span>
                ))}
              </InlineLine>
              <InlineLine label="new" tone="new">
                {newSegments.map((segment, segmentIndex) => (
                  <span
                    key={segmentIndex}
                    className={
                      segment.kind === 'changed' ? 'rounded-sm bg-success/15 px-0.5 text-success-text' : undefined
                    }
                  >
                    {segment.text || ' '}
                  </span>
                ))}
              </InlineLine>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TextVersionDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const diff = useMemo(() => unifiedDiff(oldText, newText), [newText, oldText]);
  return (
    <div className="overflow-hidden rounded-md border border-edge bg-surface">
      <DiffView diff={diff} />
      <InlineChangedLines oldText={oldText} newText={newText} />
    </div>
  );
}

function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

function ImageVersionDiff({ oldBlob, newBlob, file }: { oldBlob: Blob; newBlob: Blob; file: PreviewFile }) {
  const oldUrl = useObjectUrl(oldBlob);
  const newUrl = useObjectUrl(newBlob);
  const [opacity, setOpacity] = useState(50);

  if (!oldUrl || !newUrl) return null;

  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-2">
        <figure className="min-w-0 rounded-md border border-edge bg-surface p-2">
          <figcaption className="mb-1 text-3xs font-semibold uppercase tracking-wide text-fg-muted">
            Selected
          </figcaption>
          <img src={oldUrl} alt={`${file.name} selected version`} className="max-h-64 w-full object-contain" />
        </figure>
        <figure className="min-w-0 rounded-md border border-edge bg-surface p-2">
          <figcaption className="mb-1 text-3xs font-semibold uppercase tracking-wide text-fg-muted">Latest</figcaption>
          <img src={newUrl} alt={`${file.name} latest version`} className="max-h-64 w-full object-contain" />
        </figure>
      </div>
      <div className="rounded-md border border-edge bg-surface p-2">
        <div className="mb-2 flex items-center gap-2 text-2xs text-fg-muted">
          <span className="font-semibold text-fg-secondary">Onion skin</span>
          <input
            type="range"
            min={0}
            max={100}
            value={opacity}
            onChange={(event) => setOpacity(Number(event.target.value))}
            className="min-w-0 flex-1"
            aria-label="Latest version opacity"
          />
          <span className="w-10 text-right tabular-nums">{opacity}%</span>
        </div>
        <div className="relative grid min-h-56 place-items-center overflow-hidden bg-surface-raised">
          <img src={oldUrl} alt="" className="max-h-80 max-w-full object-contain" />
          <img
            src={newUrl}
            alt=""
            className="absolute inset-0 m-auto max-h-80 max-w-full object-contain"
            style={{ opacity: opacity / 100 }}
          />
        </div>
      </div>
    </div>
  );
}

function cellSource(cell: unknown): string {
  if (!cell || typeof cell !== 'object') return '';
  const source = (cell as { source?: unknown }).source;
  if (Array.isArray(source)) return source.map((item) => String(item)).join('');
  if (typeof source === 'string') return source;
  return '';
}

function cellType(cell: unknown): string {
  if (!cell || typeof cell !== 'object') return 'cell';
  const value = (cell as { cell_type?: unknown }).cell_type;
  return typeof value === 'string' ? value : 'cell';
}

function notebookCells(text: string): unknown[] {
  const parsed = JSON.parse(text) as { cells?: unknown };
  return Array.isArray(parsed.cells) ? parsed.cells : [];
}

function NotebookVersionDiff({ oldText, newText }: { oldText: string; newText: string }) {
  let oldCells: unknown[];
  let newCells: unknown[];
  try {
    oldCells = notebookCells(oldText);
    newCells = notebookCells(newText);
  } catch {
    return <TextVersionDiff oldText={oldText} newText={newText} />;
  }

  const max = Math.max(oldCells.length, newCells.length);
  return (
    <div className="space-y-2">
      {Array.from({ length: max }, (_, index) => {
        const oldCell = oldCells[index];
        const newCell = newCells[index];
        const oldSource = oldCell == null ? '' : cellSource(oldCell);
        const newSource = newCell == null ? '' : cellSource(newCell);
        const oldType = oldCell == null ? 'missing' : cellType(oldCell);
        const newType = newCell == null ? 'missing' : cellType(newCell);
        const unchanged = oldType === newType && oldSource === newSource;
        return (
          <section key={index} className="overflow-hidden rounded-md border border-edge bg-surface">
            <div className="flex items-center gap-2 border-b border-edge bg-surface-raised/45 px-3 py-1.5 text-2xs">
              <span className="font-semibold text-fg-body">Cell {index + 1}</span>
              <span className="rounded bg-surface-overlay px-1.5 py-px font-mono text-3xs text-fg-muted">
                {oldType === newType ? oldType : `${oldType} -> ${newType}`}
              </span>
              {unchanged && <span className="ml-auto text-3xs text-fg-muted">unchanged</span>}
            </div>
            {unchanged ? (
              <pre className="max-h-32 overflow-auto px-3 py-2 font-mono text-2xs text-fg-muted">
                {oldSource || ' '}
              </pre>
            ) : (
              <TextVersionDiff oldText={oldSource} newText={newSource} />
            )}
          </section>
        );
      })}
    </div>
  );
}

function isTextLike(file: PreviewFile, version: HubFileVersion): boolean {
  const mime = (version.mime ?? file.mime).toLowerCase();
  const ext = fileExtension(file.name);
  return (
    effectiveMediaKind(file) === 'text' ||
    effectiveMediaKind(file) === 'code' ||
    mime.startsWith('text/') ||
    TEXT_MIME_PARTS.some((part) => mime.includes(part)) ||
    ext === 'md' ||
    ext === 'markdown' ||
    ext === 'txt'
  );
}

export function VersionDiffView({
  file,
  selectedVersion,
  latestVersion,
  selectedBlob,
  latestBlob,
}: {
  file: PreviewFile;
  selectedVersion: HubFileVersion;
  latestVersion: HubFileVersion;
  selectedBlob: Blob;
  latestBlob: Blob;
}) {
  const [texts, setTexts] = useState<{ oldText: string; newText: string } | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const kind = effectiveMediaKind(file);
  const imageLike = kind === 'image' || (selectedVersion.mime ?? file.mime).toLowerCase().startsWith('image/');
  const notebookLike = isNotebookFile(file);
  const textLike = notebookLike || isTextLike(file, selectedVersion) || isTextLike(file, latestVersion);

  useEffect(() => {
    if (!textLike) {
      setTexts(null);
      setTextError(null);
      return;
    }
    let cancelled = false;
    Promise.all([selectedBlob.text(), latestBlob.text()])
      .then(([oldText, newText]) => {
        if (!cancelled) {
          setTexts({ oldText, newText });
          setTextError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setTextError('Could not read one of these versions as text.');
      });
    return () => {
      cancelled = true;
    };
  }, [latestBlob, selectedBlob, textLike]);

  if (notebookLike) {
    if (textError)
      return (
        <div className="rounded-md border border-danger-border bg-danger-tint p-3 text-2xs text-danger-text">
          {textError}
        </div>
      );
    if (!texts) return <div className="text-2xs text-fg-muted">Loading notebook diff...</div>;
    return <NotebookVersionDiff oldText={texts.oldText} newText={texts.newText} />;
  }

  if (textLike) {
    if (textError)
      return (
        <div className="rounded-md border border-danger-border bg-danger-tint p-3 text-2xs text-danger-text">
          {textError}
        </div>
      );
    if (!texts) return <div className="text-2xs text-fg-muted">Loading text diff...</div>;
    return <TextVersionDiff oldText={texts.oldText} newText={texts.newText} />;
  }

  if (imageLike) return <ImageVersionDiff oldBlob={selectedBlob} newBlob={latestBlob} file={file} />;

  return (
    <div className="rounded-md border border-edge bg-surface px-3 py-2 text-sm text-fg-body">
      Changed: <span className="font-mono text-danger-text">{formatBytes(selectedBlob.size)}</span>
      <span className="px-1 text-fg-muted">-&gt;</span>
      <span className="font-mono text-success-text">{formatBytes(latestBlob.size)}</span>
    </div>
  );
}
