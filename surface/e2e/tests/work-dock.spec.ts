import { expect, test } from '@playwright/test';
import { channelId, createTestChannel, injectSession, injectSessionReply, login, unique } from './helpers.js';

// The unified ConversationPanel: one mounted panel whose work surface docks by
// container width (top band when narrow, side dock when wide), and whose
// thread↔work toggle is a mode change — never a remount, never a second SSE.

test('the pinned work surface docks top in a split pane and side in focus', async ({ page }) => {
  const room = await createTestChannel('workdock');
  const handle = unique('docker');
  await login(page, handle, 'Dock Tester');
  const roomId = await channelId(page.context().request, room);
  const { rootId, sessionId } = await injectSession({ handle, channelId: roomId, title: unique('dock-session') });
  await injectSessionReply({ channelId: roomId, rootId, sessionId, text: unique('dock-reply') });

  // ?work= pins the drawer; the split pane is narrower than the dock
  // breakpoint, so the surface must dock as a top band.
  await page.goto(`/c/${roomId}/s/${sessionId}?work=side-effects`);
  await expect(page.getByTestId('work-dock-top')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('work-dock-side')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/work-dock-top.png' });

  // Focus layout hands the panel the full viewport — the same pinned surface
  // reflows to the side dock, and back again when returning to split.
  await page.goto(`/c/${roomId}/s/${sessionId}?work=side-effects&view=focus`);
  // (view=focus keeps the same pinned tab; only the dock side may change.)
  await expect(page.getByTestId('work-dock-side')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('work-dock-top')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/work-dock-side.png' });
});

test('thread↔work toggling never remounts the conversation panel', async ({ page }) => {
  const room = await createTestChannel('workdock-stream');
  const handle = unique('streamer');
  await login(page, handle, 'Stream Tester');
  const roomId = await channelId(page.context().request, room);
  const title = unique('stream-session');
  const { rootId, sessionId } = await injectSession({ handle, channelId: roomId, title });
  await injectSessionReply({ channelId: roomId, rootId, sessionId, text: unique('stream-reply') });

  await page.goto(`/c/${roomId}/t/${rootId}`);
  // Both mode bodies are mounted (that IS the unified panel) — target the
  // thread body's visible title button, not the hidden work header's span.
  const titleButton = page.getByRole('button', { name: title, exact: true });
  await expect(titleButton).toBeVisible({ timeout: 20_000 });

  // Brand the panel's live DOM nodes. A remount would recreate them, dropping
  // the marks — this is load-immune, unlike counting SSE opens (the stream
  // machine's silent-death watchdog may legitimately reopen a quiet stream).
  const marked = await page.evaluate(() => {
    const asides = [...document.querySelectorAll('[data-testid="conversation-title"]')]
      .map((el) => el.closest('aside'))
      .filter((el): el is HTMLElement => el != null);
    for (const el of asides) {
      (el as HTMLElement & { __qaMounted?: boolean }).__qaMounted = true;
    }
    return asides.length;
  });
  expect(marked).toBeGreaterThanOrEqual(2); // thread body + hidden work body

  // Zoom in to the work pane (in-app navigation), then back out to the thread.
  await titleButton.click();
  await expect(page).toHaveURL(new RegExp(`/s/${sessionId}`), { timeout: 20_000 });
  // The visible work body's crumb trail renders `thread` as a button (zoom
  // out); the hidden thread body's own crumb line has no such button.
  const crumb = page.getByRole('button', { name: 'thread', exact: true });
  await expect(crumb).toBeVisible();
  await crumb.click();
  await expect(page).toHaveURL(new RegExp(`/t/${rootId}`), { timeout: 20_000 });
  await expect(titleButton).toBeVisible({ timeout: 20_000 });

  // Same DOM nodes, marks intact: the round-trip was a mode change on one
  // mounted panel, not an unmount/remount. (Single-SSE identity is covered
  // deterministically by ConversationPanel.test.tsx with a mocked transport.)
  const survivors = await page.evaluate(
    () =>
      [...document.querySelectorAll('[data-testid="conversation-title"]')]
        .map((el) => el.closest('aside'))
        .filter((el) => el != null && (el as HTMLElement & { __qaMounted?: boolean }).__qaMounted === true).length,
  );
  expect(survivors).toBe(marked);
});
