export type ArtifactScope = 'private' | 'topic' | 'workspace';

export function classifyScope(path: string): ArtifactScope {
  if (path.startsWith('shared/')) return 'workspace';
  return 'private';
}

export function userCanReadScope(scope: ArtifactScope): boolean {
  return scope !== 'private';
}
