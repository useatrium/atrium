# Atrium × Macro — Borrow-Plan / Design Spec

> **Purpose.** Decide what (if anything) Atrium should borrow from Macro (docs.macro.com). Companion to [`macro-product-surface.md`](./macro-product-surface.md) (the full Macro crawl). This doc compares Macro's four most interesting ideas against **what Atrium actually does today** (verified against the codebase, file refs inline) and judges each through an **agent-UX-first, then human-UX** lens, per Gary's direction (2026-06-22).
>
> **Method.** Four parallel code-mapping passes over `surface/{server,web,shared,centaur-client}` + all 40 migrations + `notes/`. Conclusions are grounded in source, not the marketing site.

---

## 0. TL;DR

**Positioning recommendation: STAY FOCUSED.** Borrow the *agent-data + connective-tissue* patterns that amplify the agent↔human loop. Do **not** chase Macro's suite breadth (email client, calendar, CRM, canvas, calls). Rationale in §2.

**The key reframe:** Macro is a *human-productivity suite with agents bolted on as readers/actors*. Atrium is an *agent-execution substrate with human collaboration around it*. They are near-inverse shapes. Atrium already owns the hard, defensible parts Macro lacks (versioned CAS artifact ledger, jj-style "never auto-pick" conflict model, gap-free change-feed, live agent-session surfaces, channel-derived permissions). The gaps vs Macro are mostly **connective tissue and reach**, not foundations.

**Ranked borrow backlog** (agent-UX value first; full detail §3–§4):

| # | Borrow | Axis | Agent-UX | Human-UX | Cost | Verdict |
|---|---|---|---|---|---|---|
| 1 | **Agent-facing MCP entity + two-axis search** (wrap existing ledger/records/channels; remote OAuth for external Claude Code/Codex) | MCP | ★★★ | ★ | M | **Adopt** |
| 2 | **Entity-reference segment + live pills** (resolvable refs render the existing live `SessionCard` inline) | Data model / perms | ★★★ | ★★★ | S–M | **Adopt** |
| 3 | **Backlink / References graph** (`references(src,target,kind)` edge table unifying today's ad-hoc FKs) | Data model | ★★ | ★★ | S–M | **Adopt** |
| 4 | **Scoped cross-session memory + retrieval-at-spawn** (over sessions/chat/artifacts, fed by the change-feed) | Memory | ★★★ | ★★ | M–L | **Adapt** |
| 5 | **Unified "needs-me" inbox** (aggregate mentions/DMs/session-questions/conflicts/completions) | Perms/UX | ★ | ★★★ | M | **Adopt** |
| 6 | **Scoped typed-properties on the artifact/notes subsystem** ("notes→artifact-canonical", status/owner/tags) | Data model | ★★ | ★★ | M | **Adapt** |
| 7 | **Explicit share dialog + public links** (exception layer over channel-derived access) | Perms | ★ | ★★ | S–M | **Adopt (later)** |
| 8 | Snippets (`;`, agent-instruction-aware) | UX | ★ | ★★ | S | **Adopt (cheap polish)** |
| — | Universal "everything is a block" table | Data model | — | — | XL | **Reject** |
| — | Universal EAV properties replacing hard columns | Data model | — | — | L | **Reject** |
| — | Loro/CRDT co-edit on the agent write-path | Collab | ✗ regression | ★ | L | **Reject** (maybe opt-in human-prose fast-path only) |
| — | Suite breadth: email/calendar/CRM/canvas/calls | Product | — | — | XXL | **Reject** |

---

## 1. The two products, side by side

| | **Macro** | **Atrium** |
|---|---|---|
| Core thesis | One DB, "everything is a typed block", agents as first-class peers to the data model | Event-sourced messaging + agent-orchestration; files in / files out / projections to read |
| Data substrate | One block table + unified typed-properties + @mention backlink graph | Append-only `events` spine (chat) + **per-surface relational tables** (sessions, artifacts, calls, files) |
| Agent interface | **Tools** — remote OAuth MCP server, one Rust tool registry shared by in-product + external agents | **Filesystem/data** — node-daemon capture (out), read-only `/atrium` projections (in); **no MCP, no tool registry** |
| Memory | Cumulative personal+team memory, nightly refresh, auto-retrieval | **None** — context = the literal user message; no memory table |
| Permissions | Channel-membership-derived + owner/editor/viewer dialog + public links | **Channel-membership-derived** (already!); no share dialog, no roles, no public links |
| Concurrency | Loro CRDT auto-merge over Durable Objects | **diff3 + human conflict resolution** (jj-style, never auto-pick); no CRDT |
| What it has that the other lacks | Breadth (email/CRM/calls/canvas), polished human UX, MCP reach, memory | **Agent execution sandbox, versioned artifact ledger, correct multi-writer conflict model, live agent-work surfaces** |

The single most important observation: **Atrium has already built the expensive backend that Macro's agent layer sits on** (a versioned, conflict-aware, ACL-scoped, change-fed entity store). What's missing is the *thin agent-facing surface* on top of it — which is exactly the cheap, high-leverage part to borrow.

---

## 2. Positioning decision: focused vs. expand (Gary asked me to recommend)

**The trade-off.**

- **Expand toward a fuller workspace** (treat Macro as a product blueprint: add inbox, docs, channels-as-hub, calendar, CRM…). Upside: a complete daily-driver, one-app story (aligns with [[atrium-daily-driver-plan]]). Downside: every one of those surfaces is a crowded, well-funded category (Macro itself just raised $30M to fight there) where Atrium has **no moat and no differentiation**. It also dilutes the team across surface area that has nothing to do with the thing Atrium is uniquely good at.
- **Stay focused on the agent↔human substrate** (borrow only the data-layer + connective-tissue patterns). Upside: every borrow *compounds Atrium's existing moat* (the ledger, conflict model, sessions) instead of competing head-on with suites. Downside: Atrium stays a "layer", not a full destination app — though the daily-driver wishlist can still be met by borrowing *patterns* (inbox, references, memory) without becoming an email client.

**Recommendation: STAY FOCUSED.** Atrium's defensibility is the agent-execution + sync + conflict substrate — none of which Macro has. Borrow the patterns that make agents and humans *reference, find, remember, and triage shared work* (items 1–6), because those amplify the loop Atrium already owns. Treat Macro's breadth as a *UX pattern library*, not a feature checklist: e.g. steal the Signal/Noise **inbox pattern** for "what needs me", but do not build an email client; steal **live pills** for sessions/artifacts, not for a CRM.

The litmus test for any future borrow: *"Does this make the agent↔human work-loop tighter, or does it just make Atrium a worse version of an existing suite?"* Build the former.

---

## 3. The four axes — verdicts

Each axis: **Macro model → Atrium today (with evidence) → agent-UX verdict → human-UX verdict → borrow call.**

### 3.1 Block / entity + typed-properties data model

**Macro.** One table, everything a typed block (`md/email/channel/chat/project/contact/...`). Unified typed-properties (STRING/NUMBER/BOOLEAN/DATE/SELECT/ENTITY-ref/LINK; system/custom/metadata; pinnable). Tasks ARE documents (`isTask=true`).

**Atrium today.** Event-sourced + **per-surface relational** — ~38 hand-rolled SQL tables, no ORM (`surface/server/migrations/001_init.sql:1-4`; `db.ts`). The `events` spine (`001_init.sql:36-45`) is the *only* universal substrate, and it's an append-only **log of chat actions** (discriminated by `type text` + schemaless `payload jsonb`), not an entity store. Sessions (`002_phase2_sessions.sql:4-22`), the artifact CAS ledger (`033_artifact_ledger.sql`), calls, files are all bespoke tables with hard columns + CHECK enums + tuned partial indexes. **No** unified block table, **no** properties layer (attributes are hard columns or untyped `jsonb`), **no** `isTask`, and crucially **no documents/notes/tasks surface exists at all** (grep: zero hits). Mentions are a 13-line regex composer matcher (`surface/shared/src/mentions.ts`); there is **no backlink/references table** — cross-links are ad-hoc FKs (`thread_root_event_id`, `payload.sessionId`, `payload.target_event_id`).

**Agent-UX verdict.** The universal-block model would, in theory, give an agent one uniform way to enumerate/read/write anything. But Atrium can get ~80% of that *agent-facing uniformity* from a thin MCP entity adapter (§3.2) **without** rewriting storage. The part agents genuinely lack is **referenceability + backlinks** (an agent can't cite or link the session/artifact it just produced).

**Human-UX verdict.** Humans lose nothing today from the per-surface model; they lose from the *missing* pieces — no references panel, no hover previews, no doc/notes surface.

**Borrow call.**
- ✅ **Backlink/References graph** (item 3) — additive `references(src_type,src_id,target_type,target_id,kind)` edge table that unifies the already-ad-hoc FKs into one queryable graph; powers "where is this referenced", hovercards, a references panel. **No data migration needed.** Best ROI on this axis.
- ✅ **Scoped typed-properties on the artifact/notes subsystem** (item 6) — a `properties(artifact_id, def_id, typed_value)` layer keyed to the existing `artifacts` ledger, not a global EAV. Realizes "tasks-are-documents" at contained cost and matches the already-decided "notes→artifact-canonical" direction ([[agent-data-architecture]], [[atrium-daily-driver-plan]]).
- ❌ **Universal block table** — would fight Atrium's load-bearing grain (append-log vs mutable read-models; per-surface CHECK constraints, FKs, indexes the control-loop + feeds depend on). XL cost, *loses* correctness guarantees. Reject.
- ❌ **Universal EAV properties** replacing hard columns (`cost_usd`, `status`, `merge_class`) — de-types the hottest indexed paths + breaks projections/feeds. Reject; use the scoped version instead.

### 3.2 Agent-first MCP entity registry

**Macro.** Remote OAuth MCP server; one Rust tool registry serves both the in-product agent and external Claude Code/Codex. Unified entity triad (`ListEntities`/`GetEntityProperties`/`SetEntityProperty`), two-axis search (`ContentSearch` body + `NameSearch` metadata), `ReadContent`/`CreateDocument`(+`isTask`)/`GetThread`/`ReadThread`/`SendEmail`, plus bundled bash/text-editor/web tools. Agent inherits the user's permissions.

**Atrium today.** **No MCP server anywhere** (exhaustive grep: zero hits for `mcp`/`jsonrpc`/`tools/call`/tool registry). Centaur is driven by coarse session-lifecycle HTTP calls (`surface/centaur-client/src/client.ts`: `spawn`/`postMessage`/`execute`/...) — the agent is **steered by free-text user messages + stdin**, never handed a tool schema. The `/atrium/*` projection endpoints (`app.ts:2894-3045`, `atrium-session-projection.ts`) render Markdown/JSONL **for reading** but are **built-yet-unconsumed** (only tests call them). Writes go through an **x-api-key node daemon** as `node:<session>` (`app.ts:3082-3298`), not as the user. Search exists (`session-search.ts`, Postgres FTS over `session_records.text`) but is **single-axis and cookie-auth/human-only** — not agent-callable. The unified-ish data shapes already exist: `session_records` (10 kinds: message/command/file_change/artifact/question/reasoning/plan/tool_call/usage/status), the artifact ledger keyed by `(session_id, path)`, and `artifact-scope.ts` ACLs.

**Agent-UX verdict.** This is the **single biggest agent-UX gap and the highest-leverage borrow.** Today an agent can't *discover* the workspace as entities, can't *call* search, mostly sees a *stale startup snapshot*, and external coding agents can't reach Atrium at all. Macro's exact pattern maps cleanly because the expensive substrate (ledger, conflict, scope-ACL, change-feeds, FTS, projections) is already built — the registry just **wraps** it.

**Human-UX verdict.** Mostly invisible to humans directly, but it's the enabler for memory (§3.3) and for letting people run their own Claude Code/Codex against the workspace.

**Borrow call.** ✅ **Adopt (item 1)** — a thin Atrium MCP server:
- `ListEntities` / `ReadContent` / `ReadMetadata` mapped onto sessions + artifacts (the `/atrium` renderers are already ~`ReadContent`).
- **Two-axis search** — expose the existing FTS as a callable `ContentSearch`, add a `NameSearch` metadata axis. (The design docs already call for an `atrium search` "power tool" — `agent-sync-design.md`.)
- `SetProperty`/`CreateArtifact` writes mapped onto the existing ledger write-back path (respect scope-ACL).
- **Remote + OAuth** so external Claude Code/Codex can connect (`claude mcp add --transport http ...`) — pure net-new reach.
- ❌ Do **not** rebuild storage/versioning/conflict/capture — wrap them. The overlay-scan capture lane is a deliberate FS-as-interface design; keep it for the *write/capture* path and add MCP for *read/search/discovery/external access*.

### 3.3 Unified memory (personal / team)

**Macro.** Cumulative personal+team memory across all surfaces; **nightly refresh** from daily activity; agents auto-retrieve context ("what's the latest on project alamo?"); same index for agents + manual search. Explicitly NOT single-conversation chat memory.

**Atrium today.** A solid 3-layer **per-session** pipeline — raw `session_events` mirror → redacted/rendered `session_records` projection (lean/full tiers + FTS) → **gap-free `session_record_changes` change-feed** (xid8+id cursor, advisory-lock writer protection) — plus per-session `harness_transcripts` (resume) and the artifacts ledger/feed. But context assembly sends the agent **only the literal user message** at spawn/steer (`session-runs.ts:1109-1149`); the "# Session Context" block is injected by the Claude Code harness itself (date/thread/platform only). **No cross-session, cross-surface, or cumulative memory; no `memory`/`knowledge` table in any of the 40 migrations; no personal/team tiers (only per-resource scoping); no nightly refresh; no auto-retrieval.** `notes/session-record-projection-build-plan.md` already lists a "Memory lane" as a separate **unbuilt** typed-lane store — the gap is internally acknowledged.

**Agent-UX verdict.** Big gap. Agents start cold every session. A cumulative, retrievable memory over Atrium's *real* surfaces (sessions/chat/artifacts) — injected at spawn — would materially improve agent quality and continuity. The substrate is right there: the change-feed is exactly the ordered, ACL-scoped activity stream a memory layer ingests.

**Human-UX verdict.** Indirect but real ("what happened across my sessions this week"). Maps onto the session-records search UI that already exists.

**Borrow call.** ✅ **Adapt (item 4)** — build a **scoped** memory layer, not a Macro-breadth clone:
- Ingest from the **existing change-feed** (sessions/chat/artifacts), not 9 surfaces Atrium doesn't have.
- A `memory` store (summaries + embeddings) + a **retrieval-at-spawn** step that injects relevant prior context into the agent (closing the "literal user message only" gap).
- Optionally a periodic summarization/refresh job (Macro's nightly cycle) — but pull-on-spawn first; batch refresh later.
- Skip Macro's **personal-vs-team memory tiers** as framed — Atrium's scoping is already per-resource (`user_id` vs `workspace_id`/`channel_id`); "team memory" = workspace-scoped, "personal" = user-scoped. Reuse the channel-derived ACL (§3.4) for memory visibility rather than inventing tiers.

### 3.4 Channel-derived permissions (+ live pills, inbox, CRDT)

**Macro.** Access derived from channel membership (mention-in-channel = share; add/remove member = access flows). Owner/editor/commenter/viewer dialog + public links for exceptions. Live pills (mentions show current metadata). Signal/Noise unified inbox. Loro CRDT co-edit.

**Atrium today.**
- **Channel-derived permissions: already the model.** `canAccessChannel` (`events.ts:965-982`): public → any workspace member; private/dm/gdm → explicit `channel_members` row. Sessions, artifacts, files all derive access from their channel (`session-runs.ts:519-525, 886-893`; `events.ts:991-1016`). Add/remove a `channel_members` row → access to that channel's messages/sessions/artifacts/files flows automatically. **This is Macro's foundational idea, already shipped.** Missing: a share dialog, owner/editor/viewer roles (the one `role` column is always `'member'`), and public links.
- **Live pills: structural mismatch but the hard part exists.** Mentions in text are **inert static handles** (`formatting.ts`, `MessageText.tsx:33-47`) — no entity id, no hover, no status, not even an autocomplete dropdown. BUT the genuinely live `SessionCard` (`SessionCard.tsx:76-203`, WS-driven status/cost/elapsed/spectators) already exists — it's just bound to the `session.spawned` timeline position, not to a text reference.
- **Unified inbox: none.** Per-channel unread badges (`Sidebar.tsx:112-130`) + a tab-title count (`Chat.tsx:1684-1691`) + transient OS toasts (`notify.ts`). No inbox endpoint or page. Push fans out per-message for `dm|mention|thread` (`push.ts`).
- **Concurrency: no CRDT.** WS fanout (`hub.ts`) + Postgres change-feed for liveness; artifact edits are **diff3 + human conflict resolution** (`artifact-writeback.ts`, `artifact-conflict.ts`, `ConflictSurface.tsx`), jj-style, never auto-pick.

**Agent-UX verdict.** (a) Referenceability is the headline gap — an agent can't drop a resolvable, live reference to a session/artifact/doc into a message. (b) **CRDT would be a regression** for the agent write-path: you do *not* want two agents' edits silently char-merged into broken code/JSON. Atrium's detect-then-resolve model is *more correct* for agents; keep it.

**Human-UX verdict.** (a) **No unified inbox is the clearest human deficiency** — a person juggling many channels + agent sessions has no "what needs me" surface, even though agent events (needs-input, conflicts, completions) are first-class. (b) No share-for-exceptions (one artifact to one outsider; a public doc link) without adding them to the whole channel.

**Borrow call.**
- ✅ **Live pills (item 2)** — add a `{ kind:'ref'; entityType; id }` message segment + a resolver that renders the existing live `SessionCard`/artifact card inline anywhere. Highest-leverage single UI borrow; pairs with the backlink graph (§3.1) and an autocomplete on the already-present `mentions.ts` matcher.
- ✅ **Unified "needs-me" inbox (item 5)** — aggregate mentions/DMs/`session.pendingQuestion`/conflicts/completions. Data largely exists (read cursors, push reasons, change-feed); it's an aggregation layer + a screen, borrowing Macro's Signal/Noise *triage pattern* (not its email).
- ✅ **Share dialog + public links (item 7)** — a thin grant table + presigned/public-link path as the **exception** layer over the channel-derived default. Later.
- ❌ **Loro/CRDT on the agent write-path** — reject (regression). At most, a future opt-in CRDT fast-path for *human* live co-editing of prose/notes, never the agent artifact path.

---

## 4. Build sequence (recommended)

Ordered to front-load agent-UX and reuse existing plumbing; each phase is independently shippable.

1. **Phase A — Agent reach & discovery (item 1).** Thin MCP server wrapping ledger + session_records + channels; expose `ContentSearch` (existing FTS) + add `NameSearch`; `ListEntities`/`ReadContent`. Remote + OAuth for external Claude Code/Codex. *Reuses:* `atrium-session-projection.ts`, `session-search.ts`, `artifact-ledger.ts`, scope-ACL. **Biggest agent-UX unlock, mostly wrapping.**
2. **Phase B — Referenceability (items 2 + 3).** `references` edge table + `{kind:'ref'}` message segment + inline live-card resolver + mention autocomplete + hovercards/backlinks panel. *Reuses:* `SessionCard.tsx`, `mentions.ts`, `formatting.ts`. **Biggest combined agent+human UX unlock.**
3. **Phase C — Memory (item 4).** `memory` store + change-feed ingestion + retrieval-at-spawn (fixes "literal user message only"); summarization/refresh job later. *Reuses:* change-feed, session_records, the planned "Memory lane".
4. **Phase D — Triage & sharing (items 5 + 7).** Unified "needs-me" inbox; then share dialog + public links. *Reuses:* read cursors, push reasons, pendingQuestion, conflict feed.
5. **Phase E — Polish (items 6 + 8).** Scoped typed-properties on artifacts/notes; snippets. As the notes-as-artifact surface matures.

**Explicitly out of scope:** universal block table, global EAV, CRDT on the agent path, and Macro's suite breadth (email client, calendar, CRM, canvas, native calls — Atrium already has voice/calls separately).

---

## 5. Open questions / decisions for Gary

1. **MCP auth model (Phase A).** Macro = remote OAuth, "agent inherits the user." Atrium agents currently write as `node:<session>` via x-api-key. For external Claude Code/Codex reach we'd need a real per-user OAuth token scoped to that user's channel access. Do we want external-agent reach in v1, or start with an internal agent-only tool surface and add OAuth later? (Touches [[byo-subscription-credentials]].)
2. **Memory ambition (Phase C).** Retrieval-at-spawn only (cheap, big win), or also the nightly summarization/refresh cycle (more infra)? Personal+workspace scoping via existing ACL, or do we actually want explicit memory tiers?
3. **Notes-as-document surface (Phase E).** "notes→artifact-canonical" is already decided — do we want the typed-properties layer (status/owner/tags → tasks-are-documents) in this round, or keep notes property-less for now?
4. **Inbox scope (Phase D).** Full Signal/Noise triage like Macro, or a simpler single "needs-me" list first?

---

*Sources: `notes/macro-product-surface.md` (Macro crawl) + four code-mapping passes over `surface/{server,web,shared,centaur-client}` and `surface/server/migrations/*` on 2026-06-22.*
