import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

export interface GitSource {
  listDir(relDir: string): Promise<Array<{ path: string; type: 'file' | 'dir' }>>;
  readFile(relPath: string): Promise<{ bytes: Buffer; sha: string } | null>;
  history(relPath: string): Promise<Array<{ sha: string; author: string; date: string; subject: string }>>;
  isConfigured(): boolean;
}

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export function createGitSource(repoRoot?: string, branch = 'HEAD'): GitSource {
  const root = repoRoot?.trim() ? resolve(repoRoot) : undefined;
  const tree = branch.trim() || 'HEAD';

  return {
    isConfigured() {
      return root != null;
    },

    async listDir(relDir: string) {
      const dir = safeGitPath(relDir, { allowEmpty: true, trimTrailingSlash: true });
      const cwd = requireRepoRoot(root);
      const treeish = dir.length > 0 ? `${tree}:${dir}` : tree;
      try {
        const stdout = await git(cwd, ['ls-tree', '-z', treeish]);
        return parseLsTree(stdout, dir);
      } catch (err) {
        if (isMissingTreeish(err)) return [];
        throw err;
      }
    },

    async readFile(relPath: string) {
      const path = safeGitPath(relPath);
      const cwd = requireRepoRoot(root);
      let sha: string;
      try {
        sha = (await git(cwd, ['rev-parse', `${tree}:${path}`])).toString('utf8').trim();
      } catch (err) {
        if (isMissingTreeish(err)) return null;
        throw err;
      }

      const type = (await git(cwd, ['cat-file', '-t', sha])).toString('utf8').trim();
      if (type !== 'blob') return null;
      const bytes = await git(cwd, ['show', `${tree}:${path}`]);
      return { bytes, sha };
    },

    async history(relPath: string) {
      const path = safeGitPath(relPath);
      const cwd = requireRepoRoot(root);
      const stdout = await git(cwd, ['log', '--format=%H%x00%an%x00%aI%x00%s', tree, '--', path]);
      return parseHistory(stdout);
    },
  };
}

function requireRepoRoot(root: string | undefined): string {
  if (!root) throw new Error('git source is not configured');
  return root;
}

function safeGitPath(rawPath: string, opts: { allowEmpty?: boolean; trimTrailingSlash?: boolean } = {}): string {
  if (rawPath.includes('\0')) {
    throw new Error('unsafe git path');
  }
  let path = rawPath.trim();
  if (path === '.') path = '';
  if (path.startsWith('./')) path = path.slice(2);
  if (opts.trimTrailingSlash) path = path.replace(/\/+$/g, '');
  if (path.includes('..') || path.startsWith('/') || path === '.git' || path.startsWith('.git/')) {
    throw new Error('unsafe git path');
  }
  if (!opts.allowEmpty && path.length === 0) {
    throw new Error('unsafe git path');
  }
  return path;
}

async function git(repoRoot: string, args: string[]): Promise<Buffer> {
  const result = (await execFileAsync('git', args, {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  })) as { stdout: Buffer; stderr: Buffer };
  return result.stdout;
}

function parseLsTree(stdout: Buffer, relDir: string): Array<{ path: string; type: 'file' | 'dir' }> {
  const prefix = relDir.length > 0 ? `${relDir}/` : '';
  const rows: Array<{ path: string; type: 'file' | 'dir' }> = [];
  for (const entry of stdout.toString('utf8').split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const meta = entry.slice(0, tab).split(' ');
    const objectType = meta[1];
    const name = entry.slice(tab + 1);
    if (objectType === 'tree') rows.push({ path: `${prefix}${name}`, type: 'dir' });
    if (objectType === 'blob') rows.push({ path: `${prefix}${name}`, type: 'file' });
  }
  return rows;
}

function parseHistory(stdout: Buffer): Array<{ sha: string; author: string; date: string; subject: string }> {
  const text = stdout.toString('utf8').trimEnd();
  if (!text) return [];
  return text.split('\n').flatMap((line) => {
    const parts = line.split('\0');
    const sha = parts[0];
    const author = parts[1];
    const date = parts[2];
    const subject = parts[3];
    if (!sha || !author || !date || subject == null) return [];
    return [{ sha, author, date, subject }];
  });
}

function isMissingTreeish(err: unknown): boolean {
  const text = errorText(err).toLowerCase();
  return (
    text.includes('not a valid object name') ||
    (text.includes('path ') && text.includes('does not exist')) ||
    text.includes('exists on disk, but not in')
  );
}

function errorText(err: unknown): string {
  const e = err as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return [e.message, e.stdout, e.stderr]
    .map((value) => {
      if (Buffer.isBuffer(value)) return value.toString('utf8');
      return typeof value === 'string' ? value : '';
    })
    .join('\n');
}
