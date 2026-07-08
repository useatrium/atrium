import { useEffect, useMemo, useState } from 'react';
import type { Artifact, ArtifactPresentation } from '@atrium/centaur-client';
import { ApiError } from '../api';
import { Tooltip } from '../components/a11y';
import { navigate, URL_PARAMS, useLocation } from '../router';
import { EmptyState } from './EmptyState';
import { ArtifactPreviewModal } from './ArtifactsSurface';
import { sessionsApi, type AppListRow } from './api';

interface DetectedAppRoot {
  name: string;
  rootPath: string;
  entry: string;
}

function pathWithSearch(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function detectAppRoots(artifacts: Artifact[]): DetectedAppRoot[] {
  const roots = new Map<string, DetectedAppRoot>();
  for (const artifact of artifacts) {
    const match = /^(?:\/home\/agent\/workspace\/)?shared\/apps\/([a-z0-9][a-z0-9_-]*)\/(.+)$/i.exec(
      artifact.path,
    );
    if (!match) continue;
    const [, name, relPath] = match;
    if (relPath !== 'index.html' && relPath !== 'atrium.app.json') continue;
    const rootPath = `shared/apps/${name!.toLowerCase()}/`;
    if (!roots.has(rootPath)) {
      roots.set(rootPath, { name: name!.toLowerCase(), rootPath, entry: 'index.html' });
    }
  }
  return [...roots.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

function versionLabel(version: number | null): string {
  return version == null ? 'v-' : `v${version}`;
}

function presentationRoot(presentation: ArtifactPresentation): DetectedAppRoot | null {
  const match = /^shared\/apps\/([a-z0-9][a-z0-9_-]*)\/(.+)$/i.exec(presentation.path);
  if (!match) return null;
  const [, name, entry] = match;
  return {
    name: name!.toLowerCase(),
    rootPath: `shared/apps/${name!.toLowerCase()}/`,
    entry: entry!,
  };
}

function presentationArtifact(presentation: ArtifactPresentation): Artifact {
  return {
    id: presentation.id,
    path: presentation.path,
    kind: 'created',
    mime: /\.(jsx|tsx)$/i.test(presentation.path) ? 'text/jsx' : 'text/html',
    size: 0,
    sha256: '',
    ref: null,
    executionId: presentation.executionId,
    sourceEventIds: presentation.sourceEventIds,
  };
}

export function AppsSurface({
  sessionId,
  artifacts = [],
  presentations = [],
  embedded = false,
}: {
  sessionId: string;
  artifacts?: Artifact[];
  presentations?: ArtifactPresentation[];
  embedded?: boolean;
}) {
  const location = useLocation();
  const previewParam = useMemo(() => new URLSearchParams(location.search).get(URL_PARAMS.preview)?.trim() ?? '', [location.search]);
  const [apps, setApps] = useState<AppListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ArtifactPresentation | null>(null);
  const detected = useMemo(() => detectAppRoots(artifacts), [artifacts]);
  const presented = useMemo(
    () =>
      presentations
        .map((presentation) => {
          const root = presentationRoot(presentation);
          return root ? { presentation, root } : null;
        })
        .filter((row): row is { presentation: ArtifactPresentation; root: DetectedAppRoot } => row !== null),
    [presentations],
  );
  const publishedNames = useMemo(() => new Set(apps.map((app) => app.name)), [apps]);
  const presentedNames = useMemo(() => new Set(presented.map(({ root }) => root.name)), [presented]);
  const presentedByName = useMemo(
    () => new Map(presented.map(({ root, presentation }) => [root.name, presentation])),
    [presented],
  );
  const unpublishedDetected = detected.filter((root) => !publishedNames.has(root.name) && !presentedNames.has(root.name));
  const unpublishedPresented = presented.filter(({ root }) => !publishedNames.has(root.name));

  const updatePreviewUrl = (value: string | null, options: { replace?: boolean } = {}) => {
    const params = new URLSearchParams(location.search);
    if (value) params.set(URL_PARAMS.preview, value);
    else params.delete(URL_PARAMS.preview);
    navigate(pathWithSearch(location.pathname, params), options);
  };

  const openPreview = (presentation: ArtifactPresentation) => {
    setPreview(presentation);
    updatePreviewUrl(presentation.id);
  };

  const closePreview = () => {
    setPreview(null);
    updatePreviewUrl(null);
  };

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const response = await sessionsApi.listApps();
      setApps(response.apps);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load published apps.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [sessionId]);

  useEffect(() => {
    if (!previewParam) {
      setPreview(null);
      return;
    }
    const match = presentations.find((presentation) => presentation.id === previewParam || presentation.path === previewParam) ?? null;
    setPreview(match);
  }, [presentations, previewParam]);

  async function publish(root: DetectedAppRoot) {
    setBusy(`publish:${root.name}`);
    setError(null);
    try {
      await sessionsApi.publishApp(sessionId, {
        name: root.name,
        scope: 'workspace',
        entry: root.entry,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not publish app.');
    } finally {
      setBusy(null);
    }
  }

  async function launch(app: AppListRow) {
    setBusy(`launch:${app.id}`);
    setError(null);
    try {
      const { url } = await sessionsApi.launchApp(app.id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not launch app.');
    } finally {
      setBusy(null);
    }
  }

  const body = (
    <div data-testid="apps-surface" className="min-h-0 flex-1 overflow-y-auto">
      {error && (
        <div role="alert" className="border-b border-danger-border/40 bg-danger-tint/20 px-3 py-2 text-xs text-danger-text">
          {error}
        </div>
      )}
      {unpublishedPresented.length > 0 && (
        <section className="border-b border-edge">
          <div className="bg-surface-raised/40 px-3 py-2 text-3xs font-semibold uppercase tracking-wider text-fg-muted">
            Generated apps
          </div>
          <div className="divide-y divide-edge">
            {unpublishedPresented.map(({ presentation, root }) => {
              const publishLabel = `Publish ${root.name}`;
              return (
                <div key={presentation.path} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-fg">{presentation.title ?? root.name}</div>
                    <div className="truncate font-mono text-3xs text-fg-muted">{presentation.path}</div>
                    {presentation.description && (
                      <div className="mt-0.5 truncate text-3xs text-fg-muted">{presentation.description}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => openPreview(presentation)}
                    className="rounded border border-edge px-2 py-1 text-3xs font-semibold uppercase tracking-wide text-fg-muted hover:bg-surface-overlay hover:text-fg"
                  >
                    Preview
                  </button>
                  <Tooltip content={publishLabel}>
                    <button
                      type="button"
                      onClick={() => publish(root)}
                      disabled={busy != null}
                      className="rounded border border-accent-border px-2 py-1 text-3xs font-semibold uppercase tracking-wide text-accent-text hover:bg-accent-soft disabled:cursor-wait disabled:opacity-60"
                    >
                      {busy === `publish:${root.name}` ? 'Publishing' : 'Publish'}
                    </button>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {unpublishedDetected.length > 0 && (
        <section className="border-b border-edge">
          <div className="bg-surface-raised/40 px-3 py-2 text-3xs font-semibold uppercase tracking-wider text-fg-muted">
            Detected app directories
          </div>
          <div className="divide-y divide-edge">
            {unpublishedDetected.map((root) => {
              const publishLabel = `Publish ${root.name}`;
              return (
                <div key={root.rootPath} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-fg">{root.name}</div>
                    <div className="truncate font-mono text-3xs text-fg-muted">{root.rootPath}</div>
                  </div>
                  <Tooltip content={publishLabel}>
                    <button
                      type="button"
                      onClick={() => publish(root)}
                      disabled={busy != null}
                      className="rounded border border-accent-border px-2 py-1 text-3xs font-semibold uppercase tracking-wide text-accent-text hover:bg-accent-soft disabled:cursor-wait disabled:opacity-60"
                    >
                      {busy === `publish:${root.name}` ? 'Publishing' : 'Publish'}
                    </button>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {loading ? (
        <div className="px-3 py-4 text-xs text-fg-muted">Loading apps...</div>
      ) : apps.length === 0 && unpublishedDetected.length === 0 && unpublishedPresented.length === 0 ? (
        <EmptyState title="No published apps" hint="Agent-built apps under shared/apps will appear here." />
      ) : (
        <section>
          <div className="bg-surface-raised/40 px-3 py-2 text-3xs font-semibold uppercase tracking-wider text-fg-muted">
            Published apps
          </div>
          <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
            {apps.map((app) => {
              const appPresentation = presentedByName.get(app.name);
              return (
                <article key={app.id} className="rounded-md border border-edge bg-surface-raised/50 p-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-fg">{app.name}</div>
                      <div className="mt-0.5 truncate font-mono text-3xs text-fg-muted">
                        {app.entryPath ?? 'index.html'}
                      </div>
                    </div>
                    <span className="rounded bg-accent-surface px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide text-accent-text">
                      {versionLabel(app.currentVersion)}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    {appPresentation && (
                      <button
                        type="button"
                        onClick={() => openPreview(appPresentation)}
                        className="rounded border border-edge px-2 py-1 text-3xs font-semibold uppercase tracking-wide text-fg-muted hover:bg-surface-overlay hover:text-fg"
                      >
                        Preview
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => launch(app)}
                      disabled={busy != null}
                      className="rounded border border-accent-border px-2 py-1 text-3xs font-semibold uppercase tracking-wide text-accent-text hover:bg-accent-soft disabled:cursor-wait disabled:opacity-60"
                    >
                      {busy === `launch:${app.id}` ? 'Launching' : 'Launch'}
                    </button>
                    <span className="text-3xs uppercase tracking-wide text-fg-muted">{statusLabel(app.status)}</span>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}
      {preview && (
        <ArtifactPreviewModal
          sessionId={sessionId}
          artifact={presentationArtifact(preview)}
          presentation={preview}
          onClose={closePreview}
        />
      )}
    </div>
  );

  if (embedded) return body;

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-surface/95 backdrop-blur-sm">
      {body}
    </div>
  );
}
