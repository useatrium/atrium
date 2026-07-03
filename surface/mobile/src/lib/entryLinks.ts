import { tryDecodeHandle } from '@atrium/surface-client/handle';

const MAX_ENTRY_LINKS = 3;
const ENTRY_LINK_RE = /https?:\/\/[^\s<>()]+|\/e\/[^\s<>()]+/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/;
const ARTIFACT_HANDLE_RE =
  /^art_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isEntryHandle(handle: string): boolean {
  return tryDecodeHandle(handle) != null || ARTIFACT_HANDLE_RE.test(handle);
}

function stripTrailingPunctuation(value: string): string {
  let next = value.replace(TRAILING_PUNCTUATION_RE, '');
  while (/[)\]}]$/.test(next)) {
    const opens = (next.match(/[([{]/g) ?? []).length;
    const closes = (next.match(/[)\]}]/g) ?? []).length;
    if (closes <= opens) break;
    next = next.slice(0, -1);
  }
  return next;
}

function handleFromPath(pathname: string): string | null {
  const match = /^\/e\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] ?? '');
  } catch {
    return null;
  }
}

export function extractEntryLinkHandles(text: string, serverUrl: string, limit = MAX_ENTRY_LINKS): string[] {
  if (!text || limit <= 0) return [];

  let server: URL;
  try {
    server = new URL(serverUrl);
  } catch {
    return [];
  }

  const handles: string[] = [];
  const seen = new Set<string>();

  for (const rawMatch of text.matchAll(ENTRY_LINK_RE)) {
    const raw = stripTrailingPunctuation(rawMatch[0] ?? '');
    let handle: string | null = null;

    if (raw.startsWith('/e/')) {
      handle = handleFromPath(raw.split(/[?#]/, 1)[0] ?? raw);
    } else {
      try {
        const url = new URL(raw);
        if (url.host !== server.host) continue;
        handle = handleFromPath(url.pathname);
      } catch {
        continue;
      }
    }

    if (!handle || !isEntryHandle(handle) || seen.has(handle)) continue;
    seen.add(handle);
    handles.push(handle);
    if (handles.length >= limit) break;
  }

  return handles;
}
