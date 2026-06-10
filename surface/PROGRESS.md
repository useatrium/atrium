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
