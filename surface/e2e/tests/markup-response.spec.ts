import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { channelId, createTestChannel, login, unique } from './helpers.js';

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';
const centaurStubUrl = `http://127.0.0.1:${Number(process.env.E2E_CENTAUR_PORT ?? 18100)}`;
const entryText = '# Plan\n\nThe rollout has three phases.\n\nDone.';

type TestMarkupEditorView = {
  state: {
    doc: {
      descendants(callback: (node: { isText: boolean; text?: string | null }, pos: number) => boolean | void): void;
    };
    selection: { constructor: { create(doc: unknown, from: number, to: number): unknown } };
    tr: { setSelection(selection: unknown): { scrollIntoView(): unknown } };
  };
  dispatch(transaction: unknown): void;
  focus(): void;
};

async function injectSession(args: {
  handle: string;
  channelId: string;
  title: string;
}): Promise<{ sessionId: string; threadKey: string }> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  const threadKey = `thread-${unique('markup')}`;
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
       VALUES ($1, $2, $3, 'codex', $4, 'running', $5, $5, 'exe_e2e_markup', 1)
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

async function seedAgentTextRecord(args: { sessionId: string; entryUid: string; itemId: string }): Promise<void> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  try {
    await pool.query(
      `INSERT INTO session_records
         (session_id, event_id, seq, entry_uid, kind, actor, driver, view_tier, text, meta, ts)
       VALUES ($1, 2, 1, $2, 'message', 'agent', 'codex', 'lean', $3, $4::jsonb, now())`,
      [args.sessionId, args.entryUid, entryText, JSON.stringify({ itemId: args.itemId, messageId: args.itemId })],
    );
  } finally {
    await pool.end();
  }
}

async function setMergeClass(artifactId: string, mergeClass: string): Promise<void> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  try {
    await pool.query('UPDATE artifacts SET merge_class = $2 WHERE id = $1', [artifactId, mergeClass]);
  } finally {
    await pool.end();
  }
}

function sseFrame(event: string, eventId: number, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ ...data, event_id: eventId })}\n\n`;
}

async function openMarkupSession(
  page: Page,
  prefix: string,
): Promise<{ sessionId: string; handle: string; threadKey: string }> {
  const room = await createTestChannel(prefix);
  const handle = unique(prefix);
  await login(page, handle, 'Markup Tester');
  const roomId = await channelId(page.context().request, room);
  const { sessionId, threadKey } = await injectSession({
    handle,
    channelId: roomId,
    title: unique('markup-session'),
  });
  const entryUid = `e2e-markup-${unique(prefix)}`;
  const entryHandle = `rec_${entryUid}`;
  const itemId = `agent-${unique(prefix)}`;
  await seedAgentTextRecord({ sessionId, entryUid, itemId });

  const stamp = new Date().toISOString();
  await page.route('**/api/sessions/*/stream*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body:
        sseFrame('execution_state', 1, {
          type: 'execution.state',
          status: 'running',
          thread_key: 'thread-e2e-markup',
          execution_id: 'exe_e2e_markup',
          atrium_ts: stamp,
        }) +
        sseFrame('amp_raw_event', 2, {
          type: 'item.completed',
          item: { id: itemId, type: 'agentMessage', text: entryText },
          recordHandles: [
            {
              handle: entryHandle,
              kind: 'message',
              actor: 'agent',
              meta: { itemId, messageId: itemId },
            },
          ],
          atrium_ts: stamp,
        }),
    });
  });

  await page.goto(`/s/${sessionId}`);
  await expect(page.getByText('The rollout has three phases.')).toBeVisible({ timeout: 15_000 });
  return { sessionId, handle: entryHandle, threadKey };
}

async function openMarkupPane(
  page: Page,
  handle: string,
): Promise<{
  artifactId: string;
  path: string;
  seq: number;
  workspaceId: string;
}> {
  const extractResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/api/entries/${encodeURIComponent(handle)}/extract`),
  );
  await page.getByText('The rollout has three phases.').hover();
  await page.getByRole('button', { name: 'Mark up & reply' }).click();
  const response = await extractResponse;
  expect(response.ok()).toBeTruthy();
  const extracted = (await response.json()) as {
    artifactId: string;
    path: string;
    seq: number;
    workspaceId: string;
  };
  await expect(page.getByRole('dialog', { name: 'Plan' })).toBeVisible();
  await expect(page.getByTestId('markup-editor')).toBeVisible();
  return extracted;
}

async function suggestReplacement(page: Page, from: string, to: string): Promise<void> {
  const suggest = page.getByRole('button', { name: 'Suggest edit' });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await selectWordInMarkupEditor(page, from);
    try {
      await expect(suggest).toBeVisible({ timeout: 5_000 });
      break;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  await suggest.click();
  await page.getByTestId('markup-replacement-input').fill(to);
  await page.getByRole('button', { name: 'Apply suggestion' }).click();
}

async function selectWordInMarkupEditor(page: Page, word: string): Promise<void> {
  const editor = page.getByTestId('markup-editor');
  await expect(editor).toBeVisible();
  await editor.scrollIntoViewIfNeeded();
  const selected = await editor.evaluate((root, target) => {
    const view = (root as HTMLElement & { __atriumMarkupEditorView?: TestMarkupEditorView }).__atriumMarkupEditorView;
    if (!view) return false;
    let from = -1;
    let to = -1;
    view.state.doc.descendants((node, pos) => {
      if (from >= 0) return false;
      if (!node.isText) return;
      const index = (node.text ?? '').indexOf(target);
      if (index < 0) return;
      from = pos + index;
      to = from + target.length;
      return false;
    });
    if (from < 0 || to < 0) return false;
    const selection = view.state.selection.constructor.create(view.state.doc, from, to);
    view.focus();
    view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
    return true;
  }, word);
  if (!selected) throw new Error(`word not found in markup editor: ${word}`);
}

async function centaurRequests(
  request: APIRequestContext,
): Promise<Array<{ method: string; path: string; body: unknown }>> {
  const response = await request.get(`${centaurStubUrl}/__requests`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Array<{ method: string; path: string; body: unknown }>;
}

function threadMessagePosts(
  requests: Array<{ method: string; path: string; body: unknown }>,
  threadKey: string,
): Array<{ method: string; path: string; body: unknown }> {
  return requests.filter(
    (entry) => entry.method === 'POST' && entry.path.includes(threadKey) && /\/messages$/.test(entry.path),
  );
}

function messageText(body: unknown): string {
  const parts = (body as { messages?: Array<{ parts?: Array<{ type?: unknown; text?: unknown }> }> }).messages?.[0]
    ?.parts;
  const text = parts?.find((part) => part.type === 'text' && typeof part.text === 'string')?.text;
  return typeof text === 'string' ? text : '';
}

test('marking up an agent transcript row sends CriticMarkup feedback to Centaur', async ({ page, request }) => {
  const { handle, threadKey } = await openMarkupSession(page, 'markup-loop');
  const extracted = await openMarkupPane(page, handle);

  await suggestReplacement(page, 'three', 'two');
  await page.getByLabel('Add a note').fill('Please adjust the rollout count.');
  await page.getByRole('button', { name: 'Send to agent' }).click();

  await expect(page.getByRole('dialog', { name: 'Plan' })).toBeHidden();
  await expect(page.getByText('Markup sent to agent')).toBeVisible();

  const requests = await centaurRequests(request);
  const messagePost = threadMessagePosts(requests, threadKey)[0];
  expect(messagePost).toBeTruthy();
  const steer = messageText(messagePost!.body);
  expect(steer).toContain('{~~three~>two~~}');
  expect(steer).toContain('CriticMarkup');
  expect(steer).toContain('This is my response to what you wrote');
  expect(
    requests.some(
      (entry) => entry.method === 'POST' && entry.path.includes(threadKey) && /\/execute$/.test(entry.path),
    ),
  ).toBeTruthy();

  const content = await page.request.get(`/api/files/artifact/${extracted.artifactId}/content?at=2`);
  expect(content.ok()).toBeTruthy();
  expect(content.headers()['x-artifact-seq']).toBe('2');
  expect(await content.text()).toContain('{~~three~>two~~}');

  const reextract = await openMarkupPane(page, handle);
  expect(reextract.artifactId).toBe(extracted.artifactId);
  expect(reextract.seq).toBe(2);
  await expect(page.getByRole('dialog', { name: 'Plan' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
});

test('stale markup base keeps the pane open and does not steer Centaur', async ({ page, request }) => {
  const { sessionId, handle, threadKey } = await openMarkupSession(page, 'markup-stale');
  const extracted = await openMarkupPane(page, handle);
  await suggestReplacement(page, 'three', 'two');

  // A clean concurrent edit would diff3-MERGE (mergeable-doc is the extract default,
  // by design), so force a hard stale_base: make the artifact merge-incapable, then
  // bump it to seq 2 out from under the open pane.
  await setMergeClass(extracted.artifactId, 'immutable-data');
  const baseContentResponse = await page.request.get(
    `/api/files/artifact/${extracted.artifactId}/content?at=${extracted.seq}`,
  );
  expect(baseContentResponse.ok()).toBeTruthy();
  const baseContent = await baseContentResponse.text();
  const bump = await page.request.post(`/api/files/${extracted.artifactId}/feedback`, {
    data: {
      content: `${baseContent}\n\nBackground bump.`,
      baseSeq: extracted.seq,
      sessionId,
      note: 'background bump',
      opId: randomUUID(),
    },
  });
  expect(bump.ok()).toBeTruthy();

  await page.getByRole('button', { name: 'Send to agent' }).click();
  await expect(page.getByRole('dialog', { name: 'Plan' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('This document changed since you started');

  const posts = threadMessagePosts(await centaurRequests(request), threadKey);
  // Exactly the background bump's steer; the stale 409 attempt must not have steered.
  expect(posts.length).toBe(1);
  expect(messageText(posts[0]!.body)).not.toContain('{~~three~>two~~}');
});
