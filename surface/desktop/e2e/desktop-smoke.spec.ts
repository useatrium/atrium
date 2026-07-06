import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

declare global {
  interface Window {
    atrium?: {
      openSessionPopout: (sessionId: string) => Promise<void>;
    };
  }
}

interface BrowserWindowSnapshot {
  id: number;
  url: string;
  visible: boolean;
}

const e2eDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(e2eDir, '..');
const builtMainEntry = resolve(desktopRoot, 'out/main/index.js');

async function assertBuiltMainEntry(): Promise<void> {
  try {
    const entry = await stat(builtMainEntry);
    if (entry.isFile()) return;
  } catch {
    // Fall through to the actionable error below.
  }

  throw new Error(
    `Desktop main process build not found at ${builtMainEntry}. Run "pnpm --filter @atrium/desktop build" before "pnpm --filter @atrium/desktop e2e".`,
  );
}

async function writeRendererStub(webDist: string): Promise<void> {
  await mkdir(webDist, { recursive: true });
  await writeFile(
    resolve(webDist, 'index.html'),
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Atrium Desktop Smoke Stub</title>
  </head>
  <body>
    <main id="root">desktop smoke stub</main>
    <script>
      window.__atriumDesktopSmoke = {
        hasBridge: Boolean(window.atrium),
        href: window.location.href,
      };
    </script>
  </body>
</html>
`,
  );
}

async function browserWindows(app: ElectronApp): Promise<BrowserWindowSnapshot[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((window) => !window.isDestroyed())
      .map((window) => ({
        id: window.id,
        url: window.webContents.getURL(),
        visible: window.isVisible(),
      })),
  );
}

function sessionPopoutCount(windows: BrowserWindowSnapshot[], sessionId: string): number {
  const encodedSessionId = encodeURIComponent(sessionId);
  return windows.filter((window) => {
    try {
      return new URL(window.url).pathname === `/s/${encodedSessionId}/pane`;
    } catch {
      return false;
    }
  }).length;
}

async function waitForWindowCount(app: ElectronApp, count: number): Promise<void> {
  await expect
    .poll(async () => (await browserWindows(app)).length, {
      message: `BrowserWindow count reaches ${count}`,
    })
    .toBe(count);
}

async function waitForSessionPopoutCount(
  app: ElectronApp,
  sessionId: string,
  count: number,
): Promise<void> {
  await expect
    .poll(async () => sessionPopoutCount(await browserWindows(app), sessionId), {
      message: `session ${sessionId} popout count reaches ${count}`,
    })
    .toBe(count);
}

test('desktop shell menu, session popout dedup, and New Window', async (_fixtures, testInfo) => {
  await assertBuiltMainEntry();

  const webDist = testInfo.outputPath('web-dist');
  const userDataDir = testInfo.outputPath('user-data');
  await writeRendererStub(webDist);
  await mkdir(userDataDir, { recursive: true });

  const envWithoutRendererUrl = { ...process.env };
  delete envWithoutRendererUrl.ATRIUM_RENDERER_URL;

  let app: ElectronApp | null = null;
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, builtMainEntry],
      env: {
        ...envWithoutRendererUrl,
        ATRIUM_WEB_DIST: webDist,
        ATRIUM_SERVER_URL: 'http://127.0.0.1:9',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
    });

    const mainWindow = await app.firstWindow({ timeout: 30_000 });
    await expect
      .poll(async () => mainWindow.evaluate(() => Boolean(window.atrium)), {
        message: 'preload bridge is available in the renderer',
      })
      .toBe(true);
    await waitForWindowCount(app, 1);

    const menu = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()?.items.map((item) => ({
        label: item.label,
        submenuLabels: item.submenu?.items.map((submenuItem) => submenuItem.label) ?? [],
      })) ?? [],
    );
    const menuLabels = menu.map((item) => item.label);
    expect(menuLabels).toEqual(expect.arrayContaining(['File', 'Edit', 'View', 'Window', 'Help']));
    expect(menu.find((item) => item.label === 'File')?.submenuLabels).toContain('New Window');

    const sessionId = 'sess_dedupe';
    await mainWindow.evaluate((id) => window.atrium?.openSessionPopout(id), sessionId);
    await waitForSessionPopoutCount(app, sessionId, 1);
    const afterFirstPopout = await browserWindows(app);

    await mainWindow.evaluate((id) => window.atrium?.openSessionPopout(id), sessionId);
    await waitForSessionPopoutCount(app, sessionId, 1);
    await waitForWindowCount(app, afterFirstPopout.length);

    await app.evaluate(({ Menu }) => {
      const newWindowItem = Menu.getApplicationMenu()
        ?.items.find((item) => item.label === 'File')
        ?.submenu?.items.find((item) => item.label === 'New Window');

      if (!newWindowItem) throw new Error('File > New Window menu item not found');
      newWindowItem.click();
    });
    await waitForWindowCount(app, afterFirstPopout.length + 1);
  } finally {
    await app?.close();
  }
});
