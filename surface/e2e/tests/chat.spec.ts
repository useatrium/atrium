import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import {
  apiAs,
  channelId,
  confirmedRowsWithText,
  createTestChannel,
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

async function injectTranscriptSession(args: {
  handle: string;
  channelId: string;
  title: string;
}): Promise<{ rootId: number; sessionId: string }> {
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
       VALUES ($1, $2, $3, 'claude-code', $4, 'running', $5, $5, 'exe_e2e_stream', 1)
       RETURNING id`,
      [workspaceId, args.channelId, `thread-${unique('stream')}`, args.title, userId],
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

function transcriptSseFrame(
  event: string,
  eventId: number,
  data: Record<string, unknown>,
): string {
  return `event: ${event}\ndata: ${JSON.stringify({ ...data, event_id: eventId })}\n\n`;
}

function assistantTextFrame(eventId: number, text: string): string {
  return transcriptSseFrame('amp_raw_event', eventId, {
    type: 'assistant',
    message: { id: `msg-${eventId}`, content: [{ type: 'text', text }] },
  });
}

function executionStateFrame(eventId: number, status: string): string {
  return transcriptSseFrame('execution_state', eventId, {
    type: 'execution.state',
    status,
    thread_key: 'thread-e2e-stream',
    execution_id: 'exe_e2e_stream',
    ...(status === 'completed' ? { result_text: 'resume complete' } : {}),
  });
}

test('login lands in #general; sent message appears', async ({ page }) => {
  await login(page, unique('alice'), 'Alice');

  const text = unique('hello-general');
  await sendMessage(page, text);
});

test('realtime: bob sees alice message appear without reload', async ({ browser }) => {
  const room = await createTestChannel('realtime');
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const alicePage = await alice.newPage();
  const bobPage = await bob.newPage();
  await login(alicePage, unique('alice'), 'Alice');
  await login(bobPage, unique('bob'), 'Bob');
  await openChannel(alicePage, room);
  await openChannel(bobPage, room);

  const text = unique('realtime');
  await sendMessage(alicePage, text, room);
  await expect(bobPage.getByText(text, { exact: true })).toBeVisible();

  await alice.close();
  await bob.close();
});

test('thread: reply in thread; root shows reply count', async ({ page }) => {
  const room = await createTestChannel('thread');
  await login(page, unique('threader'), 'Threader');
  await openChannel(page, room);
  const root = unique('thread-root');
  const reply = unique('thread-reply');
  await sendMessage(page, root, room);

  const row = messageRow(page, root);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByLabel('Reply in thread').click({ force: true });
  await expect(page.getByPlaceholder('Reply…')).toBeVisible();
  await page.getByPlaceholder('Reply…').fill(reply);
  await page.getByPlaceholder('Reply…').press('Enter');

  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  await page.getByLabel('Close thread').click();
  await expect(row.getByRole('button', { name: '1 reply →' })).toBeVisible();
});

test('reactions: toggle a reaction, chip count updates', async ({ page }) => {
  const room = await createTestChannel('react');
  await login(page, unique('reactor'), 'Reactor');
  await openChannel(page, room);
  const text = unique('reactable');
  await sendMessage(page, text, room);

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
  const room = await createTestChannel('edit');
  await login(page, unique('editor'), 'Editor');
  await openChannel(page, room);
  const original = unique('edit-me');
  const edited = unique('edited');
  await sendMessage(page, original, room);

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
  const second = await createTestChannel('badge');

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
  const second = await createTestChannel('sync');

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
  const room = await createTestChannel('search');
  const handle = unique('searcher');
  const api = await apiAs(handle, 'Searcher');
  const searchChannel = await channelId(api, room);
  const old = unique('ancient-search-token');
  await postMessage(api, searchChannel, old);
  for (let i = 0; i < 55; i += 1) {
    await postMessage(api, searchChannel, `${unique('newer-search-filler')} ${i}`);
  }
  await api.dispose();

  await login(page, handle, 'Searcher');
  await openChannel(page, room);
  await expect(page.getByText(old, { exact: true })).toHaveCount(0);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.getByLabel('Channel and message search').fill(old);
  await expect(page.getByRole('listbox', { name: 'Search results' }).getByText(old)).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByText(old, { exact: true })).toBeVisible();
});

test('offline send survives reload and confirms once', async ({ page, context }) => {
  const room = await createTestChannel('offline-send');
  await login(page, unique('offline-sender'), 'Offline Sender');
  await warmOfflineShell(page);
  await openChannel(page, room);

  const text = unique('offline-survives');
  await context.setOffline(true);
  await mainComposer(page, room).fill(text);
  await mainComposer(page, room).press('Enter');
  await expect(timelineText(page, text)).toBeVisible();
  await expect(confirmedRowsWithText(page, text)).toHaveCount(0);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await openChannel(page, room);
  await expect(timelineText(page, text)).toBeVisible();
  await expect(confirmedRowsWithText(page, text)).toHaveCount(0);

  await context.setOffline(false);
  await expect(page.getByRole('status', { name: 'connection: open' })).toBeVisible({ timeout: 15_000 });
  await expect(confirmedRowsWithText(page, text)).toHaveCount(1, { timeout: 15_000 });
  await expect(timelineText(page, text)).toHaveCount(1);
});

test('lost POST response retries with same client id and confirms once', async ({ page }) => {
  const room = await createTestChannel('lost-response');
  await login(page, unique('lost-response'), 'Lost Response');
  await openChannel(page, room);

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
  await sendMessage(page, text, room);

  await expect(confirmedRowsWithText(page, text)).toHaveCount(1, { timeout: 15_000 });
  await expect(timelineText(page, text)).toHaveCount(1);
  expect(dropped).toBe(true);
  expect(droppedStatus).toBeGreaterThanOrEqual(200);
  expect(droppedStatus).toBeLessThan(300);

  await page.unroute('**/api/messages');
});

test('same-context tabs send without duplicate messages or queue error toasts', async ({ browser }) => {
  const room = await createTestChannel('tabs');
  const context = await browser.newContext();
  const firstPage = await context.newPage();
  const secondPage = await context.newPage();
  await login(firstPage, unique('two-tab'), 'Two Tab');
  await secondPage.goto('/');
  await expect(secondPage.getByRole('heading', { name: '# general' })).toBeVisible();
  await expect(secondPage.getByRole('status', { name: 'connection: open' })).toBeVisible();
  await openChannel(firstPage, room);
  await openChannel(secondPage, room);

  const firstText = unique('tab-one');
  const secondText = unique('tab-two');
  await mainComposer(firstPage, room).fill(firstText);
  await mainComposer(secondPage, room).fill(secondText);
  await Promise.all([
    mainComposer(firstPage, room).press('Enter'),
    mainComposer(secondPage, room).press('Enter'),
  ]);

  for (const page of [firstPage, secondPage]) {
    await expect(confirmedRowsWithText(page, firstText)).toHaveCount(1, { timeout: 15_000 });
    await expect(confirmedRowsWithText(page, secondText)).toHaveCount(1, { timeout: 15_000 });
    await expect(timelineText(page, firstText)).toHaveCount(1);
    await expect(timelineText(page, secondText)).toHaveCount(1);
    await expect(page.getByText(/Couldn't/)).toHaveCount(0);
  }

  await context.close();
});

test('offline edit and reaction land and survive reload', async ({ page, context }) => {
  const room = await createTestChannel('offline-edit');
  await login(page, unique('offline-editor'), 'Offline Editor');
  await openChannel(page, room);
  const original = unique('offline-edit-original');
  const edited = unique('offline-edit-final');
  await sendMessage(page, original, room);
  await expect(messageRow(page, original)).toBeVisible();
  await expect(confirmedRowsWithText(page, original)).toHaveCount(1, { timeout: 15_000 });

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
  await expect(editedRow.getByRole('button', { name: '👍 1, including you' })).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByRole('status', { name: 'connection: open' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('(saving edit)')).toHaveCount(0, { timeout: 15_000 });
  // '(saving edit)' clearing only proves the edit op landed; the reaction op
  // has no per-item marker and its button renders optimistically, so wait for
  // the queued-changes banner to drain before reloading — otherwise the
  // reload races the in-flight reaction op and it never survives.
  await expect(page.getByRole('status').filter({ hasText: /queued/ })).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(confirmedRowsWithText(page, edited)).toHaveCount(1);
  await expect(editedRow.getByRole('button', { name: '👍 1, including you' })).toBeVisible();

  await page.reload();
  await openChannel(page, room);
  // Post-reload hydration re-fetches the channel history (a network round-trip
  // on the cursor/structural-repair path), which is slow when parallel load
  // saturates the shared server — so match the 15s budget the rest of this
  // test's reconnect-crossing waits use. The default 8s races that refetch and
  // is the sole cause of this test's local-parallel flake (CI already tolerates
  // it via a 20s expect timeout + retries).
  await expect(confirmedRowsWithText(page, edited)).toHaveCount(1, { timeout: 15_000 });
  await expect(messageRow(page, edited).getByRole('button', { name: '👍 1, including you' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(timelineText(page, original)).toHaveCount(0);
});

test('disconnect burst heals through sync without reload', async ({ browser }) => {
  const room = await createTestChannel('burst');
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const alicePage = await alice.newPage();
  const bobPage = await bob.newPage();
  await login(alicePage, unique('oba'), 'Offline Burst Alice');
  await login(bobPage, unique('obb'), 'Offline Burst Bob');
  await openChannel(alicePage, room);
  await openChannel(bobPage, room);

  await alice.setOffline(true);
  const first = unique('burst-first');
  const editedFirst = unique('burst-first-edited');
  const second = unique('burst-second');
  await sendMessage(bobPage, first, room);
  const firstId = await messageId(bobPage, first);
  const edit = await bobPage.context().request.patch(`/api/messages/${firstId}`, {
    data: { text: editedFirst },
  });
  expect(edit.ok()).toBeTruthy();
  await sendMessage(bobPage, second, room);
  await expect(confirmedRowsWithText(bobPage, second)).toHaveCount(1, { timeout: 15_000 });
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
  const room = await createTestChannel('question');
  const handle = unique('question-offline');
  await login(page, handle, 'Question Offline');
  await openChannel(page, room);
  const roomId = await channelId(page.context().request, room);

  await context.setOffline(true);
  // Chromium's Playwright offline emulation blocks traffic but does not fire
  // the page-level event the app receives from a real browser.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText(/Reconnecting/)).toBeVisible({
    timeout: 15_000,
  });
  const title = unique('offline-question-session');
  const injected = await injectQuestionRequested({ handle, channelId: roomId, title });

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('status', { name: 'connection: open' })).toBeVisible({
    timeout: 15_000,
  });
  const sessionRow = messageRow(page, title);
  await expect(sessionRow).toBeVisible({ timeout: 15_000 });
  await expect(sessionRow.getByText('needs input')).toBeVisible();
  await sessionRow.getByRole('button', { name: '1 reply →' }).click();
  // The question card renders its prompt text in its own element (HITL
  // transcript-fidelity rendering — no emoji prefix).
  await expect(page.getByText(injected.questionText)).toBeVisible();
  expect(injected.rootId).toBeGreaterThan(0);
  expect(injected.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
});

test('session transcript stream resumes after disconnect without duplicating replayed frames', async ({
  page,
}) => {
  const room = await createTestChannel('stream');
  const handle = unique('stream-resume');
  await login(page, handle, 'Stream Resume');
  const roomId = await channelId(page.context().request, room);
  const title = unique('stream-transcript-session');
  const injected = await injectTranscriptSession({ handle, channelId: roomId, title });
  const seenAfterIds: string[] = [];
  let requestCount = 0;

  await page.route('**/api/sessions/*/stream*', async (route) => {
    const url = new URL(route.request().url());
    seenAfterIds.push(url.searchParams.get('after_event_id') ?? '');
    requestCount += 1;
    if (requestCount === 1) {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body: executionStateFrame(1, 'running') + assistantTextFrame(2, 'alpha'),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body:
        assistantTextFrame(2, 'alpha') +
        assistantTextFrame(3, 'beta') +
        executionStateFrame(4, 'completed'),
    });
  });

  await page.goto(`/s/${injected.sessionId}`);

  await expect(page.getByText('alpha')).toBeVisible();
  await expect(page.getByText('alphabeta')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('alphaalphabeta')).toHaveCount(0);
  expect(seenAfterIds[0]).toBe('0');
  await expect.poll(() => seenAfterIds.at(-1)).toBe('2');
  expect(injected.rootId).toBeGreaterThan(0);

  await page.unroute('**/api/sessions/*/stream*');
});
