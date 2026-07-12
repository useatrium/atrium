export class InvalidArtifactPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArtifactPathError';
  }
}

export interface SessionArtifactPathContext {
  sessionId: string;
  channelId: string;
  readableChannelIds?: readonly string[];
}

export interface WorkspaceArtifactPathContext {
  channelId: string;
  readableChannelIds?: readonly string[];
}

const EXCLUDED_ROOTS = new Set(['repo', 'repos', 'context']);
const EXCLUDED_DOT_ROOTS = new Set(['.claude', '.codex', '.state']);
const SHARED_ROOTS = new Set(['global', 'channels', 'apps']);

export function canonicalizeSessionArtifactPath(input: string, ctx: SessionArtifactPathContext): string {
  const path = normalizeArtifactPathInput(input);
  if (path.startsWith('scratch/')) {
    const rest = path.slice('scratch/'.length);
    if (rest.length === 0) throw new InvalidArtifactPathError('scratch path must include a file path');
    const slash = rest.indexOf('/');
    const first = slash < 0 ? rest : rest.slice(0, slash);
    if (first === ctx.sessionId) {
      if (slash < 0) throw new InvalidArtifactPathError('scratch path must include a file path');
      return path;
    }
    if (isUuidLike(first)) {
      throw new InvalidArtifactPathError('cannot address another session scratch path');
    }
    return `scratch/${ctx.sessionId}/${rest}`;
  }
  return canonicalizeWorkspaceArtifactPath(path, ctx);
}

export function canonicalizeWorkspaceArtifactPath(input: string, ctx: WorkspaceArtifactPathContext): string {
  const path = normalizeArtifactPathInput(input);
  if (path === 'scratch' || path.startsWith('scratch/')) {
    throw new InvalidArtifactPathError('scratch paths require a session context');
  }
  if (path.startsWith('shared/')) return canonicalSharedPath(path, ctx);
  return `shared/channels/${ctx.channelId}/${path}`;
}

export function displaySessionArtifactPath(path: string, ctx: SessionArtifactPathContext): string {
  const activePrefix = `shared/channels/${ctx.channelId}/`;
  if (path.startsWith(activePrefix)) return path.slice(activePrefix.length);

  const scratchPrefix = `scratch/${ctx.sessionId}/`;
  if (path.startsWith(scratchPrefix)) return `scratch/${path.slice(scratchPrefix.length)}`;

  return path;
}

export function sessionArtifactPathAliases(path: string, ctx: SessionArtifactPathContext): string[] {
  const activePrefix = `shared/channels/${ctx.channelId}/`;
  if (path.startsWith(activePrefix)) {
    const displayPath = path.slice(activePrefix.length);
    return displayPath === path ? [path] : [displayPath, path];
  }

  const displayPath = displaySessionArtifactPath(path, ctx);
  return [displayPath];
}

export function normalizeArtifactPathInput(input: string): string {
  let path = input.trim().replace(/\\/g, '/');
  if (path.startsWith('~/')) path = path.slice(2);
  if (path === '~') path = '';
  if (path.startsWith('./')) path = path.slice(2);
  path = path.replace(/\/+/g, '/').replace(/\/+$/g, '');
  if (!path) throw new InvalidArtifactPathError('path is required');
  if (path.includes('\0')) throw new InvalidArtifactPathError('path contains NUL');
  if (path.startsWith('/')) throw new InvalidArtifactPathError('absolute paths are not artifact paths');

  const parts = path.split('/');
  if (parts.some((part) => part === '.' || part === '..' || part.length === 0)) {
    throw new InvalidArtifactPathError('path must not contain dot segments');
  }
  const root = parts[0]!;
  if (EXCLUDED_ROOTS.has(root) || EXCLUDED_DOT_ROOTS.has(root)) {
    throw new InvalidArtifactPathError(`${root} is not an artifact root`);
  }
  return parts.join('/');
}

function canonicalSharedPath(path: string, ctx: WorkspaceArtifactPathContext): string {
  const parts = path.split('/');
  const root = parts[1];
  if (!root || !SHARED_ROOTS.has(root)) {
    throw new InvalidArtifactPathError('shared paths must use shared/global, shared/channels, or shared/apps');
  }
  if (root === 'global') {
    if (parts.length < 3) throw new InvalidArtifactPathError('shared/global path must include a file path');
    return path;
  }
  if (root === 'apps') {
    // Flat workspace app convention: shared/apps/<slug>/<file...>. Slug + file required.
    if (parts.length < 4) throw new InvalidArtifactPathError('shared/apps path must be shared/apps/<slug>/<file>');
    return path;
  }
  const id = parts[2];
  if (!id) throw new InvalidArtifactPathError(`shared/${root} path must include an id`);
  if (parts.length < 4) throw new InvalidArtifactPathError(`shared/${root}/${id} path must include a file path`);
  // Shape guard only: any channel id is addressable here (writes follow
  // reads — an agent may deliver files to other readable channels).
  // AUTHORIZATION lives in the scope checks (writableRoots/readableRoots) at
  // the route layer, which 403 unauthorized channels; rejecting here would
  // surface them as 400 bad-path instead and mask the real verdict.
  if (id !== ctx.channelId && !ctx.readableChannelIds?.includes(id) && !isUuidLike(id)) {
    throw new InvalidArtifactPathError(`shared/${root} path must use a channel id`);
  }
  return path;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
