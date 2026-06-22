# Build Journal

Running state log. Newest entries at the bottom. This file exists so any session
(or post-compaction context) can resume exactly where work stopped.

## 2026-06-10 — Phase 0 setup

**Environment:** arm64 Mac (16GB), Docker Desktop 29.2.1 (VM: 10 CPU / 7.7GB),
kubectl v1.34, kind + helm + just installed via brew. No pre-existing k8s cluster.

**Decisions made:**
- Cluster: `kind create cluster --name centaur` (context `kind-centaur`) — the
  documented macOS path in centaur's mac-mini-setup.mdx.
- Secrets: env-mode (`ironProxy.secretSource: env`, `secretManager.backend: env`).
  1Password not available on this machine. Token broker requires a writable
  (1Password) backend → **subscription/brokered auth is OUT** (verified in
  `services/api/api/broker_config.py: _STORE_SOURCES`).
- No LLM API keys exist anywhere on this machine (swept env, zshrc, keychain,
  .env files, LaunchAgents, history). m5p asleep. → **Phase 0 runs the real
  claude-code harness against a deterministic in-cluster Anthropic-API mock**
  (`infra/llm-mock`). Claude Code honors `ANTHROPIC_BASE_URL`. Real-model
  confirmation run deferred until Gary provides ANTHROPIC_API_KEY (then: patch
  `centaur-infra-env` secret, remove ANTHROPIC_BASE_URL extraEnv, `just smoke`).
- Slackbot disabled in our deploy (no Slack tokens; surface replaces it anyway).
- Sandbox extraEnv carries ANTHROPIC_BASE_URL + NO_PROXY (merged, verified in
  `kubernetes.py:_apply_tool_server_extra_env`) + telemetry kill-switches.
- Sandbox pods labeled `centaur.ai/managed: "true"`; default-deny egress → our
  k8s.yaml adds NetworkPolicies for sandbox→mock (and iron-proxy→mock fallback).
- Claude harness settings: `bypassPermissions` (tools auto-execute in sandbox).

**State / how to resume:**
- centaur checkout: `~/Code/centaur` (shallow clone, MIT)
- local secrets: `source ~/Code/atrium/.centaur-local/secrets.env` (gitignored;
  holds SLACKBOT_API_KEY + LOCAL_DEV_API_KEY — LOCAL_DEV_API_KEY is the admin
  key for external API calls)
- k8s secret `centaur-infra-env` created in ns `centaur` + patched with mock
  ANTHROPIC_API_KEY ("sk-ant-mock-key-phase0")
- Images: `cd ~/Code/centaur && JUST_BUILD_SEQUENTIAL=1 just build` (background)
- After build: `kind load docker-image centaur-api:latest centaur-iron-proxy:latest centaur-slackbot:latest centaur-agent:latest --name centaur`
  (slackbot image optional since disabled), build+load `atrium-llm-mock:latest`
  from infra/llm-mock, `kubectl apply -f infra/llm-mock/k8s.yaml`, then deploy:
  `helm dependency update contrib/chart && helm upgrade --install centaur contrib/chart -n centaur --create-namespace -f contrib/chart/values.dev.yaml -f ~/Code/atrium/infra/values.local.yaml`
- Probe suite: `python3 notes/build-history/phase0/probe.py` (port-forwards API itself; see --help)

**Account-impact notes for Gary:** none so far. Considered and rejected using
~/.codex/auth.json refresh token for Codex access_token mode (broker would
rotate it and likely break local `codex` login; also broker needs 1Password).
Nothing touched your Claude/Codex accounts.

## 2026-06-10 — Phase 0 first run + the 405 saga

First probe run (A/B/C): control plane mechanics all PASSED (TTFE 0.03s,
deterministic replay, usable per-frame event ids) but the LLM leg failed 405.

Debug trail (for posterity / upstreaming):
1. Sandbox env was correct (ANTHROPIC_BASE_URL + merged NO_PROXY) but the mock
   received zero requests. Claude Code hardening env
   `CLAUDE_CODE_PROXY_RESOLVES_HOSTS=1` (set in `sandbox/config.py`) routes ALL
   traffic via proxy, ignoring NO_PROXY; iron-proxy's :8080 tunnel listener is
   CONNECT-only → plain-HTTP proxy-form POST → 405.
2. Proved the loop works: exec into sandbox, unset proxies → `claude -p` → PONG
   from the mock. (Claude Code does a HEAD / preflight; mock now handles HEAD.)
3. Chose the architecturally honest fix: serve the mock over TLS on :443 with a
   cert signed by the deployment's own firewall CA (we hold the CA key in the
   `centaur-firewall-ca-key` secret), point ANTHROPIC_BASE_URL=https://… and let
   traffic flow CONNECT→MITM as designed. Port 443 because per-sandbox proxy
   egress NetworkPolicy allows `to: any` ONLY on TCP/443.
4. Remaining failure: proxy verifies upstream certs against system roots →
   `x509: certificate signed by unknown authority`. Fix: derived image
   (infra/iron-proxy-trust/Dockerfile) appending the firewall CA to the proxy's
   system bundle, retagged centaur-iron-proxy:latest, kind-loaded, pods cycled.

Probe C fix: resumed streams legitimately re-emit the terminal execution_state
snapshot; id-continuity check now requires non-decreasing ids and allows dupes
only for execution_state frames.

Upstream-worthy findings (file issues later): (a) docs don't mention the
proxy's 443-only egress for sandbox third-party hosts; (b) no supported way to
add upstream CAs to iron-proxy trust (needed for any self-hosted/internal LLM
endpoint — vLLM/Ollama deployments will hit this exact wall); (c) an env-mode
token broker (read-only refresh, in-memory rotation) would unlock
subscription auth without 1Password.

## 2026-06-10 — Phase 0 CLOSED: GO

All 18 checks green (A/B/C 14/14 + D 4/4). Test D: API pod killed mid-SLOWSTREAM,
execution still reached completed with full durable replay (last pre-kill id
present). Event schema documented in notes/build-history/phase0/results/event-schema.md — key
finding: text streaming is PER-DELTA (1.005 events/model delta), so Phase-2
panes can render true token streaming off the durable stream. Codex agent did
the dump analysis (its sandbox could not write into the repo; doc written by
main session from its findings + direct dump inspection).

## 2026-06-10 — Phase 1 CLOSED (technical gate)

Surface agent delivered Places chat: event-sourced log, optimistic reconciliation
(pure reducer, tested), WS fanout + presence + unread, after_id catch-up healing
reconnects. 26/26 tests green (re-verified by main session), p50 7.5ms local.
Day-of-use gate moves to Phase 4. Process note: use SCOPED git adds while
parallel agents share this repo (a git add -A swept agent WIP into Phase-0
commits; content verified identical at HEAD, no rewrite).

Next: Phase 2 per notes/build-history/phase2/DESIGN.md, split: codex → surface/server sessions
module (migration, SessionService, tailer, stream proxy); Claude agent →
surface/web session card + pane; me → integration + live-cluster e2e.
Both blocked on packages/centaur-client (codex task-mq8jugan-biywsm, in flight).

## 2026-06-10 — Phase 2 server half: reviewed, committed, LIVE-VERIFIED

Codex delivered surface/server sessions module (again finished without
committing — watch for this pattern). Review found+fixed: fire-and-forget
tailer shutdown (abort not awaited → write/TRUNCATE race, real shutdown bug).
19/19 tests x3. Commit 36f0683.

Live e2e against kind cluster (no UI): POST /api/sessions with a TOOLTEST task
→ session.spawned became thread root (event 80) → Centaur sandbox → Claude Code
→ mock LLM → real Bash roundtrip → tailer → status_changed events in thread →
completed with result_text TOOLCHAIN_OK in <3s. Stream proxy replays full
transcript with event_ids injected. Contract shapes match the pinned spec
exactly. Recipe: kubectl port-forward deploy/centaur-centaur-api 18000:8000;
CENTAUR_BASE_URL=http://127.0.0.1:18000 CENTAUR_API_KEY=$LOCAL_DEV_API_KEY
PORT=3001 pnpm start (surface/server has no /health route — check stdout).

Remaining for Phase-2 gate: web pane (agent in flight), then multi-spectator
live verification + reload-recovery + perf bar (500-item scroll).

## 2026-06-10 — Phase 2 CLOSED (gate green on live stack)

Web pane agent delivered sessions UI (commit a1a3473, reviewed: stream hook is
clean — rAF batching, resume-from-last-id, terminal guard). Live e2e 9/9 incl.
the steer-after-completion edge I suspected would break (it does not). The
mid-run-spectator screenshot in notes/build-history/phase2/e2e/artifacts is the product thesis
working: Bob watching Alice's live session next to #general.
Stack recipe for e2e: pf 18000 + server 3001 (CENTAUR_* env) + web 5173, then
`node notes/build-history/phase2/e2e/multispectator.mjs`.

Next: Phase 3 (driver seat) — same split: codex=server seats, claude=web,
me=review+live e2e. Contract: POST /api/sessions/:id/seat/{request,grant,take};
session.seat_requested/.seat_changed events; tx + FOR UPDATE determinism;
steer permission moves spawner→driver_id.

## 2026-06-10 — Phases 3 + 4(buildable) CLOSED — final e2e 14/14

Seat UX landed (web b4b3685, 29/29 web tests; also fixed pre-existing pane
state leak via key={session.id}). Server seats reviewed earlier (ec5d5e1).
session_views instrumentation reviewed + fixed (count() string coercion).

Live e2e caught a REAL bug neither unit suites nor agents saw: sessions never
released Centaur assignments → pods accumulated → node at 92% mem → spawn
timeouts. Fixed: idle-delayed release (60s, cancel-on-steer, terminal re-check,
SESSION_RELEASE_IDLE_MS env). Also cleaned 10 stale assignments (6 surface + 4
from my own Phase-0 probes — probe.py has the same leak, acceptable for a
probe). Final run: 14/14 incl. 35ms seat handoff.

Dev stack LEFT RUNNING for Gary: web http://127.0.0.1:5173 (login with any
handle), server :3001, port-forward :18000. Restart recipe in this journal
(Phase-2 entry). Cluster: kind "centaur" w/ mock LLM.

## 2026-06-11 — Phase 5 sync engine SHIPPED (A–F, codex fleet, 6 merges)

Charter: notes/build-history/phase5/DESIGN.md (decisions block has Gary's four calls: full web
parity, reactions clean break, fleet-per-phase, chaos harness as merge gate).
All six phases merged to master in one day: A baee1d2, B d060665, C 8b85a68,
D 9a40d44, F 0a00427, E fc04abd. Final state: 262 unit/integration tests +
11 e2e (3 new offline flows) green.

What exists now: WS frames carry per-connection seq (gap → repair); every
mutation route is exactly-once via idempotency_keys + opId (reactions moved
toggle→add/remove set semantics — the one breaking wire change); both clients
run a durable typed op queue (SQLite / IndexedDB) with FIFO-per-queueKey,
coalescing, crash recovery re-running with persisted opIds; optimistic
edit/delete/react overlays rematerialize over base state and rebase reverts
across concurrent foreign edits; GET /api/sync returns cursor events + full
sideband snapshot with limited→snapshot-repair; uploads are durable ops with
content-hash dedupe + presigned refresh, msg.send dependsOn uploads; web has
an offline app shell (network-first SW) and cursor-after-flush durability.

Review catches worth remembering: Phase A worker's catch-up fallback merged
the latest page over stale state leaving silent unfillable timeline holes —
the worker's own test enshrined the bug (fixed with resetToLatest; check what
tests ASSERT, not that they exist). Two migrations are both numbered 020
(name-tracked, both applied — do not rename; next is 021). /sync has no
workspace scoping because the schema has no user→workspace mapping (single-
tenant assumption is systemic, not new). Sync count query is O(visible
events) per call — revisit ~10⁷ events.
