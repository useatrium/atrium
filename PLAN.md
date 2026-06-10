# Atrium (working title) — Agent-Native Chat Prototype

An open-source, self-hostable Slack successor where **agent sessions are first-class,
shareable objects** next to the team's chat. Built on
[paradigmxyz/centaur](https://github.com/paradigmxyz/centaur) (MIT) as the agent
session engine; we build the chat surface ("Places") and the session UX.

**Hypothesis under test:** teammates will actually watch/join each other's agent
sessions, and sharing-the-session replaces pasting-the-output.

## Ontology

- **Event log substrate** — every message, tool call, approval, role change is a
  typed, provenance-stamped event.
- **Places** — channels/threads. Durable, named, human-social. Calm by design.
- **Sessions** — units of delegated agent work. PR-like, *not* rooms: spawned from
  a thread, spectatable live, take-over-able, linkable from many places, posting
  artifact + summary back when done. Backed by a Centaur `thread_key`.

Killer interaction: `@agent <task>` in a thread → session spawns → live card →
pop-out side-by-side pane (multiple spectators) → driver seat handoff →
completion card with permalinked transcript. Provenance-by-default.

---

## Phase 0 — Centaur seam validation (GO/NO-GO GATE)

Stand up Centaur on local kind cluster; drive sessions purely via the control-plane
API (no Slack). LLM strategy: real Claude Code harness in the real sandbox against a
**deterministic in-cluster Anthropic-API mock** (`infra/llm-mock`) — validates the
entire event pipeline reproducibly; one real-model confirmation run pending an API key.

**Done when:**
- [x] Scripted client runs spawn → message → execute → SSE tail end-to-end, no Slack ✅ 2026-06-10
- [x] Mid-stream reconnect with `after_event_id` loses zero events ✅ (413-frame stream, no gaps)
- [x] API pod killed mid-execution → execution reaches terminal state, full replay ✅ (4/4)
- [x] Transcript replay is deterministic (two full fetches identical) ✅
- [x] Tool calls appear as distinct structured events (name, args, result) ✅ (obs.assistant_tool_use / obs.tool_result)
- [x] Time from execute → first streamed event < 10s ✅ (TTFE 0.02s)
- [x] Observed event schema documented (`phase0/results/event-schema.md`) ✅

**GATE RESULT: GO** — 18/18 checks across A/B/C/D. See phase0/results/report.md and
JOURNAL.md 2026-06-10 for the proxy/TLS route that made the mock-LLM path work.

**Kill criteria:** events too coarse for live pane rendering OR infra TTFT > 10s →
patch upstream or reconsider foundation.

## Phase 1 — Places: minimal multiplayer chat (~1.5 wk)

TS/React web app + server. Workspaces, channels, threads, presence; Postgres with
event-sourced message log; WebSocket fanout. Auth simple (GitHub OAuth or magic link).

**Done when:** 2 users in 2 browsers chat in real time; reload restores state;
optimistic send, no flicker; p50 latency < 150ms.
**Quality gate:** usable as this project's own chat for a day without resentment.

**RESULT (2026-06-10): done-when ✅** — 26/26 tests (re-verified independently),
two-browser live verification incl. reconnect catch-up and unread; p50
send→deliver 7.5ms. Day-of-use quality gate deferred to Phase-4 dogfood.
Known gaps in surface/PROGRESS.md (presence granularity, in-memory unread,
single-process WS hub, no checked-in Playwright suite).

## Phase 2 — Sessions: spawn, live pane, spectate (~2 wk)

Session object ↔ Centaur thread_key. `@agent` in thread → live card → pop-out pane
rendering the SSE stream (streaming text, collapsible structured tool calls, status).
Completion posts summary + artifact permalink back to thread.

**Done when:** spawner + 2 spectators see identical live state (same last-event-id);
reload mid-session recovers transcript; completion card lands with working permalink.
**Quality bar:** @agent → visible "running" < 5s; 200+ event transcript scrolls
without jank; a non-spawner can explain what the agent did from the pane alone.

**RESULT (2026-06-10): done-when ✅** — live e2e vs kind cluster 9/9
(phase2/e2e/multispectator.mjs): spectators track spawner with worst token gap 1,
"2 watching" presence, mid-run reload catches up past pre-reload position, late
joiner renders full transcript via permalink, steer-after-completion streams,
live Bash tool card + TOOLCHAIN_OK. Perf: 500+ items at ~p95 9ms/frame (web
agent's stress run). "Non-spawner explains" gate → Phase-4 dogfood. 42/42 unit
tests across workspace.

## Phase 3 — Driver seat & handoff v0 (~1 wk)

One driver steers; spectators request the seat; grant or auto-grant on idle. Role
changes are audit events rendered in the transcript. v0 = workspace credentials +
audit attribution (per-user credential re-binding deferred → upstream iron-proxy).
Stretch: fork-by-replay into a new thread_key.

**Done when:** request/grant/steer flow works; concurrent seat-grabs resolve
deterministically (tested); handoff < 1s, no dropped in-flight events.

**RESULT (2026-06-10): done-when ✅** — live e2e 14/14: grant flips driver in
35ms, audit lines on both clients, take-seat when driver away, new driver
steers. Concurrency determinism unit-tested (FOR UPDATE, single seat_changed).
Live e2e also caught + fixed a real leak: terminal sessions now release their
sandbox after a 60s idle window (cancel-on-steer) — before this, every session
pinned a pod forever and the node hit 92% memory. Fork-by-replay stretch: not
built (deferred).

## Phase 4 — Instrument + dogfood (2–4 wk usage; human part hands to Gary)

**BUILDABLE HALF DONE (2026-06-10):** session_views durable spectate tracking +
viewerCount shipped; metrics SQL from phase4/DOGFOOD.md tested against seeded
data. Remaining: the human part — see phase4/DOGFOOD.md runbook + scorecard.

Metrics: sessions/day, % sessions viewed by non-spawner, spectate duration, organic
take-overs, card→transcript clickthrough.

**Pre-registered success thresholds (set before building, do not move):**
- ≥30% of sessions get ≥1 non-spawner viewer after week 1 (novelty excluded)
- ≥1 organic take-over or fork per team per week
- Teams still active in week 3 unprompted
- Qualitative: someone says "I checked the pane instead of asking the person"

**Pre-registered failure reads:**
- Sessions never spectated → single-player orchestrator in disguise; do not build the company
- Spectate-once-then-stop → provenance is a demo, not a habit; pivot surface to inbox/review-queue

## Cross-cutting verification

1. SPEC.md adversarial review (multi-LLM debate) before Phase 1 code
2. Every phase exits with a recorded demo + written scorecard vs done-when list
3. Playwright e2e for chat + pane; transcript-replay determinism test; connection-chaos test
4. /code-review on each phase's diff; perf budgets asserted where measurable

## Key references

- Research summary + decisions: memory `agent-native-chat-ideation`
- Centaur API contract: `~/Code/centaur/AGENTS.md` (spawn/message/execute/events)
- Centaur E2E-without-Slack runbook: AGENTS.md §"E2E Testing (without Slack)"
- Protocol bets: MCP both-ways, Zed ACP, AG-UI event shapes, LiveKit (AV later), Linear AIG (agent identity)
