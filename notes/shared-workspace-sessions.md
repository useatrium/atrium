# Shared-workspace session panes — design (2026-06-12, round 2)

Origin: codex exploration (`rollout-2026-06-12T08-19-12`) — (1) spectators can't
see driver typing (drafts are local React state); (2) sketch of a Figma-like
"shared workspace" pane. Round 1 mapped the architecture + a prior-art sweep
(~15 agent products, classic multiplayer UX, collab infra). Round 2 (Gary Q&A)
resolved the architecture forks. Design only — nothing built yet.

## Decisions (Gary, 2026-06-12)

1. **Durability: full raw-frame mirror.** Every piece of agent output stored in
   our DB, mirroring the agent JSON logs "if not even more than that" — i.e.
   raw Centaur frames AND the human-side record (steers with attribution,
   suggestions, dispositions, seat changes).
2. **Peek/focus split.** In-channel pane = peek (unchanged). `/s/:id` becomes
   **focus mode**: session as canvas, channel demoted to a right rail with
   Discussion / Channel tabs. Async permalink visitors land in focus; expand
   toggle on the pane header switches peek→focus. Focus mode doubles as the
   future mobile session UI.
3. **Turn model: idle vs ended, NO auto-archive.** Sessions stay resumable
   indefinitely until explicitly archived. UI catches up to the server (steer
   already regresses `completed → queued`, session-runs.ts:517-518). Turn end
   renders a **turn card** (result summary, cost delta, suggestions open,
   composer alive), not "Session ended — read-only". Running/recent lists need
   last-activity sorting to cope with long-idle sessions.
4. **Sequencing: control loop first.**
   1. Turn card + idle/ended split + suggestion queue (incl. spectator-proposed
      HITL answers) + session-scoped typing indicator.
   2. Durable layer: raw-frame mirror + user-message fold fix + anchored
      threads + session record.
   3. Attention layer (viewing dots, follow-driver, agent presence).
   4. Focus mode + mobile parity.
5. Control model (round 1): **driver + suggestions**; escalation ladder
   watch → comment → suggest → request seat → take seat.
6. Pane↔chat (round 1): **Variant C** — annotations are chat threads rooted on
   `session.item_thread` events; markers in the pane; reuses thread
   unreads/mentions/mobile/draft roaming.
7. Cut: shared scratchpad, multi-driver seats, pixel cursors, default-on
   keystroke sharing, public session links. Live drafts = opt-in "open-hand
   mode" later, maybe never (suggestions absorb the demand).
8. Audit: dismissed suggestions persist (retro value); optional one-line "why"
   on dispositions, never required.

## Architecture facts (verified in code)

**Two append-only logs.** Workspace events table (chat backbone) holds messages,
reactions, and *folded* session facts only (`session.spawned/status_changed/
seat_changed/question_*/completed`) plus mutable `sessions` row state. The full
transcript lives in **Centaur's per-thread event log**; the surface server is a
pass-through: `/api/sessions/:id/stream` pipes `centaur.tailEvents(threadKey,
{afterEventId})` as SSE (session-runs.ts:330-345). A server tailer folds frames
into the workspace facts but does NOT persist transcript items.

**Client materialization** (`useSessionStream` → shared `reduceSession` in
packages/centaur-client): pure fold of frames into `SessionState.items[]`.
Resume via `after_event_id=lastEventId`; dedupe drops `event_id <= lastEventId`
(terminal `execution_state` re-emits allowed); folds batch into one React
commit per animation frame. Finished sessions replay the full stream from
Centaur — durability currently depends on Centaur retention (mirror fixes).

**Anchoring coordinates.** `event_id` is the only monotonic, never-reassigned
timeline coordinate; items carry `sourceEventIds[]`. Item IDs are *eventually*
stable but mutate mid-stream: `reconcileCompleteText` rewrites `text:<eventId>`
→ `text:<messageId|uuid>` (reducer.ts:288-296). Anchor schema:
`{sessionId, anchorEventId, itemId, itemType, excerpt}`; resolution: item whose
sourceEventIds contains anchorEventId → item by id → detached rail w/ excerpt.
Moment-anchors (turn boundaries) use the same coordinate.

**Steers are invisible today.** Centaur's item types include `"userMessage"`
(centaur-client types.ts:112) and steers post with `user_id` metadata, but
`reduceSession` folds only agentMessage/commandExecution (+ Amp assistant/tool/
result) — **driver instructions never render in the transcript**; spectators
infer them from agent behavior. Fix in the fold + render attributed steer items.
Prereq for the retro record.

**Mirror design.** Dedicated `session_events(session_id, event_id, frame
jsonb, ...)` table — NOT the workspace events table the sync engine replicates
(raw frames are harness-specific + delta-chatty). Tailer already sees every
frame; upsert on (session_id, event_id) handles re-delivery on tailer restart.
Optionally cache the folded SessionState snapshot per session for fast
permalink render; the unified "session record" view = mirror + workspace
`session.*` events + suggestions/threads, joined by sessionId and ordered by
event_id/timestamps.

**Turn boundary is a soft state.** `postUserMessageOnce` regresses
`completed → queued`, nulls `completed_at` (session-runs.ts:517-518); UI's
`TERMINAL_STATUSES` wrongly includes 'completed' (treated as ended/read-only in
SessionPane via `displayTerminal`). Seat release scheduling exists
(`cancelScheduledRelease`) — suggestion queue must outlive seat release so
queued suggestions greet the next driver.

**Existing seams** (round 1): seat model request/grant/take
(session-runs.ts:579-660), driver-only enforcement (:1168), `session:<id>`
presence topic, op queue (new op ≈ 5 lines + handler, idempotency baked in;
template `session.steer`), disabled spectator composer
(SessionPane.tsx:433-439) = natural suggest box, right rail mutually exclusive
(Chat.tsx:1592-1667) → phase-1 in-pane thread drawer, `session.*` events
already render as channel timeline cards (SessionCard precedent for
`session.item_thread` roots).

## Prototype — resolved visual UX (round 4, 2026-06-13)

Canonical interactive prototype: **`notes/protos/session-min.html`** (served on the
tailnet during design at `http://macbook-m1p.tailf13d53.ts.net:8089/session-min.html`).
Toggle device/view/role via the top bar; deep-link state via URL hash
(`#device=mobile,mode=focus,role=spectator`). The earlier busy variant
(`session-workspace.html`) was retired. Verified in a real headless browser
(every view + affordance clicked/hovered), not eyeballed.

Visual direction (after a hard "what would Jobs cut" pass):
- **Near-monochrome.** Black/grays on white; ONE accent (blue) meaning exactly
  two things: *live* (the running dot) and *send*. No semantic color-coding —
  steers/agent/comments/suggestions are distinguished by weight, indent, space.
- **No bubbles/boxes.** A steer = the person's name in bold + the words; the
  agent's reply = plain text indented underneath (call-and-response). Tool runs,
  file edits, reasoning collapse to one quiet line you expand on demand. Diffs
  use faint green/red only when expanded.
- **Reading column** is a centered ~600px measure; composer + suggestions share
  the same measure (one grid).
- **Contents = ChatGPT's pancake**, copied closely: bare stacked tick-lines
  (no border/pill) floating at the **right edge, vertically centered** (left of
  the scroll track), one line per turn capped at 14; current turn's line is
  longer/darker, the running turn's line is blue. Hover/tap → the turn list
  pops out **sideways to the left**, centered on the handle; click pins, a row
  jumps to that turn. **Same handle + behavior on mobile** (slides out from the
  right; no bottom sheet).
- **Two composers in peek** (the Slack-thread model, made faithful): a narrow
  secondary **channel** column (340px, bottom-aligned history) with its own
  `Message #sessions` composer, and the **dominant session** column with the
  steer composer. The session composer carries a dark **`↳ agent`** target chip
  + "Message the agent…" so it's unmistakably addressed to the agent, not the
  room. Spectator → `↳ suggest` + "Suggest to {driver}…".
- **Suggestion queue** is one quiet grouped object ("SUGGESTIONS · N") with
  neutral actions — Send is an outline button, not blue — so blue stays scarce.
- **Focus** drops the channel to one-at-a-time (no two-composer competition);
  **peek** is session-dominant so the side-by-side never feels 50/50.
- Transcript stress-tested at 9 turns across two drivers (seat handoffs),
  exercising reasoning/plan/tool/file-diff/artifact/question/live + resolved &
  unresolved comments + stacked suggestions.

These are presentation decisions for the eventual real UI; the data/seam
decisions below (mirror, anchors, ops, seat model) are unchanged.

## Agent runtime & work-product affordances (round 5, 2026-06-13)

**Two clocks, not one.** A "session" is really two decoupled lifecycles: the
**conversation/thread** (durable, mirrored, resumable forever) and the
**environment/sandbox** (compute — shorter-lived, costly). The UI must show the
environment's state as distinct from the agent's execution state. The header
carries an **env chip** (warm / sleeping / expired).

**A session = three durable records + two restorable/ephemeral layers:**
- Transcript (raw-frame mirror) — *what happened*.
- **Artifact ledger** (auto-mirrored to blob, typed, per turn/driver) — *what it
  made*.
- **Side-effect audit** — *what it changed in the world*.
- Environment snapshot — *restorable working state* (kept until archive).
- Live state (preview, processes, ports) — dies on sleep.
The conversation outlives all ephemeral layers: live state dies first (sleep),
the snapshot is held until the session is archived, but transcript + artifacts +
audit persist forever. Expired env → **record-only** (read-only composer, "rebuild
to continue"); everything it produced is still there.

**Decisions (Gary, round 5):**
- **Environment lifecycle: warm → snapshot → sleep**, snapshot **kept until the
  session is explicitly archived** (matches resumable-forever; storage cost
  accepted). Sending a steer to a sleeping session wakes + rebuilds (~cold start).
- **Assets: auto-mirror everything** the agent writes (outputs area) to our blob
  store (S3 already in surface), tracked per session/turn/driver. Needs a sane
  "what counts as an artifact" scope (ignore node_modules/.git/build caches).
- **Code output: generic artifact substrate + repo-aware detector.** Every
  output is a typed artifact `{type, turn, driver, blobRef, detectedAs}`; most
  are generic (image/file/log/data/url). A detector recognizes when changes
  constitute a code change against a git repo and **auto-surfaces them as a
  first-class Changes artifact** (diff + branch + optional PR); otherwise generic.
  No upfront repo config. Promotion ("track as repo change") bridges the two.
- **Side effects: classify + gate the dangerous ones.** Irreversible classes
  (open PR, send email, deploy, prod writes) require approval before execution —
  reuse the HITL question flow; everything logged to the audit. Driver approves.
  The gate must be **actionable where it's shown** (Approve/Deny on the blocked
  audit row, the inline side-effect card, and near the transcript's "waiting for
  approval" line) — a gate with no button is broken. Approving propagates across
  all three surfaces (proto demonstrates this live).

**Color principle for the work surfaces:** the transcript stays monochrome +
one blue (live, send). The *work-product* surfaces earn restrained **semantic**
color because it carries state, not decoration: diff add/del green/red, env
warm/expired, approved(green)/needs-approval(amber)/denied badges. Artifact
thumbnails use monochrome type labels (PNG/HTML/CSV), not colorful emoji.

**Four work-product surfaces to account for** (all wanted): Changes/diff ·
Artifacts gallery · Side-effect audit · Live preview + environment status.

**Information architecture — UNDECIDED, prototyped for feel-test.**
`notes/protos/session-surfaces.html` mocks four arrangements over the same data
(changes/artifacts/side-effects/preview) with a warm/sleeping/expired env toggle:
- *Inline + expand* — work products as blocks in the transcript → drawer.
- *Tabbed* — top tabs switch the whole view per surface (full width; loses
  transcript context).
- *Two-pane* — transcript + persistent workspace panel (IDE-like; cramps wide
  diffs, less calm).
- *Summary strip* — clean transcript + a glanceable stat strip → drill into a
  drawer (most minimal at rest).
Claude's lean (not yet ratified): **summary-strip resting + a *tabbed* drawer**
for drill-in, **two-pane as an optional "workspace mode"**, inline cards reserved
for the gated side-effect moment (a decision, not a reference). Awaiting Gary's
verdict after using the proto.

## Pop-out / multi-pane grammar (round 6, 2026-06-13)

Resolves "can I see preview + transcript at once?" — **two-pane is not a separate
mode; it's the *pinned* state of a surface.** A four-rung ladder (research-backed:
Notion/Linear peek, DevTools dock/undock, VS Code split + floating windows,
split-attention & cognitive-load literature):
1. **Strip (rest)** — summary chips in the transcript; calm default.
2. **Peek (overlay)** — click a chip → soft-modal drawer; transient,
   dismiss-on-blur, one at a time. "Glance and decide."
3. **Pin (split)** — the drawer's ⤢ docks the surface as a persistent side pane;
   transcript reflows beside it. **Single swappable slot** (DevTools model): the
   pinned region hosts ONE surface; pinning another swaps it; stable location
   (object permanence).
4. **Detach (window/tab)** — eject to its own window/tab for surfaces that want
   viewport — **preview first**. Same live model, synced (VS Code), never a copy.
Reversible & adjacent at every rung; one source of truth / many views; resting
state is always transcript + strip.

**Pane count (Jobs lens): transcript + exactly ONE swappable pinned pane.** A 2nd
only via explicit action; never tile 3 — route anything hungrier to detach.
(Backed by DevTools/Notion single-region model, split-attention cost, Stage
Manager's 3-4-per-group clutter limit, the ~7-panel overload pole.)

**Platform-conditional (the architecture answer): self-contained single window is
the default everywhere; multi-window is an opt-in top rung, never forced.**
- **Mobile** — one thing at a time. Strip → tap → full-screen surface → back.
  Ceiling = peek; no pin, no detach.
- **Web** — single tab default; pin = in-app split; detach = native new browser
  tab (cheap; ideal for preview).
- **Desktop app** — pin = in-app split; detach = real OS window (always-on-top /
  second monitor). Richest.

**Remaining threads — all v1 (Gary), slotted by home:**
- Spawn-time config → a **spawn dialog** (repo/branch/capabilities/harness);
  feeds repo-detection + side-effect gating.
- Cost & resources → **env chip** (header) + the Overview/Environment surface;
  fleet/cross-session view later.
- Capture scope & versioning → **inside the Artifacts surface** (per-artifact
  version history) + an ignore-config.
- Preview security/sharing → **inside the Preview surface** (who can view /
  expiry / auth); ties to the collab layer.
- Multi-repo / no-repo → **v2**; no-repo already works (generic artifacts),
  multi-repo = per-repo Changes streams.

**GUI survey landed (Conductor/opencode/Factory/Devin/Crystal/Terragon/Vibe-
Kanban/Sculptor/Cursor/Zed/Warp/Amp/v0/bolt/Replit/StackBlitz, 2026-06-13) —
strongly validates the lean** and adds hazards now baked in:
- Calm transcript + summary-strip + peek→pin→detach = the synthesis of where the
  field converged (Amp/opencode inline-calm + Conductor/Terragon resizable pinned
  pane + Replit canonical-home-then-float detach).
- **Never hard-toggle chat-vs-diff** (Crystal died on exactly this).
- **Don't auto-open panes** (Cursor users revolted over the auto-review panel) —
  surfaces appear on a *meaningful event or user action*, not every turn.
- **Don't over-expose the sandbox/worktree** (Sculptor removed per-agent
  containers — "users found the isolation confusing"). Surface branch + PR +
  compact env status; the filesystem is NOT a primary surface.
- **Detach must keep the agent's instrumentation** (v0's forced new-tab preview
  broke console + the agent's own debugging loop — the survey's clearest "this
  got worse"). A detached preview must keep the port proxied / console piped back,
  or it's a downgrade. Sketch/Shelley's port-proxy-to-public-URL is the gold std.
- Multi-session viz converges on a **status-badged sidebar list** (Running /
  Awaiting-review / Done / Error / Unread) + a "jump to next needing attention" —
  maps cleanly onto atrium's channel list with unread/attention badges.

**`session-surfaces.html` SIMPLIFIED to the committed design (Jobs pass):** the
4-layout comparison lab was removed (it was scaffolding for this decision); the
file is now ONE design — calm transcript + summary strip + peek/pin/detach +
Device(desktop/web/mobile) + Env(warm/sleeping/expired) toggles. The gated
side-effect is the single inline decision (a clean amber Approve/Deny card);
changes/artifacts are summarised in the strip, not streamed inline. Verified in a
real browser: rest → peek → pin (preview beside transcript) → detach → re-dock,
the approve gate, all env states, and the mobile degradation; zero JS errors.

**Fully-loaded view added** (`View` toggle): *In channel* = the realistic full
shell — nav · channel chat (messages + `Message #sessions` composer) · the agent
session (strip + transcript + agent composer), i.e. chat ⇄ agent side-by-side
with two composers; *Focus* = session only. **Pinning enforces the pane cap:**
pinning a surface from In-channel collapses the channel into Focus (so the
transcript keeps ~600px beside the pinned surface, never a crushed 3-column),
and unpinning restores the channel. Detach from In-channel keeps the channel
(it leaves the app). Toggle selected-state bug fixed (controls live outside the
re-rendered stage; `syncSeg()` now reconciles `.on` after every render).

**Still UNDECIDED — meta home** (env/cost/spawn-config/repo binding): Overview
surface (5th item) vs folded-into-Preview vs header-only vs fleet-dashboard.
Next proto.

## Merged + consolidated to one proto (round 8, 2026-06-14)

**`session-surfaces.html` is now the single canonical proto** — the collaboration
layer from `session-min` was merged in, so one file shows everything:
collaboration (Role toggle → driver suggestion-queue / spectator suggest + Request
seat, presence "N watching", anchored comments with resolved state) + work
surfaces + pin/detach + env states + @agent spawn + Channel/Split/Focus views +
Sessions rail. Controls: **Device · View · You-are · Environment**.

The old **"minimal vs fully-loaded" split is retired** — "minimal" was the
pre-merge exploration; there is no separate minimal *product*, it's just the
**Focus view** of the one app (calm reading column that still carries comments +
suggestions). Public share consolidated to a single proto at the repo root
(`gbasin/atrium-session-proto` → GitHub Pages). `session-min.html` remains in
this repo only as the superseded pre-merge reference (rounds 2-4 history).

SJ pass (round 8) confirmed clean across Channel/Split/Focus × Driver/Spectator
× env states; blue stays disciplined (live + send only). Genuinely-missing
affordance still flagged: a **Stop/interrupt** control for the running agent.

## Realism + spawn + channel-first view (round 7, 2026-06-14)

Three additions to `session-surfaces.html`, calibrated against a real codex
session on disk (~72 tool calls / 47 reasoning blocks; short status messages
between tool batches — the work is in the *steps*, not long prose):
- **Realistic transcript.** ~18 collapsed steps across 5 turns (read / grep /
  edited / ran), reasoning blocks ("thought for Ns"), an error→diagnose loop (red
  "2 tests failed" → stash-and-compare → "pre-existing on main"), brief status
  messages. Demonstrates the point: a calm transcript *absorbs* a realistic
  firehose because every step collapses to one line.
- **Spawn = `@agent` in the channel → first session message.** A session is
  started by typing `@agent <task>` in a channel; that message becomes the
  session's first steer (rendered with a "started the session · @agent" marker),
  and the channel shows a spawned-from card. Channel composer hints it.
- **Channel-first view (3rd `View`: Channel / Split / Focus).** *Channel* = full
  channel + a right **Sessions rail** (status-badged: running / **needs-you** /
  recent) — the discovery answer: sessions are cards in the timeline *and* a
  triage rail (survey's "needs attention" pattern). *Split* = chat ⇄ agent.
  *Focus* = agent only. Pin from Split collapses the channel into Focus (cap).

## Annotation/navigation rail UX (round 3, ChatGPT-validated)

ChatGPT Pro ships nearly this exact pattern (Gary's screenshots, 2026-06-13):
collapsed = thin tick-lines at the right edge, one per **user message**; hover =
the ticks expand into a floating panel listing every prompt (current
highlighted), floating OVER the conversation (no reflow), click-to-jump. Takeaways:
- **Index the user's turns, not the agent's** — prompts are the navigation
  skeleton; long agent replies are the bulk you scroll past. Maps 1:1 onto
  *index the steers* → another payoff of the steer-fold fix (folded
  `userMessage` items ARE the ticks).
- **Default = thin spine; "expand" = floating list overlay, not a persistent
  column.** Persistent column is reserved for focus mode. Settles the variant
  question: hybrid (spine in peek, pin-to-outline in focus).
- Our enrichment over ChatGPT: each tick carries collaboration marks
  (💬 unresolved / ◆ suggestion / ❓ question) so the minimap shows *where the
  humans argued*, and floating rows preview them.

Three rail states (one component, three zoom levels = turn cards zoomed out):
1. **Collapsed spine** — ticks at the pane's right edge, proportional height,
   marks for threads/suggestions/questions, pulse on the live turn.
2. **Hover** — full turn list floats out over the transcript (no reflow);
   rows = turn lead + marks; click jumps. (Peek default.)
3. **Pinned outline** — persistent ~248px column with Turns/Discussion/Channel
   tabs. (Focus default.)
Inline 💬 markers stay in the transcript (linked to the rail, Google-Docs-style
two-views) so comments read in-context while reading top-to-bottom. Interaction
rule: hover never reflows the canvas (overlay), click pins (deliberate reflow).
Mobile: no edge spine — rail collapses to a "Turns ▾" bottom sheet; turn
skeleton ports, spine metaphor doesn't.

Interactive prototype: `notes/protos/session-workspace.html` (switch
device/mode/rail/role live). Open questions surfaced by it: peek width at 524px
(floating list mitigates); how loud the suggestion queue gets on mobile (inline
vs count-chip→sheet).

## Feature designs

- **Turn card** (general case of HITL): at idle, show turn result summary +
  cost/model delta; suggestion queue open; driver composer alive ("what
  next?"); spectator propose box alive. HITL question card = the explicit-ask
  special case; same sync-and-decide interaction at both.
- **Suggestion queue**: spectator composer relabeled "Suggest a message —
  {driver} decides"; `suggestion.create` op → `session_suggestions` table →
  `session.suggestion_added` over `session:<id>`. Driver strip above composer:
  Send / Edit-then-send / Dismiss(+optional why). Dual attribution. Never
  enters agent context unforwarded (Cognition single-instruction-stream).
- **Spectator-proposed HITL answers**: answer form renders for all; spectator
  submit = proposal attached to the question; driver one-click submits.
  Server driver-only enforcement untouched.
- **Anchored annotations**: hover item → 💬 → thread rooted on
  `session.item_thread` (compact card in channel); margin markers w/ avatar +
  count; resolved state; inbox notifications (not toasts), auto-subscribe
  participants; detached rail for orphans.
- **Attention**: object-level presence, not pixel cursors. Throttled ephemeral
  `viewing` relay → avatar dots per item; follow-driver viewport toggle; agent
  in the presence stack ("⚙ running tests…"). Symmetric visibility.
- **Typing indicator**: extend typing relay (`useWs.ts:287`, `hub.ts:74`) with
  optional sessionId → "Mara is composing a steer…" (~20 lines).
- **Session record (for agents + async humans)**: mirror + overlay
  (suggestion dispositions, thread resolutions, question answers, seat
  history, turn structure). Edited-then-sent suggestion = preference gradient;
  dismissed+why = negative example; resolved error thread = ops knowledge.
  Later: `GET /api/sessions/:id/record` / MCP surface, queryable. In-situ
  steering rationale is the thing no product ships (Devin Knowledge/Amp
  threads are the nearest prior art).

## Research basis (round 1 sweep, key citations in session transcript)

Live keystrokes = most-documented failure (Google Wave autopsy, WSJ Docs dread,
Wang et al. CSCW 2017). Anchored comments = most proven (Docs 2014 + Notion
2024 convergence; Factory headline). Single accountable driver = universal
(Warp approve-to-edit, Copilot write-gate, Cursor owner-only, mob programming
navigator, Cognition "Don't Build Multi-Agents"). Object-level presence beats
cursors (Notion block presence, Ably member location; Figma cursor-anxiety
threads). Atrium's channel+live-pane combo ships nowhere; closest is GitHub
Next's unshipped Ace prototype.

## User stories

1. **Mara (driver, pairing)**: suggestions staged by her composer;
   edit-then-send; grants seat from the pane — suggestion→seat one ladder.
2. **Alex (senior spectator)**: anchors a thread on the failing-test tool
   output; files corrective suggestion; escalates to seat request if needed.
3. **Priya (async, +3h)**: `/s/:id` lands in focus mode — transcript +
   markers + unresolved threads; replies flow through normal thread unreads.
4. **Sam (new hire, broadcast)**: follow-driver; avatar dots show where
   seniors look; visible queue teaches good steers; driver's "suggestions
   paused" toggle = no-backseating norm.
5. **The agent (live)**: one instruction stream (seat-holder only);
   participates in presence; its questions/turn-ends are the room's moments.
6. **Future agents (retro)**: read session records — attributed steers,
   dispositions with rationale, resolved threads — as organizational
   priors for how/why humans steer.

## Remaining open questions

- Mirror scope details: store SSE-derived frames only, or also fetch Centaur
  thread history on archive for anything the live tail missed?
- Idle-session list UX: last-activity sort sufficient, or need an explicit
  "parked" shelf?
- Anchored-card compactness/grouping in the channel timeline (defer until
  visible noise).
- When focus mode lands, does peek lose any affordances (e.g. drawer) to stay
  simple?

## Round 9 — MVP convergence + mirror stress-test (2026-06-15)

Decision: **build the full proto as the MVP** (Gary). Scope = full slice incl.
**Focus mode**, **all four work surfaces** (Changes/diff · Artifacts · side-effect
gate · env chip), **web + mobile parity**, and the **durable mirror**. Real-app
state today ≈ 30% built (seat model, HITL questions, streaming, `session:<id>`
presence, the `session.steer` SEND path all exist; calm visual language, steer
*visibility*, suggestions, surfaces, focus route, mobile detail do NOT). Next
migration is **027** (voice took 024–026). Correction to earlier gap-map: the
`session.steer` server handler EXISTS (`opQueue.ts:870` → `steerSession`,
driver-only `session-runs.ts:441`, posts to Centaur `:489/:510`); the real
control-loop blocker is steer *visibility* — `reducer.ts:137-141` folds only
agentMessage/commandExecution, so steers never render.

### Centaur research + stress-test (verified vs source AND live data)

Centaur source: `~/Code/centaur`. It runs in a local **kind** cluster
(`centaur-control-plane`); Postgres pod `centaur-centaur-postgres-0`, db `ai_v2`
user `tempo`; API at `127.0.0.1:18000` (dev key = `LOCAL_DEV_API_KEY` in the
`centaur-api` pod env). Sandbox harness default = **codex**, config
`harness/codex/config.toml` already `model="gpt-5.5"`, reasoning/verbosity `low`.

- **Event log = Postgres** `agent_execution_events` (BIGSERIAL `event_id`,
  globally monotonic, append-only). Ingested from the sandbox harness **stdout**
  (NDJSON), NOT from the harness's local rollout files (`agent.py:1142`).
  `amp_raw_event` is a **misnomer** — verbatim stream payload from *whichever*
  harness (codex/claude/amp), key-sorted only (`runtime_control.py:3235-3251`).
  Centaur ALSO writes Centaur-defined `*_observed` canonical rows
  (`assistant_text_observed` etc.) — but **not for every thread** (a real codex
  thread had zero). ⇒ mirror must keep ALL frames; the UI renders from raw
  (atrium's reducer already does) using canonical/`usage_observed` for cost.
- **Retention = redaction, not loss.** Hourly sweep (`retention.py`),
  **disabled by default**, overwrites `event_json` in place with a
  `retention.redacted` stub. Safe under defaults; only risk = short TTL + atrium
  offline >1h. Mirror eagerly + keep indefinitely.
- **Tailer (atrium `session-runs.ts:760-784`)** is server-side (NOT per-viewer)
  and starts at spawn — good — but it advances `last_event_id` over EVERY frame
  while `foldFrame` persists only 4 kinds. ⇒ the mirror needs **its own
  watermark + upsert-before-advance** so a crash can't skip un-mirrored frames.
- **No env/sandbox API**: only coarse `active/released` via `GET /agent/status`;
  cost lives only in `usage_observed` frames. Env chip = synthesize.

**Live-session POCs (real gpt-5.5-low codex runs, then released):**
- **Changes/diff — CONFIRMED, NO Centaur change.** A real edit produced
  `item.completed`/`fileChange`/`changes[].{path,kind,diff}` with FULL content
  (add) and a real unified-diff hunk (update: `@@ -2 +2,5 @@ … +def subtract…`).
  Paths are absolute sandbox paths (`/home/agent/workspace/…`) → strip on display.
- **git metadata is CONDITIONAL on a git-repo workspace.** `turn.done` carried
  only a `result` summary (no repo/branch/commit) because the workspace wasn't a
  git repo ⇒ spawn-time repo binding is what unlocks branch/commit/PR context.
- **Artifacts — CONFIRMED NEEDS a Centaur change.** A shell-written binary
  (`/tmp/poc_image.jpg` via pillow) produced a `commandExecution` frame (command
  text + ls) but **NO `fileChange` and ZERO image bytes** anywhere in the stream.
- **Steers ARE in the stream** as `item.completed`/`userMessage` with full text
  ⇒ the steer-fold fix is purely client-side.

### Data-layer design (ratified)

Three data classes, three homes — S3 is right for only one:
1. **Frames → Postgres** `session_events(session_id, centaur_event_id, event_kind,
   frame jsonb, created_at)`, `UNIQUE(session_id, centaur_event_id)`, fed by the
   existing tailer (hook in `runTailer`, sees all frames — NOT in `foldFrame`),
   own watermark, upsert-before-advance, eager from spawn, retained indefinitely.
   Store **opaque** (raw + canonical both) → drift-proof; render from raw.
2. **Rollout JSONL → object store**, immutable append-only segments
   (byte-offset watermark; `…/{exec}/{seq}.jsonl`; never mutate).
3. **Artifacts → object store (minio)** content-addressed by sha256 +
   `session_artifacts` ledger row per (session, turn, path, version); ignore-config
   (node_modules/.git/build caches).

**The ONE Centaur change (combined workstream): a sandbox sidecar/wrapper that
captures continuously (NOT at teardown — pods die unexpectedly) by emitting two
new frame kinds** — `artifact.captured {path,kind,blobRef,sha256,size}` and
`rollout.segment {seq,blobRef}` — uploading blobs to object store and letting
atrium's mirror tailer capture the refs through the SAME single path. This
unblocks rollout-forensics AND the Artifacts gallery together. Everything else
(transcript mirror, Changes/diff, steers, suggestions, turn cards) needs NO
Centaur change.

**Artifact detection mechanism (Gary, 2026-06-15): CONFIGURABLE scope, a
spectrum** — must catch arbitrary-location writes like `/tmp`, not just a
workspace `outputs/` dir. Mechanism MUST NOT be a per-turn rootfs walk
(huge/slow/noisy).
- **Floor (ship first): a configurable allow-list of output dirs**, default e.g.
  `{workspace, /tmp, $HOME/outputs, /var/tmp}`, user-extensible at spawn.
  Snapshot-diff each listed dir (manifest path→sha, upload deltas). Predictable,
  low secret-risk (you chose the dirs), and covers `/tmp` because it's on the list.
- **Ceiling (nothing missed): overlayfs upper-layer diff** — the container's
  writable upperdir *is* every file changed anywhere vs the base image (base
  auto-excluded, no walk/watches; `docker diff` semantics; our sandbox is a
  containerd/overlayfs k8s pod). Or **fanotify whole-mount** for per-write
  continuity (inotify can't do whole-FS).
- Both use **manifest-everything → materialize-selectively**. Capture policy =
  manifest every changed path (cheap, nothing missed), then upload *bytes* only
  when `{type ∈ allow-list} ∧ {path ∉ deny-list} ∧ {not secret-flagged} ∧
  {size < cap}`. The axis is **artifact-vs-junk, NOT binary-vs-text** — naive
  "skip binaries" is WRONG (the motivating `/tmp` jpg + most real artifacts —
  images/pdf/data/archives — are binary). Three distinct filters:
  - **Type allow-list** (what to materialize): INCLUDES output-binaries
    (png/jpg/svg/pdf/csv/xlsx/json/parquet, code, docs); EXCLUDES junk-binaries
    (`.o/.pyc/.so/.class/.whl/.a`).
  - **Path/name deny-list** (skip junk any type): `node_modules/ .git/ dist/
    build/`, package caches, `*.lock`.
  - **Secret detector** (its OWN mechanism, not type — secrets are "text"):
    name/path deny (`.env .netrc *.pem id_rsa .aws/ .ssh/ credentials*`) PLUS a
    content entropy/key-regex scan before upload.
- Git-assist still applies to the workspace-repo subset (branch/commit context).
  Non-materialized + manifest rows stay fetchable on-demand while the sandbox is
  warm. (Fleshes out round-5's open "what counts as an artifact" scope.)

### Phased build plan (front-load the mirror)

- **Phase 0 — Mirror & durability (backend, first).** Migration 027
  `session_events` + tailer mirror hook (own watermark, upsert-before-advance,
  eager-from-spawn); resume-from-mirror-watermark on boot. Invisible but de-risks
  the data layer earliest (Gary's call).
- **Phase 1 — Calm transcript + visible control loop (web).** Visual language on
  SessionPane (monochrome, no bubbles, collapsible tool/reasoning, blue=live+send);
  steer-fold + attributed rendering; turn cards at idle (fix `displayTerminal`
  treating completed as ended); turn spine/rail.
- **Phase 2 — Collaboration.** Suggestion queue (table+op+spectator box+driver
  strip), spectator-proposed HITL answers, session-scoped typing indicator,
  session-record overlay.
- **Phase 3 — Layout grammar + Focus mode.** `/s/:id` route, Channel/Split/Focus
  views + Sessions rail, peek→pin→detach, `@agent` spawn + spawn dialog (repo/
  branch/harness — also unlocks git metadata + the side-effect gate).
- **Phase 4 — Work surfaces.** Changes/diff (from frames, no Centaur change) →
  side-effect gate → env chip (synthesized) → Artifacts (rides the sandbox-capture
  Centaur change). The combined Centaur capture workstream runs parallel here.
- **Phase 5 — Attention + anchored comments.**
- **Mobile parity** — fast-follow lane behind each web phase (session detail is a
  stub today; degradation rules: no edge spine→Turns▾ sheet, full-screen surfaces,
  peek is the ceiling).

Execution: author seam contract per phase (migration + shared op/event types),
fan out codex lanes, review diffs firsthand + merge. Coordinate with the parallel
session's fleet (master in a worktree).

### Design review (round 2) — holes found + resolved (Gary, 2026-06-15)

Empirical re-check on real frames (**1721 total** across dev sessions): deltas
are only **~7%** (113), `*_observed` canonical **~41%** (705), rest = raw
completed items + lifecycle. So the earlier "drop deltas = 10–50× win" was WRONG.

1. **Delta/snapshot — mirror EVERYTHING verbatim in Phase 0; compact later.**
   Centaur publishes a self-contained snapshot per item (VERIFIED: agentMessage
   completed carries full `text`; commandExecution completed carries full
   `aggregatedOutput`; fileChange the full diff) ⇒ deltas are pure live transport;
   the CLIENT replay reads completed items + ignores deltas (a read-time choice,
   no computation). BUT dropping deltas at ingest saves only ~7%, frames are tiny
   (~309 B avg), and dropping-at-ingest is irreversible + races redaction. ⇒
   Phase 0 mirrors all frames verbatim; compaction (prune deltas + redundant
   canonical content, KEEP usage/cost) is a deferred background job if scale
   justifies it. Edge: item that never completes (crash mid-stream) → snapshot the
   accumulated deltas at the terminal `execution_state`.
2. **Oversized payloads — keep in Postgres (TOAST) + high-threshold spill valve.**
   Postgres TOASTs >2 KB values transparently; only pathological completed items
   (huge build log in `aggregatedOutput`, giant diff) spill to object store
   (>~256 KB–1 MB) via the same blob-ref mechanism. A threshold knob, not new
   machinery. (#1's snapshot read-model makes big rows rarer too.)
3. **Privileged watchers/tailers = accepted key infra.** atrium is the living
   backbone orchestrating containers+agents; its tailers/sidecar are first-class
   infra. Least-privilege where free; the stance is settled, not a risk.
4. **Sidecar→record injection — small, precedented Centaur change.** Centaur
   already has sandbox-token auth (steer/cancel/claim, `agent.py:707+`) + a sandbox
   upload path (`/agent/attachments/upload`); `append_execution_event` exists
   internally (`runtime_control.py`). Change = a sandbox-token **emit-event** route
   appending `artifact.captured` / `rollout.segment` → real ordered `event_id` →
   atrium's mirror captures it on the ONE path. **Invariant: upload-then-emit**
   (failure → orphan blob only, GC'd by hash-with-no-referencing-frame; never a
   dangling ref; idempotent by sha+path+turn). Bytes channel OPEN: 4a sidecar→
   Centaur attachments (atrium copies for durability, smallest sandbox surface) vs
   4b sidecar→atrium object store direct (injected scoped token, no double-copy,
   better for big blobs).
5. **Secrets — org-private stores bound it.** atrium stores are org-private ⇒ a
   missed secret is internal hygiene, not external leak. Encrypt blobs at rest;
   skip obvious secret files (`.env`/keys) from the gallery view; no hard boundary.
6. **Cross-harness diffs — Centaur has a canonical `file_change` for amp/claude
   (`normalize.py:268`) AND codex (`:596`).** So the Changes surface likely gets
   cross-harness file-change events; whether the canonical carries a full unified
   diff per harness (Claude `Edit` = old/new strings) is confirmed when we build
   it, else we synthesize the diff ourselves. OPEN (low).

**Remaining open — none block Phase 0:** 4a-vs-4b bytes channel · spill threshold
value · Claude diff completeness · backfill of pre-mirror sessions + tailer lag
monitoring (fast-follows after the forward mirror).
