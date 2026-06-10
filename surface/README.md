# Atrium surface — "Places" (Phase 1)

Minimal, fast, multiplayer team chat: workspace → channels → threads → messages,
with presence. Event-sourced from day one: every message is a row in an
append-only `events` table; messages are read straight off the event log (no
separate messages table). This is the substrate agent-session panes attach to
in Phase 2.

## Stack

- `server/` — Node + TypeScript, Fastify + @fastify/websocket, `pg` (no ORM),
  plain SQL migrations with a tiny built-in runner.
- `web/` — Vite + React 19 + TypeScript + Tailwind 4.
- Postgres 16 in Docker on host port **5433** (db/user/password all `atrium`).
- Auth is prototype-simple: `POST /auth/login {handle, displayName}` sets a
  signed (HMAC-SHA256) httpOnly cookie. No passwords.

## Run it

Prereqs: Node 24+, pnpm 10+, Docker.

```bash
cd surface

# 1. start Postgres (leave it running)
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
pnpm test          # vitest: server (needs Postgres up) + web reducer tests
pnpm typecheck     # tsc both packages
pnpm ws-smoke      # end-to-end WS proof + latency (needs `pnpm dev` running)
node scripts/ws-smoke.mjs 50            # bigger sample
BASE_URL=http://localhost:5173 node scripts/ws-smoke.mjs   # through the Vite proxy
```

Env (all have dev defaults): `DATABASE_URL`, `PORT` (3001), `SESSION_SECRET`.

## Two-browsers manual test script

Use two different browsers (or one normal + one private window — sessions are
cookie-based, two tabs in the same profile share one login).

1. Browser A: log in as `ana` / "Ana". Browser B: log in as `ben` / "Ben".
2. Both land in **#general**. Header should show **2 here** with both initial
   dots — presence is view-based (who has the channel open right now). When B
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

## API sketch

- `POST /auth/login {handle, displayName}` → sets `atrium_session` cookie
- `GET /auth/me`, `POST /auth/logout`
- `GET /api/workspaces`, `GET /api/channels`, `POST /api/channels {name}`
- `GET /api/channels/:id/messages?before_id=&after_id=&limit=` — newest-last;
  `before_id` pages history (root messages only); `after_id` is the reconnect
  catch-up read and includes thread replies so counts/threads stay correct
- `GET /api/threads/:rootEventId/messages`
- `POST /api/messages {channelId, text, clientMsgId?, threadRootEventId?}` —
  rejects empty and >8KB text; echoes `client_msg_id` in the event payload for
  optimistic reconciliation
- `WS /ws` — client sends `{type:"subscribe", channelIds:[...]}` (full
  replacement); server pushes `{type:"event", event}` for subscribed channels
  and `{type:"presence", channelId, users}` on join/leave. Protocol-level
  ping/pong heartbeat (30s) plus an app-level `{type:"ping"}` from the client.

Presence semantics: "in the channel" = WS clients subscribed to it. The web
client subscribes to all channels (needed for unread indicators), so presence
currently reads as "online in the workspace" — see PROGRESS.md.

## Event model

One append-only `events` table (`id bigserial`, `workspace_id`, `channel_id`,
`thread_root_event_id`, `type`, `actor_id`, `payload jsonb`, `created_at`).
Types so far: `workspace.created`, `channel.created`, `message.posted`,
`message.edited`. Read models (`workspaces`, `channels`, `users`, `sessions`)
are updated in the same transaction as the event insert. A message with
`thread_root_event_id` set is a reply; roots render in the channel timeline
with a reply count (computed from the log, edits folded via the latest
`message.edited`).
