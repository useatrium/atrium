// Agent-workspace path references.
//
// Agents naturally link files by where they live in the sandbox
// (`/home/agent/shared/channels/<id>/notes.md`) rather than by any Atrium URL.
// For shared trees that path already embeds a stable global name — the artifact
// ledger's canonical path — so the platform resolves it instead of teaching
// agents a link syntax. Session-private paths (`/home/agent/notes.md`) only
// mean something relative to the session that wrote them, so they carry a
// `workspace-relative` kind and resolve through session context.

const HOME_PREFIXES = ['/home/agent/workspace/', '/home/agent/', '~/workspace/', '~/'];

// Agents habitually suffix file links with an editor-style `:line`/`:line:col`
// (`notes.md:12`, `main.rs:12:3`); the suffix is not part of the path.
const LINE_COL_SUFFIX_RE = /:\d+(?::\d+)?$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Roots under the agent home that are never ledger artifacts. */
const NON_ARTIFACT_ROOTS = new Set(['repo', 'repos', 'context', '.claude', '.codex', '.state', 'tmp']);

export type AgentPathRef =
  | {
      kind: 'shared-channel';
      channelId: string;
      /** Path relative to the channel's shared tree (never empty). */
      relPath: string;
      /** Ledger canonical path: `shared/channels/<id>/<relPath>`. */
      canonicalPath: string;
    }
  | {
      kind: 'shared';
      /** Ledger canonical path under a non-channel shared root (`shared/global/…`, `shared/apps/…`). */
      canonicalPath: string;
    }
  | {
      kind: 'scratch';
      sessionId: string;
      relPath: string;
      /** Ledger canonical path: `scratch/<sessionId>/<relPath>`. */
      canonicalPath: string;
    }
  | {
      kind: 'workspace-relative';
      /** Path relative to the session workspace root; resolvable only with session context. */
      relPath: string;
    };

/** The self-describing kinds — resolvable from the path alone, no session context. */
export function isSelfDescribingAgentPath(ref: AgentPathRef): boolean {
  return ref.kind !== 'workspace-relative';
}

/** Canonical in-app URL for a self-describing ref (`/f/<canonicalPath>`), else null. */
export function agentPathWebUrl(ref: AgentPathRef): string | null {
  if (ref.kind === 'workspace-relative') return null;
  return `/f/${ref.canonicalPath.split('/').map(encodeURIComponent).join('/')}`;
}

/** Last path segment, for chip labels. */
export function agentPathBasename(ref: AgentPathRef): string {
  const path = ref.kind === 'workspace-relative' ? ref.relPath : ref.canonicalPath;
  const segments = path.split('/');
  return segments[segments.length - 1] ?? path;
}

function decodeSegmentwise(path: string): string | null {
  try {
    return path
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    return null;
  }
}

function cleanRelPath(path: string): string | null {
  const segments: string[] = [];
  for (const raw of path.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') return null; // never resolve traversal
    segments.push(raw);
  }
  if (segments.length === 0) return null;
  return segments.join('/');
}

function classifyCanonical(path: string): AgentPathRef | null {
  const [root, second, ...rest] = path.split('/');
  if (root === 'shared') {
    if (second === 'channels') {
      const [channelId, ...relSegments] = rest;
      if (!channelId || !UUID_RE.test(channelId) || relSegments.length === 0) return null;
      const relPath = relSegments.join('/');
      return {
        kind: 'shared-channel',
        channelId: channelId.toLowerCase(),
        relPath,
        canonicalPath: `shared/channels/${channelId.toLowerCase()}/${relPath}`,
      };
    }
    if ((second === 'global' || second === 'apps') && rest.length > 0) {
      return { kind: 'shared', canonicalPath: path };
    }
    return null;
  }
  if (root === 'scratch') {
    if (!second || !UUID_RE.test(second) || rest.length === 0) return null;
    const relPath = rest.join('/');
    return {
      kind: 'scratch',
      sessionId: second.toLowerCase(),
      relPath,
      canonicalPath: `scratch/${second.toLowerCase()}/${relPath}`,
    };
  }
  return null;
}

/**
 * Parse a markdown link target as an agent-workspace path reference.
 *
 * Recognizes only unambiguous shapes — a bare relative link like `notes.md`
 * stays a plain link (precision over recall; a false chip is worse than a
 * missed one):
 *  - `/home/agent/…` and `~/…` (optionally via `workspace/`)
 *  - ledger-canonical `shared/…` and `scratch/<uuid>/…` (with or without a
 *    leading slash)
 *
 * A trailing editor-style `:line`/`:line:col` suffix is stripped.
 *
 * Returns null for anything else, including non-artifact roots
 * (`/home/agent/repos/…`, `~/context/…`) and paths with `..` traversal.
 */
export function parseAgentPathHref(href: string): AgentPathRef | null {
  if (!href) return null;
  // Explicit schemes (https:, mailto:, atrium-entry:, …) are never agent paths.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const withoutSuffix = (href.split(/[?#]/, 1)[0] ?? href).replace(LINE_COL_SUFFIX_RE, '');
  const decoded = decodeSegmentwise(withoutSuffix);
  if (decoded == null) return null;

  let path: string | null = null;
  let insideHome = false;
  for (const prefix of HOME_PREFIXES) {
    if (decoded.startsWith(prefix) && decoded.length > prefix.length) {
      path = decoded.slice(prefix.length);
      insideHome = true;
      break;
    }
  }
  if (path == null) {
    if (decoded.startsWith('shared/') || decoded.startsWith('/shared/')) {
      path = decoded.replace(/^\//, '');
    } else if (decoded.startsWith('scratch/') || decoded.startsWith('/scratch/')) {
      path = decoded.replace(/^\//, '');
    }
  }
  if (path == null) return null;

  const cleaned = cleanRelPath(path);
  if (cleaned == null) return null;

  const root = cleaned.split('/', 1)[0] ?? '';
  if (NON_ARTIFACT_ROOTS.has(root)) return null;

  const canonical = classifyCanonical(cleaned);
  if (canonical) return canonical;

  // `shared/…`/`scratch/…` shapes that failed classification (bad uuid, no
  // file segment) are not workspace-relative files — drop them.
  if (root === 'shared' || root === 'scratch') return null;

  if (!insideHome) return null;
  return { kind: 'workspace-relative', relPath: cleaned };
}

/**
 * Extract an agent-path ref from an in-app location pathname, e.g. a pasted
 * `/f/shared/channels/<id>/notes.md` URL or a raw `/home/agent/…` link the
 * router intercepts. Only self-describing refs resolve from a bare URL.
 */
export function agentPathFromLocationPath(pathname: string): AgentPathRef | null {
  if (pathname.startsWith('/f/')) {
    const ref = parseAgentPathHref(pathname.slice('/f/'.length));
    return ref && isSelfDescribingAgentPath(ref) ? ref : null;
  }
  const ref = parseAgentPathHref(pathname);
  return ref && isSelfDescribingAgentPath(ref) ? ref : null;
}
