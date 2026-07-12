// Navigation & discoverability gate. Locks in the web nav fixes from the
// nav-audit fanout: the header exposes a visible Search affordance + a
// keyboard-shortcuts (?) button, and threads are reachable (full-screen) at
// phone widths — previously the thread panel was `hidden md:contents`, so
// tapping a reply on a phone did nothing (e2e-only-caught regression class).

import { expect, test } from '@playwright/test';
import { apiAs, createChannel, login, postMessage, unique } from './helpers.js';

test('web header exposes a visible Search control and a keyboard-shortcuts button', async ({ page }) => {
  const handle = unique('navuser');
  await login(page, handle);
  // The command palette entry is now labelled/aria'd for search discoverability,
  // not "Command".
  await expect(page.getByRole('button', { name: /search/i }).first()).toBeVisible();
  // The shortcuts sheet now has a visible trigger (was `?`-key-only).
  const shortcutsButton = page.getByRole('button', { name: 'Keyboard shortcuts' });
  await expect(shortcutsButton).toBeVisible();
  await shortcutsButton.click();
  await expect(page.getByText(/keyboard shortcuts/i).first()).toBeVisible();
});

test('threads are reachable and full-screen at phone width', async ({ page }) => {
  const handle = unique('navuser');
  const ctx = await apiAs(handle);
  const ch = await createChannel(ctx, unique('nav-room'));
  const rootId = await postMessage(ctx, ch, 'Top-level post that anchors a thread for mobile QA.');

  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, handle);
  // Deep-link to the channel + thread via the notification-target params
  // (`?channel=` gates the handler at Chat.tsx; `threadRoot` alone is ignored).
  await page.goto(`/?channel=${ch}&threadRoot=${rootId}`);

  // The thread must actually render on mobile (regression: `hidden md:contents`).
  const closeThread = page.getByRole('button', { name: 'Close thread' });
  await expect(closeThread).toBeVisible();

  // Full-screen: the thread aside should span (near) the full viewport width,
  // and the page must not scroll horizontally.
  const aside = page.locator('aside').filter({ has: closeThread });
  const box = await aside.boundingBox();
  expect(box, 'thread aside should be laid out').toBeTruthy();
  expect(box!.width).toBeGreaterThan(320); // wider than the desktop min-width pane
  const scroll = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    vw: document.documentElement.clientWidth,
  }));
  expect(scroll.sw, 'thread view must not scroll horizontally').toBeLessThanOrEqual(scroll.vw + 1);
});
