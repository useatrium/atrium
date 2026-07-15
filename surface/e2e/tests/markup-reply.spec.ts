import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { Pool } from 'pg';
import {
  channelId,
  createTestChannel,
  login,
  mainComposer,
  messageRow,
  openChannel,
  seedEvent,
  unique,
} from './helpers.js';

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';
const centaurStubUrl = `http://127.0.0.1:${Number(process.env.E2E_CENTAUR_PORT ?? 18100)}`;

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
  const threadKey = `thread-${unique('markup-reply')}`;
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
       VALUES ($1, $2, $3, 'codex', $4, 'running', $5, $5, 'exe_e2e_markup_reply', 1)
       RETURNING id`,
      [workspaceId, args.channelId, threadKey, args.title, userId],
    );
    const sessionId = session.rows[0]!.id;
    const rootId = await seedEvent(client, {
      workspaceId,
      channelId: args.channelId,
      type: 'session.spawned',
      actorId: userId,
      payload: { sessionId, title: args.title, harness: 'codex', by: userId },
    });
    await client.query('UPDATE sessions SET thread_root_event_id = $1 WHERE id = $2', [rootId, sessionId]);
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

async function postMultipartMessage(page: Page, channelName: string, text: string): Promise<void> {
  await mainComposer(page, channelName).fill(text);
  await mainComposer(page, channelName).press('Enter');
  await expect(messageRow(page, text.split('\n')[0]!)).toBeVisible();
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

async function latestSeq(request: APIRequestContext, artifactId: string): Promise<number> {
  const response = await request.get(`/api/files/${artifactId}/versions`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { versions: Array<{ seq: number; isLatest: boolean }> };
  const latest = body.versions.find((version) => version.isLatest) ?? body.versions[0];
  expect(latest).toBeTruthy();
  return latest!.seq;
}

function artifactIdFromHref(href: string): string {
  const match = /\/e\/art_([0-9a-f-]{36})/i.exec(href);
  if (!match) throw new Error(`artifact link did not contain an art_ handle: ${href}`);
  return match[1]!;
}

test('markup reply creates a thread card and can apply the markup with an agent', async ({ page, request }) => {
  const room = await createTestChannel('markup-reply');
  const handle = unique('markup-replier');
  await login(page, handle, 'Markup Replier');
  await openChannel(page, room);
  const roomId = await channelId(page.context().request, room);
  const sessionTitle = unique('markup-apply-session');
  const { threadKey } = await injectSession({ handle, channelId: roomId, title: sessionTitle });
  // Reload so the channel state (sessions list) includes the seeded session.
  await page.reload();
  await openChannel(page, room);

  const source = [
    `Round C source ${unique('message')}`,
    '',
    'The launch plan keeps the careful wording.',
    '',
    'Second paragraph for a real markdown extract.',
  ].join('\n');
  await postMultipartMessage(page, room, source);

  const row = messageRow(page, 'The launch plan keeps the careful wording.');
  await row.hover();
  const extractResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && /\/api\/entries\/[^/]+\/extract$/.test(response.url()),
  );
  const markupButton =
    (await row.getByTestId('markup-reply').count()) > 0
      ? row.getByTestId('markup-reply')
      : row.getByRole('button', { name: 'Mark up & reply' });
  await markupButton.click({ force: true });
  const extracted = (await (await extractResponse).json()) as {
    artifactId: string;
    path: string;
    seq: number;
    workspaceId: string;
  };

  await expect(page.getByTestId('markup-editor')).toBeVisible();
  await suggestReplacement(page, 'careful', 'direct');
  await page.getByRole('dialog', { name: /./ }).getByRole('button', { name: 'Reply in thread' }).click();

  // The thread panel no longer has a generic "Thread" heading — its heading is
  // the conversation's identity (the attached session, or the root message's
  // author). Identify the panel by the control that only it has.
  const threadPanel = page
    .getByRole('complementary')
    .filter({ has: page.getByRole('button', { name: 'Close thread' }) });
  await expect(threadPanel.locator('a[href*="/e/art_"]').first()).toBeVisible();
  const artifactLink = threadPanel.locator('a[href*="/e/art_"]').first();
  const href = await artifactLink.getAttribute('href');
  expect(href).toBeTruthy();
  const artifactId = artifactIdFromHref(href!);
  expect(artifactId).toBe(extracted.artifactId);
  // The card renders the tracked change itself: struck deletion + underlined insertion.
  await expect(threadPanel.locator('.atrium-critic-view-del', { hasText: 'careful' })).toBeVisible();
  await expect(threadPanel.locator('.atrium-critic-view-ins', { hasText: 'direct' })).toBeVisible();
  // The reply surfaces as the root's annotation cluster (latest reply +
  // "Open thread →") — the bare reply-count button is gone.
  await expect(row.getByRole('button', { name: 'Open thread →' })).toBeVisible();

  const seqBeforeApply = await latestSeq(page.request, artifactId);
  // extract = v1; the reply committed the markup as exactly one new version.
  expect(seqBeforeApply).toBe(extracted.seq + 1);

  await threadPanel.getByRole('button', { name: 'Apply with agent' }).click();
  await page.getByRole('menuitem', { name: new RegExp(sessionTitle) }).click();

  await expect.poll(async () => threadMessagePosts(await centaurRequests(request), threadKey).length).toBe(1);
  const post = threadMessagePosts(await centaurRequests(request), threadKey)[0];
  expect(post).toBeTruthy();
  const steer = messageText(post!.body);
  expect(steer).toContain('The file in your workspace already has my markup');
  expect(steer).toContain('Please apply the edits, address the comments');
  expect(steer).toContain('{~~careful~>direct~~}');
  expect(await latestSeq(page.request, artifactId)).toBe(seqBeforeApply);
});
