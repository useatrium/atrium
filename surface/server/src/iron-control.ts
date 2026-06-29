export interface IronControlClientOptions {
  baseUrl: string;
  apiKey: string;
  namespace?: string;
  fetchImpl?: typeof fetch;
}

export interface IronControlIdentity {
  id: string;
  namespace: string;
  foreign_id: string;
  name?: string;
  labels?: Record<string, unknown>;
}

export interface IronControlSecret {
  id: string;
  namespace: string;
  foreign_id: string;
}

export interface IronControlBrokerCredential {
  id: string;
  namespace: string;
  foreign_id?: string;
  status?: string;
}

export interface IronControlGrant {
  id: string;
  principal_id?: string;
  role_id?: string;
  static_secret_id?: string;
}

export interface GitHubTransformVerification {
  count: number;
  ok: boolean;
}

export class IronControlRequestError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
    message: string,
  ) {
    super(message);
  }
}

export class IronControlAdminClient {
  readonly namespace: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: IronControlClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.namespace = opts.namespace ?? 'default';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.baseUrl && this.apiKey);
  }

  async upsertPrincipal(args: {
    foreignId: string;
    name: string;
    labels?: Record<string, unknown>;
  }): Promise<IronControlIdentity> {
    return this.write<IronControlIdentity>('PUT', `/api/v1/principals/${encodeURIComponent(args.foreignId)}`, {
      namespace: this.namespace,
      foreign_id: args.foreignId,
      name: args.name,
      labels: args.labels ?? {},
    });
  }

  async upsertRole(args: {
    foreignId: string;
    name: string;
    labels?: Record<string, unknown>;
  }): Promise<IronControlIdentity> {
    return this.write<IronControlIdentity>('PUT', `/api/v1/roles/${encodeURIComponent(args.foreignId)}`, {
      namespace: this.namespace,
      foreign_id: args.foreignId,
      name: args.name,
      labels: args.labels ?? {},
    });
  }

  async upsertGitHubPatSecret(args: {
    foreignId: string;
    name: string;
    token: string;
    labels?: Record<string, unknown>;
  }): Promise<IronControlSecret> {
    return this.write<IronControlSecret>('PUT', `/api/v1/static_secrets/${encodeURIComponent(args.foreignId)}`, {
      namespace: this.namespace,
      foreign_id: args.foreignId,
      name: args.name,
      labels: args.labels ?? {},
      replace_config: {
        proxy_value: 'GITHUB_TOKEN',
        match_headers: ['Authorization'],
        require: true,
      },
      source: {
        source_type: 'control_plane',
        secret: args.token,
        config: {},
      },
      rules: [{ host: 'github.com' }, { host: 'api.github.com' }],
    });
  }

  async upsertGitHubBrokerSecret(args: {
    foreignId: string;
    name: string;
    brokerCredentialId: string;
    labels?: Record<string, unknown>;
  }): Promise<IronControlSecret> {
    return this.write<IronControlSecret>('PUT', `/api/v1/static_secrets/${encodeURIComponent(args.foreignId)}`, {
      namespace: this.namespace,
      foreign_id: args.foreignId,
      name: args.name,
      labels: args.labels ?? {},
      replace_config: {
        proxy_value: 'GITHUB_TOKEN',
        match_headers: ['Authorization'],
        require: true,
      },
      source: {
        source_type: 'token_broker',
        config: tokenBrokerSourceConfig(args.brokerCredentialId, this.namespace),
      },
      rules: [{ host: 'github.com' }, { host: 'api.github.com' }],
    });
  }

  async upsertBrokerCredential(args: {
    foreignId: string;
    name: string;
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    scopes?: string[];
    labels?: Record<string, unknown>;
  }): Promise<IronControlBrokerCredential> {
    return this.write<IronControlBrokerCredential>('PUT', `/api/v1/broker_credentials/${encodeURIComponent(args.foreignId)}`, {
      namespace: this.namespace,
      foreign_id: args.foreignId,
      name: args.name,
      labels: args.labels ?? {},
      token_endpoint: args.tokenEndpoint,
      scopes: args.scopes ?? [],
      client_id: args.clientId,
      ...(args.clientSecret ? { client_secret: args.clientSecret } : {}),
      refresh_token: args.refreshToken,
    });
  }

  async upsertGitHubAppInstallationBrokerCredential(args: {
    foreignId: string;
    name: string;
    githubAppId: string;
    githubInstallationId: string;
    githubPrivateKey: string;
    githubPrivateKeyId?: string;
    labels?: Record<string, unknown>;
  }): Promise<IronControlBrokerCredential> {
    return this.write<IronControlBrokerCredential>('PUT', `/api/v1/broker_credentials/${encodeURIComponent(args.foreignId)}`, {
      namespace: this.namespace,
      foreign_id: args.foreignId,
      name: args.name,
      labels: args.labels ?? {},
      grant: 'github_app_installation',
      github_app_id: args.githubAppId,
      github_installation_id: args.githubInstallationId,
      github_private_key: args.githubPrivateKey,
      ...(args.githubPrivateKeyId ? { github_private_key_id: args.githubPrivateKeyId } : {}),
    });
  }

  async validateGitHubBrokerRepos(
    brokerCredentialId: string,
    repos: readonly string[],
  ): Promise<{ inaccessible: string[] }> {
    return this.write<{ inaccessible: string[] }>(
      'POST',
      `/api/v1/broker_credentials/${encodeURIComponent(brokerCredentialId)}/validate_github_repos`,
      { namespace: this.namespace, repos },
    );
  }

  async validateGitHubStaticSecretRepos(
    staticSecretId: string,
    repos: readonly string[],
  ): Promise<{ inaccessible: string[] }> {
    return this.write<{ inaccessible: string[] }>(
      'POST',
      `/api/v1/static_secrets/${encodeURIComponent(staticSecretId)}/validate_github_repos`,
      { namespace: this.namespace, repos },
    );
  }

  async createPrincipalStaticGrant(principalId: string, staticSecretId: string): Promise<IronControlGrant> {
    return this.write<IronControlGrant>('POST', '/api/v1/grants', {
      principal_id: principalId,
      static_secret_id: staticSecretId,
    });
  }

  async deleteStaticSecret(secretIdOrForeignId: string): Promise<void> {
    await this.request('DELETE', `/api/v1/static_secrets/${encodeURIComponent(secretIdOrForeignId)}`);
  }

  async listPrincipalGrants(principalId: string): Promise<IronControlGrant[]> {
    return this.getList<IronControlGrant>(`/api/v1/principals/${encodeURIComponent(principalId)}/grants`);
  }

  async deleteGrant(grantId: string): Promise<void> {
    await this.request('DELETE', `/api/v1/grants/${encodeURIComponent(grantId)}`);
  }

  async assignRole(principalId: string, roleId: string): Promise<void> {
    await this.write<unknown>('POST', `/api/v1/principals/${encodeURIComponent(principalId)}/roles`, {
      role_id: roleId,
    });
  }

  async unassignRole(principalId: string, roleId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/api/v1/principals/${encodeURIComponent(principalId)}/roles/${encodeURIComponent(roleId)}`,
    );
  }

  async effectiveConfig(principalForeignId: string): Promise<unknown> {
    return this.get<unknown>(
      `/api/v1/principals/lookup/${encodeURIComponent(this.namespace)}/${encodeURIComponent(
        principalForeignId,
      )}/effective_config`,
    );
  }

  async verifySingleGitHubTokenTransform(principalForeignId: string): Promise<GitHubTransformVerification> {
    const config = await this.effectiveConfig(principalForeignId);
    const count = countGitHubTokenTransforms(config);
    if (count !== 1) {
      throw new Error(`expected exactly one GitHub GITHUB_TOKEN transform for ${principalForeignId}, found ${count}`);
    }
    return { count, ok: true };
  }

  private async get<T>(path: string): Promise<T> {
    const body = await this.request('GET', path);
    return unwrapData<T>(body);
  }

  private async getList<T>(path: string): Promise<T[]> {
    const body = await this.request('GET', path);
    return Array.isArray((body as { data?: unknown }).data) ? ((body as { data: T[] }).data) : [];
  }

  private async write<T>(method: 'POST' | 'PUT' | 'PATCH', path: string, data: unknown): Promise<T> {
    const body = await this.request(method, path, { data });
    return unwrapData<T>(body);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.configured) {
      throw new Error('iron-control is not configured');
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const bodyText = await res.text();
      throw new IronControlRequestError(
        res.status,
        bodyText,
        `iron-control ${method} ${path} failed: ${res.status} ${bodyText}`,
      );
    }
    if (res.status === 204) return null;
    return res.json();
  }
}

export function atriumPrincipalForeignId(workspaceId: string, userId: string): string {
  return `atrium-workspace-${workspaceId}-user-${userId}`;
}

export function githubPatSecretForeignId(workspaceId: string, userId: string): string {
  return `github-token-${atriumPrincipalForeignId(workspaceId, userId)}`;
}

export function githubAppUserBrokerCredentialForeignId(workspaceId: string, userId: string): string {
  return `github-app-user-${atriumPrincipalForeignId(workspaceId, userId)}`;
}

export function githubAppInstallationBrokerCredentialForeignId(workspaceId: string, installationId: string): string {
  return `github-app-installation-${workspaceId}-installation-${installationId}`;
}

function unwrapData<T>(body: unknown): T {
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}

function tokenBrokerSourceConfig(credentialId: string, namespace: string): Record<string, string> {
  if (credentialId.startsWith('bcr_')) return { credential_id: credentialId };
  return { credential_id: credentialId, credential_namespace: namespace };
}

export function countGitHubTokenTransforms(config: unknown): number {
  if (!config || typeof config !== 'object') return 0;
  const root = config as Record<string, unknown>;
  let count = 0;
  for (const section of ['secrets', 'transforms']) {
    const entries = root[section];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (isGitHubTokenTransform(entry)) count += 1;
    }
  }
  return count;
}

function isGitHubTokenTransform(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const replace = plainRecord(record.replace) ?? plainRecord(plainRecord(record.config)?.replace);
  const proxyValue = replace?.proxy_value;
  if (proxyValue !== 'GITHUB_TOKEN') return false;

  const rules = Array.isArray(record.rules)
    ? record.rules
    : Array.isArray(plainRecord(record.config)?.rules)
      ? (plainRecord(record.config)?.rules as unknown[])
      : [];
  return rules.some((rule) => {
    const host = plainRecord(rule)?.host;
    return host === 'github.com' || host === 'api.github.com';
  });
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
