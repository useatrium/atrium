import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Artifact, ArtifactPresentation, FileChange } from '@atrium/centaur-client';
import { ChevronDownIcon, ChevronRightIcon, XIcon } from '../components/icons';
import { ArtifactPreviewModal, ArtifactTile, latestArtifactsByPath } from './ArtifactsSurface';
import { ChangeFileRow, groupFileChanges } from './ChangesSurface';
import { EmptyState } from './EmptyState';

type Filter = 'all' | 'edited' | 'created';

function FilterChip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-1 text-2xs font-semibold ${
        active
          ? 'border-accent-border-strong bg-accent-surface text-accent-text-strong'
          : 'border-edge bg-surface-raised/40 text-fg-muted hover:bg-surface-overlay hover:text-fg-secondary'
      }`}
    >
      {label} <span className="tabular-nums font-normal">· {count}</span>
    </button>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border-b border-edge last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-surface-raised/40 px-3 py-2 text-left hover:bg-surface-overlay/60"
      >
        {open ? (
          <ChevronDownIcon size={14} className="shrink-0 text-fg-tertiary" />
        ) : (
          <ChevronRightIcon size={14} className="shrink-0 text-fg-tertiary" />
        )}
        <span className="text-3xs font-semibold uppercase tracking-wider text-fg-muted">{title}</span>
        <span className="text-3xs tabular-nums text-fg-tertiary">· {count}</span>
      </button>
      {open && children}
    </section>
  );
}

export function WhatChangedSurface({
  changes,
  artifacts,
  presentations = [],
  sessionId,
  onClose,
  embedded = false,
}: {
  changes: FileChange[];
  artifacts: Artifact[];
  presentations?: ArtifactPresentation[];
  sessionId: string;
  onClose: () => void;
  embedded?: boolean;
}) {
  const changeGroups = useMemo(() => groupFileChanges(changes), [changes]);
  const artifactTiles = useMemo(() => latestArtifactsByPath(artifacts), [artifacts]);
  const presentationByPath = useMemo(
    () => new Map(presentations.map((presentation) => [presentation.path, presentation])),
    [presentations],
  );
  const presentedTiles = useMemo(
    () =>
      presentations
        .map((presentation) => {
          const tile = artifactTiles.find(({ artifact }) => artifact.path === presentation.path);
          return tile ? { ...tile, presentation } : null;
        })
        .filter((tile): tile is { artifact: Artifact; versions: number; presentation: ArtifactPresentation } => tile !== null),
    [artifactTiles, presentations],
  );
  const otherArtifactTiles = useMemo(
    () => artifactTiles.filter(({ artifact }) => !presentationByPath.has(artifact.path)),
    [artifactTiles, presentationByPath],
  );
  const editedCount = changeGroups.length;
  const createdCount = otherArtifactTiles.length;
  const presentedCount = presentedTiles.length;
  const totalCount = editedCount + artifactTiles.length;
  const [filter, setFilter] = useState<Filter>('all');
  const [preview, setPreview] = useState<Artifact | null>(null);

  const showEdited = filter === 'all' || filter === 'edited';
  const showCreated = filter === 'all' || filter === 'created';

  useEffect(() => {
    if (embedded) return;
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onDocumentKeyDown, true);
    return () => document.removeEventListener('keydown', onDocumentKeyDown, true);
  }, [embedded, onClose]);

  const body = (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {totalCount === 0 ? (
        <EmptyState title="No changes yet" hint="Files the agent edits or creates will show up here." />
      ) : (
        <>
          <div className="sticky top-0 z-10 flex shrink-0 gap-1.5 border-b border-edge bg-surface/95 px-3 py-2 backdrop-blur-sm">
            <FilterChip active={filter === 'all'} label="All" count={totalCount} onClick={() => setFilter('all')} />
            <FilterChip
              active={filter === 'edited'}
              label="Edited"
              count={editedCount}
              onClick={() => setFilter('edited')}
            />
            <FilterChip
              active={filter === 'created'}
              label="Created"
              count={createdCount}
              onClick={() => setFilter('created')}
            />
          </div>
          {showEdited && (
            <Section title="Edited in repo" count={editedCount}>
              {editedCount === 0 ? (
                <div className="px-3 py-2 text-2xs text-fg-muted">No repo edits yet.</div>
              ) : (
                changeGroups.map(([path, fileChanges]) => (
                  <ChangeFileRow key={path} path={path} changes={fileChanges} />
                ))
              )}
            </Section>
          )}
          {showCreated && (
            <>
              {presentedCount > 0 && (
                <Section title="Presented apps" count={presentedCount}>
                  <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
                    {presentedTiles.map(({ artifact, versions, presentation }) => (
                      <ArtifactTile
                        key={`presented:${artifact.path}`}
                        sessionId={sessionId}
                        artifact={artifact}
                        versions={versions}
                        onPreview={setPreview}
                        presentation={presentation}
                      />
                    ))}
                  </div>
                </Section>
              )}
            </>
          )}
          {showCreated && (
            <Section title={presentedCount > 0 ? 'Other artifacts' : 'Created artifacts'} count={createdCount}>
              {createdCount === 0 ? (
                <div className="px-3 py-2 text-2xs text-fg-muted">No created artifacts yet.</div>
              ) : (
                <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
                  {otherArtifactTiles.map(({ artifact, versions }) => (
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
            </Section>
          )}
          {preview && (
            <ArtifactPreviewModal
              sessionId={sessionId}
              artifact={preview}
              presentation={presentationByPath.get(preview.path)}
              onClose={() => setPreview(null)}
            />
          )}
        </>
      )}
    </div>
  );

  if (embedded) return body;

  return (
    <div
      data-testid="what-changed-surface"
      role="dialog"
      aria-label="What changed"
      className="absolute inset-0 z-10 flex flex-col bg-surface/95 backdrop-blur-sm"
    >
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-edge px-3">
        <h3 className="text-xs font-semibold text-fg">
          What changed <span className="tabular-nums text-fg-muted">· {totalCount}</span>
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close what changed"
          className="rounded-md px-1.5 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
        >
          <XIcon size={15} />
        </button>
      </header>
      {body}
    </div>
  );
}
