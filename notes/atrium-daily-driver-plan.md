# Atrium as Daily Driver — Core Functionality Brainstorm

Draft: 2026-06-18. Goal: define the minimum capability set for Atrium to replace
the current `agentboard` + `remote-gallery` setup (running on an always-on M1
MacBook Pro beside the GUI laptop) as the daily driver for agent work.

Status: brainstorm. Open decisions are collected at the bottom; some are being
asked interactively and folded back in. Codex (xhigh) feedback pending → appended
as its own section.

## Framing

The daily-driver bar is set by `agentboard`/`tmux`: **near-instant** agent
spawn, repos already on disk, deps cached, zero ceremony. Atrium adds
multiplayer, mobile, durable records, artifacts, voice — but it must not lose the
"it's already there" feel. Every capability below is judged against that bar.

Two ideas recur and are worth stating up front:

1. **Files, not custom formats.** The notebook (#2) and artifacts (#3) are the
   same surface: a previewable/editable file tree that is *also* mounted into
   agent sandboxes so agents `grep`/`rg`/`git` them with zero custom tools. Meet
   agents where they are.
2. **Warm, not cold.** Match tmux latency by pre-warming sandboxes keyed by
   (repo, branch), so an interactive spawn is a *claim*, not a *create*.

---

## 1. First-class mobile + desktop/web

**Current state.** `surface/web` (React/Vite) + `surface/server` (Node) +
`surface/mobile` (Expo) + `surface/shared`. Sync engine (phase 5) shipped;
clients are views over `session_events`. Voice has verified native CallKit on
iPhone. Mobile push still needs `eas init`.

**MVP cut.** Web responsive + installable PWA covers desktop. Expo app for mobile
with EAS push wired. All three clients stay thin views over the same sync
stream — no client-specific business logic. Agents run server-side, so mobile is
a pure remote control (no on-device execution needed).

**Main trap.** Real-time reconnect/resume and notification fan-out, not rendering.
A phone that backgrounds mid-session, drops wifi, and returns must rejoin the
stream cleanly. Three clients drifting is the slow-bleed failure — enforce
"shared package is the only source of view logic."

**Non-obvious improvement.** Lockscreen voice braindump on mobile (record → STT →
appends to the notebook channel, #2) is the single highest-value mobile feature
and the reason to carry a phone client at all. Build for capture-first, not
parity-first.

## 2. Single-player "chief of staff / braindump" notebook

**Current state.** Channels are chat surfaces backed by Postgres. STT exists from
the voice work. No markdown-doc/editor surface yet; no file projection.

**The real fork — how do agents search it?** Three options:

- **(A) Git-backed markdown repo per user**, mounted into sandboxes. The app is a
  git-backed markdown editor; agents `grep`/`git log`/edit naturally; Postgres
  holds a full-text mirror for the app's own search. Free versioning, diffs,
  conflict resolution, multi-device sync. **Recommended.**
- **(B) Plain markdown file tree** on a mounted artifact volume; Postgres holds
  metadata + FTS. Simpler, but you hand-roll history/conflict handling.
- **(C) Stays in Postgres**; expose an Atrium search MCP/tool to agents. This is
  exactly the "custom tools/prompts bloat" you want to avoid; only justified for
  cross-session/structured queries the file tree can't express.

**MVP cut.** Notebook = a `braindump/` markdown tree (git-backed, option A).
Audio message → blob in S3 + transcript text inline (the transcript is what's
greppable). Basic markdown editor with live preview. App search = Postgres FTS;
agent search = the mounted repo + ripgrep. No custom retrieval tool on day one.

**Main trap.** Bidirectional sync: app edits vs agent edits vs concurrent device.
Git makes this tractable (3-way merge, last-writer-wins on conflict with history
preserved) — which is the main argument for option A over B.

**Non-obvious improvement.** The "brain" repo doubles as agent memory: point your
agents' memory/context at the same repo, so notes you take *become* agent context
with no extra plumbing. One artifact, two readers.

## 3. Artifact detection / backup / preview / markdown editing

**Current state.** Foundation merged (reducer + gallery as 3rd Work tab; record
exposes artifacts). A3b serve route + S3 offload pending. Centaur producer
(sandbox FS capture, Rust `api-rs`) in progress. Allow-list dirs + dedicated byte
channel decided. Blob store = Atrium's own S3.

**MVP cut.** Sandbox watcher emits `artifact.captured` for allow-listed dirs →
bytes to S3 → gallery preview (images, text, markdown, PDF). Markdown in-app edit
writes back as a new artifact version. remote-gallery parity = this.

**Main trap.** "Artifact vs junk" classification (don't capture `node_modules`,
build dirs) — allow-list dirs handle it but need good defaults. Edit-write-back
reconciliation is the *same* sync problem as #2; solve it once.

**Non-obvious improvement.** Unify #2 and #3 into one "Files" abstraction:
preview + edit + version + mount. The notebook is just a pinned, always-present
"artifact" tree; session artifacts are ephemeral trees. One editor, one sync
model, one mount mechanism.

## 4. Video + voice chat + outside guests

**Current state.** Voice fully shipped (calls, voice messages, STT, native ring).
No video. No guest model.

**MVP cut.** Add video on a managed SFU (LiveKit Cloud or Daily) rather than
self-hosting. Guest invite = tokenized, time-boxed magic link scoped to a single
channel/call, no account required. Recording optional + consented.

**Main trap.** Guest permission scoping — a guest link must not leak the
workspace. This needs a real sharing primitive (see Gaps). Plus TURN/NAT,
SFU cost, and mobile video + CallKit interplay.

**Non-obvious improvement.** Make "invite guest" one instance of a single
**share primitive** that also governs sharing a session, an artifact, or a
read-only channel view. Don't build guest-calls as a one-off.

## 5. Fast agent spin-up (match agentboard + tmux)

**Current state.** Centaur = k8s sandbox orchestrator; warm pool size 3; idle
pause/resume (scale-to-zero); state volumes disabled by default. Spawn today must
schedule a pod, pull image, checkout repo, install deps, start harness.

**The latency budget vs tmux.** tmux is instant because nothing is provisioned —
repo is on disk, deps cached. Centaur's costs, in order of pain:

1. **Pod scheduling + image pull** → fixed by a *fat warm pool* (claim a
   pre-warmed pod instead of creating one). Pull cost → baked base images +
   node-local image cache.
2. **Repo checkout** → per-repo warm overlays: keep a pre-cloned checkout of each
   hot repo on a shared cache volume; sandbox does copy-on-write / `git clone
   --reference` instead of a fresh network clone.
3. **Dep install** → shared cache mounts (pnpm store, cargo registry, uv cache)
   or pre-installed in the base/repo image. Keep deps warm.
4. **LLM egress latency** → the sleeper. Per-token streaming RTT from the box to
   the provider matters. A Hetzner EU box talking to a US provider adds real
   latency per turn. **Put the box near the provider** (US region) or accept it.

**MVP cut.** One cloud box. The honest fork is the isolation model:

- **k3s + fat warm pool + per-repo warm overlays** — keeps the whole Centaur
  investment (harness adapters, event stream, HITL, pause/resume); just tune
  warmth way up. Single-user, so a big idle pool is cheap.
- **Process/Docker backend (no k8s)** — a new Centaur backend that runs the
  harness as a process (or plain container) on the trusted box. Closest to tmux
  latency; loses k8s isolation (fine for single-user/trusted) but is real new
  work.
- **Point Atrium at the existing M1** as the runtime — least work, validates the
  whole product, but it's "local server" not "cloud daily driver."

**Main trap.** Single box = SPOF + noisy-neighbor + warm-pool exhaustion under
burst. Acceptable for one user; document the failure mode. The deeper question is
whether you need k8s *isolation* at all for a single-user trusted box, or whether
process/container isolation matches tmux latency at a fraction of the ceremony.

**Non-obvious improvement.** Decouple "spawn agent" from "provision sandbox."
Maintain a small warm pool *per hot repo/branch* so the interactive spawn is a
sub-second claim of an already-checked-out, deps-warm sandbox — literally
agentboard's "it's already there," as a pool. This is the single highest-leverage
latency move.

## 6. BYO subscriptions (Codex / Claude / Gemini, no API billing)

**Current state (from prior research).** Centaur's iron-proxy (per-sandbox MITM
sidecar) + iron-token-broker already do credential injection for Codex/Claude
OAuth — the token never enters the sandbox. Gaps: broker vault is
deployment-wide (per-user scoping is a Centaur contribution); rotation races with
the laptop's `auth.json` (use a separate login lineage). ToS: **Codex** =
gray/tolerated; **Claude** = explicitly prohibited + server-side enforced.

**MVP cut.**

- **Codex** → your ChatGPT sub via the broker, captured as a *separate* Atrium
  login lineage (never reuse the laptop's `~/.codex/auth.json`).
- **Claude** → either compliant API key, or a "BYO terminal" pane (below). Do not
  route a Claude sub through a shared multi-tenant broker.
- **Gemini** → Gemini CLI with your Google login (free tier is OAuth); verify ToS
  for headless use; API-key fallback.

**Main trap.** Claude ToS enforcement is real (account-ban risk, server-side). The
lowest-risk Claude-on-sub path is "ordinary individual usage" — your own creds in
an environment you control, not a shared broker.

**Non-obvious improvement.** Promote the **"BYO terminal"** to a first-class
feature: a raw PTY sandbox session where *you* supply your own auth, for any
harness Atrium doesn't natively broker. It's the escape hatch for Claude-on-sub
today and the on-ramp for every new harness (ties directly into #7).

## 7. Swap harnesses (Codex / Gemini → pi, omp, …)

**Current state.** Centaur has harness adapters for Codex/Claude/Amp
(`crates/harness-server`). The adapter pattern exists; Amp proves a third harness
is integratable. omp is already used in the agent-fanout skill (with Gemini
Flash).

**MVP cut — a two-tier capability model:**

- **Tier 0: raw PTY passthrough.** Any CLI that takes a prompt and streams output
  runs in the BYO terminal (#6). Transcript-only surface, but zero integration
  cost. This is how pi/omp/anything lands *today*.
- **Tier 1: native adapter.** The harness emits structured events
  (file-change / artifact / HITL frames) → rich Changes/Artifacts/approval
  surfaces. New harnesses graduate from Tier 0 to Tier 1 when worth it.

**Main trap.** Tier 1 needs the harness to emit structured events; a generic CLI
won't, so you get a degraded (transcript-only) surface until someone writes the
adapter. Set expectations: "swap harness" is cheap at Tier 0, real work at Tier 1.

**Non-obvious improvement.** Publish the harness event-stream contract so adapters
are community-writable; treat Amp's adapter as the reference implementation.

## 8. Full-fidelity archival + external-session ingest

**Current state.** `session_events` is already a full-fidelity mirror (canonical
product record). `cass` (installed locally) *already* does unified search over
coding-agent histories (claude_code + codex jsonl) with an indexer, remote
`sources`, export, and encrypted `pages` — i.e. most of the "search all agent
activity" ask already exists as a tool.

**MVP cut.**

- **Inside Atrium:** keep mirroring `session_events`; archive raw jsonl frames to
  cold S3.
- **Outside ingest:** a small watcher daemon (or reuse `cass` as the capture
  layer) that tails `~/.claude/projects/*.jsonl` and `~/.codex/sessions/*.jsonl`
  on any machine and uploads to an Atrium archive endpoint, tagged by
  machine/source. Atrium ingests into the same archive + search index.
- **Desktop apps:** the *CLIs* (Claude Code, Codex) write local jsonl — easy. The
  *GUI chat apps* (Claude Desktop, ChatGPT Desktop) store conversations in a
  local app DB (sqlite/leveldb) that's cloud-synced, **not** jsonl — so "desktop
  apps write jsonl" holds for the CLIs but **not** the GUI apps. Flagging so it's
  not assumed.

**Main trap.** Secrets in transcripts. jsonl routinely contains pasted tokens /
env / keys — **redact on ingest** before it lands in durable storage. Also:
cross-machine identity/dedup, and volume/cost of full-fidelity archive.

**Non-obvious improvement.** Don't rebuild the indexer — make **Atrium the
durable cloud sink for `cass`** (it already has `sources` and `export`/`pages`).
Local `cass` stays the fast on-machine search; Atrium becomes the team-wide,
permanent, redacted archive that `cass` syncs into.

---

## Gaps / extensions you didn't list but should consider

- **Identity & auth.** Accounts, device pairing, session tokens, and the
  **share primitive** (#4) that uniformly scopes guests, shared sessions, shared
  artifacts, read-only channel views.
- **Secrets management.** A real UI for per-user provider creds, repo deploy keys,
  env injection — partly via Centaur secrets/broker, but it needs a front door.
- **Session sleep/resume.** The harness-resume workstream matters *a lot* for a
  daily driver: don't lose an agent's context overnight. Codex resume POC is done
  (rollout JSONL + thread-id inject); Claude resume is greenfield. Sleep-between-
  turns lowers idle cost on the single box.
- **Cost & budget controls.** Per-session token/$ budgets, idle-pod cost
  dashboards, who-spent-what. On a single always-on box, idle compute is the
  silent cost.
- **Notifications.** Push (mobile EAS), email, and especially **HITL "agent needs
  you"** pings (the question-relay path exists). This is what lets you walk away.
- **Background / scheduled agents.** "Always-on server" implies cron agents,
  repo-watchers, long-running background sessions — a natural Atrium superpower
  over tmux, and it leans on sleep/resume.
- **Sandbox-level safety controls.** Per memory, the per-command HITL gate was
  dropped in favor of constraining the sandbox's network/fs/exec. For a daily
  driver running real repos, define those guardrails (especially for Tier-0
  BYO-terminal harnesses you don't fully observe).
- **Data ownership / export.** Full export of your record — fits the
  archive/`cass` ethos and "own your data."
- **Comms / calendar integration.** Gmail/Calendar MCP wired into the
  chief-of-staff channel makes "chief of staff" literal, not metaphorical.

## Things that are premature or a bad idea (call-outs)

- **Full root-FS snapshot as the artifact model** — the storage plan already says
  avoid; use scoped artifact capture.
- **Claude-on-subscription through a multi-tenant broker** — ToS-prohibited +
  enforced; ban risk. Keep it to individual-use / API key.
- **Rebuilding a history indexer** — `cass` exists; sink into it, don't replace.
- **A custom Atrium doc/todo/planning format** — you explicitly reject it; files +
  markdown + git is the whole design (#2/#3).
- **Self-hosting an SFU for video on day one** — use managed (LiveKit/Daily) until
  scale justifies otherwise.

## Open decisions (being asked interactively)

1. **Runtime isolation model for the single box** (#5): k3s + fat warm pool vs
   process/Docker backend vs point-at-the-M1.
2. **Notebook storage model** (#2): git-backed repo (A) vs plain file tree (B) vs
   Postgres + search tool (C).
3. **Claude-on-subscription stance** (#6): API key vs BYO-terminal pane vs defer.
4. **Day-1 milestone**: which capabilities actually unblock switching off
   agentboard.

## Codex (xhigh) feedback

_Pending — running in parallel; will be folded in when it returns._
