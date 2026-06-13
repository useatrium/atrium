import type { Db } from '../db.js';
import { withTx } from '../db.js';
import { appendVoiceTranscribedEventTx, type WireEvent } from '../events.js';
import type { WsHub } from '../hub.js';
import { getSttAdapter } from './adapter.js';

interface TranscriptJob {
  fileId: string;
  eventId: number;
  workspaceId: string;
  channelId: string | null;
}

export interface SttWorkerOptions {
  pool: Db;
  hub: WsHub;
  concurrency?: number;
  pollIntervalMs?: number;
  log?: Pick<Console, 'warn' | 'error'>;
}

export class SttWorker {
  private readonly pool: Db;
  private readonly hub: WsHub;
  private readonly concurrency: number;
  private readonly log: Pick<Console, 'warn' | 'error'>;
  private readonly pollTimer: NodeJS.Timeout | null;
  private active = 0;
  private scheduled = false;
  private stopped = false;

  constructor(options: SttWorkerOptions) {
    this.pool = options.pool;
    this.hub = options.hub;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
    this.log = options.log ?? console;
    const pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.pollTimer =
      pollIntervalMs > 0
        ? setInterval(() => {
            this.enqueue();
          }, pollIntervalMs)
        : null;
    this.pollTimer?.unref?.();
  }

  enqueue(): void {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.drain().catch((err) => {
        this.log.error(err, 'stt worker drain failed');
      });
    });
  }

  async sweepOnBoot(): Promise<void> {
    await this.pool.query(
      `UPDATE transcripts
       SET status = 'pending', updated_at = now()
       WHERE status = 'processing'`,
    );
    this.enqueue();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.active < this.concurrency) {
      const job = await this.claimNext();
      if (!job) break;
      this.active += 1;
      void this.process(job)
        .catch((err) => {
          this.log.error(err, 'stt worker job failed');
        })
        .finally(() => {
          this.active -= 1;
          this.enqueue();
        });
    }
  }

  private async claimNext(): Promise<TranscriptJob | null> {
    return withTx(this.pool, async (client) => {
      const res = await client.query<{
        file_id: string;
        event_id: number;
        workspace_id: string;
        channel_id: string | null;
      }>(
        `WITH next_job AS (
           SELECT file_id
           FROM transcripts
           WHERE status = 'pending'
           ORDER BY created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE transcripts t
         SET status = 'processing', updated_at = now()
         FROM next_job
         WHERE t.file_id = next_job.file_id
         RETURNING t.file_id, t.event_id, t.workspace_id, t.channel_id`,
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        fileId: row.file_id,
        eventId: row.event_id,
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
      };
    });
  }

  private async process(job: TranscriptJob): Promise<void> {
    const file = await this.pool.query<{
      s3_key: string;
      content_type: string;
      filename: string;
    }>('SELECT s3_key, content_type, filename FROM files WHERE id = $1', [job.fileId]);
    const row = file.rows[0];
    if (!row) {
      await this.finishFailed(job, 'audio file not found');
      return;
    }

    try {
      const result = await getSttAdapter().transcribe({
        s3Key: row.s3_key,
        contentType: row.content_type,
        filename: row.filename,
      });
      const event = await withTx(this.pool, async (client) => {
        await client.query(
          `UPDATE transcripts
           SET status = 'done',
               text = $2,
               lang = $3,
               segments = $4,
               model = $5,
               error = NULL,
               attempts = attempts + 1,
               updated_at = now()
           WHERE file_id = $1`,
          [
            job.fileId,
            result.text,
            result.lang ?? null,
            result.segments == null ? null : JSON.stringify(result.segments),
            result.model,
          ],
        );
        return appendVoiceTranscribedEventTx(client, {
          targetEventId: job.eventId,
          transcript: { status: 'done', text: result.text, ...(result.lang ? { lang: result.lang } : {}) },
        });
      });
      this.hub.publishEvent(event);
    } catch (err) {
      await this.finishFailed(job, errorMessage(err));
    }
  }

  private async finishFailed(job: TranscriptJob, message: string): Promise<void> {
    let event: WireEvent | null = null;
    try {
      event = await withTx(this.pool, async (client) => {
        await client.query(
          `UPDATE transcripts
           SET status = 'failed',
               error = $2,
               attempts = attempts + 1,
               updated_at = now()
           WHERE file_id = $1`,
          [job.fileId, message],
        );
        return appendVoiceTranscribedEventTx(client, {
          targetEventId: job.eventId,
          transcript: { status: 'failed' },
        });
      });
    } catch (err) {
      this.log.error(err, 'stt worker could not mark job failed');
    }
    if (event) this.hub.publishEvent(event);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message.slice(0, 2000);
  return String(err).slice(0, 2000);
}
