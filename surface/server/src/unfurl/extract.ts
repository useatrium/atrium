import { isUnfurlableUrl, type UnfurlResult } from '@atrium/surface-client/unfurl-contracts';

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] !== '#') return named[code.toLowerCase()] ?? entity;
    const point = Number.parseInt(
      code[1]?.toLowerCase() === 'x' ? code.slice(2) : code.slice(1),
      code[1]?.toLowerCase() === 'x' ? 16 : 10,
    );
    return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

function clean(value: string | undefined): string | undefined {
  const result = value ? decodeEntities(value).replace(/\s+/g, ' ').trim() : '';
  return result || undefined;
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return result;
}

function metadata(html: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const key = (attrs.property ?? attrs.name)?.toLowerCase();
    if (key && attrs.content !== undefined && !result.has(key)) result.set(key, attrs.content);
  }
  return result;
}

export function extractUnfurl(finalUrl: string, contentType: string, body: Buffer): UnfurlResult | null {
  if (contentType.toLowerCase().startsWith('image/')) return { url: finalUrl, kind: 'image', imageUrl: finalUrl };
  if (contentType.toLowerCase() !== 'text/html') return null;

  const html = body.toString('utf8');
  const meta = metadata(html);
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  const title = clean(meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag?.replace(/<[^>]*>/g, ''));
  if (!title) return null;
  const description = clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'));
  const rawImage = clean(meta.get('og:image') ?? meta.get('twitter:image'));
  let imageUrl: string | undefined;
  if (rawImage) {
    try {
      const candidate = new URL(rawImage, finalUrl).href;
      if (isUnfurlableUrl(candidate)) imageUrl = candidate;
    } catch {}
  }
  const siteName = clean(meta.get('og:site_name')) ?? new URL(finalUrl).hostname;
  return {
    url: finalUrl,
    kind: 'og',
    title,
    ...(description ? { description } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(siteName ? { siteName } : {}),
  };
}
