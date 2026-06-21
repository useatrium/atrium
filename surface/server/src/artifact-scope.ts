export type ArtifactScope = 'private' | 'topic' | 'workspace';

export function classifyScope(path: string): ArtifactScope {
  if (path.startsWith('scratch/')) return 'private';
  if (path.startsWith('proj-x/') || path.startsWith('topic/')) return 'topic';
  return 'workspace';
}

export function userCanReadScope(scope: ArtifactScope): boolean {
  return scope !== 'private';
}
