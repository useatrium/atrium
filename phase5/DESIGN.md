# Phase 5: Sync Engine — durable ops, unified sync, exactly-once effects

Status: CHARTERED (2026-06-11). Phase A in progress (codex worker).

## Decisions (Gary, 2026-06-11)

- **Web offline (Phase E): full parity.** IndexedDB cache + op queue + drafts,
  as scoped. The "world class" bar applies to web, not just mobile.
- **Reactions protocol: clean break.** Server and all clients update in one
  release; no compat shim for toggle-shaped requests. Acceptable at dogfood
  stage — all installed mobile builds are controlled.
- **Execution: codex fleet, one phase per worker** in self-managed worktrees
  under `atrium-wt/`, merged sequentially with full test runs between merges.
- **Test depth: chaos harness is a merge gate.** Lands inside Phase B; every
  later phase merges with chaos coverage. Invariants are enforced, not
  asserted.

## Goal

Make sync world-class: any user action survives any combination of network loss,
process death, retry, and reconnect — with at most one server effect and zero
dropped updates — on both web and mobile, with the quality enforced by tests
rather than asserted by design.

### The quality bar, as testable invariants

1. **No dropped updates.** Any event a client would render live is recoverable
   after arbitrary disconnect/reconnect. There is no state change that exists
   only as a WS frame.
2. **Exactly-once effects.** Every mutation can be retried blindly (lost
   response, duplicate flush, multi-tab race) and produces at most one server
   effect. The stored result is returned on replay.
3. **Durable intent.** A user action accepted by the UI survives app kill /
   tab close / device restart and is eventually delivered or explicitly
   surfaced as rejected. Never silently lost.
4. **Local-first cold start.** Both clients render last-known state instantly
   from local storage; the network only heals and extends it.
5. **Convergence.** Any interleaving of POST responses, WS frames, and catch-up
   fetches yields the same final client state (the reducer is already
   order-tolerant; this becomes a property test, not a hope).

## Where we are (verified 2026-06-11)

Foundations that are already right and that this design keeps:

- Append-only `events` table, monotonic `bigserial` id, source of truth
  (`surface/server/migrations/001_init.sql`).
- Client reducer dedupes by event id (`seenIds`), reconciles optimistic rows by
  `clientMsgId`/`spawnClientId`, tolerates reordering
  (`surface/shared/src/timeline.ts`).
- WS treated as untrusted: every reconnect runs `after_id` catch-up.
- Message posts are exactly-once via `clientMsgId` + unique index
  (`migrations/012_client_msg_dedupe.sql`, `events.ts:244`).
- Mobile has a durable SQLite cache + FIFO send outbox flushed on
  reconnect/wake (`mobile/src/lib/outbox.ts`, `cacheSqlite.ts`).
- Read cursors are monotonic-max server-side (`app.ts:601`).

The gaps (full mutation matrix in appendix A):

- **G1 — dropped questions.** ~~`session.question_requested/answered/resolved`
  are reducer row events (`timeline.ts:100`) but absent from
  `TIMELINE_EVENT_TYPES` (`events.ts:508`), so reconnect catch-up never replays
  them.~~ **Fixed upstream 2026-06-11** (`8b79d99`, `1e1620f`) while this doc
  was being drafted: the types are in `TIMELINE_EVENT_TYPES` and thread reads
  include them, with thread-read test coverage. Remaining Phase A work: a
  regression test for the *channel* `after_id` catch-up path (the reconnect
  scenario), which the upstream fix covers functionally but does not test.
- **G2 — idempotency is per-feature, not systemic.** Only message posts dedupe.
  Edits, deletes, reactions, spawns, HITL answers, channel ops have none.
  Reactions are *toggle* on the wire (`events.ts:402`) — a retry after a lost
  response flips state back; no idempotency key can fix toggle semantics.
- **G3 — sideband state is not syncable.** `read`, `muted`, `prefs`,
  `channel-left` are fire-and-forget WS frames backed by state tables, healed
  only incidentally by `channels()`/`me()` refetches.
- **G4 — durability covers one op type on one client.** Mobile queues plain
  message sends only. Web queues nothing and loses all pending/failed state on
  reload. Edits, reactions, read marks, mutes, spawns, answers are
  fire-and-forget everywhere.
- **G5 — no gap detection on a live socket.** Frames carry no sequence; a
  server-side send failure on a healthy socket is undetectable until the next
  reconnect.
- **G6 — catch-up doesn't scale down.** `catchUp` pages through *all* missed
  events per channel; a week offline replays everything. No "too far behind →
  snapshot" path.
- **G7 — attachments have no durable state.** Presigned-PUT progress lives in
  component state; a killed app forgets uploads, and an expired presigned URL
  has no re-issue path.
- Housekeeping: stale comment at `outbox.ts:35` claims the server doesn't
  dedupe `clientMsgId` (it does); mobile outbox has no size/TTL policy.

## Design principles — and where we deviate from the Replicache blueprint

The reference architecture (Replicache/Kafka/Matrix-style: durable per-device
op log with sequential ids, server-stored per-device cursor, transactional
apply+ack) was evaluated and deliberately **not** adopted wholesale. Two
load-bearing deviations:

**D1 — Per-op idempotency keys instead of per-device op sequences.**
Replicache needs `lastMutationID` because its mutations are arbitrary functions
whose effects can't be individually deduped. Every Atrium mutation, by
contrast, can be made individually idempotent (append with dedupe key, set-add/
set-remove, monotonic max, last-write-wins). Given that, a per-device total
order buys nothing and costs a lot: head-of-line blocking (one stuck op wedges
every op type behind it), server-side per-device state, and a
permanent-vs-temporary error classifier whose mistakes wedge the queue — the
classic failure mode of these designs. We take: client-generated `op_id` per
mutation, generic server-side dedupe, FIFO ordering only where the domain needs
it (messages within a channel), independent queues otherwise.

**D2 — Stateless sync: the cursor lives on the client.**
The server never tracks what a device has seen. `/sync` takes the client's
cursor and returns what's newer. No device registry, no cursor tables, no ack
bookkeeping — and a client that loses its storage just syncs from scratch.
Combined with D1, this also makes **multi-tab web safe for free**: two tabs
flushing the same op queue is harmless because the server dedupes by `op_id`.
No tab election required (Web Locks becomes an optional politeness
optimization, not a correctness mechanism).

Kept from the blueprint: WS demoted to an accelerator that is never trusted for
correctness; durable typed client op queue; per-type conflict semantics;
snapshot repair when too far behind; chaos testing as the enforcement
mechanism.

## Target architecture

### 1. Server: generic idempotency layer

New table + helper, adopted by every mutating route:

```sql
CREATE TABLE idempotency_keys (
  user_id    uuid NOT NULL,
  op_id      uuid NOT NULL,
  op_type    text NOT NULL,
  response   jsonb,            -- stored success response, replayed on retry
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, op_id)
);
```

Helper `withIdempotency(userId, opId, opType, fn)` runs inside the same
transaction as the effect: insert key → on conflict, return stored `response` →
else run `fn`, store response, commit. Daily prune of keys older than ~7 days
(retry horizon » outbox flush cadence; anything older is a new op).

Per-route notes:
- `clientMsgId` stays as-is (it's already a domain-level dedupe with a
  uniqueness index — stronger than the generic layer; don't churn it).
  `op_id` is additive for everything else: edit, delete, reaction, spawn,
  HITL answer, mute, join/leave, read (read doesn't strictly need it —
  monotonic max is naturally idempotent — but uniformity is cheap).
- **Reactions change wire protocol**: `POST .../reactions {emoji, action:
  'add'|'remove', op_id}`. Server applies set semantics keyed
  `(target_event_id, actor, emoji)`; an `add` when present and a `remove` when
  absent are no-ops, not errors. The UI keeps toggle UX by computing the
  intended action from local state at *enqueue* time. Toggle-on-the-wire cannot
  be made retry-safe; this is the one behavioral protocol change in the phase.
- Spawns get a real unique constraint on `clientSpawnId` (today it's echo-only
  reconciliation; a duplicated POST creates two sessions).

### 2. Server: `/sync` — one endpoint that heals everything

```
GET /api/sync?after=<event_id>&limit=500
→ {
    events:      WireEvent[],      // all visible events with id > after, ASC
    nextCursor:  number,
    limited:     boolean,          // true → cursor too old / cap exceeded; do snapshot repair
    state: {                       // full sideband snapshot — small per user, always sent
      readCursors: {channelId: lastReadEventId},
      mutes:       channelId[],
      prefs:       Prefs,
      channels:    ChannelSummary[]   // supersedes channels() in the sync path
    }
  }
```

- "Visible" = events in public channels + channels the user is currently a
  member of, workspace-scoped. Membership changes are themselves events, so a
  client sees its own join/leave in the stream. Needs index
  `events (workspace_id, id)`; the membership filter is a join against
  `channel_members` + channel kind.
- Sideband state ships as a **full snapshot every sync** (G3). Per-user it's
  tiny (cursors + mutes + prefs + channel list); versioning/deltas are
  complexity with no payoff at this size. This is the deliberate alternative to
  event-sourcing read cursors, which would pollute the log with the
  highest-frequency lowest-value writes in the system.
- `limited: true` (cursor older than cap, default ~5k events) → client drops
  its cursor, refetches the latest page per loaded channel (the existing
  history path), and resumes from `nextCursor` (G6).
- `TIMELINE_EVENT_TYPES` gains the three `session.question_*` types
  immediately (G1) — independent of and before `/sync`; per-channel `after_id`
  stays as the thread-scoped and fallback path.

### 3. Server: WS frames get a per-connection sequence

Every frame on a connection carries `seq` (monotonic per connection, starts at
1 on each connect). Client sees a gap → treats it exactly like a reconnect:
run `/sync`. Closes G5 with ~10 lines on each side. No replay buffer, no
resume-by-seq — `/sync` is the repair path; the socket never needs to be
reliable (that's the whole point of D2).

### 4. Shared client: typed durable op queue

One implementation in `surface/shared`, storage injected (SQLite on mobile,
IndexedDB on web) — the existing `EventCache`/`OutboxStorage` injection pattern,
generalized:

```ts
interface QueuedOp {
  opId: string;            // client uuid, sent to server for dedupe
  opType: OpType;          // 'msg.send' | 'msg.edit' | 'msg.delete' | 'reaction.set'
                           // | 'read.mark' | 'mute.set' | 'session.spawn'
                           // | 'session.answer' | 'channel.join' | 'channel.leave'
  queueKey: string;        // FIFO ordering domain, e.g. 'msg:<channelId>'
  payload: unknown;
  status: 'pending' | 'inflight';
  retryCount: number;
  createdAt: string;
}
```

- **Ordering**: strict FIFO *within* a `queueKey`, full independence across
  keys. Messages per channel share a key (today's outbox guarantee, kept).
  Reactions, reads, mutes, spawns each get narrow keys. A stuck channel can't
  block a read mark; a stuck upload can't block anything (D1's payoff).
- **Coalescing** per op type: `read.mark` keeps only the max per channel;
  `mute.set` and `reaction.set` keep only the latest per key. Queues stay
  O(channels), not O(actions) — also the outbox size policy that's missing today.
- **Error classification** (one rule, in one place): network-shaped error
  (today's `isNetworkFailure`) → keep, retry on reconnect/wake with capped
  backoff; HTTP 4xx → drop + surface to UI (`onRejected`); HTTP 5xx → retry
  with a cap, then surface. Misclassification cost is low by construction:
  wrongly-retried ops are idempotent, and a wrongly-dropped op is *visible*
  (rejection UX), not silent.
- **Op registry**: each `opType` declares `execute(api, payload)`,
  `onConfirmed(dispatch, result)`, `onRejected(dispatch, payload)`. The flusher
  is generic; mobile's `flushOutbox` becomes the `msg.send` entry. ~10 op
  types, each a small declaration — a registry, not an engine.
- Migration: `send_outbox` rows convert to `msg.send` ops on first run
  (reusing `clientMsgId` as `opId`); drop the old table after one release.

### 5. Web: persistence parity

IndexedDB (via `idb`, ~1KB) implementing the same storage interfaces mobile
implements in SQLite: channels + last-300-events per channel + op queue +
composer drafts. Hydrate on boot exactly as mobile does (`chat.tsx:161`), then
`/sync` heals. This closes "web loses everything on reload" (G4) and gives web
instant cold start. Multi-tab is safe by D1/D2; optional polish is a Web Locks
flush leader. The reducer stays the single projection — we persist its
*inputs* (events), not derived state, so storage-format migrations are mostly
"clear cache and resync".

### 6. Optimistic UI completion

With the queue in place, the missing optimistic paths come along: edits,
deletes, and reactions render immediately as local overlays reconciled by
`opId` when the confirming event arrives (same pattern as pending messages
today). Rejected ops produce a visible revert + notice instead of today's
silent failure or bare alert.

### 7. Attachments: durable upload state machine

The one place with a real cross-queue dependency (message references files):

- `upload` ops persist `{opId, localUri, contentHash, status: created |
  uploading | uploaded}`; a `msg.send` payload references attachment *op ids*.
- Flusher rule: a `msg.send` is eligible only when its referenced uploads are
  `uploaded`. Failed/expired presigned PUT → re-request via `POST /api/uploads`
  (server side dedupes by `(uploader, content_hash)` so re-creates don't orphan
  rows) → re-PUT.
- Mobile note: `localUri` must be a copy under app storage (picker URIs don't
  survive restart).
- Deliberately minimal: no resumable/chunked uploads, no content-addressed
  store. Re-PUT-from-zero is acceptable at chat-attachment sizes.

### 8. Conflict semantics (per type — no generic merge rule)

| State | Rule | Where enforced |
|---|---|---|
| Messages | Append-only, server-ordered by event id | exists |
| Edits/deletes | Author-only ops on known event ids; retry idempotent via `op_id` | Phase B |
| Reactions | Set membership `(message, emoji, user)`; add/remove explicit | Phase B |
| Read cursors | Monotonic max | exists (server); client coalesce Phase C |
| Mutes/prefs | Last-write-wins, server-authoritative snapshot on sync | Phase B |
| Membership | Server-authoritative; may reject queued ops (visible rejection) | Phase C |
| Session seats | Already lock-based + presence-gated; unchanged | exists |
| HITL answers | First-writer-wins (existing `FOR UPDATE` + pending check); retry replays result | Phase B |

No CRDTs anywhere: nothing in the domain is concurrent free-form editing. If a
collaborative-doc surface ever ships, it gets its own engine (Yjs) — explicitly
out of scope.

## Testing: the part that makes it "world class" rather than "probably fine"

Built *alongside* the phases, not after. The sim harness lands with Phase B so
every later phase ships chaos-covered.

1. **Chaos API harness** (vitest, real Postgres like existing server tests): a
   fetch wrapper that randomly drops responses-after-effect, duplicates
   requests, delays, and reorders — seeded PRNG, every failure reproducible
   from its seed. Core invariant suite, parametrized over the op registry:
   - exactly one server effect per `op_id` across any retry schedule;
   - replayed response equals original response.
2. **Reducer convergence property tests** (fast-check; the reducer is already
   pure): random event sets delivered in random interleavings of
   {WS frame, catch-up batch, POST response} converge to identical state.
3. **Queue property tests**: random kill/restart points around storage commits;
   invariants: FIFO preserved per `queueKey`, no op lost, no op executed after
   rejection, coalescing never drops the newest write.
4. **Sync continuity test**: random disconnect windows against a live server
   writing concurrently; assert the client's applied-event-id set has no holes
   vs. the server log's visible set — this test fails on today's G1 *before*
   the fix lands, which is how we know it has teeth.
5. **E2E offline flows** (Playwright, existing single-worker setup):
   `context.setOffline(true)` → send/edit/react → reload tab → restore network
   → assert delivery exactly once. Plus kill-server-mid-send and
   question-during-disconnect scenarios.

## Phasing

Each phase ships independently and leaves the system strictly better; nothing
below depends on a later phase.

| Phase | Contents | Closes | Size |
|---|---|---|---|
| **A — stop the bleeding** | `session.question_*` into `TIMELINE_EVENT_TYPES` (+ regression test); fix stale `outbox.ts:35` comment; `catchUp` "too far behind → latest page" guard; WS per-connection `seq` + client gap→catch-up | G1, G5, G6 | S (days) |
| **B — exactly-once everywhere** | `idempotency_keys` + `withIdempotency` in all mutation routes; reactions → add/remove protocol; `clientSpawnId` unique constraint; **chaos harness + invariant suite** | G2 | M (~1–2 wk) |
| **C — durable ops on mobile** | shared typed op queue + registry; mobile migrates `send_outbox`; all mutations queue-backed; optimistic edit/delete/react overlays; queue property tests | G4 (mobile) | M–L (~2 wk) |
| **D — unified sync** | `/sync` endpoint (events cursor + sideband snapshot + `limited`); clients adopt it as the reconnect path; sync continuity test | G3, rest of G6 | M (~1–2 wk) |
| **E — web parity** | IndexedDB storage adapter; web cache + op queue + drafts; offline E2E flows | G4 (web) | M (~1 wk) |
| **F — attachments** | durable upload ops, content-hash dedupe on `/api/uploads`, presigned re-issue, msg→upload dependency | G7 | M (~1 wk) |

Order rationale: A is pure bug-fixing and ships this week. B is the keystone —
it's what makes C and E safe (blind retry, multi-tab) and cheap (no
coordination). C before D because durable ops matter more than unified
catch-up for real usage (the existing per-channel catch-up, post-A, is correct
— just inelegant). D before E so web parity lands on the final protocol. F is
independent of D/E and can run in parallel after C.

## Non-goals

- Per-device server-side cursors / op sequences (D1/D2 — by design).
- CRDTs / collaborative text editing.
- Event log compaction or snapshotting of the log itself (bigserial + indexes
  are fine at this scale; revisit at ~10⁷ events).
- Durable typing/presence (ephemeral by design).
- Resumable chunked uploads.
- Web rendering directly from IndexedDB queries (the hydrate-then-reduce model
  is kept; "local-first reads" means durable hydration, not a query engine).

## Open questions (decide at phase start, none blocks Phase A)

1. **`/sync` visibility on join**: when a user joins a private channel, does
   `/sync` backfill that channel's history before the join event? Proposal:
   no — channel history loads through the existing history path on open;
   `/sync` only guarantees forward continuity from membership.
2. **Idempotency response staleness**: a replayed stored response may be stale
   (e.g., the message was edited after the original send). Acceptable —
   catch-up reconciles — but confirm no client treats a POST response as
   fresher than the event stream. (Today's reducer already prefers
   higher event ids; verify per op type in Phase B.)
3. **Web storage eviction**: IndexedDB is best-effort storage; eviction =
   clean resync from scratch by construction. Confirm no flow assumes the
   cache is durable-forever (mobile already has `clearCache`/invalidated
   handling to mirror).
4. **`op_id` transport**: header (`Idempotency-Key`, Stripe-style) vs. body
   field. Body field proposed — it survives the op queue's serialization
   trivially and stays visible in logs.

---

## Appendix A: mutation durability matrix (as of 2026-06-11)

| Mutation | Idempotent? | Web offline | Mobile offline | Target after Phase C/E |
|---|---|---|---|---|
| Send message | ✅ `clientMsgId` | ❌ failed-in-memory | ✅ outbox | queued both |
| Edit message | ❌ | ❌ silent | ❌ alert | queued + optimistic |
| Delete message | ❌ | ❌ silent | ❌ alert | queued + optimistic |
| Reaction | ❌ **toggle wire** | ❌ silent | ❌ alert | set-semantics, queued |
| Mark read | ✅ monotonic | ❌ rollback | ❌ rollback | queued, coalesced |
| Mute | ✅ upsert/delete | ❌ revert | ❌ revert | queued, coalesced |
| Prefs | ❌ (merge) | ❌ silent | n/a | queued LWW |
| Join/leave channel | ✅/✅ | ❌ silent | ❌ alert | queued, rejectable |
| Spawn session | ⚠️ echo-only | ❌ failed state | ❌ failed state | unique key + queued |
| HITL answer | ✅ lock+check | ❌ silent | ❌ alert | queued |
| Upload | ❌ new row each | ❌ per-file retry UI | ❌ same | durable op + hash dedupe |
