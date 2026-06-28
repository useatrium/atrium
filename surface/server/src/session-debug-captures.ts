import type { Db } from './db.js';

export type CaptureMode = 'standard' | 'admin_verbose';

export interface RecordSessionDebugCaptureArgs {
  sessionId: string;
  executionId?: string | null;
  entryUid?: string | null;
  captureMode: CaptureMode;
  eventKind: string;
  payload: unknown;
  actorId?: string | null;
  expiresAt?: Date | string | null;
}

export interface SessionDebugCapture {
  id: string;
  sessionId: string;
  executionId: string | null;
  entryUid: string | null;
  captureMode: CaptureMode;
  eventKind: string;
  payload: unknown;
  actorId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface DebugCaptureTelemetryRef {
  event: 'session_debug_capture_recorded';
  session_id: string;
  execution_id?: string;
  entry_uid?: string;
  capture_mode: CaptureMode;
  event_kind: string;
  debug_capture_id: string;
}

export async function recordSessionDebugCapture(
  pool: Db,
  args: RecordSessionDebugCaptureArgs,
): Promise<{ capture: SessionDebugCapture; telemetry: DebugCaptureTelemetryRef }> {
  const res = await pool.query<DebugCaptureRow>(
    `INSERT INTO session_debug_captures
       (session_id, execution_id, entry_uid, capture_mode, event_kind, payload, actor_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     RETURNING id, session_id, execution_id, entry_uid, capture_mode, event_kind, payload,
               actor_id, expires_at, created_at`,
    [
      args.sessionId,
      args.executionId ?? null,
      args.entryUid ?? null,
      args.captureMode,
      args.eventKind,
      JSON.stringify(args.payload),
      args.actorId ?? null,
      args.expiresAt ?? null,
    ],
  );
  const capture = mapRow(res.rows[0]!);
  return {
    capture,
    telemetry: telemetryRef(capture),
  };
}

export async function listSessionDebugCaptures(pool: Db, sessionId: string): Promise<SessionDebugCapture[]> {
  const res = await pool.query<DebugCaptureRow>(
    `SELECT id, session_id, execution_id, entry_uid, capture_mode, event_kind, payload,
            actor_id, expires_at, created_at
       FROM session_debug_captures
      WHERE session_id = $1
      ORDER BY created_at ASC, id ASC`,
    [sessionId],
  );
  return res.rows.map(mapRow);
}

function telemetryRef(capture: SessionDebugCapture): DebugCaptureTelemetryRef {
  return {
    event: 'session_debug_capture_recorded',
    session_id: capture.sessionId,
    ...(capture.executionId ? { execution_id: capture.executionId } : {}),
    ...(capture.entryUid ? { entry_uid: capture.entryUid } : {}),
    capture_mode: capture.captureMode,
    event_kind: capture.eventKind,
    debug_capture_id: capture.id,
  };
}

interface DebugCaptureRow {
  id: string;
  session_id: string;
  execution_id: string | null;
  entry_uid: string | null;
  capture_mode: CaptureMode;
  event_kind: string;
  payload: unknown;
  actor_id: string | null;
  expires_at: Date | null;
  created_at: Date;
}

function mapRow(row: DebugCaptureRow): SessionDebugCapture {
  return {
    id: row.id,
    sessionId: row.session_id,
    executionId: row.execution_id,
    entryUid: row.entry_uid,
    captureMode: row.capture_mode,
    eventKind: row.event_kind,
    payload: row.payload,
    actorId: row.actor_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}
