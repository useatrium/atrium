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

  async lookupRole(foreignId: string): Promise<IronControlIdentity> {
    return this.get<IronControlIdentity>(
      `/api/v1/roles/lookup/${encodeURIComponent(this.namespace)}/${encodeURIComponent(foreignId)}`,
    );
  }

  async upsertGitHubPatSecret(args: {
    foreignId: string;
    name: string;
    token: string;
    labels?: Record<string, unknown>;
  }): Promise<IronControlSecret> {
    return this.upsertGitHubAuthorizationSecret({
      ...args,
      source: {
        source_type: 'control_plane',
        secret: args.token,
        config: { authorization_format: 'github_basic' },
      },
    });
  }

  async upsertGitHubPublicReadSecret(args: {
    token: string;
    labels?: Record<string, unknown>;
  }): Promise<IronControlSecret> {
    return this.upsertGitHubAuthorizationSecret({
      foreignId: githubPublicReadSecretForeignId(),
      name: 'GitHub public-read fallback token',
      labels: args.labels,
      source: {
        source_type: 'control_plane',
        secret: args.token,
        config: { authorization_format: 'github_basic' },
      },
    });
  }

  async upsertGitHubBrokerSecret(args: {
    foreignId: string;
    name: string;
    brokerCredentialId: string;
    labels?: Record<string, unknown>;
  }): Promise<IronControlSecret> {
    return this.upsertGitHubAuthorizationSecret({
      ...args,
      source: {
        source_type: 'token_broker',
        config: {
          ...tokenBrokerSourceConfig(args.brokerCredentialId, this.namespace),
          authorization_format: 'github_basic',
        },
      },
    });
  }

  /**
   * GitHub secrets are proxy-side INJECTS (like the Codex bearer), not
   * placeholder replaces: the proxy overwrites the whole Authorization header
   * on GitHub hosts, so the header shape the sandbox sends is irrelevant —
   * git's bare `GITHUB_TOKEN` extraheader and gh's `token GITHUB_TOKEN` both
   * end up as the same valid header. No formatter: console pre-formats the
   * value as `Basic base64(x-access-token:<token>)` via
   * `authorization_format: github_basic` (the only scheme git accepts).
   */
  private async upsertGitHubAuthorizationSecret(args: {
    foreignId: string;
    name: string;
    labels?: Record<string, unknown>;
    source: Record<string, unknown>;
  }): Promise<IronControlSecret> {
    return this.write<IronControlSecret>('PUT', `/api/v1/static_secrets/${encodeURIComponent(args.foreignId)}`, {
      namespace: this.namespace,
      foreign_id: args.foreignId,
      name: args.name,
      labels: args.labels ?? {},
      inject_config: {
        header: 'Authorization',
      },
      source: args.source,
      rules: [{ host: 'github.com' }, { host: 'api.github.com' }],
    });
  }

  /**
   * Generic proxy-side INJECT secret: adds `header` (optionally `Bearer`-style
   * formatted) to requests matching `host`, sourced from a per-user broker
   * credential (rotating) or an inline control-plane value (static). This is how
   * a per-user subscription token reaches chatgpt.com / api.anthropic.com without
   * ever entering the sandbox. Mutually exclusive with replace_config server-side.
   */
  async upsertInjectSecret(args: {
    foreignId: string;
    name: string;
    header: string;
    formatter?: string;
    host: string;
    source: { kind: 'token_broker'; brokerCredentialId: string } | { kind: 'control_plane'; secret: string };
    labels?: Record<string, unknown>;
  }): Promise<IronControlSecret> {
    const source =
      args.source.kind === 'token_broker'
        ? {
            source_type: 'token_broker',
            config: tokenBrokerSourceConfig(args.source.brokerCredentialId, this.namespace),
          }
        : { source_type: 'control_plane', secret: args.source.secret };
    return this.write<IronControlSecret>('PUT', `/api/v1/static_secrets/${encodeURIComponent(args.foreignId)}`, {
      namespace: this.namespace,
      foreign_id: args.foreignId,
      name: args.name,
      labels: args.labels ?? {},
      inject_config: {
        header: args.header,
        ...(args.formatter ? { formatter: args.formatter } : {}),
      },
      source,
      rules: [{ host: args.host }],
    });
  }

  /**
   * Register the no-op secret that puts an egress host set on the proxy
   * allowlist (see `EGRESS_HOST_SETS`). Shape constraints, all load-bearing:
   * a secret MUST carry a source or the console silently drops it from the
   * synthesized proxy config — taking its allowlist hosts with it — so a dummy
   * inline value rides along; and the console requires exactly one of
   * inject/replace, so this uses replace mode with a placeholder that never
   * appears in traffic (`require: false` ⇒ can never reject a request).
   */
  async upsertEgressHostSetSecret(setKey: EgressHostSetKey): Promise<IronControlSecret> {
    const set = EGRESS_HOST_SETS[setKey];
    const foreignId = egressHostSetSecretForeignId(setKey);
    return this.write<IronControlSecret>('PUT', `/api/v1/static_secrets/${encodeURIComponent(foreignId)}`, {
      namespace: this.namespace,
      foreign_id: foreignId,
      name: set.name,
      labels: { source: 'atrium', kind: 'egress-host-set', egress_host_set: setKey },
      replace_config: {
        proxy_value: EGRESS_HOST_SET_PLACEHOLDER,
        require: false,
      },
      source: { source_type: 'control_plane', secret: 'egress-only-no-credential' },
      rules: set.hosts.map((host) => ({ host })),
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
    return this.write<IronControlBrokerCredential>(
      'PUT',
      `/api/v1/broker_credentials/${encodeURIComponent(args.foreignId)}`,
      {
        namespace: this.namespace,
        foreign_id: args.foreignId,
        name: args.name,
        labels: args.labels ?? {},
        token_endpoint: args.tokenEndpoint,
        scopes: args.scopes ?? [],
        client_id: args.clientId,
        ...(args.clientSecret ? { client_secret: args.clientSecret } : {}),
        refresh_token: args.refreshToken,
      },
    );
  }

  /** Fetch a broker credential's current state (notably `status`: bootstrapping/live/dead). */
  async getBrokerCredential(id: string): Promise<IronControlBrokerCredential> {
    return this.get<IronControlBrokerCredential>(`/api/v1/broker_credentials/${encodeURIComponent(id)}`);
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
    return this.write<IronControlBrokerCredential>(
      'PUT',
      `/api/v1/broker_credentials/${encodeURIComponent(args.foreignId)}`,
      {
        namespace: this.namespace,
        foreign_id: args.foreignId,
        name: args.name,
        labels: args.labels ?? {},
        grant: 'github_app_installation',
        github_app_id: args.githubAppId,
        github_installation_id: args.githubInstallationId,
        github_private_key: args.githubPrivateKey,
        ...(args.githubPrivateKeyId ? { github_private_key_id: args.githubPrivateKeyId } : {}),
      },
    );
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

  async listRoleGrants(roleId: string): Promise<IronControlGrant[]> {
    return this.getList<IronControlGrant>(`/api/v1/roles/${encodeURIComponent(roleId)}/grants`);
  }

  async createRoleStaticGrant(roleId: string, staticSecretId: string): Promise<IronControlGrant> {
    return this.write<IronControlGrant>('POST', '/api/v1/grants', {
      role_id: roleId,
      static_secret_id: staticSecretId,
    });
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
      throw new Error(`expected exactly one GitHub Authorization transform for ${principalForeignId}, found ${count}`);
    }
    return { count, ok: true };
  }

  private async get<T>(path: string): Promise<T> {
    const body = await this.request('GET', path);
    return unwrapData<T>(body);
  }

  private async getList<T>(path: string): Promise<T[]> {
    const body = await this.request('GET', path);
    return Array.isArray((body as { data?: unknown }).data) ? (body as { data: T[] }).data : [];
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

export function githubConnectionSecretForeignId(workspaceId: string, userId: string, connectionId: string): string {
  return `${githubPatSecretForeignId(workspaceId, userId)}-${slugForeignIdPart(connectionId)}`;
}

export function githubPublicReadSecretForeignId(): string {
  return 'github-public-read-token';
}

export function githubAppFallbackSecretForeignId(): string {
  return 'github-app-fallback-token';
}

export function githubAppFallbackBrokerCredentialForeignId(installationId: string): string {
  return `github-app-fallback-installation-${installationId}`;
}

/**
 * Egress-only host sets: hosts a granted capability must REACH but never needs
 * a credential injected for — signed-URL redirect targets and service-run
 * storage (GitHub 302s Actions log downloads to a signed
 * results-receiver.actions.githubusercontent.com URL; the API token must NOT
 * accompany that request).
 *
 * iron-control derives each sandbox proxy's egress allowlist exclusively from
 * the HOSTS of the principal's granted secrets' rules (console
 * `Proxy.merge_proxy_policy`), so "reachable without a credential" still has to
 * be expressed as a secret grant. `upsertEgressHostSetSecret` registers a
 * deliberate no-op secret carrying only the host rules.
 *
 * A host belongs in a set here ONLY if it is operator-run storage for the
 * granted service and cannot reflect request data back to an attacker (egress
 * to it is not an exfiltration channel). Hosts serving arbitrary third-party
 * content, or where unauthenticated writes are meaningful, must go through a
 * server-mediated fetch instead — the allowlist is host-granular (method/path
 * rules cannot gate the CONNECT tunnel), so there is no tighter knob to reach
 * for.
 */
export const EGRESS_HOST_SETS = {
  // Signed-URL host GitHub redirects Actions run/job log downloads to
  // (`gh run view --log`). Uploads require runner-minted signed URLs, and the
  // signature rides the query string — no credential involved.
  'github-actions-artifacts': {
    name: 'GitHub Actions signed-URL log downloads',
    hosts: ['results-receiver.actions.githubusercontent.com'],
  },
} as const;

export type EgressHostSetKey = keyof typeof EGRESS_HOST_SETS;

export function egressHostSetSecretForeignId(setKey: EgressHostSetKey): string {
  return `egress-hosts-${setKey}`;
}

/**
 * Never occurs in real traffic, by construction. The proxy scans request
 * headers of rule-matching requests for this token (replace mode); absence is
 * a no-op and `require: false` means absence can never reject the request —
 * both verified against iron-proxy 0.46.0.
 */
const EGRESS_HOST_SET_PLACEHOLDER = 'atrium-egress-only-placeholder-3f6a9c81d2e54b07c9a1';

export function githubAppUserBrokerCredentialForeignId(workspaceId: string, userId: string): string {
  return `github-app-user-${atriumPrincipalForeignId(workspaceId, userId)}`;
}

export function githubAppInstallationBrokerCredentialForeignId(workspaceId: string, installationId: string): string {
  return `github-app-installation-${workspaceId}-installation-${installationId}`;
}

// Per-user subscription credential foreign ids (Codex broker + injects, Claude static).
export function codexBrokerCredentialForeignId(workspaceId: string, userId: string): string {
  return `codex-broker-${atriumPrincipalForeignId(workspaceId, userId)}`;
}
export function codexBearerSecretForeignId(workspaceId: string, userId: string): string {
  return `codex-bearer-${atriumPrincipalForeignId(workspaceId, userId)}`;
}
export function codexAccountIdSecretForeignId(workspaceId: string, userId: string): string {
  return `codex-account-${atriumPrincipalForeignId(workspaceId, userId)}`;
}
export function claudeStaticSecretForeignId(workspaceId: string, userId: string): string {
  return `claude-token-${atriumPrincipalForeignId(workspaceId, userId)}`;
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

function slugForeignIdPart(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._~-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
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

// A "GitHub token transform" is any effective-config entry that sets the
// Authorization header on a GitHub host: the current shape (an Authorization
// inject) and the legacy shape (a GITHUB_TOKEN placeholder replace). Counting
// both keeps the single-transform invariant honest during the transition —
// a principal holding one old-shape and one new-shape secret is a double.
function isGitHubTokenTransform(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (!hasGitHubHostRule(record)) return false;
  const replace = plainRecord(record.replace) ?? plainRecord(plainRecord(record.config)?.replace);
  if (replace?.proxy_value === 'GITHUB_TOKEN') return true;
  const inject = plainRecord(record.inject) ?? plainRecord(plainRecord(record.config)?.inject);
  const header = inject?.header;
  return typeof header === 'string' && header.toLowerCase() === 'authorization';
}

function hasGitHubHostRule(record: Record<string, unknown>): boolean {
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
