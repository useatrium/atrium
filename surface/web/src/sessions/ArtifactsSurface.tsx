// Artifacts work-surface (Phase 4) — the gallery of work-product files a session
// produced (images, PDFs, CSVs, …) that the sandbox capture sidecar surfaced.
// Image artifacts show a thumbnail (served from atrium's store via the session
// route); others a monochrome type label. Manifest-only entries (bytes too large
// / filtered) render disabled with a note. Newest capture first.

import { useMemo, useState } from 'react';
import type { Artifact, ArtifactPresentation } from '@atrium/centaur-client';
import { XIcon } from '../components/icons';
import { EmptyState } from './EmptyState';

const KIND_BADGE: Record<Artifact['kind'], string> = {
  created: 'bg-success/15 text-success-text',
  modified: 'bg-info/15 text-info-text',
  deleted: 'bg-danger/15 text-danger-text',
};
const KIND_LABEL: Record<Artifact['kind'], string> = {
  created: 'new',
  modified: 'changed',
  deleted: 'deleted',
};

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** A short monochrome type label (PNG / PDF / CSV) from mime, falling back to the
 * filename extension. */
function typeLabel(artifact: Artifact): string {
  const fromExt = /\.([a-z0-9]+)$/i.exec(artifact.path)?.[1];
  if (fromExt) return fromExt.toUpperCase();
  const sub = artifact.mime.split('/')[1] ?? artifact.mime;
  return (sub.split('+')[0] || 'FILE').toUpperCase().slice(0, 5);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function canPreviewArtifact(artifact: Artifact): boolean {
  return artifact.mime === 'text/html' || /\.(html?|jsx|tsx)$/i.test(artifact.path);
}

function previewUrl(sessionId: string, artifact: Artifact): string {
  const renderer = /\.(jsx|tsx)$/i.test(artifact.path) ? 'react-jsx' : 'html-app';
  return `/api/sessions/${sessionId}/artifacts/preview?path=${encodeURIComponent(artifact.path)}&renderer=${renderer}`;
}

/** URL atrium serves the bytes from (presigned-GET redirect server-side). Null
 * for manifest-only artifacts (no bytes were staged). */
function artifactSrc(sessionId: string, artifact: Artifact): string | null {
  // Serve the ledger's *latest* version for this path (the by-path route follows
  // the pointer, so it reflects later captures / write-back edits) rather than
  // this single capture's bytes.
  return artifact.ref
    ? `/api/sessions/${sessionId}/artifacts/by-path?path=${encodeURIComponent(artifact.path)}`
    : null;
}

/** Collapse captures to one entry per path (newest-wins) with a version count —
 * mirroring the ledger, which keys versions by (session, path). A file captured
 * N times shows as a single tile, not N tiles. */
export function latestArtifactsByPath(artifacts: Artifact[]): { artifact: Artifact; versions: number }[] {
  const byPath = new Map<string, { artifact: Artifact; versions: number }>();
  for (const a of artifacts) {
    const versions = (byPath.get(a.path)?.versions ?? 0) + 1;
    byPath.delete(a.path); // re-insert so the most-recently-active path sorts last
    byPath.set(a.path, { artifact: a, versions });
  }
  return [...byPath.values()].reverse(); // newest activity first
}

export function ArtifactTile({
  sessionId,
  artifact,
  versions,
  onPreview,
  presentation,
}: {
  sessionId: string;
  artifact: Artifact;
  versions: number;
  onPreview?: (artifact: Artifact) => void;
  presentation?: ArtifactPresentation;
}) {
  const src = artifactSrc(sessionId, artifact);
  const isImage = artifact.mime.startsWith('image/') && src !== null;
  // Presented artifacts always preview via the ledger-backed preview route (which
  // serves by path), even when the legacy capture `ref` is absent — hydration
  // delivers presentations independent of capture. Plain tiles still need a src.
  const previewable = canPreviewArtifact(artifact) && (src !== null || presentation != null);
  const name = presentation?.title ?? basename(artifact.path);
  const fileName = basename(artifact.path);
  const inner = (
    <>
      <div className="flex h-24 items-center justify-center overflow-hidden bg-surface">
        {isImage ? (
          // Falls back to the type label if the image can't load (manifest-only,
          // store miss, or before the capture sidecar lands).
          <img
            src={src}
            alt={fileName}
            loading="lazy"
            className="h-full w-full object-contain"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
              e.currentTarget.nextElementSibling?.removeAttribute('hidden');
            }}
          />
        ) : null}
        <span
          hidden={isImage || undefined}
          className="font-mono text-sm font-semibold tracking-wide text-fg-muted"
        >
          {typeLabel(artifact)}
        </span>
      </div>
      <div className="flex items-center gap-1.5 border-t border-edge px-2 py-1.5">
        <span
          className={`shrink-0 rounded px-1 py-px text-3xs font-semibold uppercase tracking-wide ${KIND_BADGE[artifact.kind]}`}
        >
          {KIND_LABEL[artifact.kind]}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-body" title={artifact.path}>
          {name}
        </span>
        {versions > 1 && (
          <span
            className="shrink-0 text-3xs tabular-nums text-fg-muted"
            title={`${versions} captured versions`}
          >
            v{versions}
          </span>
        )}
        <span className="shrink-0 text-3xs tabular-nums text-fg-muted">{formatBytes(artifact.size)}</span>
      </div>
      {presentation && (
        <div className="border-t border-edge px-2 py-1 text-3xs text-accent-text">
          Presented app{presentation.description ? ` · ${presentation.description}` : ''}
        </div>
      )}
      {previewable && onPreview && (
        <div className="flex items-center gap-1 border-t border-edge px-2 py-1.5">
          <button
            type="button"
            onClick={() => onPreview?.(artifact)}
            className="rounded border border-accent-border px-2 py-1 text-3xs font-semibold uppercase tracking-wide text-accent-text hover:bg-accent-soft"
          >
            Preview app
          </button>
          {src && (
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              download={name}
              className="rounded border border-edge px-2 py-1 text-3xs font-semibold uppercase tracking-wide text-fg-muted hover:bg-surface-overlay hover:text-fg"
            >
              Download
            </a>
          )}
        </div>
      )}
      {artifact.ref === null && !presentation && (
        // No bytes were staged (over the capture size limit). Be honest about why
        // rather than implying a broken link. Presented artifacts are served from
        // the ledger, so the note doesn't apply to them.
        <div className="border-t border-edge px-2 py-0.5 text-3xs text-fg-muted">
          Too large to capture — exceeds the size limit
        </div>
      )}
    </>
  );

  const tileClass = 'flex flex-col overflow-hidden rounded-md border border-edge bg-surface-raised/50';

  // When the bytes are servable, the whole tile opens/downloads the artifact;
  // manifest-only tiles (no ref) stay a non-interactive card.
  if (src && !previewable) {
    return (
      <a
        data-testid="artifact-tile"
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        download={name}
        aria-label={`Open ${fileName}`}
        className={`${tileClass} cursor-pointer transition-colors hover:border-edge-strong hover:bg-surface-raised`}
      >
        {inner}
      </a>
    );
  }
  return (
    <div data-testid="artifact-tile" title="No bytes were captured for this file" className={tileClass}>
      {inner}
    </div>
  );
}

export function ArtifactPreviewModal({
  sessionId,
  artifact,
  presentation,
  onClose,
}: {
  sessionId: string;
  artifact: Artifact;
  presentation?: ArtifactPresentation;
  onClose: () => void;
}) {
  const title = presentation?.title ?? basename(artifact.path);
  return (
    <div className="fixed inset-3 z-50 flex flex-col overflow-hidden rounded-lg border border-edge-strong bg-surface shadow-2xl">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-edge px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-fg">{title}</div>
          <div className="truncate font-mono text-3xs text-fg-muted">{artifact.path}</div>
        </div>
        <a
          href={previewUrl(sessionId, artifact)}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md border border-edge px-2 py-1 text-xs text-fg-muted hover:bg-surface-overlay hover:text-fg"
        >
          Open
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close artifact preview"
          className="rounded-md px-1.5 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
        >
          <XIcon size={15} />
        </button>
      </header>
      <iframe
        title={`Artifact preview: ${basename(artifact.path)}`}
        src={previewUrl(sessionId, artifact)}
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        className="min-h-0 flex-1 bg-white"
      />
    </div>
  );
}

export function ArtifactsSurface({
  artifacts,
  presentations = [],
  sessionId,
  onClose,
  embedded = false,
}: {
  artifacts: Artifact[];
  presentations?: ArtifactPresentation[];
  sessionId: string;
  onClose: () => void;
  /** Render body-only (no own header/overlay) — the WorkDrawer supplies the chrome. */
  embedded?: boolean;
}) {
  const [preview, setPreview] = useState<Artifact | null>(null);
  const presentationByPath = useMemo(
    () => new Map(presentations.map((presentation) => [presentation.path, presentation])),
    [presentations],
  );
  // One tile per path, newest-wins (mirrors the ledger's (session,path) chain),
  // newest activity first.
  const tiles = useMemo(() => latestArtifactsByPath(artifacts), [artifacts]);

  const body = (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {tiles.length === 0 ? (
        <EmptyState title="No artifacts yet" hint="Files the agent creates will show up here." />
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {tiles.map(({ artifact, versions }) => (
            <ArtifactTile
              key={artifact.path}
              sessionId={sessionId}
              artifact={artifact}
              versions={versions}
              onPreview={setPreview}
              presentation={presentationByPath.get(artifact.path)}
            />
          ))}
        </div>
      )}
      {preview && (
        <ArtifactPreviewModal
          sessionId={sessionId}
          artifact={preview}
          presentation={presentationByPath.get(preview.path)}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );

  if (embedded) return body;

  return (
    <div
      data-testid="artifacts-surface"
      role="dialog"
      aria-label="Artifacts"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      className="absolute inset-0 z-10 flex flex-col bg-surface/95 backdrop-blur-sm"
    >
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-edge px-3">
        <h3 className="text-xs font-semibold text-fg">
          Artifacts <span className="tabular-nums text-fg-muted">· {tiles.length}</span>
        </h3>
        <button
          onClick={onClose}
          aria-label="Close artifacts"
          className="rounded-md px-1.5 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
        >
          <XIcon size={15} />
        </button>
      </header>
      {body}
    </div>
  );
}
