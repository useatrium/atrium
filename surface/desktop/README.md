# Atrium desktop

An Electron shell around the `@atrium/web` build. It serves the bundled web app
from a secure `app://` origin (so WebRTC voice works), authenticates with a
bearer token stored in the OS keychain, and adds a tray, native notifications,
close-to-tray, a dock badge, and background auto-update.

Chosen over Tauri because LiveKit voice needs Chromium's `getUserMedia`, which
Tauri's macOS WebView (WKWebView) disables when embedded.

## Develop

```bash
# point at a running Atrium server (defaults to http://localhost:18080)
ATRIUM_SERVER_URL=http://localhost:13001 pnpm --filter @atrium/desktop dev
```

- `ATRIUM_SERVER_URL` — the API/WS origin the app talks to (token auth).
- `ATRIUM_RENDERER_URL` — load the renderer from a vite dev server (e.g.
  `http://localhost:5173`) for HMR instead of the bundled build.

The server must allow the desktop origin via CORS — it's in the allowlist by
default (`ATRIUM_CORS_ORIGINS`, defaults to `app://atrium`).

## Build a signed + notarized macOS .dmg

Requires a *Developer ID Application* identity in the login keychain and an App
Store Connect API key for notarization.

```bash
APPLE_API_KEY=~/path/AuthKey_XXXX.p8 \
APPLE_API_KEY_ID=XXXX \
APPLE_API_ISSUER=<issuer-uuid> \
  pnpm --filter @atrium/desktop run package:mac
```

This builds the web bundle, signs + notarizes the `.app`, builds the `.dmg` and
`.zip`, then (via `build/notarize-dmg.cjs`) signs + notarizes + staples the
`.dmg` wrapper too. Output lands in `surface/desktop/release/`. Without the
`APPLE_*` vars it produces an unsigned build.

## Auto-update

The app uses `electron-updater` against this repo's **GitHub Releases**
(configured under `publish:` in `electron-builder.yml`). A packaged app checks
~10s after launch and every 6h, downloads new versions in the background,
installs on quit, and shows a notification (click to restart-and-install now).
It is a no-op in development.

To ship an update:

1. Bump `version` in `package.json`.
2. Publish a release (uploads the `.zip`, `.dmg`, and `latest-mac.yml` to a
   GitHub release):

   ```bash
   GH_TOKEN=<github-token-with-repo-scope> \
   APPLE_API_KEY=… APPLE_API_KEY_ID=… APPLE_API_ISSUER=… \
     pnpm --filter @atrium/desktop exec electron-builder --mac --publish always
   ```

Installed apps read `latest-mac.yml` from the release, download the new `.zip`,
and update on next quit. macOS updates require the build to be signed (the
notarized identity above) — Squirrel.Mac verifies the signature.
