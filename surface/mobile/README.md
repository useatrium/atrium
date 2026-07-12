# Atrium mobile (Expo / React Native)

iOS + Android client for the Atrium surface. Shares its protocol types,
timeline state, reducer, API client and WebSocket layer with the web app via
`@atrium/surface-client` (../shared).

License note: Atrium mobile is part of Atrium and is licensed under
AGPL-3.0-or-later. The local `LICENSE` file is the Expo template notice retained
for the template material credited there; see the repository root `LICENSE` and
`NOTICE` files for the project license.

## Run it (development)

Prereqs: the surface stack running (see ../README.md), plus Xcode (iOS
simulator) and/or Android Studio (emulator).

```bash
cd surface
pnpm install

# start postgres/minio + the API server in one terminal
docker compose up -d --wait && pnpm --filter @atrium/server dev

# start the app in another
cd mobile
npx expo start            # press i for iOS simulator, a for Android
```

Sign in with the server origin (simulator: `http://localhost:3001`; physical
device: `http://<your-mac-LAN-IP>:3001`), a handle, and a display name.

> **Loopback trap:** the API server binds `127.0.0.1` by default, so the
> LAN-IP origin only works if you start it with `HOST=0.0.0.0`. A session
> signed in against an origin the server no longer answers doesn't fail
> loudly — the app keeps painting cached SQLite chat behind a permanent
> "Reconnecting…" banner with zero live sockets. On a simulator always sign
> in with `http://localhost:3001`; on a physical device use
> `HOST=0.0.0.0 pnpm --filter @atrium/server dev` and keep Metro running.
> After the server rebinds (or Metro dies), relaunch the dev client rather
> than trusting a multi-day simulator process.

Dev shortcut: auto-login on boot (dev builds only):

```bash
EXPO_PUBLIC_AUTO_LOGIN="http://localhost:3001|alice|Alice" npx expo start
```

## Architecture

- `app/`: expo-router screens. `(app)/` is the authed group: channel list,
  `channel/[id]` timeline, `thread/[rootId]`, `session/[id]` live transcript,
  `sessions` list, `settings`, and search / new-dm / new-channel modals.
  `login.tsx` sits outside the group behind a `Stack.Protected` guard.
- `src/lib/session.tsx`: login session (server origin + bearer token) in
  SecureStore. The server returns the token from `POST /auth/login`; HTTP
  sends it as `Authorization: Bearer`, the WS upgrade and file URLs as
  `?token=`.
- `src/lib/chat.tsx`: the app store, with a shared `appReducer` and reconnecting
  WebSocket with after_id catch-up, optimistic sends, uploads (presigned PUT),
  jump-to-message. Mirrors `web/src/Chat.tsx`.
- `src/components/Timeline.tsx`: FlashList v2 anchored at the bottom
  (`startRenderingFromBottom`), `onStartReached` pages older history in.
- Styling/theming: inline style objects against `src/lib/theme.ts`, with
  `buildColors(scheme, accent, highContrast)` palettes behind
  `ThemeProvider`/`useTheme()`. Light/dark follows the OS by default
  (`userInterfaceStyle: "automatic"`); user overrides (theme, accent, text
  size, high contrast, reduced motion) live in the Settings screen, persist in
  AsyncStorage (`atrium.prefs.v1`, survives logout), and sync across devices
  via `PATCH /api/me/prefs` + the `{type:'prefs'}` WS fan-out
  (`PrefsSessionBridge` in `app/_layout.tsx` owns the reconcile rule: a
  non-default remote wins; local is re-pushed only over server defaults).

## Push notifications

The client code is fully wired (`src/lib/notifications.ts`): permission
prompt, Expo push token registration with the server, banner suppression for
the channel you're reading, tap-to-open deep link. The server sends pushes for
DMs and @mentions (skipping users actively viewing the channel) and prunes
dead tokens.

What it needs from you (one-time, interactive):

1. `npm i -g eas-cli && eas login`
2. `cd surface/mobile && eas init`: links the app to an EAS project and
   stamps `extra.eas.projectId` into app.json (the code reads it from there).
3. `eas build --profile development --platform ios` (and/or `android`); push
   does not work in Expo Go; install the resulting dev build on your device.
   iOS needs your Apple Developer account when prompted; EAS manages the APNs
   key. Android FCM is configured automatically by EAS.
4. Run `npx expo start` and open the dev build; notifications now arrive for
   DMs/mentions while the app is backgrounded or closed.

## Known gaps vs web

- Quick switcher (⌘K) is replaced by the search modal.
- No message-search jump from a cold start into very old history (search jumps
  work for loaded ranges).
- Web's settings popover and the mobile Settings screen expose the same prefs;
  notifications config is still per-platform (web: desktop notifications
  toggle; mobile: push via EAS, see above).

(Previously listed gaps that have since shipped: `@agent` composer spawn,
live session viewing/steering at `session/[id]`, sessions list, emoji
reactions, message edit/delete, uploads, jump-to-message.)
