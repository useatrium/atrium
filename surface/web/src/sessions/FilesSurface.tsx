import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { ChevronRightIcon, FileIcon, XIcon } from '../components/icons';
import { VersionSkewBadge } from './ConflictSurface';

type Backing = 'git' | 'ledger';
type FileType = 'file' | 'dir';

type FileRow = {
  path: string;
  backing: Backing;
  type: FileType;
};

type GitHistoryEntry = {
  sha: string;
  author: string;
  date: string;
  subject: string;
};

type LedgerHistoryEntry = {
  seq: number;
  sha: string;
  author: string;
  kind: string;
  status: string;
};

type HistoryResponse = {
  backing: Backing;
  entries: Array<GitHistoryEntry | LedgerHistoryEntry>;
};

type PreviewVersionSkew = {
  path: string;
  workingSeq: number;
  latestSeq: number;
};

const BACKING_BADGE: Record<Backing, string> = {
  git: 'bg-info/15 text-info-text',
  ledger: 'bg-surface-overlay/80 text-fg-secondary',
};

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function parentDir(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function filesUrl(sessionId: string, dir: string): string {
  return `/api/sessions/${sessionId}/files?dir=${encodeURIComponent(dir)}`;
}

function contentUrl(sessionId: string, path: string): string {
  return `/api/sessions/${sessionId}/files/content?path=${encodeURIComponent(path)}`;
}

function historyUrl(sessionId: string, path: string): string {
  return `/api/sessions/${sessionId}/files/history?path=${encodeURIComponent(path)}`;
}

async function responseError(response: Response, fallback: string): Promise<string> {
  if (typeof response.text !== 'function') return fallback;
  const text = await response.text();
  return text.trim() || fallback;
}

function seqHeader(response: Response, name: string): number | null {
  const raw = response.headers?.get(name);
  if (!raw) return null;
  const seq = Number(raw);
  return Number.isInteger(seq) && seq >= 0 ? seq : null;
}

function previewVersionSkew(row: FileRow, response: Response): PreviewVersionSkew | null {
  if (row.backing !== 'ledger') return null;
  if (response.headers?.get('X-Artifact-Conflicted') !== 'true') return null;
  const workingSeq = seqHeader(response, 'X-Artifact-Seq');
  const latestSeq = seqHeader(response, 'X-Artifact-Conflict-Seq');
  if (workingSeq == null || latestSeq == null || latestSeq <= workingSeq) return null;
  return { path: row.path, workingSeq, latestSeq };
}

function BackingBadge({ backing }: { backing: Backing }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-px text-3xs font-semibold uppercase tracking-wide ${BACKING_BADGE[backing]}`}
    >
      {backing}
    </span>
  );
}

function Breadcrumb({ dir, onNavigate }: { dir: string; onNavigate: (dir: string) => void }) {
  const parts = dir.split('/').filter(Boolean);
  return (
    <div className="flex min-w-0 items-center gap-1 border-b border-edge bg-surface-raised/40 px-3 py-1.5 font-mono text-2xs text-fg-muted">
      <button
        type="button"
        onClick={() => onNavigate('')}
        className="shrink-0 rounded px-1 py-0.5 hover:bg-surface-overlay hover:text-fg-body"
      >
        files
      </button>
      {parts.map((part, index) => {
        const target = parts.slice(0, index + 1).join('/');
        return (
          <span key={target} className="flex min-w-0 items-center gap-1">
            <span className="text-fg-faint">/</span>
            <button
              type="button"
              onClick={() => onNavigate(target)}
              className="max-w-28 truncate rounded px-1 py-0.5 hover:bg-surface-overlay hover:text-fg-body"
              title={target}
            >
              {part}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function HistoryEntries({ history }: { history: HistoryResponse }) {
  if (history.entries.length === 0) {
    return <div className="border-t border-edge px-3 py-2 text-2xs text-fg-muted">No history</div>;
  }
  return (
    <div className="max-h-40 overflow-y-auto border-t border-edge">
      {history.entries.map((entry, index) => (
        <div key={`${history.backing}-${index}`} className="border-b border-edge px-3 py-1.5 last:border-b-0">
          {'seq' in entry ? (
            <div className="flex min-w-0 items-center gap-2 text-2xs">
              <span className="shrink-0 font-mono tabular-nums text-fg-muted">#{entry.seq}</span>
              <span className="shrink-0 font-mono text-fg-muted">{entry.sha.slice(0, 8)}</span>
              <span className="shrink-0 rounded bg-surface-overlay px-1 py-px text-3xs font-semibold uppercase tracking-wide text-fg-secondary">
                {entry.kind}
              </span>
              <span className="min-w-0 flex-1 truncate text-fg-body">{entry.author}</span>
              <span className="shrink-0 text-fg-muted">{entry.status}</span>
            </div>
          ) : (
            <div className="min-w-0 text-2xs">
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 font-mono text-fg-muted">{entry.sha.slice(0, 8)}</span>
                <span className="min-w-0 flex-1 truncate text-fg-body">{entry.subject}</span>
              </div>
              <div className="mt-0.5 truncate text-3xs text-fg-muted">
                {entry.author} · {entry.date}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function FilesSurface({
  sessionId,
  onClose,
  embedded = false,
}: {
  sessionId: string;
  onClose: () => void;
  embedded?: boolean;
}): JSX.Element {
  const [dir, setDir] = useState('');
  const [rows, setRows] = useState<FileRow[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FileRow | null>(null);
  const [content, setContent] = useState('');
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [versionSkew, setVersionSkew] = useState<PreviewVersionSkew | null>(null);

  const sortedRows = useMemo(
    () =>
      [...rows].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return basename(a.path).localeCompare(basename(b.path));
      }),
    [rows],
  );

  const loadContent = useCallback(
    async (row: FileRow) => {
      setContentLoading(true);
      setContentError(null);
      setVersionSkew(null);
      try {
        const response = await fetch(contentUrl(sessionId, row.path), { credentials: 'same-origin' });
        if (!response.ok) throw new Error(await responseError(response, 'Could not load file'));
        const skew = previewVersionSkew(row, response);
        const text = await response.text();
        setContent(text);
        setDraft(text);
        setVersionSkew(skew);
      } catch (error) {
        setContent('');
        setDraft('');
        setVersionSkew(null);
        setContentError(error instanceof Error ? error.message : 'Could not load file');
      } finally {
        setContentLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setRowsLoading(true);
    setRowsError(null);
    fetch(filesUrl(sessionId, dir), { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response, 'Could not load files'));
        return (await response.json()) as { rows: FileRow[] };
      })
      .then((body) => {
        setRows(body.rows);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setRows([]);
        setRowsError(error instanceof Error ? error.message : 'Could not load files');
      })
      .finally(() => {
        if (!controller.signal.aborted) setRowsLoading(false);
      });
    return () => controller.abort();
  }, [dir, sessionId]);

  function selectFile(row: FileRow) {
    setSelected(row);
    setEditing(false);
    setSaveError(null);
    setHistoryOpen(false);
    setHistory(null);
    setHistoryError(null);
    void loadContent(row);
  }

  async function toggleHistory() {
    if (!selected) return;
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await fetch(historyUrl(sessionId, selected.path), { credentials: 'same-origin' });
      if (!response.ok) throw new Error(await responseError(response, 'Could not load history'));
      setHistory((await response.json()) as HistoryResponse);
    } catch (error) {
      setHistory(null);
      setHistoryError(error instanceof Error ? error.message : 'Could not load history');
    } finally {
      setHistoryLoading(false);
    }
  }

  async function saveFile() {
    if (!selected) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/files?path=${encodeURIComponent(selected.path)}`, {
        method: 'PUT',
        credentials: 'same-origin',
        body: draft,
      });
      if (!response.ok) throw new Error(await responseError(response, 'Could not save file'));
      await loadContent(selected);
      setEditing(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save file');
    } finally {
      setSaving(false);
    }
  }

  const listPane = (
    <div className="flex min-h-0 flex-1 flex-col border-r border-edge">
      <Breadcrumb dir={dir} onNavigate={setDir} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {dir !== '' && (
          <button
            type="button"
            onClick={() => setDir(parentDir(dir))}
            className="flex w-full items-center gap-2 border-b border-edge px-3 py-1.5 text-left text-2xs text-fg-muted hover:bg-surface-overlay/50 hover:text-fg-body"
          >
            <span className="shrink-0 font-mono text-3xs">up</span>
            <span className="min-w-0 flex-1 font-mono">..</span>
          </button>
        )}
        {rowsLoading && <div className="px-3 py-2 text-2xs text-fg-muted">loading files...</div>}
        {rowsError && (
          <div role="alert" className="px-3 py-2 text-2xs text-danger-text">
            {rowsError}
          </div>
        )}
        {!rowsLoading && !rowsError && sortedRows.length === 0 && (
          <div className="px-3 py-2 text-2xs text-fg-muted">No files</div>
        )}
        {!rowsLoading &&
          !rowsError &&
          sortedRows.map((row) => {
            const active = selected?.path === row.path;
            return (
              <button
                type="button"
                key={`${row.backing}:${row.type}:${row.path}`}
                onClick={() => (row.type === 'dir' ? setDir(row.path) : selectFile(row))}
                className={`flex w-full items-center gap-2 border-b border-edge px-3 py-1.5 text-left hover:bg-surface-overlay/50 ${
                  active ? 'bg-surface-overlay/60' : ''
                }`}
              >
                <span className="grid size-4 shrink-0 place-items-center text-fg-muted">
                  {row.type === 'dir' ? <ChevronRightIcon size={13} /> : <FileIcon size={13} />}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-body" title={row.path}>
                  {basename(row.path)}
                </span>
                <BackingBadge backing={row.backing} />
              </button>
            );
          })}
      </div>
    </div>
  );

  const previewPane = (
    <div className="flex min-h-0 flex-[1.4] flex-col">
      {selected ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-body" title={selected.path}>
              {selected.path}
            </span>
            {versionSkew?.path === selected.path && (
              <VersionSkewBadge workingSeq={versionSkew.workingSeq} latestSeq={versionSkew.latestSeq} />
            )}
            <BackingBadge backing={selected.backing} />
            <button
              type="button"
              onClick={toggleHistory}
              className="rounded px-2 py-0.5 text-2xs font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
            >
              History
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing((value) => !value);
                setDraft(content);
                setSaveError(null);
              }}
              className="rounded border border-edge-strong px-2 py-0.5 text-2xs font-medium text-fg-body hover:bg-surface-overlay"
            >
              {editing ? 'Preview' : 'Edit'}
            </button>
          </div>
          {historyOpen && (
            <div className="shrink-0 bg-surface-raised/30">
              {historyLoading && (
                <div className="border-t border-edge px-3 py-2 text-2xs text-fg-muted">
                  loading history...
                </div>
              )}
              {historyError && (
                <div role="alert" className="border-t border-edge px-3 py-2 text-2xs text-danger-text">
                  {historyError}
                </div>
              )}
              {!historyLoading && !historyError && history && <HistoryEntries history={history} />}
            </div>
          )}
          {contentLoading ? (
            <div className="px-3 py-2 text-2xs text-fg-muted">loading content...</div>
          ) : contentError ? (
            <div role="alert" className="px-3 py-2 text-2xs text-danger-text">
              {contentError}
            </div>
          ) : editing ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
              <textarea
                aria-label="File contents"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-0 flex-1 resize-none rounded-md border border-edge bg-surface p-2 font-mono text-2xs leading-relaxed text-fg-body outline-none focus:border-edge-focus"
              />
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={saveFile}
                  disabled={saving}
                  className="rounded-md bg-accent px-2 py-1 text-2xs font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-surface-overlay disabled:text-fg-muted"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                {saveError && (
                  <span role="alert" className="text-2xs text-danger-text">
                    {saveError}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-surface px-3 py-2 font-mono text-2xs leading-relaxed text-fg-body">
              {content}
            </pre>
          )}
        </>
      ) : (
        <div className="px-3 py-2 text-2xs text-fg-muted">Select a file</div>
      )}
    </div>
  );

  const body = (
    <div className="flex min-h-0 flex-1">
      {listPane}
      {previewPane}
    </div>
  );

  if (embedded) return body;

  return (
    <div
      data-testid="files-surface"
      role="dialog"
      aria-label="Files"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      className="absolute inset-0 z-10 flex flex-col bg-surface/95 backdrop-blur-sm"
    >
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-edge px-3">
        <h3 className="text-xs font-semibold text-fg">
          Files <span className="tabular-nums text-fg-muted">· {rows.length}</span>
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close files"
          className="rounded-md px-1.5 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
        >
          <XIcon size={15} />
        </button>
      </header>
      {body}
    </div>
  );
}
