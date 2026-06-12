import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import {
  apiAs,
  channelId,
  confirmedRowsWithText,
  createChannel,
  expectRead,
  expectUnread,
  login,
  mainComposer,
  messageId,
  messageRow,
  openChannel,
  postMessage,
  sendMessage,
  timelineText,
  unique,
  warmOfflineShell,
} from './helpers.js';

const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

const questionPrompts = [
  {
    id: 'choice',
    header: 'Decision',
    question: 'Which deployment path should I take?',
    options: [
      { label: 'Fast', description: 'Ship the smallest change' },
      { label: 'Careful', description: 'Run the full suite first' },
    ],
  },
];

async function injectQuestionRequested(args: {
  handle: string;
  channelId: string;
  title: string;
}): Promise<{ rootId: number; sessionId: string; questionText: string }> {
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
       VALUES ($1, $2, $3, 'claude-code', $4, 'running', $5, $5, 'exe_e2e_question', 1)
       RETURNING id`,
      [workspaceId, args.channelId, `thread-${unique('question')}`, args.title, userId],
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
    const pendingQuestion = {
      questionId: 'q-main',
      turnId: 'turn-1',
      eventId: 1,
      questions: questionPrompts,
    };
    await client.query(
      `UPDATE sessions
       SET thread_root_event_id = $1,
           pending_question = $2,
           last_event_id = GREATEST(last_event_id, $3)
       WHERE id = $4`,
      [rootId, JSON.stringify(pendingQuestion), pendingQuestion.eventId, sessionId],
    );
    await client.query(
      `INSERT INTO events (workspace_id, channel_id, thread_root_event_id, type, actor_id, payload)
       VALUES ($1, $2, $3, 'session.question_requested', $4, $5)`,
      [
        workspaceId,
        args.channelId,
        rootId,
        userId,
        JSON.stringify({
          sessionId,
          questionId: pendingQuestion.questionId,
          questions: questionPrompts,
          permalink: `/s/${sessionId}`,
        }),
      ],
    );
    await client.query('COMMIT');
    return { rootId, sessionId, questionText: questionPrompts[0]!.question };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

test('login lands in #general; sent message appears', async ({ page }) => {
  await login(page, unique('alice'), 'Alice');

  const text = unique('hello-general');
  await sendMessage(page, text);
});

test('realtime: bob sees alice message appear without reload', async ({ browser }) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const alicePage = await alice.newPage();
  const bobPage = await bob.newPage();
  await login(alicePage, unique('alice'), 'Alice');
  await login(bobPage, unique('bob'), 'Bob');

  const text = unique('realtime');
  await sendMessage(alicePage, text);
  await expect(bobPage.getByText(text, { exact: true })).toBeVisible();

  await alice.close();
  await bob.close();
});

test('thread: reply in thread; root shows reply count', async ({ page }) => {
  await login(page, unique('threader'), 'Threader');
  const root = unique('thread-root');
  const reply = unique('thread-reply');
  await sendMessage(page, root);

  const row = messageRow(page, root);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByLabel('Reply in thread').click({ force: true });
  await expect(page.getByPlaceholder('Reply…')).toBeVisible();
  await page.getByPlaceholder('Reply…').fill(reply);
  await page.getByPlaceholder('Reply…').press('Enter');

  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  await page.getByLabel('Close thread').click();
  await expect(page.getByRole('button', { name: '1 reply →' })).toBeVisible();
});

test('reactions: toggle a reaction, chip count updates', async ({ page }) => {
  await login(page, unique('reactor'), 'Reactor');
  const text = unique('reactable');
  await sendMessage(page, text);

  const id = await messageId(page, text);
  const add = await page.context().request.post(`/api/messages/${id}/reactions`, {
    data: { emoji: '👍', action: 'add' },
  });
  expect(add.ok()).toBeTruthy();
  // Scope to this message's row — a retry can leave a prior 👍 chip in #general.
  const row = messageRow(page, text);
  await expect(row.getByRole('button', { name: '👍 1, including you' })).toBeVisible();

  await row.getByRole('button', { name: '👍 1, including you' }).click();
  await expect(row.getByRole('button', { name: /👍 1/ })).toHaveCount(0);
});

test('edit and delete own message', async ({ page }) => {
  await login(page, unique('editor'), 'Editor');
  const original = unique('edit-me');
  const edited = unique('edited');
  await sendMessage(page, original);

  const row = messageRow(page, original);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByLabel('Edit message').click({ force: true });
  await page.getByLabel('Edit message text').fill(edited);
  await page.getByLabel('Edit message text').press('Enter');
  // No exact-text match here: the message body element also contains the
  // "(edited)"/"(saving edit)" marker span, so an exact match never resolves.
  const editedRow = messageRow(page, edited);
  await expect(editedRow).toBeVisible();
  // Scope to this message's row: a retry leaves the previous attempt's edited
  // message in #general, so a page-wide '(edited)' match goes strict-mode.
  await expect(editedRow.getByText('(edited)')).toBeVisible();

  const id = await messageId(page, edited);
  await expect(editedRow.getByLabel('Delete message')).toBeAttached();
  const del = await page.context().request.delete(`/api/messages/${id}`);
  expect(del.ok()).toBeTruthy();
  await expect(page.getByText(edited, { exact: true })).toHaveCount(0);
});

test('unread badge: alice posts in a second channel; bob opens it and badge clears', async ({
  browser,
}) => {
  const setup = await apiAs(unique('setup'), 'Setup');
  const second = unique('room').replace(/_/g, '-');
  await createChannel(setup, second);
  await setup.dispose();

  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const alicePage = await alice.newPage();
  const bobPage = await bob.newPage();
  await login(alicePage, unique('alice'), 'Alice');
  await login(bobPage, unique('bob'), 'Bob');

  await openChannel(alicePage, second);
  await sendMessage(alicePage, unique('unread'), second);

  await expectUnread(bobPage, second);
  await openChannel(bobPage, second);
  await expectRead(bobPage, second);

  await alice.close();
  await bob.close();
});

test('cross-device read sync: reading in one context clears badge in the other', async ({
  browser,
}) => {
  const setup = await apiAs(unique('setup'), 'Setup');
  const second = unique('sync-room').replace(/_/g, '-');
  await createChannel(setup, second);
  await setup.dispose();

  const alice = await browser.newContext();
  const bobOne = await browser.newContext();
  const bobTwo = await browser.newContext();
  const alicePage = await alice.newPage();
  const bobOnePage = await bobOne.newPage();
  const bobTwoPage = await bobTwo.newPage();
  const bobHandle = unique('bob');

  await login(alicePage, unique('alice'), 'Alice');
  await login(bobOnePage, bobHandle, 'Bob');
  await login(bobTwoPage, bobHandle, 'Bob');

  await openChannel(alicePage, second);
  await sendMessage(alicePage, unique('sync-unread'), second);
  // Both devices show unread (live event, or deterministically via reload).
  await expectUnread(bobOnePage, second);
  await expectUnread(bobTwoPage, second);

  // Reading on one device advances the server cursor; the other device clears
  // its badge (live `read` frame, or via reload).
  await openChannel(bobOnePage, second);
  await expectRead(bobOnePage, second);
  await expectRead(bobTwoPage, second);

  await alice.close();
  await bobOne.close();
  await bobTwo.close();
});

test('search (⌘K): find an old message and jump to it', async ({ page }) => {
  const handle = unique('searcher');
  const api = await apiAs(handle, 'Searcher');
  const general = await channelId(api, 'general');
  const old = unique('ancient-search-token');
  await postMessage(api, general, old);
  for (let i = 0; i < 55; i += 1) {
    await postMessage(api, general, `${unique('newer-search-filler')} ${i}`);
  }
  await api.dispose();

  await login(page, handle, 'Searcher');
  await expect(page.getByText(old, { exact: true })).toHaveCount(0);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.getByLabel('Channel and message search').fill(old);
  await expect(page.getByRole('listbox', { name: 'Search results' }).getByText(old)).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByText(old, { exact: true })).toBeVisible();
});

test('offline send survives reload and confirms once', async ({ page, context }) => {
  await login(page, unique('offline-sender'), 'Offline Sender');
  await warmOfflineShell(page);

  const text = unique('offline-survives');
  await context.setOffline(true);
  await mainComposer(page).fill(text);
  await mainComposer(page).press('Enter');
  await expect(timelineText(page, text)).toBeVisible();
  await expect(confirmedRowsWithText(page, text)).toHaveCount(0);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(timelineText(page, text)).toBeVisible();
  await expect(confirmedRowsWithText(page, text)).toHaveCount(0);

  await context.setOffline(false);
  await expect(page.getByRole('status', { name: 'connection: open' })).toBeVisible({ timeout: 15_000 });
  await expect(confirmedRowsWithText(page, text)).toHaveCount(1, { timeout: 15_000 });
  await expect(timelineText(page, text)).toHaveCount(1);
});

test('lost POST response retries with same client id and confirms once', async ({ page }) => {
  await login(page, unique('lost-response'), 'Lost Response');

  let dropped = false;
  let droppedStatus: number | null = null;
  await page.route('**/api/messages', async (route) => {
    if (!dropped && route.request().method() === 'POST') {
      dropped = true;
      const response = await route.fetch();
      droppedStatus = response.status();
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  const text = unique('lost-response');
  await sendMessage(page, text);

  await expect(confirmedRowsWithText(page, text)).toHaveCount(1, { timeout: 15_000 });
  await expect(timelineText(page, text)).toHaveCount(1);
  expect(dropped).toBe(true);
  expect(droppedStatus).toBeGreaterThanOrEqual(200);
  expect(droppedStatus).toBeLessThan(300);

  await page.unroute('**/api/messages');
});

test('offline edit and reaction land and survive reload', async ({ page, context }) => {
  await login(page, unique('offline-editor'), 'Offline Editor');
  const original = unique('offline-edit-original');
  const edited = unique('offline-edit-final');
  await sendMessage(page, original);

  await context.setOffline(true);
  const originalRow = messageRow(page, original);
  await originalRow.scrollIntoViewIfNeeded();
  await originalRow.hover();
  await originalRow.getByLabel('Edit message').click({ force: true });
  await page.getByLabel('Edit message text').fill(edited);
  await page.getByLabel('Edit message text').press('Enter');
  await expect(messageRow(page, edited)).toBeVisible();
  await expect(page.getByText('(saving edit)')).toBeVisible();

  const editedRow = messageRow(page, edited);
  await editedRow.hover();
  await editedRow.getByLabel('Add reaction').click({ force: true });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '👍 1, including you' })).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByRole('status', { name: 'connection: open' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('(saving edit)')).toHaveCount(0, { timeout: 15_000 });
  await expect(confirmedRowsWithText(page, edited)).toHaveCount(1);
  await expect(page.getByRole('button', { name: '👍 1, including you' })).toBeVisible();

  await page.reload();
  await expect(confirmedRowsWithText(page, edited)).toHaveCount(1);
  await expect(page.getByRole('button', { name: '👍 1, including you' })).toBeVisible();
  await expect(timelineText(page, original)).toHaveCount(0);
});

test('disconnect burst heals through sync without reload', async ({ browser }) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const alicePage = await alice.newPage();
  const bobPage = await bob.newPage();
  await login(alicePage, unique('oba'), 'Offline Burst Alice');
  await login(bobPage, unique('obb'), 'Offline Burst Bob');

  await alice.setOffline(true);
  const first = unique('burst-first');
  const editedFirst = unique('burst-first-edited');
  const second = unique('burst-second');
  await sendMessage(bobPage, first);
  const firstId = await messageId(bobPage, first);
  const edit = await bobPage.context().request.patch(`/api/messages/${firstId}`, {
    data: { text: editedFirst },
  });
  expect(edit.ok()).toBeTruthy();
  await sendMessage(bobPage, second);
  await expect(messageRow(bobPage, editedFirst)).toBeVisible();

  await alice.setOffline(false);
  await expect(alicePage.getByRole('status', { name: 'connection: open' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(confirmedRowsWithText(alicePage, editedFirst)).toHaveCount(1, { timeout: 15_000 });
  await expect(confirmedRowsWithText(alicePage, second)).toHaveCount(1);
  await expect(timelineText(alicePage, first)).toHaveCount(0);

  const firstRow = await messageRow(alicePage, editedFirst).elementHandle();
  const secondRow = await messageRow(alicePage, second).elementHandle();
  expect(firstRow).not.toBeNull();
  expect(secondRow).not.toBeNull();
  const firstBeforeSecond = await firstRow!.evaluate(
    (node, other) =>
      Boolean(node.compareDocumentPosition(other as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
    secondRow,
  );
  expect(firstBeforeSecond).toBe(true);

  await alice.close();
  await bob.close();
});

test('session question requested while disconnected heals without reload', async ({
  page,
  context,
}) => {
  const handle = unique('question-offline');
  await login(page, handle, 'Question Offline');
  const generalId = await channelId(page.context().request, 'general');

  await context.setOffline(true);
  // Chromium's Playwright offline emulation blocks traffic but does not fire
  // the page-level event the app receives from a real browser.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText(/Reconnecting/)).toBeVisible({
    timeout: 15_000,
  });
  const title = unique('offline-question-session');
  const injected = await injectQuestionRequested({ handle, channelId: generalId, title });

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('status', { name: 'connection: open' })).toBeVisible({
    timeout: 15_000,
  });
  const sessionRow = messageRow(page, title);
  await expect(sessionRow).toBeVisible({ timeout: 15_000 });
  await expect(sessionRow.getByText('needs input')).toBeVisible();
  await sessionRow.getByRole('button', { name: '1 reply →' }).click();
  await expect(page.getByText(`❓ ${injected.questionText}`)).toBeVisible();
  expect(injected.rootId).toBeGreaterThan(0);
  expect(injected.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
});
