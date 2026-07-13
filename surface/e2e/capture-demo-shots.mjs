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
    // pane wide enough that its header title doesn't collapse.
    window.localStorage.setItem('atrium.sidebarWidth', '256');
    window.localStorage.setItem('atrium.sessionPaneWidth', '760');
    window.localStorage.setItem('atrium.threadPaneWidth', '640');
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
    // Focus view folds finished tool work — expand it so thinking/commands/diffs
    // are visible in the shot.
    const fold = maya.getByText(/work steps?/, { exact: false }).first();
    if (await fold.isVisible().catch(() => false)) {
      await fold.click();
      await maya.waitForTimeout(600);
    }
    await shoot(maya, 'hero-chat-session');
    // A second take ~25s later (more of the summary streamed in).
    await maya.waitForTimeout(25_000);
    await shoot(maya, 'hero-chat-session-b');
  }
}

// ---------------------------------------------------------------------------
// 1b. THREAD — turn 1 completes, Jonas replies in the card's thread (a steer),
//     turn 2 streams; shoot the thread mid-turn-2.
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

  // The session card (the session.spawned event) is the thread root.
  const msgs = await (await mayaCtx.request.get(`${WEB}/api/channels/${hero.channelId}/messages?limit=50`)).json();
  const card = (msgs.events ?? []).find((e) => e.type === 'session.spawned' && e.payload?.sessionId === hero.sessionId);
  if (!card) throw new Error('session card not found in channel messages');

  // The seat model in action: Jonas isn't the driver, so his thread reply is a
  // suggestion; Maya (driver) steers to accept, which revives turn 2. Both
  // land in the card's thread — exactly what the thread composer sends.
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
  await maya.goto(`${WEB}/c/${hero.channelId}/t/${card.id}`);
  await settle(maya, 1500);
  await shoot(maya, 'thread-turns');
}

for (const p of heroPresence) await p.context().close();

// ---------------------------------------------------------------------------
// 2. GALLERY — /files with the lightbox open on the chart artifact
// ---------------------------------------------------------------------------
if (ONLY.includes('gallery')) {
  await maya.goto(`${WEB}/files`);
  await settle(maya, 1800);
  await shoot(maya, 'files-gallery');
  const tile = maya.getByText('f1-by-rotation.png', { exact: true }).last();
  await tile.click();
  await settle(maya, 1500);
  await shoot(maya, 'files-lightbox');
}

// ---------------------------------------------------------------------------
// 3. APP — eval session pane with the published app presentation card
// ---------------------------------------------------------------------------
if (ONLY.includes('app') && evalSession) {
  await maya.goto(`${WEB}/c/${chan.research}/s/${evalSession.id}`);
  await settle(maya, 2500);
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
  await shoot(maya, 'attention-inbox');
}

await browser.close();
console.log('done');
