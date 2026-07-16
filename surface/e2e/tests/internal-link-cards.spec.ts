import { expect, test } from '@playwright/test';
import {
  apiAs,
  channelId,
  createTestChannel,
  injectSession,
  login,
  mainComposer,
  messageRow,
  openChannel,
  postMessage,
  unique,
  uniqueChannel,
} from './helpers.js';

/**
 * An Atrium permalink pasted into Atrium must never reach the external unfurl
 * fetcher. In prod that fetcher is an unauthenticated public-internet client, so
 * Cloudflare Access served it the SIGN-IN page and its `<title>` was cached for
 * 24h as a successful og card.
 *
 * There is no Access proxy in front of the e2e stack, so the prod symptom cannot
 * reproduce verbatim. The underlying defect still does: the fetcher would fetch
 * our own SPA shell, whose only title is `<title>Atrium</title>`, and every
 * internal link would unfurl to a card titled "Atrium". That is the regression
 * these tests pin — plus the direct proof that the URL never enters a resolve
 * request at all.
 */

/** Paste text without asserting raw-text visibility — cards rewrite the row. */
async function paste(page: import('@playwright/test').Page, text: string, room: string) {
  await mainComposer(page, room).fill(text);
  await mainComposer(page, room).press('Enter');
}

test('an Atrium permalink renders a live session card and never reaches the unfurl fetcher', async ({ page }) => {
  const room = await createTestChannel('internal-link');
  const handle = unique('internal-linker');
  await login(page, handle, 'Internal Link Author');
  const ctx = await apiAs(handle, 'Internal Link Author');
  const roomId = await channelId(ctx, room);
  const { sessionId } = await injectSession({ handle, channelId: roomId, title: 'Ship internal link cards' });

  // Record every URL the client asks the server to unfurl.
  const resolveAttempts: string[] = [];
  await page.route('**/api/unfurl/resolve', async (route) => {
    const body = route.request().postDataJSON() as { urls?: string[] } | null;
    resolveAttempts.push(...(body?.urls ?? []));
    await route.continue();
  });

  await openChannel(page, room);
  const marker = unique('session-link');
  const url = `${new URL(page.url()).origin}/c/${roomId}/s/${sessionId}`;
  await paste(page, `${marker} ${url}`, room);

  const row = messageRow(page, marker);
  const card = row.locator('article').filter({ has: page.getByTestId('glance-chip') });
  await expect(card).toBeVisible();
  await expect(card.getByRole('link', { name: 'Ship internal link cards' })).toBeVisible();

  // The one status vocabulary — "Working", never the raw DB status "running".
  await expect(card.getByTestId('glance-chip')).toHaveAttribute('data-kind', 'working');
  await expect(card.getByTestId('glance-chip')).toContainText('Working');

  // The card links RELATIVELY. A host-agnostic parse must never send a reader
  // to whatever host was in the pasted URL.
  await expect(card.getByRole('link', { name: 'Ship internal link cards' })).toHaveAttribute(
    'href',
    `/c/${roomId}/s/${sessionId}`,
  );

  // The regression, stated directly: our own URL never entered a resolve batch,
  // and no external card (which in this stack would be titled "Atrium") exists.
  expect(resolveAttempts).not.toContain(url);
  await expect(row.getByText('Atrium', { exact: true })).toHaveCount(0);
});

test('a channel permalink renders a channel card and a thread permalink quotes its root', async ({ page }) => {
  const room = await createTestChannel('internal-link-mix');
  const handle = unique('internal-mixer');
  await login(page, handle, 'Internal Mix Author');
  const ctx = await apiAs(handle, 'Internal Mix Author');
  const roomId = await channelId(ctx, room);

  const rootText = unique('thread-root-body');
  const rootId = await postMessage(ctx, roomId, rootText);

  await openChannel(page, room);
  const origin = new URL(page.url()).origin;

  const channelMarker = unique('channel-link');
  await paste(page, `${channelMarker} ${origin}/c/${roomId}`, room);
  const channelCard = messageRow(page, channelMarker).locator('article');
  await expect(channelCard.getByRole('link', { name: room })).toHaveAttribute('href', `/c/${roomId}`);

  // A thread permalink IS an entry ref: /c/:id/t/:rootId -> evt_<rootId> -> the
  // existing entry-quote pipeline. No bespoke thread card should exist.
  const threadMarker = unique('thread-link');
  await paste(page, `${threadMarker} ${origin}/c/${roomId}/t/${rootId}`, room);
  await expect(messageRow(page, threadMarker).getByText(rootText)).toBeVisible();
});

test('a permalink to a channel the reader cannot see stays a plain link and loses no text', async ({ page }) => {
  // The hand-computed failure mode: mirroring the entry-ref body-strip would
  // erase a standalone URL whose card never resolves, rendering an EMPTY
  // message. The text must survive regardless of resolvability.
  //
  // This channel must be PRIVATE. `canAccessChannel` grants every workspace
  // member access to every PUBLIC channel, so a public channel would be visible
  // to the outsider and prove nothing. The shared createChannel helper omits
  // `private`, which the route reads as public — hence the direct POST.
  const owner = unique('secret-owner');
  const ownerCtx = await apiAs(owner, 'Secret Owner');
  const secretRoom = uniqueChannel('secret');
  const created = await ownerCtx.post('/api/channels', { data: { name: secretRoom, private: true } });
  expect(created.ok(), `create private channel (${created.status()})`).toBeTruthy();
  const secretId = ((await created.json()) as { channel: { id: string } }).channel.id;

  const room = await createTestChannel('internal-link-acl');
  const outsider = unique('outsider');
  await login(page, outsider, 'Outsider');
  await openChannel(page, room);

  const marker = unique('invisible-link');
  const url = `${new URL(page.url()).origin}/c/${secretId}`;
  await paste(page, `${marker} ${url}`, room);

  const row = messageRow(page, marker);
  await expect(row).toBeVisible();
  await expect(row.getByRole('link', { name: url })).toBeVisible();
  await expect(row.locator('article')).toHaveCount(0);
});
