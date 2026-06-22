import { join } from 'node:path';
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
  protocol,
  session,
  shell,
} from 'electron';
import {
  APP_ORIGIN,
  APP_SCHEME,
  RENDERER_DEV_URL,
  SERVER_URL,
  TRAY_ICON,
  WEB_DIST,
} from './config.js';
import { clearSession, loadSession, saveSession, type DesktopSession } from './session.js';
import { setupAutoUpdate } from './updater.js';

// Must run before app `ready`: marks `app://` as a standard, secure origin so
// the bundled UI gets a secure context (required for getUserMedia / WebRTC).
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: '#09090b',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const target = RENDERER_DEV_URL ?? `${APP_ORIGIN}/index.html`;

  // Close-to-tray: the app stays alive in the background (always-on, warm WS)
  // so re-opening is instant. Quit only via the tray menu / Cmd-Q.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-finish-load', () => {
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
    void mainWindow?.webContents
      .executeJavaScript(probe)
      .then((result) => console.log('[atrium] renderer probe:', result))
      .catch((err) => console.error('[atrium] probe failed:', String(err)));
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error('[atrium] renderer failed:', code, desc, url);
  });

  // External (http/https) links open in the OS browser, not inside the shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  void mainWindow.loadURL(target);
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow(): void {
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(TRAY_ICON);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Atrium');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Atrium', click: () => showWindow() },
      { type: 'separator' },
      {
        label: 'Quit Atrium',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => toggleWindow());
  console.log(
    '[atrium] tray created (iconEmpty:',
    icon.isEmpty(),
    ', notifications:',
    Notification.isSupported(),
    ')',
  );
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
  ipcMain.handle('atrium:notify', (_event, opts: { title: string; body?: string }) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: opts.title, body: opts.body });
    notification.on('click', () => showWindow());
    notification.show();
  });
  ipcMain.handle('atrium:badge', (_event, count: number) => {
    const n = typeof count === 'number' && count > 0 ? Math.floor(count) : 0;
    if (process.platform === 'darwin') {
      app.dock?.setBadge(n > 0 ? String(n) : '');
    } else {
      app.setBadgeCount(n);
    }
  });
}

app.whenReady().then(() => {
  // Grant mic/camera (LiveKit voice/calls) + notifications to our origins.
  const allowed = new Set(['media', 'mediaKeySystem', 'notifications']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  console.log('[atrium] WEB_DIST =', WEB_DIST, '| SERVER_URL =', SERVER_URL);
  registerAppProtocol();
  wireIpc();
  createWindow();
  createTray();
  setupAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

// Close-to-tray keeps the app alive even with no windows; quit only on explicit
// request (tray menu / Cmd-Q / before-quit), so we don't auto-quit here.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});
