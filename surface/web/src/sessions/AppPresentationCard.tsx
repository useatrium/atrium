import { useEffect, useState } from 'react';
import type { ArtifactPresentation } from '@atrium/centaur-client';
import { ExternalLinkIcon } from '../components/icons';
import { sessionsApi } from './api';
import { isPendingSessionId, isTerminalSessionStatus, type Session } from './types';

type AppPresentationSurface = 'timeline' | 'transcript';

function previewSrc(sessionId: string, presentation: ArtifactPresentation): string {
  const renderer = presentation.renderer || 'html-app';
  const params = new URLSearchParams({ path: presentation.path, renderer });
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

export function AppPresentationCard({
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
    <div
      data-testid="app-presentation-card"
      className={`overflow-hidden rounded-lg border border-edge bg-surface-raised/70 shadow-sm shadow-black/5 ${
        timeline ? 'mt-2 w-full max-w-3xl' : 'mt-3 max-w-2xl'
      }`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex min-w-0 items-center gap-3 border-b border-edge px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-fg">{title}</div>
        </div>
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-edge-strong bg-surface px-2 py-1 text-2xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLinkIcon className="size-3" />
          Open
        </a>
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
