# Session-record projection + search + `/atrium` agent context — build plan

> **Status: BUILD PLAN (2026-06-22).** Executable, phased, test-gated plan for
> GitHub issue [#72](https://github.com/gbasin/atrium/issues/72)
> ("Materialize `session_events` into searchable session records and `/atrium`
> agent context"). Spans **both repos** — Atrium (`~/Code/atrium`, TS/SQL) and
> Centaur (`~/Code/centaur`, Rust + k8s). Supersedes the `/atrium` sketch in
> `sync-implementation-plan.md` **Phase 7** by giving it a concrete, grounded
> shape; folds in the **root-boundary precondition** from the typed-lane thread
> (`rollout-2026-06-21T13-02-10…`, recorded on #72 comment `4764226095`).
>
> Scope decided with Gary 2026-06-22: **full slice incl. the Centaur `/atrium`
> mount**; ACL = **workspace-public + own session, extensible to opt-in private**;
> reasoning/plan/dynamic-tools = **fully rendered + indexed, with a search-time
> toggle and lean/full dual views**; redaction = **content-scanning**.

---

## 1. Goal

Turn the durable `session_events` mirror into a first-class, **searchable,
grep-able session record** usable by both humans (app/API search) and agents
(read-only `/atrium` filesystem tree), without exposing raw harness JSONL,
secrets, or private context by default.

Three deliverables, one shared projection layer:

1. **Rendered session records** — fold *every* meaningful normalized item type
   (incl. reasoning/plan/dynamic tools) from `session_events` into stable
   documents, in two views (lean + full).
2. **Search** — Postgres FTS over the rendered records (separate from existing
   chat-message FTS), ACL-scoped, with a kind/verbosity toggle.
3. **`/atrium` mount** — a read-only filesystem tree the node materializes from
   the server's projected docs, so agents `rg`/`cat`/`jq` prior chat + sibling
   sessions like a repo.

## 2. Locked decisions

From #72's decision comments + Gary 2026-06-22:

| Decision | Choice | Source |
|---|---|---|
| Default corpus | Rendered/sanitized records + chat; **raw JSONL = gated forensics only** | #72 cmt `4764222399` |
| Architecture | **Server-canonical projection + dumb node materializer/cache**; FS is a cache, not truth | #72 cmt `4764241045` |
| Agent ACL scope | **Workspace-public + the requesting agent's own session**; per-agent private grants are **opt-in, added later** (design the grant set now) | Gary 2026-06-22 |
| Reasoning / plan / dynamic tools | **Fully render + index**, but with a **search-time include/exclude toggle** and **two materialized views** (lean vs. full≈jsonl) | Gary 2026-06-22 |
| Redaction | **Content-scanning** (regex + entropy secret scrubber) applied before index + materialize, to *all* views | Gary 2026-06-22 |
| Delivery | **Full slice incl. Centaur `/atrium` mount** (Atrium phases land standalone first; Centaur mount is a co-phase, not deferred) | Gary 2026-06-22 |
| Root boundary | `/atrium` is a **read-only context root**, distinct from `artifact_root` / `harness_state_root` / `repo_root` / `profile_bundle_root`; never a capture surface | #72 cmt `4764226095` |

### 2a. One flagged tension (resolved by tiering, not re-litigated)

"Full/everything view" **+** "content-scanning-only redaction" is the highest
secret-surface combination — a jsonl-like view can carry system/developer
prompts, injected context, and tool env that a scrubber may miss. **Resolution:
tier visibility.**

- **Lean view** (`transcript.md`, messages + work items) → workspace-default
  (public + own session). Default grep target + default search corpus.
- **Full view** (`full.md` / `everything.jsonl`, incl. reasoning/plan/tools) →
  **higher privilege gate**, same tier as the raw archive. Still content-scanned,
  but not in the default workspace-public slice.
- Content-scanning is applied to **both** views; raw harness JSONL stays a
  separate gated forensics/resume archive (`harness_transcripts`, untouched).

## 3. What already exists — do NOT rebuild

| Capability | Status | Where |
|---|---|---|
| `session_events` mirror (raw Centaur frames, verbatim) | **built** | mig `027_session_events.sql`; `session-runs.ts:1747` `mirrorFrame` |
| Reducer folding **subset** (`agentMessage`/`userMessage`/`commandExecution`/`fileChange`/`question`) | **built (partial)** | `centaur-client/src/reducer.ts:175` — ignores `reasoning`/`plan`/dynamic tools/deltas |
| Chat→markdown **current-view** projection (edits/deletes/redactions applied; not append-tail) | **built** | `atrium-projection.ts` (`projectChatThread`, `renderChatMarkdown`) |
| `/api/sessions/:id/atrium/chat` projection endpoint | **built** | `app.ts:2865` |
| Chat-message FTS (`websearch_to_tsquery` + `to_tsvector` over `events.payload->>'text'`) | **built** | `events.ts:813` `searchMessages`; `/api/search` `app.ts:1721` |
| Gap-free change-feed **pattern** (xid8+id cursor capped at `pg_snapshot_xmin`) | **built (for artifacts)** | mig `034_artifact_changefeed.sql`; `artifact-ledger.ts:365`; `/api/sessions/:id/artifacts/changes?since=` `app.ts:2744` |
| Raw harness JSONL archive (resume/forensics, S3, last-write-wins) | **built** | `harness-transcript.ts`; `harness_transcripts` mig `037` |
| Overlay capture (C4) + `mountPropagation` linchpin | **built + POC-validated** (9/9 kernel + kind k8s, 2026-06-20) | `centaur-node-sync` crate on fork `main`; `cas-ledger-build-plan.md` §C4 |
| `centaur-node-sync` daemon (capture / inbound merge / harness-resume / WIP patch) | **built, merged to fork `main`** | `services/api-rs/crates/centaur-node-sync/` |

**Net-new for #72:** the session-record projection from `session_events`
(renderer coverage + dual views + redaction), the session-records FTS index +
change-feed, the `/atrium` session-record endpoints, and the **`/atrium`
materializer daemon + read-only hostPath wiring** in Centaur.

## 4. "What's unmerged with Centaur, and why it can be finished here"

Gary's question, answered precisely:

- **Nothing hard is unmerged.** The overlay/capture machinery, the
  `mountPropagation: Bidirectional (setup) → HostToContainer (agent)` linchpin,
  the node-sync daemon, harness-transcript capture/restore, inbound merge, and
  WIP-patch are **all merged to fork `main` and POC-validated** (kernel 9/9 +
  kind k8s wiring, 2026-06-20). The linchpin is **no longer a risk**.
- **The `/atrium` read-only mount sidesteps the overlay entirely.** Overlay +
  `CAP_SYS_ADMIN` are needed only for the *writable* `/workspace` capture path.
  `/atrium` is read-only context: a plain **`readOnly: true` hostPath volume**
  the node daemon populates by HTTP-fetching server-projected docs. No overlay,
  no privileged runtime, no unvalidated kernel surface.
- **The net-new Centaur work is small (~300–500 LOC):** a projection daemon loop
  (subscribe to the change-feed + etag fallback → fetch projected docs → atomic
  debounced writes to `/atrium`), the read-only hostPath wiring, and a
  session-scoped ACL hydration step. All inputs already have routes.

**Therefore the Centaur half is in scope for this plan and is genuinely
finishable here.** The remaining bulk of risk/effort is **Atrium-side**
(renderer coverage across both harnesses + redaction efficacy), not Centaur.

## 5. Architecture

```text
Atrium server  (canonical — owns truth)
  projection:   session_events → rendered records (lean + full views)
  redaction:    content-scanning before index + materialize
  ACL:          public + own-session base; opt-in private grant set
  search:       session-records FTS (separate from chat FTS)
  change-feed:  gap-free xid8+id cursor over session-records
  endpoints:    /atrium/sessions/:id/{transcript.md, full.md, summary.md,
                meta.json, changes.md, tools.md, artifacts.md, events.jsonl},
                /atrium/chat/<ch>/<thread>.md (exists), /atrium/changes?since=

Node materializer  (dumb cache)
  subscribes change-feed (+ etag/poll fallback)
  fetches authorized projected docs
  writes read-only /atrium tree (atomic temp+rename, debounced)
  NO overlay, NO product-semantics, NO ACL/redaction logic

Agent
  rg / cat / jq /atrium   (+ `atrium search|read|log` for the wide cold tail)
```

Invariants: **the API owns truth, the node owns materialization, the filesystem
is a cache.** ACL + redaction live only server-side. `/atrium` is mounted
read-only and is never a capture root.

## 6. Projected-record model

One canonical per-item document, derived from a `session_events` frame:

```
session_record {
  session_id, event_id (centaur_event_id), channel_id, thread_id?,
  kind,            // message | command | file_change | artifact | question
                   //  | reasoning | plan | tool_call | usage | status
  actor,           // user | agent ; driver (claude|codex) where known
  view_tier,       // lean | full      (lean ⊂ full)
  text,            // rendered, redacted text for FTS + markdown
  raw_ref,         // pointer back to the frame for debug (gated)
  visibility,      // workspace_public | session_private | channel:<id>
  search_weight,   // title/message > command > reasoning, etc.
  ts
}
```

Rules:
- **Dedup deltas:** index/render the *completed* item snapshot; keep deltas only
  as raw `events.jsonl` history. (`item.*/delta` frames never become records.)
- **Lean vs full:** `view_tier=lean` = messages + commands + file changes +
  artifacts + questions. `view_tier=full` = lean ∪ reasoning ∪ plan ∪ dynamic
  non-shell tool calls (named cards w/ arg/result excerpts).
- **Strip-by-policy:** injected session context, base/developer/system prompts,
  and harness bookkeeping are never projected into either view.

## 7. Phases

Atrium phases **P1–P3 have no Centaur dependency** and land the human/app value
immediately. Centaur phases **P4–P5** deliver the agent mount; **P4 (boundary)
gates P5 (mount) in any real deployment.** P6 validates end-to-end.

### Phase 0 — Decisions, ADR, fixtures *(gate: fixtures load in both test suites)*

- Record decisions on #72 (link this doc).
- **Root-boundary ADR**: name the typed lanes (`artifact_root`,
  `harness_state_root`, `repo_root`, `profile_bundle_root`, `/atrium` read-only)
  and their owners, so future work doesn't re-collapse them into dotdir sync.
- Build **representative Claude + Codex fixtures** covering: reasoning, plan,
  dynamic non-shell tools, deltas-vs-completed, file changes, artifacts,
  questions, command output, an edit, a delete, a planted secret.

### Phase 1 — Projection + renderer coverage + redaction *(Atrium; no Centaur dep)*

- Define the `session_record` model + migration (records table or materialized
  projection keyed `(session_id, event_id, view_tier)`).
- **Expand the reducer/renderer** (`reducer.ts:175`) to fold *all* item types,
  incl. `reasoning`, `plan`, dynamic non-shell tools — for **both** Claude
  (via the normalizer) and Codex paths.
- Emit the **two views** (lean `transcript.md`, full `full.md`/`everything.jsonl`).
- **Content-scanning redaction module** (regex for known token shapes + high-
  entropy string detection) applied at projection time to all text.
- *Tests:* a completed Claude **and** Codex session renders into both views;
  deltas don't double-count; a planted secret is scrubbed in both views; full
  view contains reasoning, lean view does not.

### Phase 2 — Session-records search *(Atrium; no Centaur dep)*

- New **session-records FTS** (`tsvector`), separate table/index from chat FTS.
- Backfill + incremental update from `session_events` (trigger or worker).
- `/api/search/sessions` with: **kind/verbosity toggle** (include or exclude
  reasoning/plan/tools), result shape `{session_id, channel, thread, kind,
  event_id, actor, driver, excerpt, view_tier}`, and **ACL scoping** (public +
  own session; honors the grant set).
- *Tests:* search finds rendered items; toggle excludes reasoning; a non-member
  cannot hit a private channel's records; default search never returns raw JSONL.

### Phase 3 — `/atrium` projection API + change-feed *(Atrium; no Centaur dep)*

- Extend the chat projection to **session records**:
  `/atrium/sessions/:id/{transcript.md, full.md, summary.md, meta.json,
  changes.md, tools.md, artifacts.md, events.jsonl}` — full view gated.
- **Session-records change-feed**: clone the `artifact_changes` pattern (xid8+id
  cursor capped at `pg_snapshot_xmin`); expose `/atrium/changes?since=<xid>.<id>`
  (workspace- or session-scoped). This resolves #72's one open detail
  (feed-vs-etag) → **feed primary, etag/poll fallback**, backed by proven infra.
- ACL enforced at the API boundary (server owns it).
- *Tests:* change-feed gap-free under concurrent writers; endpoints honor ACL;
  chat current-view re-render hides a redaction (no original bytes leak).

### Phase 4 — Root-boundary hardening *(Centaur; precondition for the mount)*

- **Split the node-sync scan roots**: `capture_sweep` (→ `artifact_root`) vs.
  `harness_transcript_sweep` (→ `harness_state_root`) must not share one root
  (today they do — `centaur-node-syncd.rs:279`). `/atrium` is its own read-only
  root, never swept for capture.
- **Reconcile chart/binary wiring** (chart passes `--overlays-root`; binary
  expects `NODE_SYNC_SESSION`/`NODE_SYNC_UPPER`/`NODE_SYNC_MERGED`).
- **Leak-prevention tests**: `.codex`/`.claude`/auth/config/skills/caches/logs/
  memories **cannot** become artifacts **nor** appear in `/atrium`.
- Land the ADR from Phase 0.

### Phase 5 — Node `/atrium` materializer + read-only mount *(Centaur)*

- **Materializer daemon (~300–500 LOC)** in `centaur-node-sync` runtime:
  subscribe to `/atrium/changes?since=` (+ etag fallback) → fetch authorized
  projected docs → write `/var/lib/centaur/atrium-projection/<session>/…` with
  atomic temp+rename, **debounced** (no append-per-message write-amp).
- **k8s wiring (NOT overlay):** hostPath volume bound at `/atrium` with
  `readOnly: true`.
- **ACL hydration:** session-scoped selective population — workspace-public slice
  (reflinked/shared per node) + the session's own records; opt-in private grants
  hydrate only the channels the session is a member of.
- **`atrium search|read|log` CLI** for the wide cold tail (queries the server
  API with the server's ACL — no per-agent overlay needed).
- *Tests:* materializer reflects redactions (current-view, no stale secret);
  freshness via feed; mount is read-only; private-channel non-member can't read
  the thread; the lean view is default, full view requires the gate.

### Phase 6 — End-to-end validation *(kind cluster)*

- Drive a real Claude **and** Codex session; an agent greps `/atrium`, finds a
  sibling session, runs `atrium search` with the toggle, confirms redaction +
  ACL hold.
- **Leak audit:** prove no `.codex`/`.claude`/auth material reaches `/atrium` or
  the artifact ledger.

## 8. Risks & open items

- **Biggest risk = Atrium renderer completeness**, not Centaur. Every normalized
  item type must render correctly across *both* harness paths; gaps show up as
  missing/garbled transcript items. Mitigation: the Phase 0 fixtures + per-type
  render tests.
- **Redaction efficacy:** content-scanning misses unknown secret shapes. The
  visibility tiering (§2a) is the backstop — the full/jsonl view stays gated.
- **Freshness write-amplification:** debounce + buffer; never append per message
  (O(sessions²) risk per `agent-sync-design.md:108`).
- **Adjacent, referenced (not specced here):** the typed-lane Agent Profile,
  Credentials (private refresh-writeback), Memory lane, and Session Exact-Resume
  bundle from the neighboring thread share the same node daemon + lane discipline.
  This plan only **hardens the boundary** they depend on (Phase 4); their stores
  are a separate build. Widen this doc if you want one umbrella plan.

## 9. References

- Issue [#72](https://github.com/gbasin/atrium/issues/72) + decision comments
  `4764222399`, `4764226095`, `4764241045`.
- `notes/sync-implementation-plan.md` Phase 7 (the `/atrium` sketch this replaces).
- `notes/agent-sync-design.md` §2A (`/atrium` layout), §8B (#4 ACL, #6 chat).
- `notes/cas-ledger-build-plan.md` §C4 (overlay + `mountPropagation` validation).
- Neighboring thread: `rollout-2026-06-21T13-02-10…` (typed lanes, data-class
  ownership, root-boundary precondition).
