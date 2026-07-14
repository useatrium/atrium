import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  ipcMain,
  nativeImage,
  net,
  nativeTheme,
  protocol,
  session,
  shell,
} from 'electron';
import { APP_ORIGIN, APP_SCHEME, RENDERER_DEV_URL, SERVER_URL, TRAY_ICON, WEB_DIST } from './config.js';
import { buildAppMenu } from './appMenu.js';
import { clearSession, loadSession, saveSession, type DesktopSession } from './session.js';
import { DEEP_LINK_SCHEME, deepLinkToRoute } from './deepLink.js';
import { setupAutoUpdate } from './updater.js';
import { resolveSessionPopoutOpen, resolveWindowOpen, sessionIdFromPanePath } from './windowOpenPolicy.js';
import { launchBackgroundColor, mainWindowOptions, popoutWindowOptions } from './windowConfig.js';
import { installContextMenu } from './contextMenu.js';

// Must run before app `ready`: marks `app://` as a standard, secure origin so
// the bundled UI gets a secure context (required for getUserMedia / WebRTC).
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
const mainWindows = new Set<BrowserWindow>();
let tray: Tray | null = null;
let isQuitting = false;
const popoutWindows = new Map<string, BrowserWindow>();
const closedPopoutUrls: string[] = [];
const pendingDeepLinkPaths: string[] = [];
const CLOSED_POPOUT_LIMIT = 10;
const DOCS_URL = 'https://github.com/useatrium/atrium';
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  isQuitting = true;
  app.quit();
}

/** Serve the bundled web build over `app://`, with SPA fallback to index.html. */
function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    const filePath = join(WEB_DIST, pathname);
    if (!filePath.startsWith(WEB_DIST)) {
      return new Response('forbidden', { status: 403 });
    }

    try {
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch (err) {
      // SPA deep links (no file extension) fall back to the app shell.
      if (!pathname.split('/').pop()?.includes('.')) {
        return net.fetch(pathToFileURL(join(WEB_DIST, 'index.html')).toString());
      }
      console.error('[atrium] asset not found:', pathname, '→', filePath, String(err));
      return new Response('not found', { status: 404 });
    }
  });
}

function preloadPath(): string {
  return join(import.meta.dirname, '../preload/index.mjs');
}

function rendererTarget(): string {
  return RENDERER_DEV_URL ?? `${APP_ORIGIN}/index.html`;
}

function devOrigin(): string | null {
  return RENDERER_DEV_URL ? new URL(RENDERER_DEV_URL).origin : null;
}

function registerDeepLinkProtocol(): void {
  const scriptPath = process.argv[1];
  const didRegister =
    !app.isPackaged && scriptPath && !scriptPath.startsWith('-')
      ? app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [resolve(scriptPath)])
      : app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);

  if (!didRegister) {
    console.warn(`[atrium] failed to register ${DEEP_LINK_SCHEME}:// protocol handler`);
  }
}

function findDeepLinkArg(argv: string[]): string | null {
  return argv.find((arg) => deepLinkToRoute(arg) !== null) ?? null;
}

function createWindow(): BrowserWindow {
  const preload = preloadPath();
  const target = rendererTarget();
  const main = new BrowserWindow(
    mainWindowOptions(preload, {
      platform: process.platform,
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    }),
  );
  mainWindow = main;
  mainWindows.add(main);
  installContextMenu(main.webContents, { isDev: !app.isPackaged });

  // Close-to-tray: the app stays alive in the background (always-on, warm WS)
  // so re-opening is instant. Quit only via the tray menu / Cmd-Q.
  main.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      main.hide();
    }
  });
  main.on('closed', () => {
    mainWindows.delete(main);
    if (mainWindow === main) {
      mainWindow = Array.from(mainWindows).find((window) => !window.isDestroyed()) ?? null;
    }
  });

  main.webContents.on('did-finish-load', () => {
    console.log('[atrium] renderer loaded:', target);
    // Dev-only sanity probe: confirm the secure context + preload bridge are
    // live. Never runs in a packaged build and never touches auth/accounts.
    if (app.isPackaged) return;
    const probe = `JSON.stringify({
      secureContext: window.isSecureContext,
      reactMounted: (document.getElementById('root')?.childElementCount ?? 0) > 0,
      bridge: !!window.atrium,
      serverUrl: window.atrium?.serverUrl ?? null,
    })`;
    void main.webContents
      .executeJavaScript(probe)
      .then((result) => console.log('[atrium] renderer probe:', result))
      .catch((err) => console.error('[atrium] probe failed:', String(err)));
  });
  main.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error('[atrium] renderer failed:', code, desc, url);
  });

  attachWindowOpenPolicy(main.webContents, preload, devOrigin());

  void main.loadURL(target);
  return main;
}

function sessionPopoutUrl(sessionId: string): string {
  return new URL(`/s/${encodeURIComponent(sessionId)}/pane`, RENDERER_DEV_URL ?? APP_ORIGIN).toString();
}

function sessionIdFromWindowOpenUrl(url: string): string | null {
  try {
    return sessionIdFromPanePath(new URL(url).pathname);
  } catch {
    return null;
  }
}

function registeredPopoutState(sessionId: string | null): 'missing' | 'live' | 'destroyed' {
  if (!sessionId) return 'missing';
  const existing = popoutWindows.get(sessionId);
  if (!existing) return 'missing';
  if (!existing.isDestroyed()) return 'live';
  popoutWindows.delete(sessionId);
  return 'destroyed';
}

function focusBrowserWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function rememberClosedPopoutUrl(url: string): void {
  closedPopoutUrls.push(url);
  if (closedPopoutUrls.length > CLOSED_POPOUT_LIMIT) {
    closedPopoutUrls.shift();
  }
}

function focusRegisteredPopout(sessionId: string): BrowserWindow | null {
  const existing = popoutWindows.get(sessionId);
  if (!existing) return null;
  if (existing.isDestroyed()) {
    popoutWindows.delete(sessionId);
    return null;
  }
  focusBrowserWindow(existing);
  return existing;
}

function registerPopoutWindow(
  sessionId: string,
  popoutWindow: BrowserWindow,
  preload: string,
  devOrigin: string | null,
): void {
  popoutWindows.set(sessionId, popoutWindow);
  installContextMenu(popoutWindow.webContents, { isDev: !app.isPackaged });
  const popoutUrl = sessionPopoutUrl(sessionId);
  popoutWindow.once('closed', () => {
    if (popoutWindows.get(sessionId) === popoutWindow) {
      popoutWindows.delete(sessionId);
    }
    rememberClosedPopoutUrl(popoutUrl);
  });
  attachWindowOpenPolicy(popoutWindow.webContents, preload, devOrigin);
}

function createSessionPopout(sessionId: string): BrowserWindow {
  const preload = preloadPath();
  const popoutWindow = new BrowserWindow(
    popoutWindowOptions(preload, {
      platform: process.platform,
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    }),
  );
  registerPopoutWindow(sessionId, popoutWindow, preload, devOrigin());
  void popoutWindow.loadURL(sessionPopoutUrl(sessionId));
  return popoutWindow;
}

function openOrFocusSessionPopout(sessionId: string): BrowserWindow | null {
  const decision = resolveSessionPopoutOpen(sessionId, registeredPopoutState(sessionId));
  if (decision.action === 'deny') return null;
  if (decision.action === 'focus') {
    const existing = focusRegisteredPopout(decision.sessionId);
    if (existing) return existing;
  }
  return createSessionPopout(decision.sessionId);
}

function reopenClosedPopout(): void {
  while (closedPopoutUrls.length > 0) {
    const url = closedPopoutUrls.pop();
    const sessionId = url ? sessionIdFromWindowOpenUrl(url) : null;
    if (sessionId) {
      openOrFocusSessionPopout(sessionId);
      return;
    }
  }
}

function getCurrentMainWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = Array.from(mainWindows).find((window) => !window.isDestroyed()) ?? null;
  return mainWindow;
}

function getFocusedMainWindow(): BrowserWindow | null {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow && !focusedWindow.isDestroyed() && mainWindows.has(focusedWindow)) {
    return focusedWindow;
  }
  return getCurrentMainWindow();
}

function sendNavigate(window: BrowserWindow, path: string): void {
  const send = () => {
    setTimeout(() => {
      if (!window.isDestroyed()) {
        window.webContents.send('atrium:navigate', path);
      }
    }, 0);
  };

  if (window.webContents.isLoadingMainFrame() || !window.webContents.getURL()) {
    window.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

function navigateMainWindow(path: string): void {
  const target = getFocusedMainWindow() ?? createWindow();
  focusBrowserWindow(target);
  sendNavigate(target, path);
}

function handleDeepLink(url: string): boolean {
  const path = deepLinkToRoute(url);
  if (!path) return false;

  if (!app.isReady()) {
    pendingDeepLinkPaths.push(path);
    return true;
  }

  navigateMainWindow(path);
  return true;
}

function flushPendingDeepLinks(): void {
  const paths = pendingDeepLinkPaths.splice(0);
  for (const path of paths) navigateMainWindow(path);
}

/** Popout windows are real BrowserWindows and can open links of their own, so
 * the policy attaches recursively — otherwise a child falls back to Electron's
 * default `allow` and external links open inside the shell. */
function attachWindowOpenPolicy(contents: Electron.WebContents, preload: string, devOrigin: string | null): void {
  contents.on('did-create-window', (childWindow, details) => {
    installContextMenu(childWindow.webContents, { isDev: !app.isPackaged });
    const sessionId = sessionIdFromWindowOpenUrl(details.url);
    if (sessionId) {
      registerPopoutWindow(sessionId, childWindow, preload, devOrigin);
    } else {
      attachWindowOpenPolicy(childWindow.webContents, preload, devOrigin);
    }
  });

  // In-shell interception is scoped to our own `atrium:` scheme only. The
  // parser also recognizes https share-links (for OS-delivered / argv links),
  // but capturing those here would hijack any external `…/s|/e|/c/*` link a
  // user clicks inside a message and route it to a broken in-app view.
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${DEEP_LINK_SCHEME}:`) && handleDeepLink(url)) {
      event.preventDefault();
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${DEEP_LINK_SCHEME}:`) && handleDeepLink(url)) {
      return { action: 'deny' };
    }

    const decision = resolveWindowOpen(url, { appOrigin: APP_ORIGIN, devOrigin });
    switch (decision.kind) {
      case 'popout': {
        const sessionId = sessionIdFromWindowOpenUrl(url);
        const popoutDecision = resolveSessionPopoutOpen(sessionId, registeredPopoutState(sessionId));
        if (popoutDecision.action === 'focus') {
          if (focusRegisteredPopout(popoutDecision.sessionId)) {
            return { action: 'deny' };
          }
        }
        if (popoutDecision.action === 'deny') return { action: 'deny' };
        return {
          action: 'allow',
          overrideBrowserWindowOptions: popoutWindowOptions(preload, {
            platform: process.platform,
            shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
          }),
        };
      }
      case 'external':
        void shell.openExternal(url);
        return { action: 'deny' };
      case 'deny':
        return { action: 'deny' };
    }
  });
}

function showWindow(): void {
  const currentMainWindow = getCurrentMainWindow();
  if (!currentMainWindow) {
    createWindow();
    return;
  }
  focusBrowserWindow(currentMainWindow);
}

function toggleWindow(): void {
  const currentMainWindow = getCurrentMainWindow();
  if (currentMainWindow && currentMainWindow.isVisible() && currentMainWindow.isFocused()) {
    currentMainWindow.hide();
  } else {
    showWindow();
  }
}

function quitApp(): void {
  isQuitting = true;
  app.quit();
}

function createTray(): void {
  const icon = nativeImage.createFromPath(TRAY_ICON);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Atrium');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'New Window', click: () => createWindow() },
      { type: 'separator' },
      { label: 'Show Atrium', click: () => showWindow() },
      { type: 'separator' },
      {
        label: 'Quit Atrium',
        click: () => quitApp(),
      },
    ]),
  );
  tray.on('click', () => toggleWindow());
  console.log('[atrium] tray created (iconEmpty:', icon.isEmpty(), ', notifications:', Notification.isSupported(), ')');
}

function createDockMenu(): void {
  if (process.platform !== 'darwin') return;
  app.dock?.setMenu(Menu.buildFromTemplate([{ label: 'New Window', click: () => createWindow() }]));
}

function wireIpc(): void {
  // Synchronous bootstrap: the renderer needs serverUrl + token BEFORE its
  // module scripts run (createApi is constructed at import time).
  ipcMain.on('atrium:bootstrap', (event) => {
    event.returnValue = { serverUrl: SERVER_URL, session: loadSession() };
  });
  ipcMain.handle('atrium:session:set', (_event, value: DesktopSession) => {
    saveSession(value);
  });
  ipcMain.handle('atrium:session:clear', () => {
    clearSession();
  });
  ipcMain.handle('atrium:badge', (_event, count: number) => {
    const n = typeof count === 'number' && count > 0 ? Math.floor(count) : 0;
    if (process.platform === 'darwin') {
      app.dock?.setBadge(n > 0 ? String(n) : '');
    } else {
      app.setBadgeCount(n);
    }
  });
  ipcMain.handle('atrium:open-session-popout', (_event, sessionId: string) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
    openOrFocusSessionPopout(sessionId);
    return true;
  });
}

if (hasSingleInstanceLock) {
  registerDeepLinkProtocol();

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (!handleDeepLink(url)) {
      console.warn('[atrium] ignored unsupported deep link:', url);
    }
  });

  app.on('second-instance', (_event, argv) => {
    const deepLinkUrl = findDeepLinkArg(argv);
    const openRequestedTarget = () => {
      if (deepLinkUrl && handleDeepLink(deepLinkUrl)) return;
      showWindow();
    };

    if (app.isReady()) {
      openRequestedTarget();
    } else {
      void app.whenReady().then(openRequestedTarget);
    }
  });

  app.whenReady().then(() => {
    const coldStartDeepLinkUrl = findDeepLinkArg(process.argv);

    // Grant mic/camera (LiveKit voice/calls) + notifications to our origins.
    const allowed = new Set(['media', 'mediaKeySystem', 'notifications']);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(allowed.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

    console.log('[atrium] WEB_DIST =', WEB_DIST, '| SERVER_URL =', SERVER_URL);
    registerAppProtocol();
    nativeTheme.on('updated', () => {
      const background = launchBackgroundColor(nativeTheme.shouldUseDarkColors);
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.setBackgroundColor(background);
      }
    });
    wireIpc();
    Menu.setApplicationMenu(
      buildAppMenu({
        createMainWindow: () => {
          createWindow();
        },
        navigate: navigateMainWindow,
        openDocs: () => {
          void shell.openExternal(DOCS_URL);
        },
        quit: quitApp,
        reopenClosedPopout,
      }),
    );
    if (!getCurrentMainWindow()) createWindow();
    createTray();
    createDockMenu();
    setupAutoUpdate();
    if (coldStartDeepLinkUrl) {
      handleDeepLink(coldStartDeepLinkUrl);
    }
    flushPendingDeepLinks();

    app.on('activate', () => {
      if (!getCurrentMainWindow()) createWindow();
      else showWindow();
    });
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

// Close-to-tray keeps the app alive even with no windows; quit only on explicit
// request (tray menu / Cmd-Q / before-quit), so we don't auto-quit here.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});
