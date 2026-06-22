import { app, Notification } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

// Background auto-update against the configured publish feed (GitHub Releases,
// see electron-builder.yml). No-op in dev (unpackaged). On a packaged build it
// checks shortly after launch and every 6h, downloads in the background, and
// installs on quit — surfacing a native "update ready" notification that
// restarts-and-installs on click.
const CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function setupAutoUpdate(): void {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log('[atrium] update available:', info.version);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[atrium] update downloaded:', info.version);
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: 'Atrium update ready',
      body: `Version ${info.version} installs when you quit — click to restart now.`,
    });
    notification.on('click', () => autoUpdater.quitAndInstall());
    notification.show();
  });

  autoUpdater.on('error', (err) => {
    console.error('[atrium] auto-update error:', err instanceof Error ? err.message : String(err));
  });

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      console.error('[atrium] checkForUpdates failed:', String(err));
    });
  };

  setTimeout(check, CHECK_DELAY_MS);
  setInterval(check, CHECK_INTERVAL_MS);
}
