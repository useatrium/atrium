// Captures the marketing screenshots against a seeded demo stack.
//
// Prereqs:
//   1. server on :3210 with ATRIUM_DEMO_SCRIPT_PATH=server/scripts/demo-scripts.json
//   2. web on :5273 proxying to it
//   3. seed-demo-workspace.mts just ran (fresh unread state)
//
// Usage:  node e2e/capture-demo-shots.mjs [--out <dir>] [--only hero,thread,gallery,app,attention]
//
// Spawns the live hero session itself (via spawn-hero-session.mts), holds three
// extra logged-in users on the hero channel for the presence facepile, drives a
// typing indicator over a raw WS, and screenshots at 2x deviceScaleFactor.

import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = process.env.ATRIUM_WEB ?? 'http://localhost:5273';
const OUT = argValue('--out') ?? join(here, 'demo-shots');
const ONLY = (argValue('--only') ?? 'hero,thread,gallery,app,attention').split(',');
const VIEWPORT = { width: 1800, height: 1000 };

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

mkdirSync(OUT, { recursive: true });

// --- spawn the live hero session first: its stream paces the whole shoot ----
let hero = null;
if (ONLY.includes('hero') || ONLY.includes('thread')) {
  const raw = execFileSync('pnpm', ['--filter', '@atrium/server', 'exec', 'tsx', 'scripts/spawn-hero-session.mts'], {
    cwd: join(here, '..'),
    env: { ...process.env },
    encoding: 'utf8',
  });
  hero = JSON.parse(raw.trim().split('\n').at(-1));
  console.log(`hero session: ${hero.sessionId} (t0 = now)`);
}
const t0 = Date.now();

const browser = await chromium.launch();

async function loginPage(handle, displayName, viewport = VIEWPORT) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: 'light' });
  const res = await ctx.request.post(`${WEB}/auth/login`, { data: { handle, displayName } });
  if (!res.ok()) throw new Error(`login ${handle}: ${res.status()}`);
  await ctx.addInitScript(() => {
    // Wide enough that no channel name truncates in the shots, and a session
    // or thread pane wide enough that its spine stays compact.
    window.localStorage.setItem('atrium.sidebarWidth', '256');
    window.localStorage.setItem('atrium.sessionPaneWidth', '760');
    window.localStorage.setItem('atrium.threadPaneWidth', '760');
  });
  const page = await ctx.newPage();
  return page;
}

const maya = await loginPage('maya', 'Maya Chen');

// Look up channel + session ids as maya.
const mayaCtx = maya.context();
const chRes = await (await mayaCtx.request.get(`${WEB}/api/channels`)).json();
const chan = Object.fromEntries(chRes.channels.map((c) => [c.name, c.id]));
const sessRes = await (await mayaCtx.request.get(`${WEB}/api/sessions`)).json();
const sessions = sessRes.sessions ?? sessRes;
const evalSession = sessions.find((s) => s.title?.startsWith('Analyze eval regression'));

async function settle(page, ms = 1200) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

async function shoot(page, name) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path });
  console.log(`shot: ${path}`);
}

async function waitForImage(image) {
  await image.waitFor({ state: 'visible', timeout: 15_000 });
  await image.evaluate((element) =>
    element.complete && element.naturalWidth > 0
      ? undefined
      : new Promise((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error('image did not load')), 10_000);
          element.addEventListener(
            'load',
            () => {
              window.clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
          element.addEventListener(
            'error',
            () => {
              window.clearTimeout(timeout);
              reject(new Error('image failed to load'));
            },
            { once: true },
          );
        }),
  );
}

async function openWorkFold(page) {
  const expanded = page.getByTestId('work-fold-expanded').first();
  if (!(await expanded.isVisible().catch(() => false))) {
    const collapsed = page.getByTestId('work-fold-collapsed').first();
    await collapsed.waitFor({ state: 'visible', timeout: 15_000 });
    await collapsed.click();
  }
  await expanded.waitFor({ state: 'visible', timeout: 15_000 });
  await expanded.scrollIntoViewIfNeeded();
}

// ---------------------------------------------------------------------------
// 1. HERO — #eng-platform + live agent session split view
// ---------------------------------------------------------------------------
let heroPresence = [];
if (hero) {
  // Presence: three teammates parked on the hero channel; jonas also watches
  // the session itself (drives the "watching" count).
  const others = [];
  for (const [handle, name, url] of [
    ['jonas', 'Jonas Weber', `/c/${hero.channelId}/s/${hero.sessionId}`],
    ['sam', 'Sam Okafor', `/c/${hero.channelId}`],
    ['priya', 'Priya Nair', `/c/${hero.channelId}`],
  ]) {
    const p = await loginPage(handle, name, { width: 1100, height: 800 });
    await p.goto(`${WEB}${url}`);
    others.push(p);
  }
  heroPresence = others;
  await Promise.all(others.map((p) => p.waitForLoadState('networkidle').catch(() => {})));

  // Typing indicator: jonas "types" via a raw focused WS.
  await others[0].evaluate(
    async ({ channelId }) => {
      const ws = new WebSocket(`ws://${location.host}/ws`);
      await new Promise((resolve) => {
        ws.onopen = resolve;
      });
      ws.send(JSON.stringify({ type: 'subscribe', channelIds: [channelId] }));
      ws.send(JSON.stringify({ type: 'focus', channelId }));
      setInterval(() => ws.send(JSON.stringify({ type: 'typing', channelId })), 2500);
    },
    { channelId: hero.channelId },
  );

  if (ONLY.includes('hero')) {
    await maya.goto(`${WEB}/c/${hero.channelId}/s/${hero.sessionId}`);
    await settle(maya);

    // The intro (thinking → greps → edits → pytest) finishes ~25s in; the final
    // summary then streams for ~2 minutes. Shoot inside that window.
    const target = t0 + 42_000;
    const waitLeft = target - Date.now();
    if (waitLeft > 0) await maya.waitForTimeout(waitLeft);
    // Frame both altitudes of the new grammar: the trigger message's LIVE slot
    // in the channel and the split SessionPane's output strips + open work fold.
    const workingSlot = maya.getByTestId('session-slot-working').last();
    const annotation = maya.getByTestId('channel-annotation-cluster').filter({ has: workingSlot });
    await annotation.waitFor({ state: 'visible', timeout: 15_000 });
    await workingSlot.scrollIntoViewIfNeeded();
    await maya.getByTestId('spine-work-strips').waitFor({ state: 'visible', timeout: 15_000 });
    await maya.getByTestId('changes-strip').waitFor({ state: 'visible', timeout: 15_000 });
    await openWorkFold(maya);
    await maya.waitForTimeout(600);
    await shoot(maya, 'hero-chat-session');
    // A second take ~25s later (more of the summary streamed in).
    await maya.waitForTimeout(25_000);
    await shoot(maya, 'hero-chat-session-b');
  }
}

// ---------------------------------------------------------------------------
// 1b. THREAD — turn 1 completes, Jonas suggests under the trigger message,
//     Maya steers, and turn 2 streams; shoot the full spine mid-turn-2.
// ---------------------------------------------------------------------------
if (ONLY.includes('thread') && hero) {
  // Turn 1 runs ~150s of scripted stream; wait for the session to settle.
  for (;;) {
    const res = await (await mayaCtx.request.get(`${WEB}/api/sessions/${hero.sessionId}`)).json();
    const status = res.session?.status ?? res.status;
    if (status === 'completed') break;
    if (Date.now() - t0 > 240_000) throw new Error(`turn 1 never completed (status ${status})`);
    await maya.waitForTimeout(2000);
  }

  const triggerEventId = hero.threadRootEventId;
  if (!Number.isSafeInteger(triggerEventId)) throw new Error('hero trigger message has no thread root');

  // The seat model in action: Jonas isn't the driver, so his thread reply is a
  // suggestion; Maya (driver) steers to accept, which revives turn 2. Both
  // land under the trigger message — exactly what the thread composer sends.
  const jonasCtx = heroPresence[0].context();
  const suggestion = await jonasCtx.request.post(`${WEB}/api/sessions/${hero.sessionId}/suggestions`, {
    data: {
      text: "the DLQ sweeper's alert threshold still assumes the 30s ceiling — worth fixing while it's in there?",
      postToThread: true,
    },
  });
  if (!suggestion.ok()) throw new Error(`suggestion failed: ${suggestion.status()} ${await suggestion.text()}`);
  await maya.waitForTimeout(1200);
  const steer = await mayaCtx.request.post(`${WEB}/api/sessions/${hero.sessionId}/messages`, {
    data: {
      text: "good catch — bring the sweeper's alert threshold in line with the new ceiling too",
      postToThread: true,
    },
  });
  if (!steer.ok()) throw new Error(`steer failed: ${steer.status()} ${await steer.text()}`);
  const tReply = Date.now();

  // Turn 2: intro ~6s, then a ~26s pytest window — shoot inside it.
  await maya.waitForTimeout(Math.max(0, tReply + 15_000 - Date.now()));
  await maya.goto(`${WEB}/c/${hero.channelId}`);
  await settle(maya, 800);
  const threadSlot = maya.getByTestId('session-slot-working').last();
  const triggerCluster = maya.getByTestId('channel-annotation-cluster').filter({ has: threadSlot });
  await triggerCluster.waitFor({ state: 'visible', timeout: 15_000 });
  await triggerCluster.getByRole('button', { name: 'Open thread →' }).click();
  await maya.waitForURL(`**/c/${hero.channelId}/t/${triggerEventId}`);
  await settle(maya, 1500);
  const threadPane = maya.getByRole('complementary').filter({ has: maya.getByLabel('Close thread') });
  await threadPane.waitFor({ state: 'visible', timeout: 15_000 });
  const strips = threadPane.getByTestId('spine-work-strips');
  await strips.waitFor({ state: 'visible', timeout: 15_000 });
  await strips.getByRole('button', { name: /What changed/ }).waitFor({ state: 'visible' });
  await threadPane.getByTestId('work-fold-collapsed').first().waitFor({ state: 'visible', timeout: 15_000 });
  const liveFold = threadPane.getByTestId('work-fold-expanded').last();
  await liveFold.waitFor({ state: 'visible', timeout: 15_000 });
  await threadPane.getByText(/batches stall in pending_ocr whenever/).waitFor({ state: 'visible' });
  await threadPane.getByText(/Fixed the retry ceiling: 30s → 300s/).waitFor({ state: 'visible' });
  await threadPane
    .getByText("the DLQ sweeper's alert threshold still assumes the 30s ceiling", { exact: false })
    .waitFor({ state: 'visible' });
  await threadPane
    .getByText("good catch — bring the sweeper's alert threshold in line with the new ceiling too", { exact: true })
    .waitFor({ state: 'visible' });
  await liveFold.scrollIntoViewIfNeeded();
  await shoot(maya, 'thread-turns');
}

for (const p of heroPresence) await p.context().close();

// ---------------------------------------------------------------------------
// 2. GALLERY — /files with the lightbox open on the chart artifact
// ---------------------------------------------------------------------------
if (ONLY.includes('gallery')) {
  await maya.goto(`${WEB}/files`);
  await settle(maya, 1800);
  const gallery = maya.getByTestId('files-gallery');
  await gallery.waitFor({ state: 'visible', timeout: 15_000 });
  const tile = gallery.getByRole('button', { name: /f1-by-rotation\.png/ }).first();
  // Gallery thumbnails are decorative (alt="") and SELF-HEAL asynchronously
  // after a fresh seed — reload until the tile's img has actually painted.
  for (let attempt = 0; ; attempt++) {
    const img = tile.locator('img').first();
    const painted = await img.evaluate((element) => element.complete && element.naturalWidth > 0).catch(() => false);
    if (painted) break;
    if (attempt >= 20) throw new Error('gallery thumbnail never materialized');
    await maya.waitForTimeout(3000);
    await maya.reload();
    await gallery.waitFor({ state: 'visible', timeout: 15_000 });
  }
  await shoot(maya, 'files-gallery');
  await tile.click();
  await settle(maya, 1500);
  const lightbox = maya.getByRole('dialog');
  await lightbox.waitFor({ state: 'visible', timeout: 15_000 });
  await waitForImage(lightbox.locator('img').first());
  await shoot(maya, 'files-lightbox');
}

// ---------------------------------------------------------------------------
// 3. APP — eval session pane with the published app presentation card
// ---------------------------------------------------------------------------
if (ONLY.includes('app')) {
  if (!evalSession) throw new Error('eval presentation session not found');
  await maya.goto(`${WEB}/c/${chan.research}/s/${evalSession.id}`);
  await settle(maya, 2500);
  const presentation = maya.getByTestId('app-presentation-card');
  await presentation.waitFor({ state: 'visible', timeout: 15_000 });
  await presentation.locator('iframe').waitFor({ state: 'visible', timeout: 15_000 });
  // Give the sandboxed iframe a beat to render.
  await maya.waitForTimeout(2500);
  await shoot(maya, 'app-presentation');
}

// ---------------------------------------------------------------------------
// 4. ATTENTION — the unified inbox
// ---------------------------------------------------------------------------
if (ONLY.includes('attention')) {
  await maya.goto(`${WEB}/activity`);
  await settle(maya, 1800);
  await maya
    .getByRole('heading', { name: 'Attention', exact: true })
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });
  await maya.getByRole('heading', { name: /Needs attention/ }).waitFor({ state: 'visible', timeout: 15_000 });
  await maya.getByTestId('question-pointer').waitFor({ state: 'visible', timeout: 15_000 });
  await maya.getByText('Migrate thumbnails to atlas-derivatives failed', { exact: true }).waitFor({ state: 'visible' });
  await maya.getByText('Jonas Weber called you', { exact: true }).waitFor({ state: 'visible' });
  await shoot(maya, 'attention-inbox');
}

await browser.close();
console.log('done');
