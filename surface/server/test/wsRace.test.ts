// Regression: frames sent the instant the socket opens (subscribe/focus/ping)
// must not be lost while the route's auth lookup is still awaiting the DB.
// Requires a real listening server — fastify.inject can't do WS upgrades.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;
let port: number;

beforeAll(async () => {
  pool = await createTestPool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({
    pool,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});
afterEach(async () => {
  await app.close();
});

async function loginToken(handle: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName: handle },
  });
  return res.json().token as string;
}

describe('ws auth race', () => {
  it('frames sent immediately on open are processed after auth resolves', async () => {
    const token = await loginToken('alice');
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
    );
    const received: { type?: string; channelId?: string; seq?: number }[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`only got: ${JSON.stringify(received)}`)),
        4000,
      );
      ws.on('open', () => {
        // No await between open and these sends — this is the racing burst.
        ws.send(JSON.stringify({ type: 'subscribe', channelIds: [fx.channelId] }));
        ws.send(JSON.stringify({ type: 'focus', channelId: fx.channelId }));
        ws.send(JSON.stringify({ type: 'ping' }));
      });
      ws.on('message', (d) => {
        received.push(JSON.parse(d.toString()));
        const gotPong = received.some((m) => m.type === 'pong');
        const gotPresence = received.some(
          (m) => m.type === 'presence' && m.channelId === fx.channelId,
        );
        if (gotPong && gotPresence) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    await done;
    expect(received.every((m) => typeof m.seq === 'number')).toBe(true);
    expect(received.map((m) => m.seq)).toEqual(received.map((_, i) => i + 1));
    ws.close();
  });

  it('rejects a bad token with 4401 even with frames in flight', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=garbage.token`);
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no close')), 4000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'ping' }));
      });
      ws.on('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).toBe(4401);
  });
});
