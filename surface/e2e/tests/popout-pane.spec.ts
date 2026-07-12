// Lean session popout (/s/:id/pane): the full loop no unit test can cover —
// the standalone route renders the interactive pane with no app shell, folds
// the real SSE replay, reports presence over the real WS ("1 watching"), lights
// the unseen-output accent + the document.title ● and clears both on view, and
// steers Centaur over the direct REST path (popouts skip the offline op queue).

import { expect, test, type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import { channelId, createTestChannel, login, unique } from './helpers.js';

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';
const centaurStubUrl = `http://127.0.0.1:${Number(process.env.E2E_CENTAUR_PORT ?? 18100)}`;

/** Seed a running codex session driven by the logged-in user (composer enabled). */
async function injectSession(args: {
  handle: string;
  channelId: string;
  title: string;
}): Promise<{ sessionId: string; threadKey: string }> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  const threadKey = `thread-${unique('popout')}`;
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>('SELECT id FROM users WHERE handle = $1', [args.handle]);
    const channel = await client.query<{ workspace_id: string }>('SELECT workspace_id FROM channels WHERE id = $1', [
      args.channelId,
    ]);
    if (!user.rows[0] || !channel.rows[0]) throw new Error('missing e2e user or channel');
    const userId = user.rows[0].id;
    const workspaceId = channel.rows[0].workspace_id;
    const session = await client.query<{ id: string }>(
      `INSERT INTO sessions (
         workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
         driver_id, current_execution_id, assignment_generation
       )
       VALUES ($1, $2, $3, 'codex', $4, 'running', $5, $5, 'exe_e2e_popout', 1)
       RETURNING id`,
      [workspaceId, args.channelId, threadKey, args.title, userId],
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
        JSON.stringify({ sessionId, title: args.title, harness: 'codex', by: userId }),
      ],
    );
    await client.query('UPDATE sessions SET thread_root_event_id = $1 WHERE id = $2', [
      Number(root.rows[0]!.id),
      sessionId,
    ]);
    await client.query('COMMIT');
    return { sessionId, threadKey };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

function sseFrame(event: string, eventId: number, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ ...data, event_id: eventId })}\n\n`;
}

async function centaurRequests(
  request: APIRequestContext,
): Promise<Array<{ method: string; path: string; body: unknown }>> {
  const response = await request.get(`${centaurStubUrl}/__requests`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Array<{ method: string; path: string; body: unknown }>;
}

function messageText(body: unknown): string {
  const parts = (body as { messages?: Array<{ parts?: Array<{ type?: unknown; text?: unknown }> }> }).messages?.[0]
    ?.parts;
  const text = parts?.find((part) => part.type === 'text' && typeof part.text === 'string')?.text;
  return typeof text === 'string' ? text : '';
}

test('popout renders the lean pane, folds the stream, tracks unseen output, and steers Centaur', async ({
  page,
  request,
}) => {
  const room = await createTestChannel('popout');
  const handle = unique('popout');
  await login(page, handle, 'Popout Tester');
  const roomId = await channelId(page.context().request, room);
  const { sessionId, threadKey } = await injectSession({
    handle,
    channelId: roomId,
    title: unique('popout-session'),
  });

  const stamp = new Date().toISOString();
  await page.route('**/api/sessions/*/stream*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body:
        sseFrame('execution_state', 1, {
          type: 'execution.state',
          status: 'running',
          thread_key: threadKey,
          execution_id: 'exe_e2e_popout',
          atrium_ts: stamp,
        }) +
        sseFrame('amp_raw_event', 2, {
          type: 'item.completed',
          item: {
            id: 'steer-1',
            type: 'userMessage',
            content: [{ type: 'text', text: 'please fix the parser' }],
          },
          atrium_ts: stamp,
        }) +
        sseFrame('artifact.captured', 3, {
          type: 'artifact.captured',
          artifact_id: 'art-popout',
          path: '/home/agent/workspace/out/report.csv',
          kind: 'created',
          mime: 'text/csv',
          size_bytes: 3120,
          sha256: 'art-popout',
          ref: 'blob-popout',
          atrium_ts: stamp,
        }),
    });
  });

  await page.goto(`/s/${sessionId}/pane`);

  // Lean standalone page: pane content, no channel shell around it.
  await expect(page.getByTestId('session-pane-page')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('user-steer')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Channels', { exact: true })).toHaveCount(0);
  const fullApp = page.getByRole('link', { name: 'Open in full app' });
  await expect(fullApp).toHaveAttribute('href', `/s/${sessionId}`);

  // Presence over the real WS: this popout counts as a watcher.
  await expect(page.getByText('1 watching')).toBeVisible({ timeout: 15_000 });

  // The replayed artifact frame is unseen output: strip accent + title ●.
  await expect(page.getByTestId('artifacts-strip')).toBeVisible();
  await expect(page).toHaveTitle(/^● .+ · running$/);
  await page.getByTestId('artifacts-strip').click();
  await expect(page).toHaveTitle(/^(?!● ).+ · running$/);

  // Steer over the direct REST path; the real server forwards to Centaur.
  const steerText = unique('popout-steer-check');
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes(`/api/sessions/${sessionId}/messages`),
  );
  await page.getByPlaceholder(/Steer the agent/).fill(steerText);
  await page.keyboard.press('Enter');
  expect((await accepted).status()).toBe(202);

  await expect
    .poll(
      async () => {
        const requests = await centaurRequests(request);
        return requests.some(
          (entry) =>
            entry.method === 'POST' &&
            entry.path.includes(threadKey) &&
            /\/messages$/.test(entry.path) &&
            messageText(entry.body).includes(steerText),
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);
});

test('popout stop turn forwards an interrupt without cancelling the session', async ({ page, request }) => {
  const room = await createTestChannel('popout-stop');
  const handle = unique('popout-stop');
  await login(page, handle, 'Popout Stop Tester');
  const roomId = await channelId(page.context().request, room);
  const { sessionId, threadKey } = await injectSession({
    handle,
    channelId: roomId,
    title: unique('popout-stop-session'),
  });

  await request.delete(`${centaurStubUrl}/__requests`);
  const stamp = new Date().toISOString();
  await page.route('**/api/sessions/*/stream*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: sseFrame('execution_state', 1, {
        type: 'execution.state',
        status: 'running',
        thread_key: threadKey,
        execution_id: 'exe_e2e_popout_stop',
        atrium_ts: stamp,
      }),
    });
  });

  await page.goto(`/s/${sessionId}/pane`);
  await expect(page.getByTestId('session-pane-page')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByPlaceholder(/Steer the agent/)).toBeVisible({ timeout: 15_000 });

  const stopAccepted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes(`/api/sessions/${sessionId}/stop-turn`),
  );
  await page.getByRole('button', { name: 'Stop turn' }).first().click();
  expect((await stopAccepted).status()).toBe(202);

  await expect
    .poll(
      async () => {
        const requests = await centaurRequests(request);
        return requests.some(
          (entry) =>
            entry.method === 'POST' && entry.path === `/api/session/${encodeURIComponent(threadKey)}/interrupt`,
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  await expect(page.getByPlaceholder(/Steer the agent/)).toBeVisible();
});
