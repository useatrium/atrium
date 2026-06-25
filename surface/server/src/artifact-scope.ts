export type ArtifactScope = 'private' | 'topic' | 'workspace';

export function classifyScope(path: string): ArtifactScope {
  if (isCanonicalSharedPath(path)) return 'workspace';
  return 'private';
}

export function userCanReadScope(scope: ArtifactScope): boolean {
  return scope !== 'private';
}

export function isCanonicalSharedPath(path: string): boolean {
  return (
    /^shared\/global\/.+/.test(path) ||
    /^shared\/channels\/[^/]+\/.+/.test(path)
  );
}

export function isSessionScratchPath(path: string, sessionId: string): boolean {
  return path.startsWith(`scratch/${sessionId}/`);
}

export function userCanReadSessionArtifactPath(path: string, sessionId: string): boolean {
  return isCanonicalSharedPath(path) || isSessionScratchPath(path, sessionId);
}
