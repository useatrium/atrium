import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { PROFILE_BUNDLES_NOTIFY_CHANNEL } from '../agent-profiles.js';
import { ArtifactLedger, CHANGE_CURSOR_ZERO, type ChangeCursor } from '../artifact-ledger.js';
import type { Db } from '../db.js';
import { FilesChangedDebouncer } from '../files-nudge.js';
import { isHarness, type Harness } from '../harness-transcript.js';
import type { WsHub } from '../hub.js';
import { workspaceMemberExists, workspaceMemberIds } from '../membership.js';
import { CLAUDE_CODE_PROVIDER, CODEX_PROVIDER } from '../provider-credentials.js';
import { listSessionProfileBundles } from '../profile-bundles.js';
import {
  SESSION_RECORD_CHANGE_CURSOR_ZERO,
  SESSION_RECORD_CHANGES_NOTIFY_CHANNEL,
  sessionRecordChangesSince,
  type SessionRecordChangeCursor,
} from '../session-record-changefeed.js';

type Logger = FastifyInstance['log'];

type InternalSessionRef = {
  id: string;
  channelId: string;
  workspaceId: string;
};

type BatchSessionRequest = {
  key: string;
  artifactsSince?: string;
  atriumSince?: string;
  profileHarness: Harness;
};

type ChangeFeed = 'artifacts' | 'atrium' | 'profile';

type PendingChangeEvent = {
  feed: ChangeFeed;
  key?: string;
  workspaceId?: string;
  channels?: string[];
};

type ChangeEvent = PendingChangeEvent & {
  seq: number;
};

const ARTIFACT_ADVANCED_CHANNEL = 'artifact_advanced';
const MAX_BATCH_SESSIONS = 200;
const DEFAULT_HEARTBEAT_MS = 15_000;
const MAX_QUEUED_SSE_FRAMES = 1000;
const LISTEN_RECONNECT_MIN_MS = 1_000;
const LISTEN_RECONNECT_MAX_MS = 30_000;

export interface InternalChangesRouteDeps {
  pool: Db;
  hub?: WsHub;
  requireCaptureKey(req: FastifyRequest, reply: FastifyReply): boolean;
  resolveInternalSessionRef(sessionRef: string): Promise<InternalSessionRef | null>;
  heartbeatMs?: number;
}

class BadBatchRequest extends Error {}

export function registerInternalChangesRoutes(app: FastifyInstance, deps: InternalChangesRouteDeps): void {
  const { pool, hub, requireCaptureKey, resolveInternalSessionRef } = deps;
  const filesNudge = hub
    ? new FilesChangedDebouncer({
        publish: async (event) => {
          hub.publishToUsers(await workspaceMemberIds(pool, event.workspaceId), event);
        },
        onError: (err) => app.log.warn({ err }, 'files.changed nudge failed'),
      })
    : null;
  const broadcaster = new InternalChangeBroadcaster(pool, app.log, filesNudge);
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  app.addHook('onClose', async () => {
    await broadcaster.close();
  });

  app.post('/api/internal/sessions/changes/batch', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;

    let sessions: BatchSessionRequest[];
    try {
      sessions = parseBatchSessions(req.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid batch request';
      return reply.code(400).send({ error: 'bad_request', message });
    }

    const results = [];
    for (const item of sessions) {
      let artifactCursor: ChangeCursor;
      let atriumCursor: SessionRecordChangeCursor;
      try {
        artifactCursor = parseCursor(item.artifactsSince, CHANGE_CURSOR_ZERO, 'artifactsSince');
        atriumCursor = parseCursor(item.atriumSince, SESSION_RECORD_CHANGE_CURSOR_ZERO, 'atriumSince');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'invalid cursor';
        return reply.code(400).send({ error: 'bad_request', message });
      }
      const session = await resolveInternalSessionRef(item.key);
      if (!session) {
        results.push({ key: item.key, found: false });
        continue;
      }

      const [artifacts, atrium, profileBundles] = await Promise.all([
        loadInternalArtifactChanges(pool, session, artifactCursor),
        loadInternalAtriumChanges(pool, session.id, atriumCursor),
        loadInternalProfileBundles(pool, session.id, item.profileHarness),
      ]);
      results.push({
        key: item.key,
        found: true,
        artifacts,
        atrium,
        profileBundles,
      });
    }

    return reply.send({ sessions: results });
  });

  app.get('/api/internal/changes/stream', async (req, reply) => {
    if (!requireCaptureKey(req, reply)) return;

    await broadcaster.start();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const subscriber = broadcaster.subscribe(reply.raw);
    const heartbeat = setInterval(() => {
      subscriber.send(sseComment('keep-alive'));
    }, heartbeatMs);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      subscriber.close();
    };
    req.raw.on('close', cleanup);

    subscriber.send(sseEvent('hello', { protocol: 1 }));
    await new Promise<void>((resolve) => {
      req.raw.once('close', resolve);
      req.raw.once('aborted', resolve);
      req.raw.once('error', resolve);
    });
    cleanup();
  });
}

async function loadInternalArtifactChanges(
  pool: Db,
  session: InternalSessionRef,
  cursor: ChangeCursor,
): Promise<{ activePrefix: string; rows: unknown[]; next_cursor: string }> {
  const page = await new ArtifactLedger(pool).changesSince(session.id, cursor, 500);
  return {
    activePrefix: `shared/channels/${session.channelId}`,
    rows: page.rows,
    next_cursor: `${page.nextCursor.xid}.${page.nextCursor.id}`,
  };
}

async function loadInternalAtriumChanges(
  pool: Db,
  viewerSessionId: string,
  cursor: SessionRecordChangeCursor,
): Promise<{ rows: unknown[]; next_cursor: string }> {
  const viewer = await pool.query<{ id: string }>(
    `SELECT u.id
       FROM sessions s
       JOIN users u ON u.id = s.spawned_by
      WHERE s.id = $1
      LIMIT 1`,
    [viewerSessionId],
  );
  const userId = viewer.rows[0]?.id;
  if (!userId) throw new BadBatchRequest('viewer session not found');

  const page = await sessionRecordChangesSince(pool, {
    userId,
    cursor,
    limit: 500,
  });
  return {
    rows: page.rows,
    next_cursor: `${page.nextCursor.xid}.${page.nextCursor.id}`,
  };
}

async function loadInternalProfileBundles(
  pool: Db,
  sessionId: string,
  harness: Harness,
): Promise<{ bundles: unknown[] }> {
  const provider = harness === 'codex' ? CODEX_PROVIDER : CLAUDE_CODE_PROVIDER;
  const bundles = await listSessionProfileBundles(pool, sessionId, provider);
  return { bundles };
}

function parseBatchSessions(body: unknown): BatchSessionRequest[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadBatchRequest('body must be an object with sessions');
  }
  const sessions = (body as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new BadBatchRequest('sessions must be a non-empty array');
  }
  if (sessions.length > MAX_BATCH_SESSIONS) {
    throw new BadBatchRequest(`sessions must contain at most ${MAX_BATCH_SESSIONS} entries`);
  }
  return sessions.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new BadBatchRequest(`sessions[${index}] must be an object`);
    }
    const raw = item as Record<string, unknown>;
    const key = raw.key;
    if (typeof key !== 'string' || key.length === 0) {
      throw new BadBatchRequest(`sessions[${index}].key is required`);
    }
    const artifactsSince = optionalString(raw.artifactsSince, `sessions[${index}].artifactsSince`);
    const atriumSince = optionalString(raw.atriumSince, `sessions[${index}].atriumSince`);
    const profileHarness = raw.profileHarness;
    if (typeof profileHarness !== 'string' || !isHarness(profileHarness)) {
      throw new BadBatchRequest(`sessions[${index}].profileHarness must be claude|codex`);
    }
    return { key, artifactsSince, atriumSince, profileHarness };
  });
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') throw new BadBatchRequest(`${field} must be a string`);
  return value;
}

function parseCursor<T extends { xid: string; id: string }>(value: string | undefined, zero: T, field: string): T {
  if (value == null || value.length === 0) return zero;
  const match = /^(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new BadBatchRequest(`${field} must be "<xid>.<id>"`);
  return { xid: match[1]!, id: match[2]! } as T;
}

class InternalChangeBroadcaster {
  private client: pg.PoolClient | null = null;
  private starting: Promise<void> | null = null;
  private processing: Promise<void> = Promise.resolve();
  private readonly subscribers = new Set<SseSubscriber>();
  private seq = 0;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = LISTEN_RECONNECT_MIN_MS;

  constructor(
    private readonly pool: Db,
    private readonly log: Logger,
    private readonly filesNudge: FilesChangedDebouncer | null = null,
  ) {}

  async start(): Promise<void> {
    if (this.closed) return;
    if (this.client) return;
    if (this.starting) return this.starting;
    this.starting = this.startListener();
    try {
      await this.starting;
      this.reconnectDelayMs = LISTEN_RECONNECT_MIN_MS;
    } finally {
      this.starting = null;
    }
  }

  subscribe(response: ServerResponse): SseSubscriber {
    const subscriber = new SseSubscriber(response, () => {
      this.subscribers.delete(subscriber);
    });
    this.subscribers.add(subscriber);
    return subscriber;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const subscriber of [...this.subscribers]) subscriber.close();
    this.filesNudge?.close();
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    client.removeAllListeners('notification');
    client.removeAllListeners('error');
    client.removeAllListeners('end');
    await client.query('UNLISTEN *').catch(() => {});
    client.release();
  }

  private async startListener(): Promise<void> {
    const client = await this.pool.connect();
    this.client = client;
    client.on('notification', (notification) => {
      this.processing = this.processing
        .then(() => this.processNotification(notification))
        .catch((err) => {
          this.log.warn({ err }, 'internal changes notification failed');
        });
    });
    client.on('error', (err) => {
      this.log.error({ err }, 'internal changes listener failed');
      this.restartListener(client);
    });
    client.on('end', () => {
      this.restartListener(client);
    });
    await client.query(`LISTEN ${ARTIFACT_ADVANCED_CHANNEL}`);
    await client.query(`LISTEN ${SESSION_RECORD_CHANGES_NOTIFY_CHANNEL}`);
    await client.query(`LISTEN ${PROFILE_BUNDLES_NOTIFY_CHANNEL}`);
  }

  /** The LISTEN connection died under us: drop it and reconnect with backoff. */
  private restartListener(client: pg.PoolClient): void {
    if (this.client !== client) return;
    this.client = null;
    client.removeAllListeners('notification');
    client.removeAllListeners('error');
    client.removeAllListeners('end');
    try {
      // Release with an error so the pool destroys the dead connection.
      client.release(new Error('internal changes listener connection lost'));
    } catch {
      // already released
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, LISTEN_RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start()
        .then(() => {
          this.log.info('internal changes listener reconnected');
        })
        .catch((err) => {
          this.log.error({ err }, 'internal changes listener reconnect failed');
          this.scheduleReconnect();
        });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async processNotification(notification: pg.Notification): Promise<void> {
    const changes = await this.mapNotification(notification);
    if (changes.length === 0) return;
    for (const change of changes) {
      if ((change.feed === 'artifacts' || change.feed === 'atrium') && change.workspaceId) {
        this.filesNudge?.nudge(change.workspaceId);
      }
      this.seq += 1;
      this.broadcast({ ...change, seq: this.seq });
    }
  }

  private async mapNotification(notification: pg.Notification): Promise<PendingChangeEvent[]> {
    const payload = parseJsonPayload(notification.payload);
    switch (notification.channel) {
      case ARTIFACT_ADVANCED_CHANNEL:
        return [await this.mapArtifactAdvanced(payload)];
      case SESSION_RECORD_CHANGES_NOTIFY_CHANNEL:
        if (stringField(payload.channelId)) return this.mapChannelAdvanced(payload);
        return this.mapSessionAdvanced('atrium', payload);
      case PROFILE_BUNDLES_NOTIFY_CHANNEL:
        return this.mapSessionAdvanced('profile', payload);
      default:
        return [];
    }
  }

  private async mapArtifactAdvanced(payload: Record<string, unknown>): Promise<PendingChangeEvent> {
    const artifactId = stringField(payload.artifactId);
    if (!artifactId) return { feed: 'artifacts' };
    const res = await this.pool.query<{
      workspace_id: string;
      centaur_thread_key: string | null;
    }>(
      `SELECT a.workspace_id, s.centaur_thread_key
         FROM artifacts a
         LEFT JOIN sessions s ON s.id = a.session_id
        WHERE a.id = $1
        LIMIT 1`,
      [artifactId],
    );
    const row = res.rows[0];
    return {
      feed: 'artifacts',
      ...(row?.centaur_thread_key ? { key: row.centaur_thread_key } : {}),
      ...(row?.workspace_id ? { workspaceId: row.workspace_id } : {}),
    };
  }

  private async mapSessionAdvanced(
    feed: Exclude<ChangeFeed, 'artifacts'>,
    payload: Record<string, unknown>,
  ): Promise<PendingChangeEvent[]> {
    const sessionId = stringField(payload.sessionId);
    const payloadWorkspaceId = stringField(payload.workspaceId);
    if (!sessionId) {
      return [
        {
          feed,
          ...(payloadWorkspaceId ? { workspaceId: payloadWorkspaceId } : {}),
        },
      ];
    }
    const res = await this.pool.query<{
      workspace_id: string;
      centaur_thread_key: string | null;
    }>(
      `SELECT workspace_id, centaur_thread_key
         FROM sessions
        WHERE id = $1
        LIMIT 1`,
      [sessionId],
    );
    const row = res.rows[0];
    return [
      {
        feed,
        ...(row?.centaur_thread_key ? { key: row.centaur_thread_key } : {}),
        ...(row?.workspace_id || payloadWorkspaceId ? { workspaceId: row?.workspace_id ?? payloadWorkspaceId } : {}),
      },
    ];
  }

  private async mapChannelAdvanced(payload: Record<string, unknown>): Promise<PendingChangeEvent[]> {
    const channelId = stringField(payload.channelId);
    if (!channelId) return [{ feed: 'atrium' }];
    const res = await this.pool.query<{
      workspace_id: string;
      centaur_thread_key: string;
    }>(
      `SELECT DISTINCT c.workspace_id,
              s.centaur_thread_key
         FROM channels c
         JOIN sessions s ON s.workspace_id = c.workspace_id
        WHERE c.id = $1::uuid
          AND s.centaur_thread_key IS NOT NULL
          AND s.status IN ('spawning', 'queued', 'running')
          AND (
            (c.kind = 'public' AND ${workspaceMemberExists('c.workspace_id', 's.spawned_by')})
            OR EXISTS (SELECT 1 FROM channel_members cm
                       WHERE cm.channel_id = c.id AND cm.user_id = s.spawned_by)
            OR EXISTS (SELECT 1 FROM sessions own
                       WHERE own.channel_id = c.id AND own.spawned_by = s.spawned_by)
          )
          AND (c.kind NOT IN ('dm', 'gdm') OR s.channel_id = c.id)`,
      [channelId],
    );
    return res.rows.map((row) => ({
      feed: 'atrium',
      key: row.centaur_thread_key,
      workspaceId: row.workspace_id,
      channels: [channelId],
    }));
  }

  private broadcast(event: ChangeEvent): void {
    const frame = sseEvent('changed', event);
    for (const subscriber of this.subscribers) {
      subscriber.send(frame);
    }
  }
}

class SseSubscriber {
  private readonly queue: string[] = [];
  private flushing = false;
  private closed = false;

  constructor(
    private readonly response: ServerResponse,
    private readonly onClosed: () => void,
  ) {}

  send(frame: string): void {
    if (this.closed) return;
    if (this.queue.length >= MAX_QUEUED_SSE_FRAMES) {
      this.close();
      return;
    }
    this.queue.push(frame);
    void this.flush();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.onClosed();
    if (!this.response.destroyed) {
      this.response.end();
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        const frame = this.queue.shift()!;
        if (!this.response.write(frame)) {
          await once(this.response, 'drain');
        }
      }
    } catch {
      this.close();
    } finally {
      this.flushing = false;
      if (!this.closed && this.queue.length > 0) void this.flush();
    }
  }
}

function parseJsonPayload(payload: string | undefined): Record<string, unknown> {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseComment(comment: string): string {
  return `: ${comment}\n\n`;
}
