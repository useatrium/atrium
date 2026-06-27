import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactPresentation } from '@atrium/centaur-client';
import { ExpandIcon, ExternalLinkIcon, ShrinkIcon } from '../components/icons';
import { sessionsApi } from './api';
import { isPendingSessionId, isTerminalSessionStatus, type Session } from './types';

type AppPresentationSurface = 'timeline' | 'transcript';

interface PreviewSize {
  id: string;
  minWidth: number;
  height: number;
}

interface PreviewSizePolicy {
  defaultSize: string;
  sizes: PreviewSize[];
}

function previewSrc(sessionId: string, presentation: ArtifactPresentation, previewSizeId?: string): string {
  const renderer = presentation.renderer || 'html-app';
  const params = new URLSearchParams({ path: presentation.path, renderer });
  const appPreviewUrl = presentation.previewUrl;
  if (appPreviewUrl) {
    const query = appPreviewUrl.split('?', 2)[1] ?? '';
    for (const [key, value] of new URLSearchParams(query)) {
      if (!params.has(key)) params.set(key, value);
    }
  }
  if (previewSizeId) params.set('previewSize', previewSizeId);
  return `/api/sessions/${sessionId}/artifacts/preview?${params.toString()}`;
}

function displayTitle(presentation: ArtifactPresentation): string {
  return presentation.title?.trim() || presentation.appSlug || presentation.path.split('/').at(-2) || 'App preview';
}

function parsePreviewSizePolicy(value: unknown): PreviewSizePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { defaultSize: 'card', sizes: [] };
  }
  const record = value as Record<string, unknown>;
  const defaultSize = typeof record.defaultSize === 'string' && record.defaultSize.trim()
    ? record.defaultSize.trim()
    : 'card';
  const sizes = Array.isArray(record.sizes)
    ? record.sizes
        .map((item): PreviewSize | null => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
          const size = item as Record<string, unknown>;
          const id = typeof size.id === 'string' && size.id.trim() ? size.id.trim() : '';
          const minWidth = typeof size.minWidth === 'number' && Number.isFinite(size.minWidth)
            ? Math.max(0, size.minWidth)
            : 0;
          const height = typeof size.height === 'number' && Number.isFinite(size.height)
            ? Math.max(120, size.height)
            : 0;
          return id && height > 0 ? { id, minWidth, height } : null;
        })
        .filter((item): item is PreviewSize => item !== null)
    : [];
  return { defaultSize, sizes };
}

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(node.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver((entries) => {
      setWidth(entries[0]?.contentRect.width ?? node.getBoundingClientRect().width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

function chooseDefaultSize(policy: PreviewSizePolicy, width: number): PreviewSize | null {
  const regularSizes = policy.sizes.filter((size) => !/^(expanded|full)$/i.test(size.id));
  const sizes = [...(regularSizes.length > 0 ? regularSizes : policy.sizes)].sort((a, b) => a.minWidth - b.minWidth);
  const fitting = sizes.filter((size) => width <= 0 || size.minWidth <= width);
  return (
    fitting.at(-1) ??
    sizes.find((size) => size.id === policy.defaultSize) ??
    sizes[0] ??
    null
  );
}

function chooseExpandedSize(policy: PreviewSizePolicy, width: number): PreviewSize | null {
  return (
    policy.sizes.find((size) => /^(expanded|full|large)$/i.test(size.id)) ??
    [...policy.sizes].sort((a, b) => b.height - a.height || b.minWidth - a.minWidth)[0] ??
    chooseDefaultSize(policy, width)
  );
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
  const timeline = surface === 'timeline';
  const [expanded, setExpanded] = useState(false);
  const [cardRef, cardWidth] = useElementWidth<HTMLDivElement>();
  const sizePolicy = useMemo(() => parsePreviewSizePolicy(presentation.previewSizePolicy), [presentation.previewSizePolicy]);
  const defaultSize = chooseDefaultSize(sizePolicy, cardWidth);
  const expandedSize = chooseExpandedSize(sizePolicy, cardWidth);
  const selectedSize = expanded ? expandedSize : defaultSize;
  const fallbackHeight = expanded ? (timeline ? 900 : 720) : timeline ? 448 : 288;
  const frameHeight = selectedSize?.height ?? fallbackHeight;
  const canToggle = Boolean(expandedSize && (!defaultSize || expandedSize.height > defaultSize.height || expandedSize.id !== defaultSize.id))
    || sizePolicy.sizes.length === 0;
  const src = previewSrc(sessionId, presentation, selectedSize?.id);
  return (
    <div
      ref={cardRef}
      data-testid="app-presentation-card"
      className={`overflow-hidden rounded-lg border border-edge bg-surface-raised/70 shadow-sm shadow-black/5 ${
        timeline ? (expanded ? 'mt-2 w-full max-w-5xl' : 'mt-2 w-full max-w-3xl') : 'mt-3 max-w-2xl'
      }`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex min-w-0 items-center gap-3 border-b border-edge px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-fg">{title}</div>
        </div>
        {canToggle && (
          <button
            type="button"
            title={expanded ? 'Collapse preview' : 'Expand preview'}
            aria-label={expanded ? 'Collapse preview' : 'Expand preview'}
            aria-pressed={expanded}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-edge-strong bg-surface text-fg-secondary hover:bg-surface-overlay hover:text-fg"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((value) => !value);
            }}
          >
            {expanded ? <ShrinkIcon className="size-3.5" /> : <ExpandIcon className="size-3.5" />}
          </button>
        )}
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
        className="block w-full border-0 bg-white"
        style={{ height: frameHeight }}
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
