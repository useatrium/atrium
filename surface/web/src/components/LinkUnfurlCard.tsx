import { useMemo, useState } from 'react';
import { unfurlImageProxyUrl, type UnfurlResult } from '@atrium/surface-client';
import { CardControls, collapsedUnfurlStorageKeys, updateCollapsedUnfurlStorage } from './EntryQuoteCard';
import { Lightbox, type PreviewFile } from './media';
import { TimelineImage } from './TimelineImage';

function urlLabel(url: string): { hostname: string; basename: string } {
  try {
    const parsed = new URL(url);
    const basename = parsed.pathname.split('/').filter(Boolean).at(-1);
    return { hostname: parsed.hostname, basename: basename ? decodeURIComponent(basename) : parsed.hostname };
  } catch {
    return { hostname: url, basename: url };
  }
}

export function LinkUnfurlCard({
  result,
  messageEventId,
  onSuppress,
}: {
  result: UnfurlResult;
  messageEventId?: number | null;
  onSuppress?: () => void;
}) {
  const labels = urlLabel(result.url);
  const siteName = result.siteName || labels.hostname;
  const title = result.title || labels.basename;
  const imageUrl = result.kind === 'image' ? result.imageUrl || result.url : result.imageUrl;
  const proxyUrl = imageUrl ? unfurlImageProxyUrl(imageUrl) : null;
  const previewFile = useMemo<PreviewFile | null>(
    () =>
      proxyUrl
        ? {
            id: result.url,
            name: result.kind === 'image' ? labels.basename : title,
            mime: 'image/*',
            mediaKind: 'image',
            contentUrl: proxyUrl,
            width: result.width,
            height: result.height,
          }
        : null,
    [labels.basename, proxyUrl, result.height, result.kind, result.url, result.width, title],
  );
  const storageKey = messageEventId != null ? `${messageEventId}:${result.url}` : null;
  const [collapsed, setCollapsed] = useState(
    () => storageKey != null && collapsedUnfurlStorageKeys().includes(storageKey),
  );
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // A proxy fetch can fail (upstream slow/oversized/non-image); the card must
  // degrade to text rather than show a broken-image glyph.
  const [imageFailed, setImageFailed] = useState(false);
  const setCardCollapsed = (next: boolean) => {
    setCollapsed(next);
    if (storageKey) updateCollapsedUnfurlStorage(storageKey, next);
  };

  const titleLink = (
    <a
      href={result.url}
      target="_blank"
      rel="noreferrer noopener"
      className="min-w-0 truncate font-medium text-fg no-underline hover:underline"
    >
      {title}
    </a>
  );
  const header = (
    <div className="flex min-w-0 items-center gap-2 text-xs text-fg-secondary">
      <span className="max-w-28 shrink-0 truncate text-fg-muted">{siteName}</span>
      {titleLink}
      <CardControls collapsed={collapsed} onCollapsedChange={setCardCollapsed} onSuppress={onSuppress} />
    </div>
  );

  if (collapsed) {
    return (
      <article className="rounded-md border border-edge bg-surface-raised/55 px-2 py-1.5 text-fg-body">
        {header}
      </article>
    );
  }

  return (
    <>
      <article className="rounded-md border border-edge bg-surface-raised/55 px-3 py-2 text-fg-body">
        {header}
        {result.kind === 'image' && previewFile && !imageFailed ? (
          <button
            type="button"
            aria-label={`Open ${previewFile.name}`}
            onClick={() => setLightboxOpen(true)}
            className="mt-2 block min-w-0 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <TimelineImage
              src={previewFile.contentUrl}
              alt={previewFile.name}
              width={result.width}
              height={result.height}
              loading="lazy"
              className="max-h-72 w-auto rounded-md border border-edge object-contain"
              onError={() => setImageFailed(true)}
            />
          </button>
        ) : result.description || (previewFile && !imageFailed) ? (
          <div className="mt-2 flex min-w-0 items-start gap-3">
            <div className="min-w-0 flex-1">
              {result.description ? (
                <p className="line-clamp-3 text-sm leading-relaxed text-fg-secondary">{result.description}</p>
              ) : null}
            </div>
            {previewFile && !imageFailed ? (
              <button
                type="button"
                aria-label={`Open preview image for ${title}`}
                onClick={() => setLightboxOpen(true)}
                className="shrink-0 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                <img
                  src={previewFile.contentUrl}
                  alt=""
                  loading="lazy"
                  className="h-24 w-24 rounded-md border border-edge bg-surface-overlay object-cover"
                  onError={() => setImageFailed(true)}
                />
              </button>
            ) : null}
          </div>
        ) : null}
      </article>
      {lightboxOpen && previewFile ? (
        <Lightbox files={[previewFile]} index={0} onIndexChange={() => {}} onClose={() => setLightboxOpen(false)} />
      ) : null}
    </>
  );
}
