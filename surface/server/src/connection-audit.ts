import type { ConnectionStatusJson } from './connections.js';
import { atriumPrincipalForeignId } from './iron-control.js';

export type GitHubConnectionAuditAction = 'connect' | 'disconnect' | 'activate' | 'needs_auth';
export type GitHubConnectionAuditResult = 'success' | 'failure';

export interface GitHubConnectionAuditInput {
  action: GitHubConnectionAuditAction;
  result: GitHubConnectionAuditResult;
  workspaceId: string;
  actorUserId: string;
  credentialOwnerUserId: string;
  requestedTokenKind?: unknown;
  connection?: ConnectionStatusJson | null;
  error?: unknown;
}

export function githubConnectionAuditMetadata(input: GitHubConnectionAuditInput): Record<string, unknown> {
  const connection = input.connection ?? null;
  const tokenKind = connection?.tokenKind ?? safeString(input.requestedTokenKind);
  return compactRecord({
    event: 'github_connection_audit',
    provider: 'github',
    action: input.action,
    result: input.result,
    workspace_id: input.workspaceId,
    actor_user_id: input.actorUserId,
    credential_owner_user_id: input.credentialOwnerUserId,
    principal_foreign_id: atriumPrincipalForeignId(input.workspaceId, input.credentialOwnerUserId),
    status: connection?.status,
    connected: connection?.connected,
    token_kind: tokenKind,
    account_login: connection?.accountLogin,
    account_label: connection?.accountLabel,
    scopes: connection?.scopes,
    capabilities: redactObject(connection?.capabilities),
    metadata: redactObject(connection?.metadata),
    last_validated_at: connection?.lastValidatedAt,
    last_error: connection?.lastError,
    error: errorMessage(input.error),
  });
}

function redactObject(value: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  if (!value || Object.keys(value).length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (/(token|secret|credential|authorization|password|private[_-]?key|refresh)/i.test(lower)) {
      out[key] = '[redacted]';
    } else if (lower === 'last4' && typeof raw === 'string') {
      out[key] = raw.slice(-4);
    } else if (Array.isArray(raw)) {
      out[key] = raw.map((item) => (typeof item === 'string' ? safeAuditString(item) : redactNested(item)));
    } else if (raw && typeof raw === 'object') {
      out[key] = redactObject(raw as Record<string, unknown>) ?? {};
    } else if (typeof raw === 'string') {
      out[key] = safeAuditString(raw);
    } else {
      out[key] = raw;
    }
  }
  return out;
}

function redactNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactNested);
  if (value && typeof value === 'object') return redactObject(value as Record<string, unknown>) ?? {};
  if (typeof value === 'string') return safeAuditString(value);
  return value;
}

function safeAuditString(value: string): string {
  if (/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}\b/.test(value)) return '[redacted]';
  if (/bearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(value)) return value.replace(/bearer\s+\S+/i, 'Bearer [redacted]');
  return value;
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error) return error.message;
  return String(error);
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}
