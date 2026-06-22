import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitSource } from '../src/git-source.js';

const execFileAsync = promisify(execFile);
const tempRepos: string[] = [];

afterEach(async () => {
  await Promise.all(tempRepos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })));
});

describe('createGitSource', () => {
  it('reports an undefined repo root as unconfigured', () => {
    expect(createGitSource(undefined).isConfigured()).toBe(false);
  });

  it('lists, reads, and histories files in a git repo', async () => {
    const repo = await seedRepo();
    const source = createGitSource(repo);

    expect(source.isConfigured()).toBe(true);
    expect(await source.listDir('')).toEqual([
      { path: 'README.md', type: 'file' },
      { path: 'src', type: 'dir' },
    ]);
    expect(await source.listDir('src')).toEqual([
      { path: 'src/a.ts', type: 'file' },
      { path: 'src/nested', type: 'dir' },
    ]);

    const read = await source.readFile('src/a.ts');
    expect(read?.bytes.toString('utf8')).toBe('export const a = 1;\n');
    expect(read?.sha).toMatch(/^[0-9a-f]{40}$/);

    const initialHistory = await source.history('src/a.ts');
    expect(initialHistory).toHaveLength(1);
    expect(initialHistory[0]).toMatchObject({ author: 'Test User', subject: 'initial commit' });
  });

  it('rejects unsafe paths', async () => {
    const repo = await seedRepo();
    const source = createGitSource(repo);

    await expect(source.listDir('..')).rejects.toThrow('unsafe git path');
    await expect(source.readFile('/x')).rejects.toThrow('unsafe git path');
    await expect(source.history('src/../a.ts')).rejects.toThrow('unsafe git path');
  });
});

async function seedRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'atrium-git-source-'));
  tempRepos.push(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.name', 'Test User']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await mkdir(join(repo, 'src', 'nested'), { recursive: true });
  await writeFile(join(repo, 'README.md'), '# Test\n');
  await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(repo, 'src', 'nested', 'b.ts'), 'export const b = 1;\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial commit']);
  return repo;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}
