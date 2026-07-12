import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

declare global {
  interface Window {
    atrium?: {
      openSessionPopout: (sessionId: string) => Promise<void>;
      onNavigate: (callback: (path: string) => void) => () => void;
    };
    __atriumMenuNavigation?: string;
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
const builtRendererEntry = resolve(desktopRoot, '../web/dist/index.html');
const builtRendererRoot = resolve(desktopRoot, '../web/dist');

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

async function assertBuiltRenderer(): Promise<void> {
  try {
    const entry = await stat(builtRendererEntry);
    if (entry.isFile()) return;
  } catch {
    // Fall through to the actionable error below.
  }

  throw new Error(
    `Built web renderer not found at ${builtRendererEntry}. Run "pnpm --filter @atrium/web build" before "pnpm --filter @atrium/desktop e2e".`,
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

async function waitForSessionPopoutCount(app: ElectronApp, sessionId: string, count: number): Promise<void> {
  await expect
    .poll(async () => sessionPopoutCount(await browserWindows(app), sessionId), {
      message: `session ${sessionId} popout count reaches ${count}`,
    })
    .toBe(count);
}

test('desktop shell menu, session popout dedup, and New Window', async () => {
  const testInfo = test.info();
  await assertBuiltMainEntry();
  await assertBuiltRenderer();

  const userDataDir = testInfo.outputPath('user-data');
  await mkdir(userDataDir, { recursive: true });

  const envWithoutRendererUrl = { ...process.env };
  delete envWithoutRendererUrl.ATRIUM_RENDERER_URL;

  let app: ElectronApp | null = null;
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, '--force-light-mode', builtMainEntry],
      env: {
        ...envWithoutRendererUrl,
        ATRIUM_WEB_DIST: builtRendererRoot,
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
    await expect
      .poll(async () => mainWindow.locator('#root').evaluate((root) => root.childElementCount), {
        message: 'real React renderer is mounted',
      })
      .toBeGreaterThan(0);
    await waitForWindowCount(app, 1);

    const shell = await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('main window not found');
      return {
        backgroundColor: window.getBackgroundColor().toLowerCase(),
        minimumSize: window.getMinimumSize(),
        shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      };
    });
    expect(shell.shouldUseDarkColors).toBe(false);
    expect(shell.backgroundColor).toBe('#fafafa');
    expect(shell.minimumSize).toEqual([420, 480]);

    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('main window not found');
      window.setSize(420, 480);
    });
    await expect.poll(async () => mainWindow.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(420);
    await expect.poll(async () => mainWindow.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(390);

    const menu = await app.evaluate(
      ({ Menu }) =>
        Menu.getApplicationMenu()?.items.map((item) => ({
          label: item.label,
          submenuLabels: item.submenu?.items.map((submenuItem) => submenuItem.label) ?? [],
        })) ?? [],
    );
    const menuLabels = menu.map((item) => item.label);
    expect(menuLabels).toEqual(expect.arrayContaining(['File', 'Edit', 'View', 'Window', 'Help']));
    expect(menu.find((item) => item.label === 'File')?.submenuLabels).toContain('New Window');
    expect(menu.find((item) => item.label === 'View')?.submenuLabels).toEqual(
      expect.arrayContaining(['Zoom In', 'Zoom Out', 'Actual Size']),
    );

    await mainWindow.evaluate(() => {
      window.atrium?.onNavigate((path) => {
        window.__atriumMenuNavigation = path;
      });
    });
    await app.evaluate(({ Menu }) => {
      const filesItem = Menu.getApplicationMenu()
        ?.items.find((item) => item.label === 'Go')
        ?.submenu?.items.find((item) => item.label === 'Files');
      if (!filesItem) throw new Error('Go > Files menu item not found');
      filesItem.click();
    });
    await expect.poll(() => mainWindow.evaluate(() => window.__atriumMenuNavigation)).toBe('/files');

    const sessionId = 'sess_dedupe';
    await mainWindow.evaluate((id) => window.atrium?.openSessionPopout(id), sessionId);
    await waitForSessionPopoutCount(app, sessionId, 1);
    const afterFirstPopout = await browserWindows(app);
    const popout = afterFirstPopout.find((window) => sessionPopoutCount([window], sessionId) === 1);
    expect(popout).toBeDefined();

    await mainWindow.evaluate((id) => window.atrium?.openSessionPopout(id), sessionId);
    await waitForSessionPopoutCount(app, sessionId, 1);
    await waitForWindowCount(app, afterFirstPopout.length);
    await expect
      .poll(() => app?.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null))
      .toBe(popout?.id);

    await mainWindow.screenshot({ path: testInfo.outputPath('compact-real-renderer.png') });

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
