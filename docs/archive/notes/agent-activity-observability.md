# Agent Activity Observability — surfacing what the agent *actually does*

Status: **DRAFT / exploration** (2026-06-22). Captures how agent behavior is
captured + surfaced today, the two gaps, and a recommended design for a unified
**human-oversight** view of agent activity — nested sub-agent runs, shells,
plan/TODO/goals, and reasoning/loop iterations.

Scope locked with Gary (2026-06-22, via AskUserQuestion):
- **Behaviors in scope:** (1) nested/sub-agent runs, (2) shell commands (live +
  history), (3) plan / TODO / goal checklist, (4) reasoning & loop iterations.
- **Nested-run capture mechanism = PASSIVE** — capture the nested `~/.claude` /
  `~/.codex` JSONL as logs, parse post-hoc into a sub-run view. *No Centaur
  runtime change beyond the capture filter.* (Rejected for now: an active PATH
  shim that forces `--output-format stream-json`; and first-class child
  executions in Centaur's session graph. See §10.)
- **Audience = humans** (oversight / audit surfaces in the Atrium UI). Making this
  agent-consumable (parent supervising its children via MCP/CLI) is a deliberate
  v2 — see `macro-borrow-plan.md` Tier-1 agent tool surface.
- **Deliverable = this design note** (not a build plan, not code).

Sister docs: `shared-workspace-sessions.md` (surfaces/transcript spine),
`session-record-projection-build-plan.md` (frame→record projection, Phase-1 fold),
`agent-data-architecture.md` (capture mechanism, no-ingress sync),
`harness-resume-workstream.md` + `harness-resume-build-plan.md` (where the JSONL
lives + per-session PVC persistence), `macro-borrow-plan.md` (agent tool surface).

---

## 0. TL;DR

Atrium's session instrumentation is **primary-harness-centric**: it folds the
machine-readable event stream that the *one* harness Centaur drives prints to
stdout. Two things fall outside that stream:

- **Gap A — captured but not rendered.** The primary agent's plan, TODO
  (`TodoWrite`), reasoning, and shell *history* are already in `session_events`,
  but they're either dropped at fold time or shown only as full-tier transcript
  text. There is no plan/TODO panel, no shell-history surface, no loop/step model.
  *This is Atrium rendering work; no Centaur change.*

- **Gap B — not captured at all.** When the primary agent shells out to a
  **nested headless agent** (`claude -p …`, `codex exec …`, `amp …`), Centaur
  sees exactly **one opaque `commandExecution`** — the command string plus a
  stdout/stderr blob. The child's *internal* tool calls, edits, plan and
  reasoning land only in the container's local `~/.claude/projects/*.jsonl` /
  `~/.codex/sessions/*.jsonl`, which are outside the capture namespace today.
  Your instinct is exactly right: **that behavior is invisible everywhere except
  the local JSONL.**

The good news: closing Gap B passively is cheap, because (a) the child logs are
the *same JSONL schema* Atrium already parses, (b) the **primary** session id is
known so every *other* JSONL file is unambiguously a sub-run, and (c) the
harness-resume work is already persisting those dirs to a per-session volume — so
durability comes for free and capture collapses to **scan + parse**.

---

## 1. How agent behavior is captured today (the pipeline)

```
Harness (Claude Code / Codex) in the sandbox
  → prints structured protocol events to stdout
       Claude: stream-json events     Codex: item.started / item.completed
  → Centaur stdout pump: each line → `session.output.line` event
       centaur/services/api-rs/.../centaur-session-runtime/src/lib.rs:2484-2628
  → Atrium mirrors verbatim → session_events(event_kind, frame jsonb)
       surface/server/src/session-runs.ts:1754  (mig 027)
  → reducer folds frames into SessionState.items[]
       surface/centaur-client/src/reducer.ts
  → projected to session_records (mig 039) + rendered surfaces
       surface/server/src/session-records.ts
```

**Frame vocabulary** (`surface/centaur-client/src/types.ts:302-315`):
`execution_state`, `execution_started`, **`amp_raw_event`** (wraps the harness's
own stream events), `assistant_text_observed`, `assistant_tool_use_observed`,
`tool_result_observed`, `usage_observed`, `result_observed`, `question_*`,
`artifact.captured`.

**Surfaces that exist** (`shared-workspace-sessions.md` §5; `surface/web/src/sessions/`):
- the **transcript spine** (collapsible step timeline),
- **Changes** ("what changed") — file diffs,
- **Artifacts** gallery — captured outputs (CAS ledger, mig 031/033/034),
- **Side-effects** ("what it ran") — `Bash`/`command` tool-calls classified into
  `network|package|git|filesystem|process|shell` × `danger|caution|normal`
  (`surface/centaur-client/src/sideEffects.ts`). **Post-hoc audit, not a gate** —
  the side-effect HITL gate was dropped 2026-06-16 and reconceived as
  sandbox-level controls (`shared-workspace-sessions.md` §9).

**The key property:** capture taps the **one** harness's machine-readable stream.
Anything that doesn't print to *that* stream isn't seen as structured activity.

---

## 2. The two gaps, precisely

### Gap A — already captured, under-rendered
| Behavior | Where it already is | Why you don't see it |
| --- | --- | --- |
| Plan blocks | `session_records.kind='plan'` (full tier) | full-tier text only; no panel |
| TODO list (`TodoWrite`) | `assistant_tool_use_observed`, name `TodoWrite`, `input.todos[]` in `session_events` | reducer doesn't fold dynamic tools → no checklist |
| Reasoning / thinking | `session_records.kind='reasoning'` (full tier) | full-tier text only |
| Shell *history* | Side-effects surface | shown, but flat list; no per-shell output drill-in / search / live tail |
| Loop / step structure | the turn structure in the transcript | rendered as prose-ish steps; no explicit iteration/goal model |

`reducer.ts` folds `agentMessage`/`userMessage`/`commandExecution`/`fileChange`/
`question` but **not** `reasoning`/`plan`/dynamic tools — the planned Phase-1 fold
(`session-record-projection-build-plan.md`) is exactly the lever for Gap A.

### Gap B — not captured at all (the nested blind spot)
Confirmed in Centaur:
- The stdout pump turns each sandbox stdout line into `session.output.line`
  (`centaur-session-runtime/src/lib.rs:2484-2628`). A nested `claude -p` is just a
  subprocess of the `Bash` tool — Centaur records the **command + its stdout/
  stderr**, nothing about the child's internals.
- Centaur enforces **one active execution per thread**
  (`active_execution_for_thread`, lib.rs:2530-2537) — a child run is *not* a
  separate execution; it has no place in the model.
- The child's structured trace is written to local JSONL:
  - Claude: `$CLAUDE_CONFIG_DIR/projects/-home-agent-workspace/<thread-id>.jsonl`
  - Codex: `$CODEX_HOME/sessions/.../rollout-<id>.jsonl`
  (`harness-resume-build-plan.md:28,31`).
- The in-sandbox capture loop (`centaur/services/sandbox/artifact_capture.py`)
  scans only `DEFAULT_DIRS = /home/agent/workspace:/tmp:/home/agent/outputs:/var/tmp`
  (line 18) and `.jsonl` is **not** in `ALLOWED_EXTENSIONS` (line 25-46 — `.json`
  is allowed, `.jsonl` is not). So the child logs are **double-excluded**: wrong
  directory *and* wrong extension. → In Atrium a nested run is one side-effect row
  (`command: claude -p …`, shell/normal) and a stdout blob. Nothing else.

---

## 3. The unified model — five lenses on one spine

For **human oversight**, treat all four requested behaviors as lenses hung off the
existing transcript spine + Work drawer. Four are Gap-A rendering of data we have;
the fifth (sub-runs) is the new passive capture.

1. **Steps / loop** — make the turn/iteration structure explicit: each agentic
   turn = (assistant text + tool calls) → tool results, repeated to a stop. This
   *is* "loop iterations"; it's already in the transcript, just needs an explicit
   step/iteration affordance (collapsed one-liners, expand on demand). The spine.
2. **Plan & TODO** — fold `plan` records + `TodoWrite` tool calls into a live
   checklist panel (pending/in-progress/done), the way the TUIs show it.
3. **Shells** — promote Side-effects into a **Terminal/Shells** lens: classified
   history (today) **+** per-command stdout/stderr drill-in (have it in
   `tool_result_observed`) **+** search/filter **+** live-streaming output where
   the harness emits deltas (Codex `commandExecution.outputDelta`; Claude
   non-streaming → settles on completion). True *interactive* PTY stays the
   separate BYO-terminal pane (`atrium-daily-driver-plan.md` Tier-1) — out of
   scope for read-only oversight.
4. **Reasoning** — thinking blocks, full-tier, collapsed inline under their step.
5. **Sub-runs** — nested agent runs as **nested mini-sessions** (§4). The novel
   piece.

The unifying insight for §5 sub-runs: **a sub-run is just a session one level
down.** Capture its JSONL, run it through the *same* reducer, and render it with
the *same* transcript / Changes / Side-effects surfaces, nested under a card in
the parent. Lenses 1-4 then apply recursively inside a sub-run for free.

---

## 4. Nested sub-runs — the passive JSONL-as-artifact design (the meat)

### 4.1 Where the logs live, and the free primary/child discriminator
Both harnesses write one JSONL per agent session into a well-known state dir:
- Claude → `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<session-uuid>.jsonl`
- Codex → `$CODEX_HOME/sessions/<date>/rollout-<ts>-<uuid>.jsonl`

The **primary** session's id is known to Centaur at launch (it's the thread id;
Codex even gets `CODEX_CONTINUE_THREAD_ID`, `harness-resume-workstream.md:18`). So:

> **Discriminator (robust, zero-cost):** the JSONL file whose id == the primary
> thread id is the primary's own transcript (already captured via the stream and
> must be *excluded*). **Every other JSONL file in those dirs is, by definition, a
> sub-run.** Fresh nested runs get fresh uuids.

This sidesteps the hard "is this stdout from the parent or a child?" problem
entirely — we never parse stdout to find children; we enumerate the state dir and
subtract the one we already have.

### 4.2 Capture-lane change (precise, minimal)
Add a dedicated **harness-log capture lane** (extend `artifact_capture.py`, or the
node-scan, whichever reaches `/home/agent/.claude` — see §9 open item):
- **Dirs:** add `$CLAUDE_CONFIG_DIR/projects` + `$CODEX_HOME/sessions` (resolve the
  env vars; default `/home/agent/.claude/projects`, `/home/agent/.codex/sessions`).
- **Extension:** allow `.jsonl` *for this lane only* (don't loosen the artifact
  gallery filter).
- **Exclude** the primary thread-id file(s) (§4.1).
- **Class:** tag captured blobs `kind='harness-log'` so they route to a **Sub-runs**
  surface, **not** the Artifacts gallery (these are observability data, not
  deliverables).
- **Secrets:** the current secret-*content* scan (`artifact_capture.py:95-105`)
  *drops the whole file* on a match — wrong for transcripts (a child that printed
  an `ANTHROPIC_API_KEY=` would vanish entirely). For this lane, **redact-not-drop**
  (mask the matched span, keep the log). Reuse the same patterns.

### 4.3 The resume synergy — durability for free
Harness-resume is already persisting `CODEX_HOME` (and later `CLAUDE_CONFIG_DIR`)
to a **per-session PVC** (`harness-resume-workstream.md:88-89`). That PVC *is*
where the sub-run JSONL lives. So we are not adding a new durable store — the logs
are (becoming) durable for resume regardless. Passive capture collapses to:
**point a scanner at the already-persisted dir, subtract the primary, parse.**

### 4.4 Parsing = reuse the reducer (sub-run = mini-session)
A captured nested `.jsonl` is the **same line schema** the client already
normalizes (Claude stream-json lines ≈ `amp_raw_event` payloads; Codex rollout
lines ≈ the `item.*` protocol). So:
- Feed the blob through the **existing** `reducer.ts` / normalizer → a
  `SessionState`-shaped object → render with the existing transcript / Changes /
  Side-effects components, scoped to the sub-run.
- **Lazy projection:** don't persist projected rows for sub-runs up front. Store
  the blob + lightweight summary metadata (§6); parse on demand when a human
  expands the sub-run card. Keeps write-path cheap and GC simple.

### 4.5 Correlation (spawn side-effect ↔ child log)
Link the sub-run to the `Bash` side-effect that spawned it, so the parent
transcript shows "▸ ran `claude -p …` → [sub-run: 14 steps, 3 files]":
- **Signals:** temporal overlap (child JSONL `started_at` within the parent
  command's window), the child's first user message ≈ the `-p`/prompt argument,
  and the cwd-slug in the Claude path (`-home-agent-workspace`).
- v1: best-effort match to the nearest preceding agent-spawn side-effect; anything
  unmatched goes to a flat **"Other sub-runs"** bucket under the session. Oversight
  doesn't need bulletproof correlation — that's the only thing the rejected active
  shim would buy (an injected correlation id), and it's not worth the shim.
- **Detecting an agent-spawn side-effect:** classify commands matching
  `^(claude|codex|amp|gemini|q|cursor-agent)\b` as a new side-effect subtype
  `agent-spawn` (a small addition to `sideEffects.ts`) — gives the parent
  transcript a distinct badge even before the child log is parsed.

### 4.6 Noise, redaction, cost, GC
- Sub-run logs can be large and numerous; surface lazily, summarize eagerly.
- Redaction parity with the main transcript (diffs are already redacted); §4.2
  redact-not-drop.
- GC: harness-log blobs ride the existing blob-GC + retention
  (`data-lifecycle.md`); expire with the session.

### 4.7 Depth / tree
A child can spawn grandchildren — and because §4.1 enumerates *all* non-primary
JSONL, arbitrary depth is captured automatically. v1: render one level + a flat
"Other sub-runs" list. v2: reconstruct the tree (correlate each child's own
agent-spawn side-effects to its grandchildren).

### 4.8 Live-ish (v2)
The JSONL is appended in real time. A tailing scanner could capture incrementally
and stream a sub-run as it runs (near-live, seconds). v1 captures on settle
(simpler); v2 tails for live sub-run monitoring.

---

## 5. Gap-A lenses — rendering data we already have

No new capture; extend the Phase-1 reducer fold + add panels.
- **Plan & TODO panel:** fold `TodoWrite` (`input.todos[]`) + `plan` records into a
  live checklist. Promote from full-tier so it's visible by default (it's the
  single most legible "what's the agent doing" signal).
- **Shells lens:** Side-effects + per-command output drill-in (`tool_result_observed`)
  + search/filter + delta-streamed live output (Codex). Same component renders a
  sub-run's shells.
- **Reasoning:** keep full-tier, collapsed inline under its step (oversight, not
  default noise).
- **Steps/loop:** explicit iteration affordance over the existing turn structure.

---

## 6. Data-model sketch (for when this becomes a build plan)

**No new tables for Gap A** — projection/reducer + UI only.

**Sub-runs (Gap B):** a thin index over captured harness-log blobs.
```
session_subruns (
  id              uuid pk,
  session_id      uuid,             -- parent Atrium session
  parent_exec_id  text,             -- parent execution that spawned it
  harness         text,             -- 'claude' | 'codex' | 'amp' | …
  child_uid       text,             -- the JSONL session/rollout uuid
  log_blob_id     text,             -- captured harness-log blob (reuse artifact store)
  spawn_effect_id text null,        -- correlated agent-spawn side-effect (§4.5)
  first_prompt    text,             -- child's opening user message (preview)
  status          text,             -- running | done | failed | unknown
  started_at      timestamptz,
  ended_at        timestamptz null,
  summary         jsonb             -- {steps, tool_calls, files_changed, tokens, cost}
)
```
Projection of the child transcript is **lazy** (parse `log_blob_id` on expand);
`summary` is computed once at capture for the collapsed card. Reuse the artifact
blob store for `log_blob_id` (it's already content-addressed + GC'd).

---

## 7. Surface / UX

- **In the parent transcript:** an agent-spawn step renders as a **sub-run card** —
  `▸ claude -p "refactor X"  ·  14 steps · 3 files · 1m20s`. Expand → the child's
  full transcript inline (or peek/pin/detach into the Work drawer, reusing the
  existing ladder).
- **Work drawer:** a **Sub-runs** tab (count badge) alongside Changes / What-it-ran
  / Artifacts; a **Plan/TODO** tab (live checklist); the enhanced **Shells** lens.
- **Recursion:** inside an expanded sub-run, the same Changes/Side-effects/Plan
  lenses apply — it's a mini-session.

---

## 8. Phasing (if greenlit to build)

- **P0 (Gap A, Atrium-only, no Centaur):** Phase-1 reducer fold → Plan/TODO panel +
  Shells drill-in/search. Highest legibility-per-effort; ships independently.
- **P1 (Gap B capture):** harness-log lane in `artifact_capture.py` (dirs +
  `.jsonl` + primary-exclude + `kind='harness-log'` + redact-not-drop). Verify the
  lane reaches `/home/agent/.claude` (§9).
- **P2 (Gap B surface):** `session_subruns` index + lazy parse via existing reducer
  + sub-run card + Sub-runs tab + `agent-spawn` side-effect subtype/correlation.
- **P3 (polish):** sub-run tree (depth >1), live tail (§4.8).

---

## 9. Open questions / risks

1. **Which capture lane reaches `/home/agent/.claude`?** The overlay node-scan (C4)
   scans the overlay *upper* = the workspace artifact namespace; the harness state
   dir is in the agent's *home*, likely outside the overlay. So the harness-log
   lane probably belongs in the **in-agent poll** (`artifact_capture.py`) — or the
   resume PVC gets included in the node-scan's roots. Confirm against the C4 /
   resume mount layout before building. (This is the one genuine Centaur-side
   unknown.)
2. **`CLAUDE_CONFIG_DIR` persistence timing.** Resume persists `CODEX_HOME` now and
   `CLAUDE_CONFIG_DIR` "later" (`harness-resume-workstream.md:89`). For Claude
   sub-runs the dir must be on a captured/persisted path — may need to land the
   Claude half of resume persistence first, or capture from the default
   `/home/agent/.claude` directly.
3. **Correlation fidelity** — is temporal+prompt+cwd enough, or do unmatched
   sub-runs in the "Other" bucket feel broken? Cheap to start heuristic; revisit
   only if noisy.
4. **Harness format drift** — `amp`/Gemini/others have their own log shapes; the
   parser needs per-harness adapters (the reducer already has Claude+Codex paths).
5. **Secret redaction completeness** — redact-not-drop must not leak; reuse the
   audited side-effect/diff redaction, don't invent new.
6. **Privacy framing** — sub-run logs may contain prompts the human didn't write;
   confirm they inherit the session's existing access scope.

---

## 10. Why not the rejected options (recorded for completeness)

- **Active PATH shim** (force `--output-format stream-json`/`--json`, tee to a live
  channel): gives *live* structured nested events + a clean injected correlation
  id, but needs a shim on PATH (fragile vs. agents calling absolute paths or odd
  flags), a dedicated byte channel, and it only works if the agent uses the shimmed
  invocation. Passive captures *any* nested run unconditionally. Revisit if live
  sub-run streaming (§4.8) proves insufficient via tailing.
- **First-class child executions** (model nested runs as real child executions in
  Centaur's session graph): cleanest fidelity (each child gets its own
  Changes/Side-effects natively), but a significant change to Centaur's
  one-active-execution-per-thread model and the runtime. Over-built for
  *oversight*; reconsider if/when sub-agents become a first-class *product*
  primitive (agents orchestrating agents) rather than a thing we observe.
- **Agent-consumable (parent supervises children via MCP/CLI):** deferred to v2;
  folds into the Tier-1 agent tool surface (`macro-borrow-plan.md`). This note is
  human-oversight-first.
```
