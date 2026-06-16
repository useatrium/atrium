// Artifacts work-surface (Phase 4) — the gallery of work-product files a session
// produced (images, PDFs, CSVs, …) that the sandbox capture sidecar surfaced.
// Image artifacts show a thumbnail (served from atrium's store via the session
// route); others a monochrome type label. Manifest-only entries (bytes too large
// / filtered) render disabled with a note. Newest capture first.

import { useMemo } from 'react';
import type { Artifact } from '@atrium/centaur-client';
import { XIcon } from '../components/icons';

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

/** URL atrium serves the bytes from (presigned-GET redirect server-side). Null
 * for manifest-only artifacts (no bytes were staged). */
function artifactSrc(sessionId: string, artifact: Artifact): string | null {
  return artifact.ref ? `/api/sessions/${sessionId}/artifacts/${encodeURIComponent(artifact.id)}` : null;
}

function ArtifactTile({ sessionId, artifact }: { sessionId: string; artifact: Artifact }) {
  const src = artifactSrc(sessionId, artifact);
  const isImage = artifact.mime.startsWith('image/') && src !== null;
  return (
    <div
      data-testid="artifact-tile"
      className="flex flex-col overflow-hidden rounded-md border border-edge bg-surface-raised/50"
    >
      <div className="flex h-24 items-center justify-center overflow-hidden bg-surface">
        {isImage ? (
          // Falls back to the type label if the image can't load (manifest-only,
          // store miss, or before the capture sidecar lands).
          <img
            src={src}
            alt={basename(artifact.path)}
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
          {basename(artifact.path)}
        </span>
        <span className="shrink-0 text-3xs tabular-nums text-fg-muted">{formatBytes(artifact.size)}</span>
      </div>
      {artifact.ref === null && (
        <div className="border-t border-edge px-2 py-0.5 text-3xs text-fg-faint">not captured · too large</div>
      )}
    </div>
  );
}

export function ArtifactsSurface({
  artifacts,
  sessionId,
  onClose,
  embedded = false,
}: {
  artifacts: Artifact[];
  sessionId: string;
  onClose: () => void;
  /** Render body-only (no own header/overlay) — the WorkDrawer supplies the chrome. */
  embedded?: boolean;
}) {
  // Newest capture first (artifacts accumulate in capture order).
  const ordered = useMemo(() => [...artifacts].reverse(), [artifacts]);

  const body = (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {ordered.map((artifact) => (
          <ArtifactTile key={artifact.id} sessionId={sessionId} artifact={artifact} />
        ))}
      </div>
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
          Artifacts <span className="tabular-nums text-fg-muted">· {artifacts.length}</span>
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
