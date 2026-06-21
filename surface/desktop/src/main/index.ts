import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  Notification,
  ipcMain,
  net,
  protocol,
  session,
  shell,
} from 'electron';
import { APP_ORIGIN, APP_SCHEME, RENDERER_DEV_URL, SERVER_URL, WEB_DIST } from './config.js';
import { clearSession, loadSession, saveSession, type DesktopSession } from './session.js';

// Must run before app `ready`: marks `app://` as a standard, secure origin so
// the bundled UI gets a secure context (required for getUserMedia / WebRTC).
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
  },
]);

let mainWindow: BrowserWindow | null = null;

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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[atrium] renderer loaded:', target);
    const probe = `(async () => {
      const base = window.atrium?.serverUrl ?? null;
      let serverFetch = 'skip';
      let loginRoundTrip = 'skip';
      if (base) {
        try {
          const r = await fetch(base + '/auth/methods');
          serverFetch = r.ok ? ('ok ' + JSON.stringify(await r.json())) : ('http ' + r.status);
        } catch (e) { serverFetch = 'ERR ' + (e && e.message ? e.message : e); }
        try {
          // Full cross-origin token flow: POST login (preflights content-type)
          // then GET /auth/me with Authorization (preflights the auth header).
          const lr = await fetch(base + '/auth/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ handle: 'desktopprobe', displayName: 'Desktop Probe' }),
          });
          if (!lr.ok) { loginRoundTrip = 'login http ' + lr.status; }
          else {
            const lj = await lr.json();
            const mr = await fetch(base + '/auth/me', { headers: { authorization: 'Bearer ' + lj.token } });
            loginRoundTrip = 'login=' + (lj.token ? 'token' : 'notoken') + ' me=' + (mr.ok ? 'ok' : ('http' + mr.status));
          }
        } catch (e) { loginRoundTrip = 'ERR ' + (e && e.message ? e.message : e); }
      }
      return JSON.stringify({
        secureContext: window.isSecureContext,
        reactMounted: (document.getElementById('root')?.childElementCount ?? 0) > 0,
        bridge: !!window.atrium,
        serverUrl: base,
        serverFetch,
        loginRoundTrip,
      });
    })()`;
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
    if (Notification.isSupported()) {
      new Notification({ title: opts.title, body: opts.body }).show();
    }
  });
}

app.whenReady().then(() => {
  // Grant mic/camera to our trusted origins (LiveKit voice/calls).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'mediaKeySystem');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  console.log('[atrium] WEB_DIST =', WEB_DIST, '| SERVER_URL =', SERVER_URL);
  registerAppProtocol();
  wireIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
