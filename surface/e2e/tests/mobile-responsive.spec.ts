// Mobile-responsiveness gate. The web app is desktop-first; this spec locks in
// that the major screens do not force a horizontal page-scroll at phone widths
// (the fanout's historical blind spot — regressions here are e2e-only-caught).
// Each responsive lane extends the SCREENS list with the surface it fixed.

import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';
import {
  apiAs,
  channelId,
  createChannel,
  login,
  postMessage,
  unique,
  uniqueChannel,
} from './helpers.js';

const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';

// iPhone 14 and small-Android floor (Gary's 360px target).
const WIDTHS = [390, 360];

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
      const gen = await channelId(page.context().request, 'general');
      await postMessage(setup, gen, 'seed general');
      await setup.dispose();

      // Shell / channel with messages.
      await page.goto('/');
      await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
      await expectNoHScroll(page, 'shell/general');

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
