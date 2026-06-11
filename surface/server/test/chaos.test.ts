import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { createChannel } from '../src/events.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';
import {
  ChaosCentaur,
  chaosInject,
  chaosSeed,
  SeededPrng,
  type ChaosRequest,
} from './chaosHarness.js';

interface UserLogin {
  cookie: string;
  user: { id: string; handle: string; displayName: string };
}

interface RoundContext {
  fx: Fixture;
  alice: UserLogin;
  bob: UserLogin;
}

interface ChaosOp {
  name: string;
  build: (ctx: RoundContext, opId: string) => Promise<ChaosRequest>;
  effectCount: (ctx: RoundContext) => Promise<number>;
}

let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let centaur: ChaosCentaur;

beforeAll(async () => {
  pool = await createTestPool();
  centaur = new ChaosCentaur();
  await centaur.start();
  app = await buildApp({
    pool,
    rateLimit: false,
    sessionRuns: { baseUrl: centaur.url, apiKey: 'test', autoResume: false },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await centaur.stop();
  await pool.end();
});

const registry: ChaosOp[] = [
  {
    name: 'message.edit',
    build: async (ctx, opId) => {
      const msg = await post(ctx.alice.cookie, ctx.fx.channelId, 'before edit');
      return {
        method: 'PATCH',
        url: `/api/messages/${msg.id}`,
        headers: { cookie: ctx.alice.cookie },
        payload: { text: 'after edit', opId },
      };
    },
    effectCount: async () => countEvents("type = 'message.edited'"),
  },
  {
    name: 'message.delete',
    build: async (ctx, opId) => {
      const msg = await post(ctx.alice.cookie, ctx.fx.channelId, 'delete me');
      return {
        method: 'DELETE',
        url: `/api/messages/${msg.id}`,
        headers: { cookie: ctx.alice.cookie },
        payload: { opId },
      };
    },
    effectCount: async () => countEvents("type = 'message.deleted'"),
  },
  {
    name: 'reaction.set',
    build: async (ctx, opId) => {
      const msg = await post(ctx.alice.cookie, ctx.fx.channelId, 'react');
      return {
        method: 'POST',
        url: `/api/messages/${msg.id}/reactions`,
        headers: { cookie: ctx.alice.cookie },
        payload: { emoji: '👍', action: 'add', opId },
      };
    },
    effectCount: async () => countEvents("type = 'reaction.added'"),
  },
  {
    name: 'session.spawn',
    build: async (ctx, opId) => ({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: ctx.alice.cookie },
      payload: {
        channelId: ctx.fx.channelId,
        task: 'chaos spawn',
        clientSpawnId: `pending:${opId}`,
        opId,
      },
    }),
    effectCount: async () => {
      const res = await pool.query(
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE client_spawn_id IS NOT NULL`,
      );
      return Number(res.rows[0].count);
    },
  },
  {
    name: 'session.answer',
    build: async (ctx, opId) => {
      const id = await insertRunningSession(ctx, true);
      return {
        method: 'POST',
        url: `/api/sessions/${id}/answer`,
        headers: { cookie: ctx.alice.cookie },
        payload: { questionId: 'q-main', answers: { choice: { answers: ['Fast'] } }, opId },
      };
    },
    effectCount: async () => countEvents("type = 'session.question_answered'"),
  },
  {
    name: 'session.cancel',
    build: async (ctx, opId) => {
      const id = await insertRunningSession(ctx, false);
      return {
        method: 'POST',
        url: `/api/sessions/${id}/cancel`,
        headers: { cookie: ctx.alice.cookie },
        payload: { opId },
      };
    },
    effectCount: async () => countEvents("type = 'session.status_changed' AND payload->>'status' = 'cancelled'"),
  },
  {
    name: 'mute.set',
    build: async (ctx, opId) => ({
      method: 'POST',
      url: `/api/channels/${ctx.fx.channelId}/mute`,
      headers: { cookie: ctx.alice.cookie },
      payload: { muted: true, opId },
    }),
    effectCount: async () => countRows('channel_mutes'),
  },
  {
    name: 'channel.member.add',
    build: async (ctx, opId) => {
      const { channel } = await createChannel(pool, {
        workspaceId: ctx.fx.workspaceId,
        name: `priv-${opId.slice(0, 8)}`,
        actorId: ctx.alice.user.id,
        private: true,
      });
      return {
        method: 'POST',
        url: `/api/channels/${channel.id}/members`,
        headers: { cookie: ctx.alice.cookie },
        payload: { userId: ctx.bob.user.id, opId },
      };
    },
    effectCount: async () => countEvents("type = 'channel.member_joined'"),
  },
  {
    name: 'channel.leave',
    build: async (ctx, opId) => {
      const { channel } = await createChannel(pool, {
        workspaceId: ctx.fx.workspaceId,
        name: `leave-${opId.slice(0, 8)}`,
        actorId: ctx.alice.user.id,
        private: true,
      });
      return {
        method: 'DELETE',
        url: `/api/channels/${channel.id}/members/me`,
        headers: { cookie: ctx.alice.cookie },
        payload: { opId },
      };
    },
    effectCount: async () => countEvents("type = 'channel.member_left'"),
  },
  {
    name: 'prefs.patch',
    build: async (ctx, opId) => ({
      method: 'PATCH',
      url: '/api/me/prefs',
      headers: { cookie: ctx.alice.cookie },
      payload: { theme: 'dark', opId },
    }),
    effectCount: async (ctx) => {
      const res = await pool.query(
        "SELECT COUNT(*) AS count FROM users WHERE id = $1 AND prefs->>'theme' = 'dark'",
        [ctx.alice.user.id],
      );
      return Number(res.rows[0].count);
    },
  },
  {
    name: 'read.mark',
    build: async (ctx, opId) => ({
      method: 'POST',
      url: `/api/channels/${ctx.fx.channelId}/read`,
      headers: { cookie: ctx.alice.cookie },
      payload: { lastReadEventId: 42, opId },
    }),
    effectCount: async () => countRows('channel_read_cursors'),
  },
];

describe('idempotent mutation chaos invariants', () => {
  const seed = chaosSeed();
  const rounds = Number(process.env.CHAOS_ROUNDS ?? 2);

  for (const op of registry) {
    it(`${op.name}: one effect and stable replayed response`, async () => {
      const rng = new SeededPrng(seed ^ hashName(op.name));
      try {
        for (let round = 0; round < rounds; round += 1) {
          const ctx = await resetRound();
          const request = await op.build(ctx, randomUUID());
          const responses = await chaosInject(app, request, rng);
          for (const response of responses) {
            expect(response.statusCode).toBeGreaterThanOrEqual(200);
            expect(response.statusCode).toBeLessThan(300);
          }
          const encoded = responses.map((response) => stableJson(response.body));
          expect(new Set(encoded).size).toBe(1);
          expect(await op.effectCount(ctx)).toBe(1);
          await settleBackground();
        }
      } catch (err) {
        throw new Error(`chaos op ${op.name} failed with seed ${seed}`, { cause: err });
      }
    });
  }
});

async function resetRound(): Promise<RoundContext> {
  await truncateAll(pool);
  const fx = await seedFixture(pool);
  const alice = await login('alice', 'Alice');
  const bob = await login('bob', 'Bob');
  return { fx, alice, bob };
}

async function login(handle: string, displayName: string): Promise<UserLogin> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName },
  });
  expect(res.statusCode).toBe(200);
  return { cookie: res.headers['set-cookie'] as string, user: res.json().user };
}

async function post(cookie: string, channelId: string, text: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { cookie },
    payload: { channelId, text, clientMsgId: randomUUID() },
  });
  expect(res.statusCode).toBe(201);
  return res.json().event as { id: number };
}

async function insertRunningSession(ctx: RoundContext, pendingQuestion: boolean): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO sessions (
       workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
       driver_id, current_execution_id, assignment_generation
     )
     VALUES ($1, $2, $3, 'claude-code', 'chaos session', 'running', $4, $4, 'exe_chaos', 1)
     RETURNING id`,
    [ctx.fx.workspaceId, ctx.fx.channelId, `thread-${randomUUID()}`, ctx.alice.user.id],
  );
  const id = inserted.rows[0]!.id;
  if (pendingQuestion) {
    await pool.query('UPDATE sessions SET pending_question = $1 WHERE id = $2', [
      JSON.stringify({
        questionId: 'q-main',
        turnId: 'turn-1',
        eventId: 1,
        questions: [
          {
            id: 'choice',
            header: 'Decision',
            question: 'Which path?',
            options: [
              { label: 'Fast', description: 'Smallest change' },
              { label: 'Careful', description: 'Full suite first' },
            ],
          },
        ],
      }),
      id,
    ]);
  }
  return id;
}

async function countEvents(where: string): Promise<number> {
  const res = await pool.query(`SELECT COUNT(*) AS count FROM events WHERE ${where}`);
  return Number(res.rows[0].count);
}

async function countRows(table: 'channel_mutes' | 'channel_read_cursors'): Promise<number> {
  const res = await pool.query(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(res.rows[0].count);
}

function hashName(name: string): number {
  let hash = 2166136261;
  for (const ch of name) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) out[key] = normalize(record[key]);
  return out;
}

function settleBackground(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}
