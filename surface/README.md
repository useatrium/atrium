# Atrium product workspace

`surface/` is the pnpm workspace for the Atrium product. The name means
"product surface," not frontend-only code: it contains the backend, web app,
desktop shell, mobile app, shared client/state package, Centaur integration
client, MCP server, deployment wrappers, and e2e tests.

Atrium is event-sourced at the collaboration layer: messages, session lifecycle
updates, reactions, calls, artifacts, and related product events flow through an
append-only `events` table plus focused read models. The server owns durable
product state; Centaur owns sandboxed agent execution.

## Stack

- `server/`: Node + TypeScript, Fastify + @fastify/websocket, `pg` (no ORM),
  plain SQL migrations with a tiny built-in runner. Owns auth, workspaces,
  channels, messages, sessions, artifacts, calls, push, provider credentials,
  app serving, and internal Centaur-facing routes.
- `web/`: Vite + React 19 + TypeScript + Tailwind 4.
- `desktop/`: Electron shell around the web app, including macOS packaging.
- `mobile/`: Expo app sharing the product protocol/state package.
- `shared/`: `@atrium/surface-client`, shared protocol types, timeline/app
  state, API and WebSocket client code used by web/mobile.
- `centaur-client/`: `@atrium/centaur-client`, a typed Centaur control-plane
  client plus durable event-stream reducer used by server/web/mobile.
- `mcp/`: Atrium MCP server exposing addressable entries as resources.
- `e2e/`: Playwright tests for product flows.
- Postgres 16 in Docker on host port **5433** (db/user/password all `atrium`).
- MinIO in Docker on **9000** (console **9001**, user `atrium` /
  `atrium-dev-secret`) for file uploads, using presigned PUT/GET and a bucket
  auto-created on first upload. `S3_ENDPOINT` is the public presign host;
  `S3_INTERNAL_ENDPOINT` is optional for server byte I/O. Override via
  `S3_BUCKET`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`.
- Auth: three paths, all ending in the same signed (HMAC-SHA256) httpOnly
  session cookie. Open handle login (`POST /auth/login {handle, displayName}`,
  no password — dev default, disable with `AUTH_OPEN=0`), email one-time codes
  (`/auth/email/request` + `/auth/email/verify`; codes print to the server log
  in dev, `EMAIL_MODE=resend` sends real mail), and Google OAuth when
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URL` are set.
  `GET /auth/methods` tells clients which paths are live.

## Where code lives

| Path | Purpose |
|---|---|
| `server/` | Atrium backend: REST, WebSocket, Postgres, migrations, S3/MinIO, sessions, artifacts, calls, push, provider auth, app serving. |
| `web/` | Browser client: chat, threads, sessions, artifacts, calls, provider connection UI. |
| `desktop/` | Electron wrapper and desktop packaging around the web client. |
| `mobile/` | Expo client for mobile chat/session/call workflows. |
| `shared/` | Shared product protocol types, reducers, API client, sync queue, prefs, formatting, and WebSocket helpers. |
| `centaur-client/` | Centaur API/event-stream types and reducers. This is Atrium's integration layer with the vendored runtime. |
| `mcp/` | MCP resources for addressable Atrium entries. |
| `e2e/` | Playwright browser tests. |
| `deploy/` | Production-oriented Docker/Caddy/Postgres deployment files. |
| `scripts/` | Workspace utility scripts such as WebSocket smoke testing. |

## Run it

Prereqs: Node 24+, pnpm 10+, Docker.

```bash
cd surface

# 1. start local services: Postgres, MinIO, and LiveKit (leave them running)
docker compose up -d --wait

# 2. install deps
pnpm install

# 3. apply SQL migrations (also runs automatically on server boot)
pnpm migrate

# 4. run both dev servers (server :3001, web :5173)
pnpm dev
```

Open http://localhost:5173. First boot auto-creates workspace **atrium** with
**#general**.

Useful:

```bash
pnpm lint          # Biome check (lint rules + formatting); same gate as CI Surface static
pnpm lint:fix     # auto-fix format + safe Biome fixes
pnpm check:migrations  # migration filename guard
pnpm test          # vitest across workspace packages
pnpm typecheck     # typecheck packages that expose a typecheck script
pnpm --filter @atrium/centaur-client build  # tsc build/typecheck for centaur-client
pnpm check         # lint + migration guard + typecheck + tests
pnpm e2e           # Playwright e2e tests
pnpm ws-smoke      # end-to-end WS proof + latency (needs `pnpm dev` running)
node scripts/ws-smoke.mjs 50            # bigger sample
BASE_URL=http://localhost:5173 node scripts/ws-smoke.mjs   # through the Vite proxy
```

Env (all have dev defaults): `DATABASE_URL`, `PORT` (3001), `SESSION_SECRET`.
Server tests create one Postgres database per Vitest worker, derived from
`ATRIUM_TEST_DB` or `atrium_test` by default. Use `ATRIUM_TEST_DB` to avoid
collisions between concurrent worktrees and `ATRIUM_TEST_WORKERS` to tune
parallelism.

## Two-browsers manual test script

Use two different browsers (or one normal + one private window; sessions are
cookie-based, two tabs in the same profile share one login).

1. Browser A: log in as `ana` / "Ana". Browser B: log in as `ben` / "Ben".
2. Both land in **#general**. Header should show **2 here** with both initial
   dots. Presence is view-based (who has the channel open right now). When B
   switches channels in step 6, A's #general header drops to **1 here**.
3. B types "hello from ben" + Enter → appears instantly in A with author +
   time, no reload. A's message renders in B the same way.
4. A sends several messages quickly → they appear grouped under one author
   header; the pending state is invisible-fast locally (no flicker, no dupes).
5. A hovers B's message → "↩ Reply" → thread panel opens on the right. A
   replies. B sees "1 reply →" appear under the root message live; clicking it
   opens the same thread.
6. B switches to **#dev-chat** (create it with the + in the sidebar if needed).
   A posts in #general → B's sidebar shows #general bold with an indigo unread
   dot. B clicks #general → unread clears, message is there.
7. Reload A mid-conversation → still logged in, full history restores, presence
   comes back.
8. Kill the network on A (devtools → offline) for a few seconds while B posts,
   then go back online → A reconnects with backoff and catches up the missed
   message (fetched with `after_id`).
9. Day separators: messages from previous days render under "Today" /
   "Yesterday" / weekday labels.

## API surface

Routes live in `server/src/routes/`, one file per area — read the route file
for the current contract rather than trusting a listing here to stay fresh.
The areas: `auth` (handle / email-code / Google login), `workspaces`,
`channels`, `messages`, `sessions` + `session-interactions` (spawn, stream,
steer, questions), `artifacts` + `channel-artifact-writeback`, `uploads` +
`files` + `files-hub`, `entries` (addressable entry refs), `activity` (the
Attention feed), `calls`, `push`, `me`, `markup-feedback`, `atrium`
(agent-facing team context), `client-errors`, `health` — plus `sync` and the
`internal-*` routes consumed by Centaur/node-sync rather than browsers.

Realtime is `WS /ws` (`server/src/routes/websocket.ts`): the client subscribes
to channel IDs and receives `{type:"event", event}` fanout and presence
updates, with a protocol-level ping/pong heartbeat plus an app-level ping.

Presence semantics: channel presence is focus-based ("who is actively viewing
this channel"), because clients subscribe broadly for event fanout and unread
counts. Session presence is subscription-based on `session:<id>` keys, because
clients subscribe to those keys only while a session pane is open.

## Event model

One append-only `events` table (`id bigserial`, `workspace_id`, `channel_id`,
`thread_root_event_id`, `type`, `actor_id`, `payload jsonb`, `created_at`).
Event families include `workspace.*`, `channel.*`, `message.*`, `session.*`,
`call.*`, reactions, drafts, and artifact-related product events. Read models
(`workspaces`, `channels`, `users`, `sessions`, artifact/session projections,
and related tables) are updated in the same transaction as the event insert
where the route needs a durable projection. A message with
`thread_root_event_id` set is a reply; roots render in the channel timeline with
a reply count, with edits folded through the latest `message.edited` event.

## Artifact workspace model

Artifact identity is workspace-scoped by canonical path. The reserved prefixes
are:

- `scratch/<session-id>/...`: private durable files for one session.
- `shared/global/...`: workspace-wide artifacts.
- `shared/apps/...`: static app artifacts and app bundles.
- `shared/channels/<channel-id>/...`: channel-scoped artifacts.

A session can write its scratch, `shared/global`, `shared/apps`, and its active
channel root. Other readable channel roots remain visible for context but are
read-only from that session. Git repos and build/cache directories are not
artifact-synced; repo state is handled by Git and session WIP snapshots.
