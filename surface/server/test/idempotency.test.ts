import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { appendEvent } from '../src/events.js';
import { withIdempotency } from '../src/idempotency.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;

beforeAll(async () => {
  pool = await createTestPool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  fx = await seedFixture(pool);
});

describe('withIdempotency', () => {
  it('blocks concurrent duplicates and returns one stored response', async () => {
    const opId = randomUUID();
    let effects = 0;

    const run = () =>
      withIdempotency(
        pool,
        {
          userId: fx.userId,
          opId,
          opType: 'test.concurrent',
          body: { channelId: fx.channelId, text: 'once' },
        },
        async (client) => {
          effects += 1;
          // Hold the first operation open briefly so the concurrent duplicate
          // reaches the in-flight idempotency path.
          await new Promise((resolve) => setTimeout(resolve, 75));
          const event = await appendEvent(client, {
            workspaceId: fx.workspaceId,
            channelId: fx.channelId,
            type: 'test.effect',
            actorId: fx.userId,
            payload: { text: 'once' },
          });
          return { eventId: event.id, text: event.payload.text };
        },
      );

    const [a, b] = await Promise.all([run(), run()]);

    expect(a).toEqual(b);
    expect(effects).toBe(1);
    const events = await pool.query("SELECT id FROM events WHERE type = 'test.effect'");
    expect(events.rowCount).toBe(1);
  });

  it('rejects opId reuse with a different operation type or body hash', async () => {
    const opId = randomUUID();
    await withIdempotency(pool, { userId: fx.userId, opId, opType: 'test.once', body: { value: 1 } }, async () => ({
      ok: true,
    }));

    await expect(
      withIdempotency(pool, { userId: fx.userId, opId, opType: 'test.once', body: { value: 2 } }, async () => ({
        ok: true,
      })),
    ).rejects.toMatchObject({ statusCode: 409, code: 'op_id_reuse' });

    await expect(
      withIdempotency(pool, { userId: fx.userId, opId, opType: 'test.other', body: { value: 1 } }, async () => ({
        ok: true,
      })),
    ).rejects.toMatchObject({ statusCode: 409, code: 'op_id_reuse' });
  });
});
