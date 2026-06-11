# Phase 1 "Places" — progress

Status: **working end-to-end**, verified 2026-06-10 on this machine.

## What works

- Event-sourced core: append-only `events` table is the only message store;
  `workspaces`/`channels`/`users`/`sessions` read models updated in the same
  transaction. Event types: `workspace.created`, `channel.created`,
  `message.posted`, `message.edited`.
- Auth: handle+displayName login, HMAC-signed httpOnly session cookie,
  `/auth/me`, logout. Cookie verify is constant-time and unit-tested.
- REST: workspaces, channels (create + 409 on dup), channel messages with
  `before_id`/`after_id`/`limit` (newest-last), thread reads, message post with
  empty/oversize (8KB → 413) rejection. Default workspace `atrium` + `#general`
  auto-created on first boot.
- WS: cookie-authed `/ws`, subscribe-by-channel fanout, presence broadcast on
  join/leave, protocol ping/pong heartbeat with dead-socket reaping, app-level
  ping. Client reconnects with exponential backoff + jitter and catches up via
  `after_id` per loaded channel (`after_id` reads include thread replies so
  reply counts/open threads heal too).
- Client: dark dense UI — sidebar (channels, create-channel, presence counts,
  unread dots, connection indicator), timeline (day separators, 5-min
  consecutive-author grouping, load-earlier pagination preserving scroll),
  right-side thread panel, composer (Enter sends / Shift+Enter newline),
  optimistic send reconciled by `client_msg_id` (pure reducer, unit-tested),
  failed-send retry, colored-initial avatars, presence dots in header.

## How verified

- `pnpm -r test` — **14 server tests + 12 web reducer tests, all green**:
  - server: cookie sign/verify (5), event insert + thread guards + fanout
    ordering + presence (4), pagination before/after/replies/edit-folding (5).
    These hit a real Postgres (`atrium_test` db, auto-created).
  - web: optimistic reconciliation (replace-by-client_msg_id, idempotent POST+WS
    echo, ordering with concurrent senders, failed sends), dedupe/ordering,
    reply-count double-count guard (`lastReplyId`), history merge, edit fold.
- `pnpm typecheck` clean on both packages.
- curl proofs (against `pnpm dev`):
  - login/me/logout, 401 without cookie
  - `POST /api/messages` → 201 with event echoing `client_msg_id`
  - empty text → 400, 9KB text → 413, dup channel → 409
  - thread reply → root shows `replyCount:1,lastReplyId:5`; `after_id=3`
    returns the reply with `hasMore:false`
- `scripts/ws-smoke.mjs` (two REST users, one WS subscriber):

  ```
  OK: 50 messages posted by bob → all received on alice's WS, in id order
  OK: every event echoed its client_msg_id and author
  send→WS-deliver latency over 50 msgs: p50=7.5ms p95=11.8ms max=12.4ms   (via Vite proxy :5173)
  send→WS-deliver latency over 20 msgs: p50=7.0ms p95=34.7ms max=34.7ms   (direct :3001)
  ```

- Real-browser multiplayer test (two separate headless Chromium instances,
  Playwright via dev-browser): login both users; B's message appeared live in
  A; thread opened from hover-Reply; A's thread reply bumped "1 reply →" in B
  live; unread dot appeared in B's sidebar for #general while B sat in
  #dev-chat and cleared on click; **offline/online chaos**: A taken offline, B
  posted, A restored → reconnect + `after_id` catch-up delivered the missed
  message; reload restored session, history, presence; sent messages appear
  exactly once (no optimistic dupes). Screenshots looked clean (dark, dense,
  grouped).

## Latency

p50 send→WS-deliver ≈ **7.5ms** localhost through the Vite proxy (p95 11.8ms,
n=50). The PLAN budget is p50 < 150ms send→render; render adds one React commit
on top of delivery, so there is roughly 140ms of headroom locally. Not yet
measured over a real network.

## Known gaps / honest notes

- **Presence semantics**: presence = WS clients subscribed to a channel (as
  specced), but the web client subscribes to *all* channels to power unread
  indicators — so every online user shows "present" in every channel. A
  follow-up could add an `activeChannelId` signal to make presence mean "viewing
  this channel".
- **message.edited** is modeled (migration, read-fold, reducer + tests) but
  there is no edit endpoint/UI yet — the locked Phase 1 API surface doesn't
  include one.
- Unread indicators are in-memory only (reset on reload) and there's no mention
  /notification system.
- Thread reads are capped at 1000 replies, no pagination inside threads.
- Sessions never expire server-side (cookie maxAge 30d only); logout deletes
  the session row.
- Single-process fanout: WS hub is in-memory, so one server instance only (fine
  for the prototype; Phase 2+ would need a bus if we shard).
- No rate limiting; channel-create is workspace-global (no membership model —
  everyone sees every channel by design for now).
- `pnpm dev` (tsx watch) restarts the server on file edits; clients reconnect
  and catch up automatically (verified via the offline test path).
- Not yet done from the cross-cutting list: Playwright e2e checked into the
  repo (browser verification above was run ad hoc), recorded demo, /code-review
  of the diff.

## Mobile app (Expo) — added 2026-06-10

- **`shared/` (`@atrium/surface-client`)**: protocol types, pure timeline
  state, `appReducer`, session entity folds, parameterized API client
  (`createApi({baseUrl, getToken})`) and reconnecting `useWs` hook extracted
  from the web app; web migrated onto it (thin `web/src/api.ts` instance +
  `sessions/types.ts` re-export shim keep web imports unchanged). Reducer
  tests moved to `shared/test`.
- **Server**: bearer-token auth (`Authorization: Bearer` everywhere, `?token=`
  on `/ws` and `/api/files/:id`; `POST /auth/login` returns the token);
  Expo push fanout on DMs/@mentions (`src/push.ts`, `push_tokens` table via
  migration 008, register/unregister routes, live-viewer skip, dead-token
  pruning). Tests: `tokenAuth.test.ts`, `push.test.ts` (53 server tests).
- **`mobile/` (`@atrium/mobile`)**: Expo SDK 56 + expo-router app — login
  (server origin + handle), channel/DM list with unread/mention badges,
  FlashList v2 timeline (bottom-anchored, `onStartReached` history paging,
  day separators, author grouping), composer with optimistic send/retry,
  image+file attachments via presigned PUT, long-press reactions/edit/delete,
  threads, search with jump-to-message, presence counts, typing indicators,
  push registration + notification deep links. Session rows render as status
  cards (panes stay web-only). Styling mirrors the web zinc theme.
- **Verified**: `pnpm -r typecheck` green (server/shared/web/mobile);
  103 unit tests pass; `expo export` bundles both platforms cleanly through
  the pnpm monorepo; bearer login + channels + seeded messages exercised
  against the live dev server. Verified 2026-06-11 in the iOS 26.1 simulator
  (iPhone 17, Expo Go): auto-login via token auth, channel list with all
  channels, #general timeline with author grouping, WS presence ("1 here
  now"), expo-router deep link straight into a channel, live WS fanout +
  reconnect catch-up healing + typing indicator (driven from a second client
  while watching the simulator). Gotcha: `react` must be pinned EXACTLY to
  react-native's bundled renderer version (19.2.3 for RN 0.85.3) — a newer
  react patch hard-crashes at startup. Android still unverified (no SDK on
  this machine). Push needs `eas init` + a dev build — see `mobile/README.md`.
- **WS auth race fixed** (found via the mobile client, affected web too): the
  /ws route awaited the auth DB lookup before attaching socket handlers, so
  subscribe/focus/ping frames sent the instant the socket opened could be
  silently dropped — leaving a client on a "live" socket subscribed to
  nothing (no presence, no fanout, no reconnect banner). Handlers now attach
  synchronously and frames buffer until auth resolves (`wsRace.test.ts`
  regression-tests the racing burst against a real listening server).

## Mobile P1 hardening — 2026-06-11

- **Signed file URLs**: session tokens no longer appear in any URL. In-app
  images load via `Authorization` header (expo-image source.headers);
  external opens mint a 5-minute file-scoped HMAC URL via
  `GET /api/files/:id/url` (`src/filesign.ts`, `fileSign.test.ts`). Bare
  unauthenticated file fetches now 401.
- **Session expiry** (migration 009): auth_sessions expire after 30 idle
  days with sliding renewal when <15 days remain; expired rows reaped
  opportunistically on login. Client 401s route back to login.
- **Foreground reconnect**: shared `useWs` gained an `onWake` option —
  mobile binds AppState 'active' to skip reconnect backoff or ping-probe a
  suspended-dead socket (5s deadline) instead of waiting out the 60s idle
  timer. (Not provable in the iOS simulator, which doesn't truly suspend
  apps — verify on device.)
- **Cold-start notification taps**: `getLastNotificationResponse()` handled
  with a once-guard, so a push tap that launches the killed app navigates to
  its channel. (Full push flow still needs the EAS dev build.)
- Verified live in the simulator: signed-URL mint → anonymous 302, bare
  401, real image upload → header-auth render arriving over live WS.
