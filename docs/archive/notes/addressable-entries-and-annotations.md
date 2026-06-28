# Addressable Entries & Shared Annotations — universal entry handles + one comment/reaction model

Status: **DESIGN LOCKED (Gary, 2026-06-23) after a hand-compute/stress-test pass; not built.**
Captures the grounded current-state, the decisions, the design, the hand-computed
edge cases, and why this beats the alternatives. Build plan:
`addressable-entries-build-plan.md`.

Origin: the "internal artifact URL scheme" question — *should Atrium expose a
product-native scheme (`atrium://…`) so harnesses can reference files, child
outputs, reviews, patches, histories without dumping content into prompt text?*
Tracing it landed here: the URL handle, the "copy a link" target, and the
"comment/react on it" anchor are **the same primitive** — a universal,
resolvable entry handle.

Sister docs:
- `agent-data-architecture.md` — logs/artifacts/workspaces; this is the
  addressing+annotation layer that sits on top of the logs shape.
- `agent-activity-observability.md` — surfacing nested sub-agent runs; child runs
  are the one entry type with **no identity today** (see §8).
- `session-record-projection-build-plan.md` — the `session_records` projection
  this addresses.
- `macro-borrow-plan.md` — "Atrium has no MCP server" (#1 gap); the handle is the
  resource id an MCP server would expose (§7).

---

## 1. Problem

Today there is **no way to reference, link to, or annotate a single entry** in
either the chat or the agent transcript with one uniform mechanism:

- Chat messages can be reacted to and threaded, but only chat messages.
- Agent-transcript entries (a diff, a review, a command, a plan, a reasoning step)
  have a stable id **but no resolve route and no annotation path at all**.
- There is **no universal handle** that spans both, so harnesses can't reference
  "that entry" by a short stable token, humans can't copy a deep link to it, and
  agents can't point at a prior entry instead of re-inlining its content.

The premise that motivated the URL-scheme idea — "stop dumping content into
prompts" — is **already ~80% solved for files** (artifacts flow by reference via
the CAS ledger + by-path/hydration routes; nothing is inlined). The genuine,
unmet need is **uniform addressing + annotation for *entries*** (the conversational
and transcript units), and identity for the entry types that have none.

## 2. Grounded current state (verified 2026-06-23)

Three separate, **incompatible** id spaces — no universal key:

| Store | Key | Paradigm | Notes |
|---|---|---|---|
| `events` (chat) | `id bigserial PRIMARY KEY` | **event-sourced, append-only, immutable** | `001_init.sql:37` |
| `session_records` (transcript) | `PRIMARY KEY (session_id, seq)` | **materialized projection, mutates in place** | `039_session_records.sql` |
| `session_events` (raw frames) | `PRIMARY KEY (session_id, centaur_event_id)` | append-only frame log (projection input) | `027_session_events.sql` |

"event_id" is **overloaded** across three meanings: `events.id` (chat),
`session_records.event_id` (= latest contributing Centaur frame, *not unique*),
`session_events.centaur_event_id`. Watch this when naming things.

**Chat already implements the exact model we want** — anchor-to-entry, append-only,
tombstone-friendly:
- Reactions are **not a table**: `reaction.added`/`reaction.removed` *events* with
  `payload.target_event_id`, net-summed at read (`events.ts:setReactionTx`, `:488`).
- Edits are `message.edited` events with `payload.target_event_id`; reads fold the
  latest (`events_edit_target` index, `001_init.sql:62`). Rows never mutate.
- Threads = `events.thread_root_event_id`.

**Transcript is the opposite** — and that's correct by design. A streaming entry is
**one record that mutates in place** (`session-records.ts:603–661`):

| Frame | Action | seq | text | meta |
|---|---|---|---|---|
| f1 | `pushRecord`, opens `openAmpTextIndex` | 42 | `"Let me"` | `streaming:true, sourceEventIds:[f1]` |
| f2 | `updateRecord(42, text=existing+…)` | **42** | `"Let me check the"` | `streaming:true, sourceEventIds:[f1,f2]` |
| f3 (final) | `updateRecord(42, streaming:false)` | **42** | `"Let me check the file."` | `streaming:false, sourceEventIds:[f1,f2,f3]` |

Crucially, **mutation targets a record by harness-native logical key, not by
position**: `messageId`/`uuid`, `tool_use_id` (`:751`), `questionId` (`:952`),
codex `itemId`, `changeIndex` (`:912`). `seq` is just the array index stamped at
creation (`:1005`); every record also carries `meta.sourceEventIds` provenance.
This is what makes a durable anchor possible (§6).

No `comment`/`annotation`/`reaction` table exists in migrations. Reactions today
target only `type='message.posted'` (`setReactionTx`); nothing targets transcript.

## 3. Decision

1. **Do NOT physically merge the tables or share one primary key.** Unify the
   **handle namespace logically** instead (§4). Physical merge is rejected for
   contention/index/lifecycle/authz/paradigm reasons (§9).
2. **Keep the coalescing upsert** on `session_records`. Don't make records
   append-only — once annotations live *off* the record (§5), target mutation can
   no longer threaten annotation integrity.
3. **Extend chat's event-sourced annotation pattern** rather than introduce a new
   annotation store: generalize `payload.target_event_id` (chat-only bigint) →
   `payload.target` (universal handle). One model for comments, reactions, edits,
   tombstones, across chat *and* transcript.

The handle (1) and extend-the-pattern (3) are **complementary, not alternatives**:
extending requires the handle, because `target_event_id` is a chat-only bigint.

### 3a. Resolved choices (Gary, 2026-06-23)

- **Sequencing — P1 annotations and P2 MCP run in parallel** after P0. The
  human-collaboration value (comment/link/react) and the agent-reference value
  (MCP `resources/read`) are co-equal; neither blocks the other once handles exist.
- **No GC of transcripts/chat — they live forever** (verified: nothing deletes
  `sessions`/`session_records`/`session_events`; `gc.ts` only sweeps orphan
  uploads; `data-lifecycle.md` — "no event pruning today"). So **EC3 (dangling
  annotations from GC) is not a real risk**; drop tombstone-for-GC machinery. The
  only delete is *explicit user delete* (chat already tombstones via
  `message.deleted`; transcript entries aren't user-deletable today). Forward-compat
  only: a future archival path must keep entries resolvable — design the resolver so
  an archive fallback is additive (§ EC3, revised).
- **Humans + agents author annotations.** An agent's review/critique can be a
  first-class comment, not only a transcript entry → there IS an agent annotation
  write path (actor `agent`), with the usual auth/rate considerations.
- **v1 = chat + transcript entries only.** Defer `run_*` child/sub-agent run
  identity (§8) to a later phase — net-new identity, downstream of the observability
  capture work.
- **Anchor = surrogate id (not raw `seq`).** Forced by the *live* rebuild path, not
  by GC (§6, EC2).

## 4. Universal entry handle

A typed string that resolves to exactly one entry.

```
evt_<bigserial>            → events row            (chat entry)
rec_<opaque>               → session_records row   (transcript entry)
run_<opaque>               → sub-agent / child run (NEW identity, §8)
```

> **Hardening amendment (2026-06-24): only `rec_*`/`run_*` are opaque; `evt_*` is a
> transparent, derivable bigint.** Opacity buys "the backing can evolve without
> breaking issued references" — which matters for the *derived* `rec_*` surrogate, but
> chat `events.id` is already a stable immutable key, so wrapping it adds a codec + key
> for no real benefit. Trade-off accepted: `evt_*` is enumerable, leaking
> existence/cardinality (not content — authz at resolve is the control). See build-plan
> H8.

- `evt_*` is trivially derivable from the existing immutable `events.id`.
- `rec_*` is backed by a **stable record surrogate id** (§6), *not* raw `seq`, so
  re-projection can't re-point it.
- The handle is the single token used by: the resolve route (§5b), the "copy link"
  UI, the agent-facing reference (instead of inlining), and the MCP resource id
  (§7). One concept, four uses.

## 5. Shared annotation model

### 5a. Storage — annotations are events

Annotations (comment / reaction / edit / tombstone) are **append-only events in the
existing `events` log**, because an annotation is inherently social, append-only,
and itself wants threading + reactions. The only generalization:

```
payload.target = <handle>     // replaces / supersedes payload.target_event_id
```

Event types (existing + new):
- existing: `reaction.added`, `reaction.removed`, `message.edited`
- new: `comment.posted`, `comment.edited`, `comment.deleted`, `entry.deleted`
  (tombstone), and reaction/edit generalized to accept `target` (handle).

Back-compat: chat keeps working unchanged; for a chat target, `target = evt_<id>`
and writers may continue to set `target_event_id` during migration. Readers prefer
`target`.

**Tenant scope of an annotation on a transcript entry:** the session belongs to a
channel/workspace, so a `rec_*` annotation event is written into the session's
channel/workspace — keeping it in the correct tenant scope and visible in context.

> **Hardening amendment (2026-06-24): annotation visibility = channel membership**
> (decision). A transcript-entry annotation follows the *channel* it's stored in — the
> broadest scope here. Since channel-member ⊆ the entry-resolve union (`full_view` OR
> channel-member OR `spawned_by`, §5b), anyone who can see an annotation can resolve its
> entry, so the dual-authz "split brain" collapses to one rule. Documented edge: a
> `full_view`-without-membership viewer (rare) resolves the entry but not its
> channel-scoped annotations. See build-plan H6.

### 5b. Resolution routes

```
GET  /api/entries/:handle               → normalized entry payload
GET  /api/entries/:handle/annotations   → threaded comments + reaction net
POST /api/entries/:handle/comments      → emits comment.posted
POST /api/entries/:handle/reactions     → emits reaction.added/removed
```

Normalized entry payload (uniform across types): `{ handle, kind, actor, text,
meta, targetType: 'event'|'record'|'run', sourceRefs, tombstoned }`. Resolution
enforces authz per target: chat = channel membership; transcript/run = session
`full_view`. The handle is global; **access is not** (§ EC8).

## 6. Anchor durability (the load-bearing decision)

Raw `(session_id, seq)` is **positional** — stable under normal forward projection,
but a *projection-logic change* (new record kind, changed merge rule) or a
non-deterministic replay can renumber historical `seq` and silently re-anchor every
comment. This is a **live runtime path**, not just a code-migration concern:
`rebuildSessionRecords` (`session-records.ts:225`) does a full `DELETE` + re-project,
reachable via `POST …/atrium/reproject` (`app.ts:3196`) and the changefeed
(`projectAndEmitChange`). So the surrogate is required, not optional. Fix:

- **Allocate an opaque surrogate id per record at first creation; preserve it
  across re-projection by matching the harness-native logical key already in
  `meta`** — `messageId`/`uuid` (claude), `tool_use_id` (tools), `questionId`,
  codex `itemId`, or `sourceEventIds[0] + changeIndex` (file changes). These come
  from the harness/model, so they're replay-stable. The surrogate becomes the
  `rec_*` handle; resolution maps surrogate → current `(session_id, seq)`.
- Store the target's `sourceEventIds[0]` (creating frame) on each annotation as a
  **repair hint**, so drift is detectable even if a cheaper backing is used early.

Cheap interim path (acceptable pre-scale): back `rec_*` directly by encoded
`(session_id, seq)` and treat a breaking projection-logic change as a **migration
event** (re-stamp anchors). Because the handle is opaque (§4), the backing can be
upgraded later without changing issued handles.

## 7. MCP / agent-facing tie-in

The same handle is the resource id an MCP server (the #1 Macro-eval gap) would
expose: `atrium://entry/<handle>` → `resources/read` → the §5b resolve payload.
That gives the agent the reference-not-inline capability across **any** harness
(claude/codex/amp) with no custom per-harness URI parser. A bespoke
`atrium://`-string-parsed-from-prompt-text is explicitly rejected: a URL the
harness can't dereference is dead text. Resolution is always a tool/protocol the
agent actually calls (egress-only model: the agent reaches *out*).

## 8. Child / sub-agent runs (the one net-new identity)

Diffs/reviews/commands are easy — they're already `session_records`. **Child runs
are not.** A nested `claude -p` / `codex exec` produces internals that live only in
the sandbox's local `~/.claude` / `~/.codex` JSONL and are double-excluded from
capture (see `agent-activity-observability.md`). So a child run has **no
`(session_id, seq)` handle at all**. Making `run_*` real = mint a durable id per
child run + capture its records — that's identity invented from scratch, tracked
separately and downstream of the observability work.

## 9. Why this is the best solution (alternatives considered)

- **Physical single table / shared PK — rejected.** Co-locating a write-heavy,
  mutating projection with a read-optimized chat timeline forces contention on the
  chat indexes (tsvector GIN, thread indexes, changefeed triggers); forces one
  index/lifecycle/authz/mutation paradigm on two different workloads
  (`ON DELETE CASCADE` session vs channel-lived; membership vs `full_view`;
  immutable vs mutating). The `bigserial` *sequence* is cheap; the **table/index
  coupling** is the cost. Logical unification gets every benefit (link, resolve,
  anchor, MCP id) with none of it.
- **New polymorphic `annotations` table — rejected as primary.** Standing up a
  second annotation paradigm means chat reactions stay as events while transcript
  comments live in a table — two mechanisms, or a migration of all chat reactions.
  Extending the event-sourced pattern reuses the model that already ships and gets
  tombstones + threading + reactions-on-comments **for free**.
- **Bespoke `atrium://` string parsed from prompt text — rejected.** Dead text the
  harness can't dereference; N custom parsers; lock-in. Handle + MCP `resources/read`
  is dereferenceable everywhere (§7).
- **Anchor on raw `seq` — rejected as the durable key.** Positional; a projection
  change orphans every comment. Surrogate seeded by harness-native keys (§6).
- **Make transcript append-only to match chat — rejected.** The coalescing upsert
  is the right design for streaming (one growing record, not N events). Decoupling
  annotations via the handle removes the only reason to want append-only.

## 10. Hand-computed edge cases (stress test)

- **EC1 streaming-comment.** Comment on `rec_X` mid-stream; later frames mutate the
  record. Comment still resolves (anchor = handle, not content). ✅ = "anchor to
  entry; entry can be edited," identical to commenting on a later-edited chat msg.
- **EC2 re-projection — LIVE runtime break, confirmed by hand-compute.** `seq` is
  deterministic only if frame order *and* projection logic are unchanged. And full
  rebuild is reachable at runtime, not just on code migration: `rebuildSessionRecords`
  does `DELETE FROM session_records … + re-project` (`session-records.ts:225`), hit
  by `POST /api/sessions/:id/atrium/reproject` (`app.ts:3196`) and the changefeed's
  `projectAndEmitChange` (`session-record-changefeed.ts:67`). Walked: with positional
  `rec_<S,seq>`, a projection-code change that inserts an earlier record shifts the
  diff from seq 42→43, and a comment on `rec_S_42` silently re-anchors to the wrong
  entry. With a surrogate seeded from `meta.tool_use_id`/`messageId`/`itemId`/
  `sourceEventIds[0]` (all replay-stable, sourced from the immutable frame log, not
  position), the diff keeps its surrogate across the rebuild and the comment resolves
  correctly. **⇒ positional `seq` is unsound as the durable anchor; surrogate is
  required** (§6). Note: rebuild ≠ GC — rebuild re-derives the same logical entries.
- **EC3 session GC — NOT A RISK (revised).** Verified nothing deletes
  `sessions`/`session_records`/`session_events`; `gc.ts` sweeps only orphan uploads;
  `data-lifecycle.md` = "no event pruning today." Transcripts and chat live forever,
  so annotations can't dangle from GC. Only delete = explicit user delete (chat:
  `message.deleted` tombstone exists, `events.ts:388`; transcript: not user-deletable
  today). Forward-compat: a future archival path must keep entries resolvable —
  resolver gets an archive fallback then (additive), not now.
- **EC4 delete target with comments.** Tombstone, never hard-delete: `entry.deleted`,
  keep row as anchor, render stub with thread intact. Chat already does this;
  transcript needs soft-delete added (today redaction blanks `text` but keeps the
  row — a partial tombstone to build on). ✅
- **EC5 delete a comment that has replies/reactions.** Comment is itself an event →
  `comment.deleted` tombstone; children survive, re-parent to stub. Recursion free.
- **EC6 reaction concurrency on a transcript target.** Chat locks the target
  `events` row `FOR UPDATE` (`events.ts:478`); a transcript target has no such row.
  Serialize on an advisory lock keyed by handle, or rely on the idempotent
  per-`(target,actor,emoji)` net-sum. Small seam.
- **EC7 file_change granularity.** Codex fileChange with N edits → N records
  (per `changeIndex`, `:912`), each its own handle → "comment on the 2nd diff"
  works; diffs are per-entry, per-change. ✅
- **EC8 cross-session / cross-workspace deep link.** Handle is global; resolve must
  enforce session `full_view`. Same check applies to agent cross-referencing.

## 11. Build phases (per resolved sequencing — P1 ∥ P2)

- **P0 — handle + resolve (read-only).** Record surrogate id (§6) + `evt_*`/`rec_*`
  handles + `GET /api/entries/:handle` + handle-bearing transcript read. No
  annotations yet. Delivers copy-link + the resolvable substrate both P1 and P2 need.
- **P1 — annotations (∥ P2).** Generalize `target_event_id → target`; `comment.*`
  events + `GET/POST …/annotations|comments|reactions`; `payload->>'target'` index;
  agent annotation write path (humans + agents); transcript explicit-delete
  tombstone. Brings transcript to chat parity.
- **P2 — MCP resources (∥ P1).** `atrium://entry/<handle>` via an MCP server (closes
  the Macro "no MCP server" gap); agents reference instead of inline. Depends only on
  P0.
- **P3 — `run_*` identity (deferred).** Child/sub-agent run capture + handles;
  downstream of `agent-activity-observability.md`.

## 12. Open questions — resolved 2026-06-23

- ~~EC3 lifecycle~~ → **no GC; transcripts forever** (§3a, EC3). Only explicit-delete
  tombstone; archive fallback deferred.
- ~~Agents emitting annotations~~ → **yes, humans + agents** (§3a).
- Handle opacity → **opaque public form** (`rec_<surrogate>`), structured internally;
  surrogate derived from replay-stable provenance keys (§6).

Remaining genuinely-open (build-time, not blocking the plan):
- Exact surrogate derivation when a future projection change alters frame *coalescing*
  (narrow, detectable; pick repair vs re-stamp then).
- Whether agent-authored annotations need rate/spam controls in v1 or later.
