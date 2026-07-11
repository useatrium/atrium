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
n=50). The initial build plan budget is p50 < 150ms send→render; render adds one React commit
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

## Parallel codex-worker round — 2026-06-11

Four workstreams built concurrently by Codex CLI workers in isolated
worktrees, integrated sequentially (all merged to master, 128 tests green):

- **Read cursors** (migration 010): `channel_read_cursors` + `POST
  /api/channels/:id/read` (GREATEST upsert — only advances), per-channel
  `lastReadEventId`/`latestEventId` in /api/channels, `{type:'read'}` WS
  fanout to the same user's other devices, reducer cold-unread derivation +
  `read-cursor` action, throttled mark-read glue in both clients. Reading on
  the phone now clears the web badge and vice versa; badges survive restarts.
  Verified live (advance / no-regress / payload).
- **Mobile offline cache**: expo-sqlite-backed event cache (newest 300 per
  channel) hydrates the reducer before the WS connects, so cold starts render
  from disk and after_id catch-up only fetches the gap. Cache cleared on
  logout. Needs an on-device pass (sqlite runtime not exercised in tests).
- **Push hardening**: thread replies notify prior thread authors ("X replied
  in #chan"; precedence dm > mention > thread), Expo receipts checked ~15 min
  after send with DeviceNotRegistered pruning, `PUSH_REDACT=1` keeps message
  bodies off Expo's servers.
- **Rate limiting + initials**: @fastify/rate-limit (global 600/min/IP,
  login 30/min, `rateLimit: false` escape hatch for tests) and
  `initials('Gary (mobile)') → 'GM'` (punctuation-stripping) with tests.

Audit recheck (read-only agent): all three June P1s confirmed fixed in
8951874 — zombie SPAWNING cards, silent steer failures, permalink dead-end.

Orchestration note: the codex plugin's rescue agents background their jobs
and exit, which let the harness reap their worktrees mid-run (two jobs died,
one had to be harvested from a /tmp git dir). Reliable pattern: `codex exec`
driven directly in self-managed `git worktree add` checkouts.

## Parallel round 2 + codex review — 2026-06-11

Five workstreams by codex exec workers in self-managed worktrees, merged
sequentially, then a codex read-only review of the integrated diff:

- **Channel mutes** (migration 011): mute toggle on web sidebar rows +
  mobile long-press; muted channels never badge and never push; `{type:
  'muted'}` WS frame syncs the user's other devices.
- **Mobile offline send queue + drafts**: network-failed sends persist in a
  sqlite outbox (FIFO flush on reconnect/wake, original clientMsgId), drafts
  per channel/thread survive restarts.
- **Mobile agent-session viewer**: `/session/[id]` screen streams the
  Centaur SSE feed via expo/fetch + centaur-client's platform-agnostic
  parser — live status/cost/elapsed, tool-call cards, result, steer
  (driver-only) and two-step cancel; timeline session cards now tap through.
- **Deployment packaging** (`surface/deploy/`): multi-stage server image,
  prod compose (secrets required via :?), Caddy config, Tailscale + VPS
  guides; worker boot-tested an isolated stack (healthz + login) before
  committing.
- **Playwright e2e** (`surface/e2e`): 8 specs — login, realtime two-context,
  threads, reactions, edit/delete, unread badges, cross-device read sync,
  search jump — against a dedicated atrium_e2e DB on override ports; root
  script `pnpm e2e`. Caught a real integration regression on landing (mute
  button broke unread-badge selectors).
- **Codex review findings fixed**: DM-session ACL (any authed user could
  fetch/stream any session — now 404 via canAccessChannel), idempotent
  sends by client_msg_id (migration 012 — outbox retries can't duplicate),
  401 invalidation clears the mobile cache/outbox (cross-account leak),
  unmute re-derives badges, draft-load no longer clobbers typed text,
  postgres host port binds loopback.

141 unit tests + 8 e2e green. Still needs on-device passes: session viewer
streaming, outbox wake-flush, sqlite cache.

## Round 3 — CI, mobile spawn + mentions, polish; prod stack live — 2026-06-11

- **CI** (.github/workflows/ci.yml): typecheck + unit suites + Playwright
  e2e on push/PR (postgres service, centaur-client built first, report
  artifact on failure). Workflow replicated locally end-to-end by the worker.
- **Mobile @agent spawn + mention autocomplete**: trigger grammar extracted
  to shared (spawnTrigger.ts/mentions.ts; web re-exports, behavior
  preserved), optimistic spawn flow in mobile ChatProvider, suggestion
  overlay (@agent pinned at message start, lazy user cache). Review fixes:
  lost-POST spawn reconciliation via client_spawn_id echo, attachments
  fall through to plain send, bare @agent prompts for a task.
- **Mobile polish**: in-app media lightbox (header-auth expo-image, pinch on
  iOS / double-tap both platforms — Android pan is a known P3 gap), copy
  text (expo-clipboard), bounded scrollToIndex retries for search jumps,
  centralized haptics.
- **Prod stack live on this Mac** (atrium-prod compose project): server
  :13001 + minio :19000 + loopback postgres :15433, real secrets in
  surface/deploy/.env (gitignored), S3_ENDPOINT on the Tailscale IP.
  Verified over Tailscale (100.82.11.20): healthz, login, channels, full
  presigned upload→fetch round-trip. Phone URL: http://100.82.11.20:13001
  (requires Tailscale on the phone; Docker Desktop must auto-start).
- **Session viewer live check**: screen renders real session state
  (status/cost/elapsed/read-only footer) against a spawned session; the
  RUN ITSELF failed 401 — the restarted dev server lacks CENTAUR_API_KEY
  (Gary's normal env has it). Streaming-path live test pending the key.
- 145 unit + 8 e2e green after review fixes.

## Round 4 + reviews — 2026-06-11
- Session browser (GET /api/sessions, web sidebar + modal, mobile screen),
  private channels + group DMs (migration 013), mobile code-block formatting
  (shared tokenizer), email-code auth + Google OAuth scaffold (migration 014,
  AUTH_OPEN compat). Web now served from the prod stack via Caddy at
  http://100.82.11.20:18080.
- Reviews this round: my own seam pass (caught session-list private/gdm leak),
  3 parallel self-run review agents (security/state/parity — found 7 P1s incl.
  session seat-hijack, private-channel push leak, file ACL, cache cross-session
  leak, ghost timelines, silent mobile failures), and a Codex pass on the
  salvaged auth (atomic email-code redemption race, OAuth state-CSRF +
  unverified id_token, EMAIL_MODE prod leak). All fixed + regression-tested.
- Auth worker stalled on its e2e step (~1h); salvaged its complete-but-
  uncommitted work, caught the compat regression it introduced (handle login
  moved behind a collapsed dev-login panel broke the e2e selectors), fixed.
- 172 unit + 8 e2e green; pushed (ec47ea2); prod stack rebuilt + verified over
  Tailscale (healthz, auth methods, session list, web SPA).
