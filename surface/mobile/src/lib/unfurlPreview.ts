import { unfurlImageProxyUrl } from '@atrium/surface-client';

const PREFIX = 'unfurl-preview:';

export interface UnfurlPreviewTarget {
  imageUrl: string;
  targetUrl: string;
}

export function unfurlPreviewArtifactId(imageUrl: string, targetUrl: string): string {
  return `${PREFIX}${encodeURIComponent(imageUrl)}|${encodeURIComponent(targetUrl)}`;
}

export function parseUnfurlPreviewArtifactId(artifactId: string): UnfurlPreviewTarget | null {
  if (!artifactId.startsWith(PREFIX)) return null;
  const separator = artifactId.indexOf('|', PREFIX.length);
  if (separator < 0) return null;
  try {
    return {
      imageUrl: decodeURIComponent(artifactId.slice(PREFIX.length, separator)),
      targetUrl: decodeURIComponent(artifactId.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

export function unfurlPreviewContentUrl(artifactId: string, serverUrl: string): string | null {
  const preview = parseUnfurlPreviewArtifactId(artifactId);
  if (!preview) return null;
  return `${serverUrl.replace(/\/+$/, '')}${unfurlImageProxyUrl(preview.imageUrl)}`;
}
