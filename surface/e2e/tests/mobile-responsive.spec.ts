// Mobile-responsiveness gate. The web app is desktop-first; this spec locks in
// that the major screens do not force a horizontal page-scroll at phone widths
// (the fanout's historical blind spot — regressions here are e2e-only-caught).
// Each responsive lane extends the SCREENS list with the surface it fixed.

import { deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';
import {
  apiAs,
  channelId,
  createChannel,
  login,
  postMessage,
  postWithAttachment,
  unique,
  uniqueChannel,
  uploadViaApi,
} from './helpers.js';

const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

// iPhone 14 and small-Android floor (Gary's 360px target).
const WIDTHS = [390, 360];
const LONG_ATTACHMENT_NAME = 'quarterly-financial-projections-final-v7-REVISED.tar.gz';

const PNG_CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < PNG_CRC_TABLE.length; i += 1) {
  let c = i;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  PNG_CRC_TABLE[i] = c >>> 0;
}

function pngCrc32(parts: Buffer[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) {
      crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32([typeBytes, data]), 8 + data.byteLength);
  return chunk;
}

function generatedPng(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  const stride = 1 + width * 3;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      pixels[offset] = Math.round((x / Math.max(width - 1, 1)) * 255);
      pixels[offset + 1] = Math.round((y / Math.max(height - 1, 1)) * 180);
      pixels[offset + 2] = 220;
    }
  }

  return Buffer.concat([
    header,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const WIDE_ATTACHMENT_PNG = generatedPng(800, 400);

/** Assert the page does not scroll horizontally, and surface the offenders if it does. */
async function expectNoHScroll(page: Page, screen: string): Promise<void> {
  const r = await page.evaluate(() => {
    const de = document.documentElement;
    const vw = de.clientWidth;
    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > vw + 1 && getComputedStyle(el).position !== 'fixed') {
        offenders.push(
          `<${el.tagName.toLowerCase()} class="${(el.getAttribute('class') || '').slice(0, 80)}"> right=${Math.round(rect.right)}`,
        );
      }
    }
    return { vw, scrollWidth: de.scrollWidth, offenders: offenders.slice(0, 8) };
  });
  expect(
    r.scrollWidth,
    `${screen}: page scrolls horizontally (scrollWidth ${r.scrollWidth} > viewport ${r.vw}). Offenders:\n${r.offenders.join('\n')}`,
  ).toBeLessThanOrEqual(r.vw + 1);
}

async function seedSession(handle: string, ch: string, title: string): Promise<string> {
  const pool = new Pool({ connectionString: e2eDatabaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>('SELECT id FROM users WHERE handle=$1', [handle]);
    const channel = await client.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM channels WHERE id=$1',
      [ch],
    );
    const userId = user.rows[0]!.id;
    const workspaceId = channel.rows[0]!.workspace_id;
    const session = await client.query<{ id: string }>(
      `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, harness, title, status,
         spawned_by, driver_id, current_execution_id, assignment_generation)
       VALUES ($1,$2,$3,'claude-code',$4,'running',$5,$5,'exe_mobgate',1) RETURNING id`,
      [workspaceId, ch, `thread-${unique('mobgate')}`, title, userId],
    );
    const sessionId = session.rows[0]!.id;
    const root = await client.query<{ id: string }>(
      `INSERT INTO events (workspace_id, channel_id, type, actor_id, payload)
       VALUES ($1,$2,'session.spawned',$3,$4) RETURNING id`,
      [workspaceId, ch, userId, JSON.stringify({ sessionId, title, harness: 'claude-code', by: userId })],
    );
    await client.query('UPDATE sessions SET thread_root_event_id=$1 WHERE id=$2', [
      Number(root.rows[0]!.id),
      sessionId,
    ]);
    await client.query('COMMIT');
    return sessionId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * The page-level check above can miss overflow that lands INSIDE the message
 * list: the timeline is its own scroll container, so a too-wide attachment
 * gives the chat area a horizontal scrollbar while document.scrollWidth stays
 * clean (the exact shape of the prod bug this screen locks in). Assert the
 * timeline itself, plus that nothing pokes past the viewport.
 */
async function expectChatAreaContained(page: Page, screen: string): Promise<void> {
  const r = await page.evaluate(() => {
    const de = document.documentElement;
    const vw = de.clientWidth;
    const log = document.querySelector('[role="log"]');
    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > vw + 1 && getComputedStyle(el).position !== 'fixed') {
        offenders.push(
          `<${el.tagName.toLowerCase()} class="${(el.getAttribute('class') || '').slice(0, 80)}"> right=${Math.round(rect.right)}`,
        );
      }
    }
    return {
      vw,
      logClientWidth: log?.clientWidth ?? null,
      logScrollWidth: log?.scrollWidth ?? null,
      offenders: offenders.slice(0, 8),
    };
  });
  expect(r.logScrollWidth, `${screen}: [role=log] timeline not found`).not.toBeNull();
  expect(
    r.logScrollWidth!,
    `${screen}: chat history scrolls horizontally (scrollWidth ${r.logScrollWidth} > clientWidth ${r.logClientWidth})`,
  ).toBeLessThanOrEqual((r.logClientWidth ?? 0) + 1);
  expect(
    r.offenders,
    `${screen}: elements extend past the viewport:\n${r.offenders.join('\n')}`,
  ).toEqual([]);
}

for (const width of WIDTHS) {
  test.describe(`mobile @${width}px`, () => {
    test.use({ viewport: { width, height: 844 } });

    test('major screens do not scroll horizontally', async ({ page }) => {
      test.setTimeout(120_000);
      const handle = unique('mobgate');

      // Login (pre-auth).
      await page.goto('/');
      await expect(page.getByPlaceholder('gary', { exact: true })).toBeVisible();
      await expectNoHScroll(page, 'login');

      await login(page, handle, 'Mobile Gate');

      // Seed a channel with content that stresses wrapping.
      const setup = await apiAs(unique('mobgate-seed'), 'Seed');
      const room = uniqueChannel('mobilegate');
      await createChannel(setup, room);
      const rid = await channelId(setup, room);
      await postMessage(setup, rid, 'Short hello.');
      await postMessage(
        setup,
        rid,
        'A long message with a very-long-unbroken-token supercalifragilisticexpialidocioussupercalifragilistic and a link https://example.com/some/really/long/path/that/should/not/blow/the/layout?q=1&x=2',
      );
      const imageId = await uploadViaApi(setup, 'wide-overflow-800x400.png', 'image/png', WIDE_ATTACHMENT_PNG);
      await postWithAttachment(setup, rid, 'wide image attachment', imageId);
      const fileId = await uploadViaApi(
        setup,
        LONG_ATTACHMENT_NAME,
        'application/gzip',
        Buffer.from('quarterly projections placeholder\n'),
      );
      await postWithAttachment(setup, rid, 'long filename attachment', fileId);
      const gen = await channelId(page.context().request, 'general');
      await postMessage(setup, gen, 'seed general');
      await setup.dispose();

      // Shell / channel with messages.
      await page.goto('/');
      await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
      await expectNoHScroll(page, 'shell/general');

      // Navigate by URL: at phone widths the channel list lives in a drawer,
      // and the deep link is the surface the overflow bug was reported on.
      await page.goto(`/c/${rid}`);
      await expect(page.getByRole('heading', { name: `# ${room}` })).toBeVisible();
      await expect(page.getByText('wide image attachment', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'wide-overflow-800x400.png' })).toBeVisible();
      await expect(page.getByText('long filename attachment', { exact: true })).toBeVisible();
      await expect(page.getByText(LONG_ATTACHMENT_NAME, { exact: true })).toBeVisible();
      await expectNoHScroll(page, 'channel attachments');
      await expectChatAreaContained(page, 'channel attachments');

      // Top-level routed surfaces (settings/agents are new in #299).
      for (const path of ['/settings', '/agents', '/files', '/activity']) {
        await page.goto(path);
        await page.waitForTimeout(500);
        await expectNoHScroll(page, `route ${path}`);
      }

      // Session pane + detached work surfaces. Stub the stream so the pane renders.
      const stamp = new Date().toISOString();
      await page.route('**/api/sessions/*/stream*', async (route) => {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          body: `event: execution_state\ndata: ${JSON.stringify({ type: 'execution.state', status: 'running', thread_key: 'thread-mobgate', execution_id: 'exe_mobgate', atrium_ts: stamp, event_id: 1 })}\n\n`,
        });
      });
      const sid = await seedSession(handle, gen, 'Mobile gate session');

      await page.goto(`/s/${sid}`);
      await page.waitForTimeout(1200);
      await expectNoHScroll(page, 'session-pane');

      // The lean standalone pane — its header metadata strip used to force a
      // ~490px horizontal scroll before the session lane wrapped it.
      await page.goto(`/s/${sid}/pane`);
      await page.waitForTimeout(1000);
      await expectNoHScroll(page, 'lean-pane');

      for (const [slug, name] of [
        ['changes', 'work-changes'],
        ['hub-files', 'work-files'],
      ] as const) {
        await page.goto(`/s/${sid}/work/${slug}`);
        await page.waitForTimeout(800);
        await expectNoHScroll(page, name);
      }
    });
  });
}
