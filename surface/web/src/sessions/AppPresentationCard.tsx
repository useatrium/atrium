import { useEffect, useState } from 'react';
import type { ArtifactPresentation } from '@atrium/centaur-client';
import { sessionsApi } from './api';
import { isPendingSessionId, isTerminalSessionStatus, type Session } from './types';

type AppPresentationSurface = 'timeline' | 'transcript';

function previewPath(presentation: ArtifactPresentation): string {
  const appPreviewUrl = presentation.previewUrl;
  if (!appPreviewUrl) return presentation.path;
  const pathPart = appPreviewUrl.split(/[?#]/, 1)[0];
  if (!pathPart) return presentation.path;
  const match = /^shared\/apps\/([a-z0-9][a-z0-9_-]*)\/.+$/i.exec(presentation.path);
  if (!match) return presentation.path;
  return `shared/apps/${match[1]}/${pathPart}`;
}

function previewSrc(sessionId: string, presentation: ArtifactPresentation): string {
  const renderer = presentation.renderer || 'html-app';
  const params = new URLSearchParams({ path: previewPath(presentation), renderer });
  const appPreviewUrl = presentation.previewUrl;
  if (appPreviewUrl) {
    const query = appPreviewUrl.split('?', 2)[1] ?? '';
    for (const [key, value] of new URLSearchParams(query)) {
      if (!params.has(key)) params.set(key, value);
    }
  }
  return `/api/sessions/${sessionId}/artifacts/preview?${params.toString()}`;
}

function displayTitle(presentation: ArtifactPresentation): string {
  return presentation.title?.trim() || presentation.appSlug || presentation.path.split('/').at(-2) || 'App preview';
}

function AppPresentationCard({
  sessionId,
  presentation,
  surface = 'transcript',
}: {
  sessionId: string;
  presentation: ArtifactPresentation;
  surface?: AppPresentationSurface;
}) {
  const title = displayTitle(presentation);
  const src = previewSrc(sessionId, presentation);
  const timeline = surface === 'timeline';

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: container only stops parent card activation; nested controls provide keyboard interaction.
    // biome-ignore lint/a11y/useKeyWithClickEvents: container only stops parent card activation; nested controls provide keyboard interaction.
    <div
      data-testid="app-presentation-card"
      className={`overflow-hidden rounded-lg border border-edge bg-surface-raised/70 shadow-sm shadow-black/5 ${
        timeline ? 'mt-2 w-full max-w-3xl' : 'mt-3 max-w-2xl'
      }`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-edge px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-fg">{title}</div>
        </div>
      </div>
      <iframe
        title={`${title} preview`}
        src={src}
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        className={`block w-full border-0 bg-white ${
          timeline ? 'h-[28rem] max-h-[70vh]' : 'h-72 max-h-[48vh]'
        }`}
      />
    </div>
  );
}

export function AppPresentationCards({
  sessionId,
  presentations,
  surface = 'transcript',
}: {
  sessionId: string;
  presentations: ArtifactPresentation[];
  surface?: AppPresentationSurface;
}) {
  if (presentations.length === 0) return null;
  return (
    <div className={surface === 'timeline' ? 'space-y-2' : 'space-y-3'}>
      {presentations.map((presentation) => (
        <AppPresentationCard
          key={presentation.presentationId ?? presentation.id}
          sessionId={sessionId}
          presentation={presentation}
          surface={surface}
        />
      ))}
    </div>
  );
}

export function SessionAppPresentationCards({
  session,
  surface = 'timeline',
}: {
  session: Session;
  surface?: AppPresentationSurface;
}) {
  const [presentations, setPresentations] = useState<ArtifactPresentation[]>([]);
  const terminal = isTerminalSessionStatus(session.status);

  useEffect(() => {
    if (isPendingSessionId(session.id)) return;
    let disposed = false;
    let timer: number | null = null;
    const load = () => {
      sessionsApi
        .listPresentations(session.id)
        .then(({ presentations }) => {
          if (!disposed) setPresentations(Array.isArray(presentations) ? presentations : []);
        })
        .catch(() => {
          if (!disposed) setPresentations([]);
        });
    };
    load();
    if (!terminal) timer = window.setInterval(load, 5000);
    return () => {
      disposed = true;
      if (timer != null) window.clearInterval(timer);
    };
  }, [session.id, terminal, session.completedAt]);

  return <AppPresentationCards sessionId={session.id} presentations={presentations} surface={surface} />;
}
