import { useEffect, useMemo, useState } from 'react';
import type { HubFileVersion } from '@atrium/surface-client';
import { VersionDiffView } from './VersionDiffView';
import type { LightboxCallbacks, PreviewFile } from './types';
import { formatBytes } from './utils';

function relativeTime(value: string): string {
  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return value;

  const seconds = Math.round((time - Date.now()) / 1000);
  const divisions: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 60 * 60 * 24 * 365],
    ['month', 60 * 60 * 24 * 30],
    ['week', 60 * 60 * 24 * 7],
    ['day', 60 * 60 * 24],
    ['hour', 60 * 60],
    ['minute', 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, amount] of divisions) {
    if (Math.abs(seconds) >= amount) return formatter.format(Math.round(seconds / amount), unit);
  }
  return formatter.format(seconds, 'second');
}

function authorLabel(author: string): string {
  const stripped = author
    .replace(/^human:/i, '')
    .replace(/^agent:/i, '')
    .replace(/^user:/i, '')
    .replace(/^session:/i, '')
    .trim();
  return stripped || author || 'Unknown';
}

function versionLabel(version: HubFileVersion): string {
  return `v${version.seq}`;
}

function statusClass(version: HubFileVersion): string {
  if (version.status === 'conflict') return 'border-danger-border bg-danger-tint text-danger-text';
  if (version.isLatest) return 'border-accent-border bg-accent-tint text-accent-text-strong';
  return 'border-edge bg-surface-overlay text-fg-muted';
}

function VersionRow({
  version,
  selected,
  canManage,
  fileTombstoned,
  busySeq,
  onCompare,
  onRevert,
}: {
  version: HubFileVersion;
  selected: boolean;
  canManage: boolean;
  fileTombstoned: boolean;
  busySeq: number | null;
  onCompare: (version: HubFileVersion) => void;
  onRevert: (version: HubFileVersion) => void;
}) {
  const revertable = canManage && !fileTombstoned && !version.isLatest && version.kind !== 'deleted';
  return (
    <div
      className={`rounded-md border px-3 py-2 ${
        selected ? 'border-accent-border bg-accent-tint/45' : 'border-edge bg-surface'
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="font-mono text-xs font-semibold text-fg-body">{versionLabel(version)}</span>
            <span
              className={`rounded border px-1.5 py-px text-3xs font-semibold uppercase tracking-wide ${statusClass(version)}`}
            >
              {version.isLatest ? 'latest' : version.kind}
            </span>
            {version.status === 'conflict' && (
              <span className="rounded border border-danger-border bg-danger-tint px-1.5 py-px text-3xs font-semibold uppercase tracking-wide text-danger-text">
                conflict
              </span>
            )}
          </div>
          <div className="mt-1 truncate text-2xs text-fg-muted" title={version.author}>
            {authorLabel(version.author)} / {relativeTime(version.createdAt)}
          </div>
          <div className="mt-0.5 truncate text-3xs text-fg-muted">
            {formatBytes(version.sizeBytes ?? undefined)} / {version.mime ?? 'unknown mime'}
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {!version.isLatest && (
          <button
            type="button"
            className="rounded-md border border-edge-strong px-2 py-1 text-3xs font-semibold text-fg-secondary hover:bg-surface-overlay hover:text-fg"
            onClick={() => onCompare(version)}
          >
            Compare to latest
          </button>
        )}
        {revertable && (
          <button
            type="button"
            className="rounded-md border border-accent-border px-2 py-1 text-3xs font-semibold text-accent-text hover:bg-accent-soft disabled:cursor-default disabled:text-fg-faint"
            onClick={() => onRevert(version)}
            disabled={busySeq === version.seq}
          >
            {busySeq === version.seq ? 'Restoring...' : 'Restore this version'}
          </button>
        )}
      </div>
    </div>
  );
}

export function VersionHistoryPanel({
  file,
  canManage,
  onListVersions,
  onFetchVersionContent,
  onRevertVersion,
  onRestoreFile,
}: {
  file: PreviewFile;
  canManage: boolean;
  onListVersions?: LightboxCallbacks['onListVersions'];
  onFetchVersionContent?: LightboxCallbacks['onFetchVersionContent'];
  onRevertVersion?: LightboxCallbacks['onRevertVersion'];
  onRestoreFile?: LightboxCallbacks['onRestoreFile'];
}) {
  const [versions, setVersions] = useState<HubFileVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busySeq, setBusySeq] = useState<number | null>(null);
  const [restoringDeleted, setRestoringDeleted] = useState(false);
  const [compareSeq, setCompareSeq] = useState<number | null>(null);
  const [diffBlobs, setDiffBlobs] = useState<{ selected: Blob; latest: Blob } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const latestVersion = useMemo(() => versions.find((version) => version.isLatest) ?? versions[0] ?? null, [versions]);
  const selectedVersion = useMemo(
    () => versions.find((version) => version.seq === compareSeq) ?? null,
    [compareSeq, versions],
  );

  useEffect(() => {
    if (!onListVersions) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    onListVersions(file, controller.signal)
      .then((next) => {
        setVersions(next);
        setCompareSeq((current) => {
          if (current != null && next.some((version) => version.seq === current && !version.isLatest)) return current;
          return next.find((version) => !version.isLatest)?.seq ?? null;
        });
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Could not load version history');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [file, onListVersions]);

  useEffect(() => {
    if (!onFetchVersionContent || !selectedVersion || !latestVersion) {
      setDiffBlobs(null);
      setDiffError(null);
      return;
    }
    const controller = new AbortController();
    setDiffLoading(true);
    setDiffError(null);
    Promise.all([
      onFetchVersionContent(file, selectedVersion.seq, controller.signal),
      onFetchVersionContent(file, undefined, controller.signal),
    ])
      .then(([selected, latest]) => setDiffBlobs({ selected, latest }))
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setDiffBlobs(null);
        setDiffError(err instanceof Error ? err.message : 'Could not load version diff');
      })
      .finally(() => {
        if (!controller.signal.aborted) setDiffLoading(false);
      });
    return () => controller.abort();
  }, [file, latestVersion, onFetchVersionContent, selectedVersion]);

  const refresh = async () => {
    if (!onListVersions) return;
    setLoading(true);
    setError(null);
    try {
      const next = await onListVersions(file);
      setVersions(next);
      setCompareSeq((current) =>
        current != null && next.some((version) => version.seq === current)
          ? current
          : (next.find((version) => !version.isLatest)?.seq ?? null),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load version history');
    } finally {
      setLoading(false);
    }
  };

  const revert = async (version: HubFileVersion) => {
    if (!onRevertVersion) return;
    setBusySeq(version.seq);
    try {
      await onRevertVersion(file, version.seq);
      await refresh();
    } finally {
      setBusySeq(null);
    }
  };

  const restoreDeleted = async () => {
    if (!onRestoreFile) return;
    setRestoringDeleted(true);
    try {
      await onRestoreFile(file);
      await refresh();
    } finally {
      setRestoringDeleted(false);
    }
  };

  if (!onListVersions) {
    return (
      <aside className="flex w-[min(420px,44vw)] min-w-80 flex-col border-l border-edge bg-surface-raised">
        <div className="border-b border-edge px-4 py-3">
          <div className="text-xs font-semibold text-fg">History</div>
          <div className="mt-2 text-2xs text-fg-muted">Version history is not available for this file.</div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex w-[min(460px,46vw)] min-w-80 flex-col border-l border-edge bg-surface-raised">
      <div className="shrink-0 border-b border-edge px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-fg">History</div>
            <div className="mt-0.5 truncate text-3xs text-fg-muted" title={file.name}>
              {file.name}
            </div>
          </div>
          <button
            type="button"
            className="rounded-md border border-edge-strong px-2 py-1 text-3xs font-semibold text-fg-secondary hover:bg-surface-overlay hover:text-fg disabled:cursor-default disabled:text-fg-faint"
            onClick={() => void refresh()}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
        {file.tombstoned && canManage && (
          <div className="mt-3 rounded-md border border-danger-border bg-danger-tint p-2">
            <div className="text-2xs font-semibold text-danger-text">This file is removed.</div>
            <button
              type="button"
              className="mt-2 rounded-md border border-accent-border bg-surface px-2 py-1 text-3xs font-semibold text-accent-text hover:bg-accent-soft disabled:cursor-default disabled:text-fg-faint"
              onClick={() => void restoreDeleted()}
              disabled={restoringDeleted}
            >
              {restoringDeleted ? 'Restoring...' : 'Restore'}
            </button>
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="mt-2 rounded-md border border-danger-border bg-danger-tint px-2 py-1.5 text-2xs text-danger-text"
          >
            {error}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-2 border-b border-edge p-3">
          {loading && versions.length === 0 && <div className="text-2xs text-fg-muted">Loading versions...</div>}
          {!loading && versions.length === 0 && !error && (
            <div className="text-2xs text-fg-muted">No versions found.</div>
          )}
          {versions.map((version) => (
            <VersionRow
              key={version.seq}
              version={version}
              selected={compareSeq === version.seq}
              canManage={canManage}
              fileTombstoned={file.tombstoned === true}
              busySeq={busySeq}
              onCompare={(next) => setCompareSeq(next.seq)}
              onRevert={(next) => void revert(next)}
            />
          ))}
        </div>

        <div className="p-3">
          <div className="mb-2 flex items-center gap-2">
            <div className="min-w-0 flex-1 text-xs font-semibold text-fg">Diff</div>
            {selectedVersion && latestVersion && (
              <div className="shrink-0 font-mono text-3xs text-fg-muted">
                v{selectedVersion.seq} -&gt; v{latestVersion.seq}
              </div>
            )}
          </div>
          {!selectedVersion && (
            <div className="text-2xs text-fg-muted">Select an older version to compare with latest.</div>
          )}
          {diffLoading && <div className="text-2xs text-fg-muted">Loading diff...</div>}
          {diffError && (
            <div
              role="alert"
              className="rounded-md border border-danger-border bg-danger-tint px-2 py-1.5 text-2xs text-danger-text"
            >
              {diffError}
            </div>
          )}
          {selectedVersion && latestVersion && diffBlobs && !diffLoading && (
            <VersionDiffView
              file={file}
              selectedVersion={selectedVersion}
              latestVersion={latestVersion}
              selectedBlob={diffBlobs.selected}
              latestBlob={diffBlobs.latest}
            />
          )}
        </div>
      </div>
    </aside>
  );
}
