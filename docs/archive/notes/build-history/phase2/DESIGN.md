# Phase 2 — Sessions: Design

How agent sessions attach to Places. Builds on: surface/ (Phase 1 chat),
packages/centaur-client (typed client + reducer), notes/build-history/phase0/results/event-schema.md
(stream contract).

## Principles

1. **The browser never holds a Centaur credential.** The surface server is the
   only Centaur API client; browsers get a proxied, auth-checked stream.
2. **Sessions are PR-like objects, not rooms** (see notes/build-history/initial-build-plan.md ontology). A session
   is spawned *from* a thread, linkable from anywhere, and reports back.
3. **Everything user-visible is an event** in the surface event log (provenance),
   while high-frequency agent frames stay in Centaur's durable store —
   referenced by `(centaur_thread_key, execution_id, last_event_id)`, not copied.
   The surface log gets session *lifecycle* events only (calm channel, detail one
   click away).

## Data model (surface Postgres)

```sql
sessions (
  id uuid pk,
  workspace_id, channel_id, thread_root_event_id,   -- where it was spawned
  centaur_thread_key text unique,                    -- backing Centaur thread
  harness text default 'claude-code',
  title text,                                        -- first ~80 chars of task
  status text,        -- spawning|queued|running|completed|failed|cancelled
  spawned_by, driver_id,                             -- user ids (driver = P3)
  current_execution_id text, assignment_generation int,
  last_event_id bigint default 0,                    -- resume cursor
  result_text text, cost_usd numeric default 0,
  created_at, completed_at
)
```

New surface event types (flow through existing WS fanout; the live card in the
thread re-renders off them): `session.spawned`, `session.status_changed`,
`session.completed` (payload: result_text excerpt + permalink), and in P3
`session.seat_requested` / `session.seat_changed`.

## Spawn flow

Composer grammar: message starting with `@agent ` (or `/agent `) in a thread or
channel → POST /api/sessions {channelId, threadRootEventId?, task}.

Server: insert session row (status=spawning) + append `session.spawned` event →
respond immediately (optimistic card) → async task: centaur spawn → postMessage
(task text) → execute → store execution_id/generation → start the **tailer**.

## The tailer (server-side, one per active session)

Consumes `tailEvents()` from @atrium/centaur-client with auto-resume:
- updates sessions.last_event_id (throttled, e.g. every 25 frames / 2s)
- on execution_state transitions → update row + append session.status_changed
- on obs.usage → accumulate cost_usd
- on terminal → result_text, completed_at, append `session.completed`
- **does NOT copy content frames into the surface log** (they stay in Centaur)

Surface-server restart: on boot, find sessions with non-terminal status →
restart tailers from last_event_id. (Centaur replay durability verified in
Phase 0 test D — this is free.)

## Live pane (spectating)

- Card click → pane opens: GET /api/sessions/:id (metadata) then
  GET /api/sessions/:id/stream?after_event_id=N → server checks the user's
  workspace membership, then proxies Centaur's SSE verbatim (adds nothing).
- Browser folds frames with `reduceSession()` from @atrium/centaur-client
  (same reducer the tests cover; shared package, no drift).
- Spectator presence: pane-open/close registers on the existing WS presence
  channel keyed `session:<id>` → spectator count + faces on the card and pane.
- Reload/late-join: fresh stream from after_event_id=0 (full replay) or from a
  snapshot cursor — replay determinism makes this safe; >200-frame transcripts
  render incrementally (virtualized list).

## Pane UI (quality bar from initial build plan)

Header: status chip · title · spawner → driver · spectators · cost ticker ·
elapsed · "open thread" link. Body: streamed text (token-level, per Phase-0
finding) interleaved with collapsible tool cards — name + input (command)
always visible when open, output/`is_error` styled, long output clamped with
expand. Footer (P3): steer composer (driver only) + request-seat button.
Completion: summary card (result_text) pinned at pane top and posted to the
spawning thread with permalink `/s/<session-id>`.

## Follow-up turns (multi-turn sessions)

Driver sends text in pane composer → POST /api/sessions/:id/messages →
server: centaur postMessage + execute (same thread_key; refresh generation via
spawn if assignment was released) → tailer picks up the new execution_id.
v0 (P2): only spawner may steer; P3 generalizes via seat semantics.

## Permissions (P2 scope)

Workspace members: may view any session card + open any pane (the provenance
bet — default-visible). Spawner: may steer/cancel. Cancel = POST
/api/sessions/:id/cancel → Centaur execution cancel + release.

## Done-when (restating initial build plan gate)

- Spawner + 2 spectators see identical live state (same last_event_id)
- Reload mid-session recovers full transcript
- Completion card lands in thread with working permalink
- @agent → visible "running" card < 5s; 200+ event transcript scrolls cleanly
- Non-spawner can explain what the agent did from the pane alone
- Surface-server restart mid-session: tailer resumes, no lost lifecycle events

## Open questions (defer unless they block)

- Title generation: first line of task for now; later a cheap model call.
- Channel-level `@agent` (no thread): spawn creates the thread implicitly —
  the session card IS the thread root. (Chosen: yes, do this.)
- Multiple concurrent sessions per thread: allowed; cards stack.
- Cost ceilings/budgets per session: P4 instrumentation, not P2.
