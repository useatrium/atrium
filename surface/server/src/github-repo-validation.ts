import { sign } from 'node:crypto';

export interface GitHubRepoValidationConfig {
  appId: string;
  privateKey: string;
  privateKeyId?: string;
  installationId: string;
  fetchImpl?: typeof fetch;
  nowSeconds?: number;
}

export interface GitHubRepoValidationResult {
  inaccessible: string[];
}

export class GitHubRepoValidationError extends Error {
  constructor(
    readonly code: 'unconfigured' | 'token_exchange_failed' | 'repo_check_failed',
    message: string,
  ) {
    super(message);
  }
}

export async function validateGitHubAppInstallationRepos(
  config: GitHubRepoValidationConfig,
  repos: readonly string[],
): Promise<GitHubRepoValidationResult> {
  if (!config.appId || !config.privateKey || !config.installationId) {
    throw new GitHubRepoValidationError('unconfigured', 'GitHub App installation validation is not configured');
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const jwt = githubAppJwt(config);
  const tokenRes = await fetchImpl(
    `https://api.github.com/app/installations/${encodeURIComponent(config.installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: githubHeaders({ authorization: `Bearer ${jwt}` }),
    },
  );
  if (!tokenRes.ok) {
    throw new GitHubRepoValidationError(
      'token_exchange_failed',
      `GitHub installation token exchange failed: ${tokenRes.status}`,
    );
  }
  const tokenBody = await tokenRes.json().catch(() => null);
  const token = tokenBody && typeof tokenBody === 'object' ? (tokenBody as { token?: unknown }).token : null;
  if (typeof token !== 'string' || !token) {
    throw new GitHubRepoValidationError('token_exchange_failed', 'GitHub installation token response was empty');
  }

  const inaccessible: string[] = [];
  for (const repo of repos) {
    const parsed = parseGitHubRepo(repo);
    if (!parsed) {
      inaccessible.push(repo);
      continue;
    }
    const res = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`,
      {
        method: 'GET',
        headers: githubHeaders({ authorization: `Bearer ${token}` }),
      },
    );
    if (res.ok) continue;
    if (res.status === 403 || res.status === 404) {
      inaccessible.push(repo);
      continue;
    }
    throw new GitHubRepoValidationError('repo_check_failed', `GitHub repo access check failed: ${res.status}`);
  }
  return { inaccessible };
}

function githubHeaders(args: { authorization: string }): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: args.authorization,
    'x-github-api-version': '2022-11-28',
  };
}

function githubAppJwt(config: GitHubRepoValidationConfig): string {
  const now = config.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    ...(config.privateKeyId ? { kid: config.privateKeyId } : {}),
  };
  const claims = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: config.appId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), normalizePem(config.privateKey));
  return `${signingInput}.${base64url(signature)}`;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function normalizePem(value: string): string {
  const raw = value.trim().replace(/\\n/g, '\n');
  if (raw.includes('BEGIN')) return raw;
  const decoded = Buffer.from(raw, 'base64').toString('utf8').trim().replace(/\\n/g, '\n');
  return decoded.includes('BEGIN') ? decoded : raw;
}

function parseGitHubRepo(repo: string): { owner: string; name: string } | null {
  const parts = repo.trim().split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], name: parts[1] };
}
