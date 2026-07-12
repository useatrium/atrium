import type { HubFile } from '@atrium/surface-client';

export const TEXT_SNIPPET_MAX_FILE_BYTES = 512 * 1024;
export const TEXT_SNIPPET_CACHE_CHARS = 2048;

type TextSnippetCacheValue = string | null | Promise<string | null>;

const snippetCache = new Map<string, TextSnippetCacheValue>();

const CODE_EXTENSIONS = new Set([
  'bash',
  'c',
  'css',
  'go',
  'html',
  'java',
  'js',
  'json',
  'jsx',
  'kt',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'swift',
  'toml',
  'ts',
  'tsx',
  'xml',
  'yaml',
  'yml',
]);

function extension(file: Pick<HubFile, 'name' | 'path'>): string {
  const name = file.name || file.path;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function normalizedSnippetKind(
  file: Pick<HubFile, 'isText' | 'mediaKind' | 'mime' | 'name' | 'path'>,
): 'text' | 'markdown' | 'code' | 'other' {
  const ext = extension(file);
  const mime = file.mime?.toLowerCase() ?? '';
  if (mime === 'text/markdown' || ext === 'md' || ext === 'markdown') return 'markdown';
  if (file.mediaKind === 'code' || CODE_EXTENSIONS.has(ext)) return 'code';
  if (file.isText || file.mediaKind === 'text' || mime.startsWith('text/')) return 'text';
  return 'other';
}

export function canPreviewTextSnippet(
  file: Pick<HubFile, 'isText' | 'mediaKind' | 'mime' | 'name' | 'path' | 'sizeBytes' | 'tombstoned'>,
): boolean {
  if (file.tombstoned) return false;
  if (file.sizeBytes != null && file.sizeBytes > TEXT_SNIPPET_MAX_FILE_BYTES) return false;
  return normalizedSnippetKind(file) !== 'other';
}

export function textSnippetCacheKey(artifactId: string, versionSeq: number): string {
  return `${artifactId}:${versionSeq}`;
}

function capSnippet(text: string): string | null {
  const capped = text.replace(/\r\n?/g, '\n').slice(0, TEXT_SNIPPET_CACHE_CHARS);
  return capped.trim().length > 0 ? capped : null;
}

export async function fetchArtifactTextSnippet({
  artifactId,
  versionSeq,
  fileContentUrl,
  fileHeaders,
}: {
  artifactId: string;
  versionSeq: number;
  fileContentUrl: (artifactId: string) => string;
  fileHeaders?: Record<string, string>;
}): Promise<string | null> {
  const key = textSnippetCacheKey(artifactId, versionSeq);
  const cached = snippetCache.get(key);
  if (cached !== undefined) return cached;

  const request = fetch(fileContentUrl(artifactId), { headers: fileHeaders })
    .then(async (response) => {
      if (!response.ok) return null;
      return capSnippet(await response.text());
    })
    .catch(() => null)
    .then((snippet) => {
      snippetCache.set(key, snippet);
      return snippet;
    });

  snippetCache.set(key, request);
  return request;
}

export function clearArtifactTextSnippetCache() {
  snippetCache.clear();
}
