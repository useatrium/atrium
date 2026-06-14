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
