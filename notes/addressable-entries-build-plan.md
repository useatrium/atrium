# Addressable Entries & Annotations — build plan

Status: **PLAN (2026-06-23), design locked; not started.**
Spec: `addressable-entries-and-annotations.md` (read it first — this is the how, that
is the why). Decisions locked there §3a.

## Scope

v1 = **chat events + transcript records** become uniformly addressable (one opaque
handle), resolvable (one route + MCP resource), and annotatable (comments + reactions
by humans **and** agents, reusing chat's event-sourced pattern). `run_*` child-run
identity is **deferred** (P3). No GC work — transcripts/chat live forever.

Sequencing: **P0 first; then P1 and P2 in parallel — except the agent-authoring
slice of P1, which needs P2's MCP write tool** (see P1-2). Human annotation is
independent of P2.

**CLEAN BREAK (Gary, 2026-06-23): nothing is live yet.** No backward-compat, no
dual-write, no dual-read, no careful backfill. Replace the old chat-only
`target_event_id` annotation model with the handle model outright. Delete legacy
paths rather than bridge them.

**HARDENING PASS (Gary, 2026-06-24).** A critique surfaced 9 weaknesses; all are
*additive hardening* (none re-architect the model). Four were design forks, now
decided:
1. **Frame gaps → active re-fetch** (not passive-alert): detect the gap, refill it
   (§ H1). 2. **Transcript annotation visibility → channel-scoped** — same rule as
   where the event is stored (§ H6). 3. **`run_*` child-run identity stays deferred**
   to P3 (§ H7). 4. **`evt_*` stays a raw derivable bigint** — only `rec_*` is opaque
   (§ H8). The remaining five take defaults (§§ H2–H5, H9). Full resolutions: the
   **Hardening** section below. Spec §4 (handle opacity) and §5 (annotation visibility)
   updated to match.

Carried invariants (from spec, do not violate):
- Don't merge `events` + `session_records` physically; unify the handle namespace.
- Keep the `session_records` coalescing upsert; annotations live *off* the record.
- Anchor on a **stable derived entry id (`entry_uid`)**, never raw `seq`. It is
  *derived* (deterministic) from the record's immutable frame provenance, so it
  regenerates identically on every rebuild — not a random surrogate (which rebuild's
  DELETE+reinsert would lose). Rebuild is a live path; positional `seq` is unsound.
- Annotations are **typed events** in `events`; the chat timeline already filters
  `type='message.posted'`, so `comment.*` won't leak into the channel timeline.

---

## Data model (migrations; next free number = 044)

**044_session_record_entry_uid.sql**
- `ALTER TABLE session_records ADD COLUMN entry_uid text;` + unique `(session_id,
  entry_uid)` + index `(entry_uid)` for resolve.
- `entry_uid` = stable derived id from replay-stable frame provenance (see P0-2).
- Clean break: nothing live → no backfill story; a one-shot rebuild populates any
  dev/CI data. (Make it NOT NULL once the projection always sets it.)

**045_entry_annotation_handle.sql** (clean break — replace, don't bridge)
- Switch the annotation target to a handle: writers set `payload.target` (text).
- `CREATE INDEX events_target ON events ((payload->>'target')) WHERE
  payload->>'target' IS NOT NULL;`
- **Drop** `events_edit_target` (the old `(payload->>'target_event_id')::bigint`
  index) — superseded by `events_target`.
- New event types (`comment.*`) are `events.type` values, not schema — no DDL.

No new annotation table. No tombstone-for-GC table (transcripts live forever, §3a).

---

## P0 — handle + resolve (read-only)

**P0-1. Handle codec** (`server/src/entries.ts`, new)
- `encodeHandle`/`decodeHandle` for `evt_<bigserial>` and `rec_<entry_uid>`.
- **`evt_*` is a transparent, derivable bigint** (decision H8) — `evt_<events.id>`,
  no codec/key. **Only `rec_<entry_uid>` is opaque.** Internal decode yields
  `{type:'event'|'record', ...}`. Enumeration of `evt_*` leaks existence/cardinality
  only; authz at resolve (P0-3) is the content control.
- `run_*` reserved, not implemented (decision H7 — stays deferred to P3).

**P0-2. Record derived entry_uid** (`server/src/session-records.ts`)
- In `pushRecord`, compute `entry_uid` from replay-stable keys already in `meta`,
  in priority order: `tool_use_id` → `messageId`/`uuid` → codex `itemId`
  (+`changeIndex` for file changes) → `questionId` → fallback
  `hash(sourceEventIds[0], kind, ordinalWithinFrame)`. `sourceEventIds[0]` is the
  immutable `centaur_event_id`, so all branches are rebuild-stable.
- Carry `entry_uid` through `insertSessionRecord`/`upsertSessionRecord` and
  `rebuildSessionRecords` (the delete+reinsert must reproduce the same `entry_uid`).
- Test: rebuild a session after simulating a projection change that inserts an
  earlier record; assert every pre-existing entry keeps its `entry_uid`.
- **H2 — harness conformance:** add a per-harness (claude/codex/amp) test asserting
  every record *kind* derives a **non-fallback** `entry_uid` (i.e. lands on a real
  native key, not `hash(sourceEventIds[0], kind, ordinal)`). Emit a
  `entry_uid_fallback_total` counter; a rising fallback rate is the regression
  signal that a harness changed its id discipline. Not v1-blocking, but monitored.

**P0-3. Resolve route** (`server/src/app.ts` + `entries.ts`)
- `GET /api/entries/:handle` → normalized `{handle, kind, actor, text, meta,
  targetType, sourceRefs, tombstoned}`.
- Authz: event → channel membership; record → session `full_view` OR channel member
  OR `spawned_by` (reuse the changefeed's predicate, `session-record-changefeed.ts`).
- **H6 — annotation authz = channel membership** (decision): a transcript-entry
  annotation follows the *channel* it's stored in, the broadest scope here. Since
  channel-member ⊆ the entry-resolve union above, anyone who can see an annotation
  can resolve its entry — the dual-authz "split brain" collapses to one rule. One
  documented edge: a `full_view`-without-membership viewer (rare) resolves the entry
  but not its channel-scoped annotations. Build one tested authz matrix (member /
  non-member / full_view / spawned_by) covering both target types.
- Archive fallback: leave a `// TODO archival` seam (no behavior now).

**P0-4. Handle-bearing reads**
- **First confirm** the structured records feed the card-rendering web UI actually
  consumes (the `/atrium/transcript`/`/full` endpoints are Markdown; the work-drawer
  cards must read a JSON records feed — likely the changefeed-driven one). Add
  `handle` to *that* payload + the chat event read payload; don't invent a new
  endpoint if one exists.

**P0 done when:** any chat or transcript entry resolves by handle with correct authz,
and `entry_uid` survives a forced `/reproject`.

---

## P1 — annotations (human slice ∥ P2; agent-author slice needs P2; depends on P0)

**P1-1. Move chat annotations to the handle model** (`server/src/events.ts`) — clean break
- Rewrite `setReactionTx` + `message.edited`/`message.deleted` writers to key on
  `payload.target` (= `evt_<id>` for chat). **Delete** the `target_event_id` reads
  and writes; no dual path. The fold queries switch from
  `(payload->>'target_event_id')::bigint = $1` to `payload->>'target' = $1`.
- **H9 — silent-failure guard:** add a CI grep-guard that fails the build on any
  surviving `target_event_id` reader/writer after the cutover, plus a transitional
  assertion/log on any read that still encounters `target_event_id`-only rows. Cheap
  insurance against the clean break's failure mode (a missed reader returns *no
  annotations*, not an error).

**P1-2. New event types + writers**
- `comment.posted`, `comment.edited`, `comment.deleted`. Reactions reuse
  `reaction.added/removed`. (Transcript `entry.deleted` is **out of v1** — see note.)
- Concurrency on a **record** target (no `events` row to `FOR UPDATE`): serialize on
  `pg_advisory_xact_lock(hash(handle))`; keep the idempotent
  per-`(target,actor,emoji)` net-sum. Consider unifying chat onto the same
  hash(handle) lock for one concurrency path.
- **Agent author path** (`actor='agent'`): the agent writes via the **P2 MCP tool**
  (`entries.comment` / `entries.react`), so this slice depends on P2. Human authoring
  (routes below) does not.
- **H4 — rate cap ships WITH agent-write** (no longer deferred): a per-actor
  token-bucket on `comment.*`/`reaction.*` writes, enforced at *both* the MCP tool
  and the human routes. Configurable; default ~30 annotations/min/actor. Lands in the
  same change as the agent-write path — a chatty agent loop must not be able to flood
  the forever-log on a hot entry (compounds the H3 fold cost).

**P1-3. Annotation routes** (`server/src/app.ts`)
- `GET /api/entries/:handle/annotations` → threaded comments + reaction net + folded
  edits/deletes.
- `POST /api/entries/:handle/comments`, `POST /api/entries/:handle/reactions` (human).

**P1-4. Read fold** (`server/src/events.ts`)
- Folding for `comment.*`/`reaction.*` keyed by `target` (parallels the existing
  `message.edited`/`message.deleted` fold, `events.ts:569–584`).
- **Transcript entry deletion is deferred** — agent-transcript entries are immutable
  history; there is no "delete a transcript line" feature today and we're not adding
  one in v1. Redaction already blanks text while keeping the row. Chat keeps its
  existing `message.deleted` tombstone (now handle-keyed via P1-1).

**P1-5. UI** (`surface/web`, then mobile)
- Copy-link, comment composer, reaction picker on chat rows **and** transcript rows
  (the work-drawer/transcript surfaces). Reuse the existing `REACTION_EMOJI` set.

**P1 done when:** a human and an agent can comment/react on a chat message and a
transcript diff; delete leaves a tombstone; reactions are concurrency-safe.

---

## P2 — MCP resources (∥ P1, depends on P0)

**P2-1. MCP server** (new service/package) exposing Atrium entries as resources.
- Resource id = `atrium://entry/<handle>`; `resources/read` → the P0-3 resolve
  payload; optionally `resources/list`/templates for a session's entries.
- Auth: per-sandbox scoped credential via the existing token-broker (egress-only;
  agent reaches out). No new ingress.
- This is the "no MCP server" Macro-gap closer; keep it generic so future resource
  types (artifacts already addressable) can register.

**P2-2. Harness reference ergonomics** — teach the harness to mint a handle/reference
instead of inlining a child output/review/diff when handing context to another agent.

**P2 done when:** an agent can `resources/read("atrium://entry/<handle>")` and get the
entry content, scoped to its session, on claude and codex harnesses.

---

## Hardening — critique resolutions (2026-06-24)

Master map of the 9 weaknesses → plan items. Detail for the items without an inline
phase home (H1/H3/H5/H7) is here; the rest point at their phase.

| # | Weakness | Resolution | Where |
|---|---|---|---|
| H1 | Silent frame loss | **active re-fetch** (detect gap → refill) | P0 · Lane G ↓ |
| H2 | `entry_uid` only as stable as weakest harness | per-harness conformance test + fallback metric | P0-2 |
| H3 | Chat `events` grows forever, folded at read | fold behind a cache seam, **defer** the cache | ↓ |
| H4 | Agent annotation spam | per-actor rate cap **ships with** agent-write | P1-2 |
| H5 | `/sync` `limited` bail leans on an unenforced invariant | registry doc + guard test | ↓ |
| H6 | Two authz models in one table | **channel-scoped** annotations (one rule) | P0-3 |
| H7 | P2's best use case (`run_*`) behind P3 | **stays deferred**; make the v1 gap explicit | ↓ / P3 |
| H8 | `evt_*` enumerable vs "opaque" | **raw bigint**; only `rec_*` opaque | P0-1 |
| H9 | Clean break fails silently | CI grep-guard + transitional assertion | P1-1 |

**H1 — frame-gap detection + active re-fetch (P0, new Lane G; transcript integrity).**
- **First confirm Centaur's `event_id` contiguity** per `(thread, execution)` — is the
  sequence gap-free, or does Centaur filter some events out of the stream? The whole
  detection keys off this. (Build-time verification; if non-contiguous, key off
  Centaur's own next-expected signal instead of a raw `+1`.)
- In the tailer (`session-runs.ts runTailer`), track `lastContiguousId`. On
  `frame.event_id > expected`:
  - **Interim refill — in-repo, ships now, needs no new Centaur endpoint:** abort the
    tail, reset the resume cursor to `lastContiguousId`, reconnect. The existing
    `tailEvents(afterEventId=lastContiguousId)` replays everything after it; the
    `ON CONFLICT DO NOTHING` mirror dedups what we already have. This *is* active
    re-fetch, reusing the watermark machinery — just not yet a targeted range.
  - **Targeted re-fetch — cross-repo, later optimization:** a bounded
    `GET /api/session/:thread/events?after=A&before=B` on api-rs to refill only the
    hole without re-streaming a long tail. Pure perf; the interim is correct without it.
- **Health surface:** per-session `frames_behind`, `last_gap_at`, `refetch_count`.
  **Alarm if a gap persists *after* a refill** — that's the irreducible bound (Centaur
  no longer retains the frame); nothing downstream can recover it, so it must page a
  human, not fail silently.
- **Cross-repo dependency:** only the targeted-range endpoint (optional). Interim is
  fully in Atrium.

**H3 — chat read-model scale (design-for, defer the build).**
- Keep the `events_target` index (mig 045). Put the comment/reaction **fold behind a
  function boundary** (`foldAnnotations(target)`), so a materialized fold-cache
  (per-target reaction-net + folded-edit/tombstone) can slot in later with **zero
  caller changes**. Do **not** build the cache now — nothing is at scale, and the
  index makes point reads cheap. Track as a future-scale item; the trigger is a hot
  entry accumulating thousands of annotation rows (watch via H4's counters).

**H5 — `/sync` invariant guard (P1).**
- Document, at the `SYNC_EVENT_TYPES` registry (`events.ts:720`), the invariant the
  `limited:true` bail depends on: **every sync event type must be recoverable from the
  `state` snapshot or a lazy per-channel load — never delta-only** (a client >1 page
  behind skips the delta entirely). Add a test that fails when a new `SYNC_EVENT_TYPES`
  member has no snapshot/lazy equivalent. New `comment.*`/`reaction.*` events satisfy
  it (re-folded on channel/entry load) — but the *test* keeps the next addition honest.

**H7 — `run_*` stays deferred (P3); name the v1 gap.**
- Per decision: v1 MCP reference (P2) covers **chat + transcript entries only**. Make
  this explicit in the P2 docs and the MCP `resources/list` template: large
  **child-run outputs stay inline until P3** — the one place "reference-not-inline" is
  *not* yet available. Reserve the `run_` prefix; no v1 implementation. (If the
  inlining cost proves painful before P3, revisit pulling an id-only `run_*` forward.)

## Test plan

- **Unit:** handle codec round-trip; `entry_uid` derivation per record kind;
  surrogate stability across rebuild (the EC2 trace as a regression test).
  **H2:** per-harness (claude/codex/amp) non-fallback `entry_uid` conformance.
- **Integration:** **single** resolve+annotation authz matrix (member / non-member /
  `spawned_by` / `full_view`), asserting **H6** channel-scoped annotation visibility;
  comment+reaction fold; agent-authored annotation; record-target advisory-lock
  concurrency (two reactions race → net never negative). **H4:** agent annotation
  burst → rate-capped. **H5:** registry guard fails on a snapshot-less sync type.
- **Integrity (H1):** drop a `centaur_event_id` in the mirror → assert gap detected,
  interim refill restores contiguity, and a *persistent* gap raises the alarm metric.
- **E2E (Playwright):** copy-link → resolve in another session; comment on a streaming
  message then let it finalize (EC1 — comment still anchored); delete → tombstone stub.
- **MCP:** a sandbox agent reads an entry by handle; cross-session denied without access.
- **Guard (H9):** CI grep fails on any residual `target_event_id` reader/writer.

## Risks / watch-items

- **entry_uid vs coalescing change** — a future projection change that *merges/splits*
  records re-derives those specific entries' ids (narrow, detectable). Pick
  repair-vs-restamp when it happens; not v1.
- **P1↔P2 coupling** — the agent-authoring slice of P1 rides P2's MCP tool, so it
  can't fully land before P2. The human slice is independent. Don't plan P1 as if
  agent-write is free of P2.
- **Agent annotation noise** — ~~rate/spam controls deferred~~ **RESOLVED (H4):** a
  per-actor rate cap now ships with agent-write.
- **Clean break is real** — `target_event_id` is removed, not bridged. ~~A missed
  reader silently returns no annotations.~~ **GUARDED (H9):** CI grep-guard +
  transitional assertion catch a missed reader/writer.
- **Frame-gap re-fetch depends on Centaur id semantics (H1)** — the interim refill is
  in-repo, but verify `centaur_event_id` contiguity *first*; the targeted-range
  optimization needs an api-rs endpoint (cross-repo). A gap that persists after refill
  is real Centaur-side loss — alarm, don't swallow.

## Suggested fan-out (codex workers, isolated worktrees)

Lane A = migrations 044/045 + handle codec (P0-1, data model; `evt_*` raw, `rec_*`
opaque per H8). Lane B = entry_uid derivation in projection (P0-2) + H2 conformance —
highest-care, review firsthand. Lane C = resolve route + the single H6 authz matrix +
handle-bearing reads (P0-3/4). **Lane G = frame-gap detection + interim refill (H1)** —
independent of the handle work (it's in the tailer/mirror), can run in parallel with
P0; verify Centaur contiguity first. After P0 merges: Lane D = annotations server incl.
the chat clean-break refactor + H9 grep-guard + H4 rate cap (P1-1..4), Lane E = web UI
(P1-5), Lane F = MCP server + agent-write tool (P2, unblocks P1-2's agent slice).
Self-review the cross-branch seams (handle codec used by C/D/F; the P1-1
`target_event_id` removal touches existing chat code) per the usual recipe.
