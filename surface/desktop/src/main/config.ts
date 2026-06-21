import { join } from 'node:path';
import { app } from 'electron';

/** Privileged scheme used to serve the bundled web UI as a secure origin. */
export const APP_SCHEME = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://atrium`;

/**
 * Atrium API/WS origin (token auth). Defaults to the local prod compose
 * (docker-compose.prod.yml maps HTTP_HOST_PORT=18080), which has LiveKit
 * configured so voice/calls can be exercised. Override with ATRIUM_SERVER_URL.
 */
export const SERVER_URL = process.env.ATRIUM_SERVER_URL ?? 'http://localhost:18080';

/**
 * Optional renderer URL for desktop-shell development (e.g. the web vite dev
 * server at http://localhost:5173 for HMR). When null, the bundled web build is
 * served over `app://`.
 */
export const RENDERER_DEV_URL = process.env.ATRIUM_RENDERER_URL ?? null;

/**
 * Bundled @atrium/web build directory. Dev: web/dist next to the package.
 * Packaged: copied into the app's Resources via electron-builder extraResources.
 */
export const WEB_DIST =
  process.env.ATRIUM_WEB_DIST ??
  (app.isPackaged
    ? join(process.resourcesPath, 'web-dist')
    : join(app.getAppPath(), '..', 'web', 'dist'));

/** Menu-bar/tray template icon (dev: package resources/; packaged: Resources/). */
export const TRAY_ICON = app.isPackaged
  ? join(process.resourcesPath, 'resources', 'trayTemplate.png')
  : join(app.getAppPath(), 'resources', 'trayTemplate.png');
