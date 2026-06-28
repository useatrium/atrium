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

The app uses `electron-updater` against **GitHub Releases** (configured under
`publish:` in `electron-builder.yml`). A packaged app checks ~10s after launch
and every 6h, downloads new versions in the background, installs on quit, and
shows a notification (click to restart-and-install now). No-op in development.
macOS updates require a signed build — Squirrel.Mac verifies the signature.

### Pick a feed

`electron-updater` reads GitHub Releases from the repository configured under
`publish:` in `electron-builder.yml`. Public source releases can use this repo
directly. If you ever move binaries to a separate releases repo, keep that repo
public so the app does not need an embedded token.

### Publish a release

```bash
# token comes from the gh CLI login (repo scope) — no secret to paste
GH_TOKEN=$(gh auth token) \
APPLE_API_KEY=~/path/AuthKey_XXXX.p8 APPLE_API_KEY_ID=XXXX APPLE_API_ISSUER=<uuid> \
  pnpm --filter @atrium/desktop exec electron-builder --mac --publish always
```

This signs + notarizes and uploads `.dmg`, `.zip`, `.blockmap`, and
`latest-mac.yml` to a **draft** release tagged `v<version>`. electron-updater
ignores drafts and prereleases, so **publish the release** (un-draft it) before
expecting clients to see it:

```bash
gh release edit v0.1.0 -R gbasin/<releases-repo> --draft=false
```

### Verify end-to-end (needs two versions)

One release can't test updating — the updater only fires when an *installed*
build sees a *newer* release:

1. Publish **v0.1.0**, un-draft it, install that `.dmg`, and launch the app.
2. Bump `version` to **0.1.1** in `package.json`, publish again, un-draft.
3. Within ~10s the running app finds v0.1.1, downloads it, and shows the
   "update ready" notification; it installs on the next quit.
