import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { addWorkspaceMember } from '../src/membership.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;
const uploaded = new Map<string, { body: Buffer | Uint8Array; contentType: string }>();
const deleted: string[] = [];

const fileStorage = {
  ensureBucket: async () => {},
  deleteObject: async (key: string) => {
    deleted.push(key);
    uploaded.delete(key);
  },
  uploadObject: async (key: string, body: Buffer | Uint8Array, contentType: string) => {
    uploaded.set(key, { body, contentType });
  },
  presignPut: async (key: string) => `https://storage.local/put/${encodeURIComponent(key)}`,
  presignGet: async (key: string) => `https://storage.local/get/${encodeURIComponent(key)}`,
};

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  uploaded.clear();
  deleted.length = 0;
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({
    pool,
    fileStorage,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function login(handle: string, displayName = handle) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName },
  });
  expect(res.statusCode).toBe(200);
  return { cookie: res.headers['set-cookie'] as string, user: res.json().user };
}

async function samplePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 40,
      height: 20,
      channels: 3,
      background: '#2f8f83',
    },
  })
    .png()
    .toBuffer();
}

describe('profile avatars', () => {
  it('normalizes an uploaded image and exposes it on workspace-scoped user refs', async () => {
    const { cookie, user } = await login('alice', 'Alice');
    const image = await samplePng();

    const upload = await app.inject({
      method: 'PUT',
      url: '/api/me/avatar',
      headers: { cookie, 'content-type': 'image/png' },
      payload: image,
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.json()).toMatchObject({ avatarVersion: 1 });
    expect(upload.json().avatarUrl).toBe(`/api/users/${user.id}/avatar?v=1`);
    expect(uploaded.size).toBe(1);
    const object = [...uploaded.values()][0]!;
    expect(object.contentType).toBe('image/webp');
    const meta = await sharp(object.body).metadata();
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);

    const users = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie } });
    expect(users.statusCode).toBe(200);
    const alice = users.json().users.find((candidate: { id: string }) => candidate.id === user.id);
    expect(alice).toMatchObject({ avatarUrl: `/api/users/${user.id}/avatar?v=1`, avatarVersion: 1 });

    const avatar = await app.inject({ method: 'GET', url: `/api/users/${user.id}/avatar?v=1`, headers: { cookie } });
    expect(avatar.statusCode).toBe(302);
    expect(avatar.headers.location).toContain('/get/avatars%2F');
  });

  it('rejects undecodable images before storing metadata', async () => {
    const { cookie, user } = await login('alice', 'Alice');
    const upload = await app.inject({
      method: 'PUT',
      url: '/api/me/avatar',
      headers: { cookie, 'content-type': 'image/png' },
      payload: Buffer.from('not an image'),
    });
    expect(upload.statusCode).toBe(400);
    expect(upload.json().error).toBe('invalid_image');
    expect(uploaded.size).toBe(0);
    const row = await pool.query('SELECT avatar_s3_key FROM users WHERE id = $1', [user.id]);
    expect(row.rows[0]!.avatar_s3_key).toBeNull();
  });

  it('deletes avatars and hides avatars for users outside shared workspaces', async () => {
    const { cookie, user } = await login('alice', 'Alice');
    const upload = await app.inject({
      method: 'PUT',
      url: '/api/me/avatar',
      headers: { cookie, 'content-type': 'image/png' },
      payload: await samplePng(),
    });
    expect(upload.statusCode).toBe(200);

    const outsider = await pool.query<{ id: string }>(
      `INSERT INTO users (handle, display_name) VALUES ('outsider', 'Outsider') RETURNING id`,
    );
    const outsiderLogin = await login('outsider', 'Outsider');
    await pool.query('DELETE FROM workspace_members WHERE user_id = $1', [outsider.rows[0]!.id]);
    const hidden = await app.inject({
      method: 'GET',
      url: `/api/users/${user.id}/avatar?v=1`,
      headers: { cookie: outsiderLogin.cookie },
    });
    expect(hidden.statusCode).toBe(404);

    await addWorkspaceMember(pool, fx.workspaceId, outsider.rows[0]!.id);
    const visible = await app.inject({
      method: 'GET',
      url: `/api/users/${user.id}/avatar?v=1`,
      headers: { cookie: outsiderLogin.cookie },
    });
    expect(visible.statusCode).toBe(302);

    const remove = await app.inject({ method: 'DELETE', url: '/api/me/avatar', headers: { cookie } });
    expect(remove.statusCode).toBe(200);
    expect(remove.json()).toEqual({ avatarUrl: null, avatarVersion: 2 });
    expect(deleted.length).toBe(1);
    const gone = await app.inject({ method: 'GET', url: `/api/users/${user.id}/avatar?v=2`, headers: { cookie } });
    expect(gone.statusCode).toBe(404);
  });
});
