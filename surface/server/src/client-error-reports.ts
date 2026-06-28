import { createHash } from 'node:crypto';
import type { Db } from './db.js';

export interface RecordClientErrorReportArgs {
  userId?: string | null;
  kind: string;
  errorName?: string | null;
  message?: string | null;
  stack?: string | null;
  urlPath?: string | null;
  component?: string | null;
  userAgent?: string | null;
}

export interface ClientErrorReport {
  id: number;
  userId: string | null;
  kind: string;
  errorName: string | null;
  messageHash: string | null;
  stackHash: string | null;
  messageLength: number | null;
  stackLength: number | null;
  urlPath: string | null;
  component: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export async function recordClientErrorReport(
  pool: Db,
  args: RecordClientErrorReportArgs,
): Promise<ClientErrorReport> {
  const message = cleanText(args.message);
  const stack = cleanText(args.stack);
  const res = await pool.query<ClientErrorReportRow>(
    `INSERT INTO client_error_reports
       (user_id, kind, error_name, message_hash, stack_hash, message_length,
        stack_length, url_path, component, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, user_id, kind, error_name, message_hash, stack_hash,
               message_length, stack_length, url_path, component, user_agent, created_at`,
    [
      args.userId ?? null,
      bounded(args.kind, 80) || 'unknown',
      bounded(args.errorName, 120),
      message ? sha256(message) : null,
      stack ? sha256(stack) : null,
      message?.length ?? null,
      stack?.length ?? null,
      safePath(args.urlPath),
      bounded(args.component, 120),
      bounded(args.userAgent, 300),
    ],
  );
  return mapRow(res.rows[0]!);
}

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 100_000) : null;
}

function bounded(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : null;
}

function safePath(value: string | null | undefined): string | null {
  const boundedValue = bounded(value, 300);
  if (!boundedValue) return null;
  try {
    return new URL(boundedValue, 'http://atrium.local').pathname.slice(0, 300);
  } catch {
    return null;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface ClientErrorReportRow {
  id: number;
  user_id: string | null;
  kind: string;
  error_name: string | null;
  message_hash: string | null;
  stack_hash: string | null;
  message_length: number | null;
  stack_length: number | null;
  url_path: string | null;
  component: string | null;
  user_agent: string | null;
  created_at: Date;
}

function mapRow(row: ClientErrorReportRow): ClientErrorReport {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    errorName: row.error_name,
    messageHash: row.message_hash,
    stackHash: row.stack_hash,
    messageLength: row.message_length,
    stackLength: row.stack_length,
    urlPath: row.url_path,
    component: row.component,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  };
}
