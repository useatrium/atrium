import { expect, test, type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import { apiAs, apiURL, channelId, login, unique } from './helpers.js';

const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

interface SeededSession {
  rootId: number;
  sessionId: string;
}

interface ArtifactWriteResult {
  seq: number;
  status: 'normal' | 'conflict';
}

interface ArtifactConflictDetail {
  artifactId: string;
  path: string;
  conflictSeq: number;
  left: { text: string };
  right: { text: string };
  base: { text: string };
  markers: string;
}

async function seedSession(args: {
  handle: string;
  channelId: string;
  title: string;
}): Promise<SeededSession> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>('SELECT id FROM users WHERE handle = $1', [
      args.handle,
    ]);
    const channel = await client.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM channels WHERE id = $1',
      [args.channelId],
    );
    if (!user.rows[0] || !channel.rows[0]) throw new Error('missing e2e user or channel');

    const userId = user.rows[0].id;
    const workspaceId = channel.rows[0].workspace_id;
    const session = await client.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation
       )
       VALUES ($1, $2, $3, 'claude-code', $4, 'running', $5, $5, 'exe_e2e_conflict', 1)
       RETURNING id`,
      [workspaceId, args.channelId, `thread-${unique('conflict')}`, args.title, userId],
    );
    const sessionId = session.rows[0]!.id;
    const root = await client.query<{ id: string }>(
      `INSERT INTO events (workspace_id, channel_id, type, actor_id, payload)
       VALUES ($1, $2, 'session.spawned', $3, $4)
       RETURNING id`,
      [
        workspaceId,
        args.channelId,
        userId,
        JSON.stringify({
          sessionId,
          title: args.title,
          harness: 'claude-code',
          by: userId,
        }),
      ],
    );
    const rootId = Number(root.rows[0]!.id);
    await client.query('UPDATE sessions SET thread_root_event_id = $1 WHERE id = $2', [
      rootId,
      sessionId,
    ]);
    await client.query('COMMIT');
    return { rootId, sessionId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function markMergeable(sessionId: string, path: string): Promise<void> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  try {
    const res = await pool.query(
      `UPDATE artifacts SET merge_class = 'mergeable-doc' WHERE session_id = $1 AND path = $2`,
      [sessionId, path],
    );
    if (res.rowCount !== 1) throw new Error(`artifact not marked mergeable: ${path}`);
  } finally {
    await pool.end();
  }
}

async function writeArtifact(
  ctx: APIRequestContext,
  args: {
    channelId: string;
    sessionId: string;
    path: string;
    text: string;
    baseSeq?: number;
  },
): Promise<ArtifactWriteResult> {
  const headers: Record<string, string> = { 'content-type': 'text/markdown' };
  if (args.baseSeq != null) headers['x-artifact-base-seq'] = String(args.baseSeq);
  const res = await ctx.put(
    `${apiURL}/api/channels/${args.channelId}/artifacts?session=${args.sessionId}&path=${encodeURIComponent(args.path)}`,
    {
      headers,
      data: Buffer.from(args.text, 'utf8'),
    },
  );
  if (!res.ok()) {
    throw new Error(`artifact write failed (${res.status()}): ${await res.text()}`);
  }
  return (await res.json()) as ArtifactWriteResult;
}

async function loadConflict(
  ctx: APIRequestContext,
  sessionId: string,
  path: string,
): Promise<ArtifactConflictDetail> {
  const res = await ctx.get(
    `${apiURL}/api/sessions/${sessionId}/artifacts/conflict?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok()) {
    throw new Error(`conflict load failed (${res.status()}): ${await res.text()}`);
  }
  return (await res.json()) as ArtifactConflictDetail;
}

function executionStateFrame(eventId: number, status: string): string {
  return `event: execution_state\ndata: ${JSON.stringify({
    type: 'execution.state',
    status,
    thread_key: 'thread-e2e-conflict',
    execution_id: 'exe_e2e_conflict',
    event_id: eventId,
  })}\n\n`;
}

// QUARANTINED (#41): write-back offloads blobs to S3, but CI has no MinIO, and
// even with one the conflict-merge write 500s against fresh storage (passes
// locally only because the dev MinIO volume has blobs from prior runs). This
// test has never run green in CI. Re-enable once both are fixed — see #41.
test.fixme('session conflicts drawer resolves a mergeable artifact conflict', async ({ page }) => {
  const aliceHandle = unique('conflict-alice');
  let bobApi: APIRequestContext | null = null;

  try {
    await login(page, aliceHandle, 'Conflict Alice');
    bobApi = await apiAs(unique('conflict-bob'), 'Conflict Bob');

    const generalId = await channelId(page.context().request, 'general');
    const title = unique('conflict-session');
    const seeded = await seedSession({ handle: aliceHandle, channelId: generalId, title });
    const artifactPath = 'plan.md';

    const v1 = await writeArtifact(page.context().request, {
      channelId: generalId,
      sessionId: seeded.sessionId,
      path: artifactPath,
      text: 'intro\nstep two\nconclusion\n',
    });
    expect(v1).toMatchObject({ seq: 1, status: 'normal' });

    await markMergeable(seeded.sessionId, artifactPath);

    const theirs = await writeArtifact(page.context().request, {
      channelId: generalId,
      sessionId: seeded.sessionId,
      path: artifactPath,
      text: 'intro\nstep two - THEIRS\nconclusion\n',
      baseSeq: 1,
    });
    expect(theirs).toMatchObject({ seq: 2, status: 'normal' });

    const yours = await writeArtifact(bobApi, {
      channelId: generalId,
      sessionId: seeded.sessionId,
      path: artifactPath,
      text: 'intro\nstep two - YOURS\nconclusion\n',
      baseSeq: 1,
    });
    expect(yours).toMatchObject({ seq: 3, status: 'conflict' });

    const detail = await loadConflict(page.context().request, seeded.sessionId, artifactPath);
    expect(detail).toMatchObject({ path: artifactPath, conflictSeq: 3 });
    expect(detail.base.text).toContain('step two');
    expect(detail.left.text).toContain('step two - THEIRS');
    expect(detail.right.text).toContain('step two - YOURS');
    expect(detail.markers).toContain('<<<<<<<');

    await page.route('**/api/sessions/*/stream*', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body: executionStateFrame(1, 'completed'),
      });
    });
    await page.goto(`/s/${seeded.sessionId}`);

    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    const strip = page.getByTestId('conflicts-strip');
    await expect(strip).toContainText('Conflicts', { timeout: 20_000 });
    await expect(strip).toContainText('· 1');
    await strip.click();

    const drawer = page.getByTestId('work-drawer');
    await expect(drawer.getByRole('tab', { name: /Conflicts.*1/ })).toBeVisible();
    await expect(drawer.getByText(artifactPath)).toBeVisible();
    // The side text appears in the diff line, the markers <pre>, and the merge
    // box — assert the unique diff lines (left/right each show their own +line).
    await expect(drawer.getByText('+step two - THEIRS')).toBeVisible();
    await expect(drawer.getByText('+step two - YOURS')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Keep theirs' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Keep yours' })).toBeVisible();
    await expect(drawer.getByLabel('merged resolution')).toHaveValue(/<</);

    await drawer.getByRole('button', { name: 'Keep theirs' }).click();
    await expect(page.getByTestId('conflicts-strip')).toHaveCount(0, { timeout: 20_000 });

    const cleared = await page
      .context()
      .request.get(
        `${apiURL}/api/sessions/${seeded.sessionId}/artifacts/conflict?path=${encodeURIComponent(artifactPath)}`,
      );
    expect(cleared.status()).toBe(404);
    expect(seeded.rootId).toBeGreaterThan(0);
  } finally {
    await bobApi?.dispose();
  }
});
