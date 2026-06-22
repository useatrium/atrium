export type Backing = 'git' | 'ledger';

export interface ResolvedBacking {
  backing: Backing;
  relPath: string;
}

export function resolveBacking(path: string, opts?: { gitPrefix?: string }): ResolvedBacking {
  const gitPrefix = normalizeGitPrefix(opts?.gitPrefix ?? process.env.GIT_PREFIX ?? 'repo/');
  if (path.startsWith(gitPrefix)) {
    return { backing: 'git', relPath: path.slice(gitPrefix.length) };
  }
  return { backing: 'ledger', relPath: path };
}

function normalizeGitPrefix(value: string): string {
  const trimmed = value.trim();
  const prefix = trimmed.length > 0 ? trimmed : 'repo/';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}
