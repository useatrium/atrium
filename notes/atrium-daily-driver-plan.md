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

> **REVISED 2026-06-19 — supersedes the read-only / chat-canonical model below.**
> Notes move to **artifact-canonical files** in the CAS-ledger; chat becomes an
> **input method + rendered view**, not the source of truth, so agents can edit
> notes directly (base-aware capture + conflict-state). The frictionless
> **voice/mobile braindump** is preserved by a **second write mode**: chat-style
> *append* materializes into an **append-only daily/log artifact** (appends commute
> → never conflicts); structured docs use the *edit* mode (conflict-state). See
> `cas-ledger-build-plan.md` §10.2. The §2 body below is retained as the original
> brainstorm.

**Current state.** Channels are chat surfaces backed by Postgres. STT exists from
the voice work. No markdown-doc/editor surface yet; no file projection.

**The model (resolving "is this separate from chat history?").** No — it *is* the
existing chat history, not a parallel store. The notebook is a normal Atrium
channel (your "chief of staff" channel): you type, record audio, edit markdown in
the same surface as every channel, and **Postgres stays canonical**. What's new
is a **materialized projection** — Atrium continuously renders that channel's
messages + transcripts into a markdown file tree in a per-workspace
`atrium-memory/` git repo:

```text
atrium-memory/
  channels/chief-of-staff/2026-06.md
  channels/<name>/<month>.md
  sessions/<id>.md
  index.jsonl
```

…mounted **read-only** into agent sandboxes. You interact with chat (canonical);
agents `grep`/`rg`/`git log` the mirror (ergonomic, zero custom tools); git gives
the mirror versioning + multi-device sync for free. The git repo is *how the
projection is stored and mounted*, not a second source of truth. (This reconciles
the earlier "git-backed repo" idea with "Postgres canonical" — git is the
transport for the projection, Postgres is the truth.)

**MVP cut.** Read-only projection. App search = Postgres FTS (already exists —
migration `005_search_fts.sql`). Agent search = the mounted mirror + ripgrep.
Audio message → blob in S3 + transcript inline (the transcript is what's
greppable). Basic markdown editor with live preview. No custom retrieval tool.

**Where the bytes live, and why agents can still search them.** Explorability
comes from the **mount**, not from the canonical store — an agent cannot `rg` an
S3 object store directly. So the two concerns separate cleanly:

- **Artifacts (incl. agent-written `.md`)** → canonical bytes in the **Atrium S3
  artifact store**, versioned. (This is the "keep md in the artifact store" idea —
  correct for *files*.)
- **Braindump notes** → canonical in **chat/Postgres** (free audio, STT,
  real-time sync, threading, FTS). Don't move these to files-canonical: it buys
  nothing on explorability and loses the chat ergonomics.
- **One read-only mount** materializes *both* (rendered notes + S3 artifacts) as a
  real file tree in the sandbox. Agents `rg`/`cat`/`ls` it; they never touch S3.
- **Agent writes** land in the sandbox's **`git clone --shared` workspace**; the
  in-process 2.5 s watcher captures changed files → offloaded to the **S3
  CAS-ledger** (`cas/<sha>`) → re-materialized into the read-only view as a new
  version. (The earlier overlay-FS *and* object-FUSE/Archil models were both
  dropped — see the §3 correction and [[agent-data-architecture]].)

**Main trap.** Two different things, don't conflate them: **(a) notes** stay
read-only because they're chat-canonical — agent contributions arrive as
messages/artifacts that re-materialize, never direct edits to canonical state;
**(b) artifacts the agent should edit get *writable-hydrated*** into the workspace
(not the read-only mount — that's for pure-read context only) and are versioned on
capture. The human↔agent conflict model is built (OCC + node-diff3), **but a
hand-compute (2026-06-19) showed shared-doc *capture* must be made base-aware or it
silently loses updates — see §3.** The genuinely-deferred piece is **freshness**:
sync is no-ingress / egress-only, so a *running* sandbox sees another actor's edits
only at its next pull — **mid-session inbound sync is new Centaur work** and the
gating item for live cross-container collab (see Gaps). (Search scaling: ripgrep
over a huge mount can get slow — scope per-channel/session or add a light index
later; MVP ripgrep is fine.)

**Non-obvious improvement.** The same `atrium-memory/` mirror doubles as agent
memory: point agents' memory/context at it, so notes you take *become* agent
context with no extra plumbing. Codex independently proposed the same
`atrium-memory/` tree plus per-day/week **"distillations"** (generated summaries,
clearly derived from event IDs and reversible) — a strong fast-follow.

## 3. Artifact detection / backup / preview / markdown editing

**Current state.** Foundation merged (reducer + gallery as 3rd Work tab; record
exposes artifacts). **Atrium-side capture/offload/serve now merged on master**
(`session_artifacts` migs 031+032, `artifact-offload.ts` lease worker, serve route
+ `ARTIFACT_CAPTURE_API_KEY`). The **Centaur producer** (`1000_artifact_blobs.sql`,
`services/sandbox/artifact_capture.py`, api-rs capture routes, `artifact.captured`
frames) is **merged into `atrium/integration`** — Atrium's Centaur deploy branch,
18 commits ahead of `origin/main` (branch `gb/api-rs-artifact-capture`, pushed to
`fork`). The only thing outstanding is **upstreaming to Centaur `origin/main`**,
not integration. (Deploy status of `integration` not separately verified here.)
Today's store is still a **capture-only, flat, content-hashed per-session log** —
**missing write-back, version chains, global dedup, GC**. Blob store = Atrium's S3.

**MVP cut.** Sandbox watcher captures allow-listed dirs → bytes to S3 → gallery
preview (images, text, markdown, PDF). Markdown in-app edit writes back as a new
version. remote-gallery parity = this.

**Storage substrate — BUILDING NOW (`feat/cas-ledger`).** The live spike (both
tracks run vs the dev stack incl. real lakeFS 1.82.0) settled the backing — **own
CAS-ledger, beat lakeFS 39–29** (lakeFS lost on conflict-fit, ops, paywalled RBAC)
— and v1 is now in build. **Schema (mig `033_artifact_ledger.sql`):** `cas_blobs`
(sha256→S3, global dedup) · `artifacts` (identity `UNIQUE(session_id,path)`,
channel denormalized, `merge_class`) · `artifact_versions` (chain:
`blob_sha`/`base_seq`/`author`/`kind`/`status`/`conflict`) · `artifact_pointers`
(v1 ships `latest` only). Identity = **(session,path)**, content-deduped
(re-captures idempotent). **Fan-out** = a Claude-built foundation (mig +
`artifact-ledger.ts` + tests, in the working tree now) gating 4 codex lanes:
**(1)** capture-bridge `mirrorFrame`→versions + CAS re-key (`cas/<sha>`); **(2)**
serve-latest-by-path route + by-path gallery view (one row/path, newest-wins);
**(3)** human write-back PUT + **node-diff3** 3-way conflict-state (OCC base
required); **(4)** blob-GC mark-sweep + **C1-ready hooks** (LISTEN/NOTIFY on
pointer-advance — the invalidation source for inbound sync). So write-back +
conflict-state, earlier "deferred," is **in this round**. Plan:
`notes/cas-ledger-build-plan.md`; design [[agent-data-architecture]].

**Main trap.** (1) "Artifact vs junk" → **layered filtering** (path-globs + type
allow/deny + secrets detector + size-as-routing-signal) per workspace mode, not a
single allow-list. (2) **GC mark-sweep + grace is mandatory day one** — tiny
autosave/op-log writes are 10× garbage; scattered Merkle keys measured 68× blowup.
(3) Edit-write-back is no longer the open problem (the CAS-ledger gives it +
conflict-state); what *remains* open is mid-session inbound sync (see Gaps).
(4) **Large files** — Centaur has **no object store** today: bytes are
whole-in-memory at every hop, capped ~1 MiB at capture and ~16 MiB at the route,
`bytea`-staged. So **>~16 MiB has no servable bytes** until Centaur adds streaming
(presigned-PUT to Atrium S3, or stream-through api-rs). Not a v1 blocker (notebook
= md + small images); a one-config cap-bump (~16 MiB) covers medium artifacts;
true large-file is a dedicated Centaur fast-follow, gated behind this ledger anyway.

**Concurrent editing — hand-computed (2026-06-19), and where it breaks.** Tracing
two agents + a human editing one shared doc against the *built* `commitVersion`
surfaced that the ledger is **session-scoped + blind-append** today, so shared
editing isn't safe yet. Five findings:

1. **Blind-append capture loses updates on a shared chain.** `commitVersion` with
   no `baseSeq` sets `effectiveBase = latest.seq` (can't trip `stale_base`) and
   dedup only checks *equality* — so if two agents both edit base v1 and capture in
   turn, the second append silently buries the first (code-confirmed
   `artifact-ledger.ts:277,281`). **Fix:** shared-artifact captures must be
   **base-aware** — carry the hydrated `base_seq` and route through the *same*
   OCC → node-diff3 conflict-state the human write-back lane already uses.
2. **The change-feed is session-scoped.** `changedSince` filters
   `WHERE a.session_id = $1`, so an agent can't even *see* another session's edit.
   Cross-agent sharing needs a **channel/subscription-scoped feed**.
3. **C1 delivers bytes but doesn't reconcile.** Stage-to-`incoming/` + no-hot-swap
   correctly protects a dirty working copy, but for an *autonomous* agent the
   staged file is inert — **no trigger** makes it rebase. Needs a reconcile signal
   (daemon drops a conflict marker the harness surfaces as a steer).
4. **Watermark cursor bug.** `changedSince` uses `created_at > $2` (bare
   timestamp); same-`created_at` versions get skipped. **Fix:** `(created_at, seq)`
   cursor, watermark on the max row *returned*, not wall-clock.
5. **"Reconcile at the ledger" assumes a within-artifact merge** (built) but the
   shared case is cross-chain. **Resolution:** make a shared doc a **single chain**
   identified by `(channel, name)` so it reuses the built within-artifact
   conflict-state — *not* per-session chains needing a new cross-artifact engine.

**Net:** "channel-shared = a modest pointer table" (last round) was **under-scoped**
— a pointer is modest, *concurrent shared editing* is not. The small-but-correct v1
= `(channel,name)` identity + **base-aware capture for shared artifacts** (reusing
built OCC/node-diff3). **Single-player is well-served**: you-in-app + one
agent-in-sandbox is a conflict *within one shared artifact* = the built path. The
multi-*agent* live case needs C1 + the channel-scoped feed + reconcile trigger
(deferred). Full trace + fixes in `notes/cas-ledger-build-plan.md`.

**Non-obvious improvement.** Unify #2 and #3 into one "Files" abstraction:
preview + edit + version + mount. **Capture mechanism — DECIDED 2026-06-20
(scalable/permanent): overlay-upper node-scan (`cas-ledger-build-plan.md` Track
C4).** The overlay model is **reinstated with the privilege relocated**: the
*runtime* provisions a per-pod overlay (lower = base+deps+repo RO; upper on a
session-keyed persistent node volume; `merged` bind into the hardened agent), and a
**node DaemonSet scans the upper** — O(changes) scan, O(nodes) scanner, delete/rename
fidelity, zero agent footprint, direct-to-S3 large files. *(This refines the
2026-06-19 correction: agent-mounts-overlay stays dropped — no `CAP_SYS_ADMIN` in the
sandbox — but runtime-mounts-overlay + node-scan is the target; today's 2.5s
`git clone --shared` watcher is the fallback.)* The one pre-build check is the
`mountPropagation: Bidirectional` linchpin (verify on a real Linux node). Multi-tenant
isolation = **VM-per-tenant** (per-tenant node → per-tenant DaemonSet; hypervisor
boundary). The ledger is cadence- and FS-agnostic, so none of this blocks it.

**Scope + filtering — design pass 2026-06-19 (see `cas-ledger-build-plan.md` §10).**
Artifacts are **shared workspace-wide by default** — sessions share *across*
channels. Identity is effectively `(workspace, fullpath)`; **scope is a path
prefix** the filter/access layer reads, not a session/channel tag: `scratch/<session>/`
= private (filter-excluded, blind-append), `proj-x/` = topic/team scope (the default
altitude), `shared/`/root = workspace-wide. Each task gets a default working dir so
files land namespaced and generic names (`report.md`) don't accidentally collide.
**diff3 is gated by merge-class**: binaries → `immutable-data` (never merged);
structured-serialized (JSON/YAML/CSV/`.ipynb`) → diff3-unsafe, whole-file
conflict-state; line-text (code, md prose) → diff3 OK. **Code repos are excluded
from the shared pool** — a repo checked out in two containers is git's to coordinate,
never artifact-synced between them; the filter excludes anything under a git working
tree (extends today's `.git/`-only ignore), and deliverables are written *outside*
repo roots into the shared namespace.

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

| Dimension | k3s + fat warm pool **(recommended)** | Process/Docker backend | Point at the M1 |
|---|---|---|---|
| Spawn latency | near-instant on warm-pool hit; cold = full provision. Per-(repo,branch) leases close most of the tmux gap | best — closest to tmux (no pod sched / PVC attach) | like agentboard locally + a surface→M1 network hop |
| Isolation | strong: pod/namespace, network policy, per-pod iron-proxy | process/container only; fine on a trusted single-user box | your existing local trust model |
| **BYO-subs coupling (#6, must-have)** | **keeps it** — iron-proxy + token-broker are k8s sidecar/Deployment-shaped today | **RISK** — brokered credential injection is k8s-shaped; non-k8s forces a re-wire | inherits whatever runs on the M1 |
| New engineering | low: tune existing Centaur (bigger pool, per-repo overlays, leases) | high: a new non-k8s execution backend under Centaur | lowest: point centaur-client at Centaur-on-M1 |
| Ops burden | moderate: run single-node k3s | simplest: a daemon + docker | none beyond today |
| Failure mode | warm-pool exhaustion, image pull, PVC attach; single-node SPOF | noisy-neighbor, no net-policy isolation, blast radius on the box | M1 SPOF, home network, not portable |
| Future (multiplayer) | scales to multi-node/multi-tenant naturally | rebuild needed for multi-tenant | validation only; migrate later |

**Recommendation: k3s on a US box.** The decider is **#6** — BYO subscriptions
ride the per-pod iron-proxy + token-broker, which are k8s-shaped *today*. A
process backend would force you to re-wire credential injection, spending your
novelty budget exactly where you can least afford it. Warm per-(repo,branch)
**leases** get most of tmux's speed without dropping k8s. Use **point-at-the-M1**
as a zero-cost bring-up this week to validate end-to-end, then graduate to the box.

**Main trap.** Warm pods alone do *not* match tmux — the real latency is auth +
clone + checkout + dependency install + build-cache misses + volume attach (codex
flagged this hard). Warm the *whole* lease (checkout + deps + caches), not just
the pod. Single box is also SPOF + noisy-neighbor under burst; document it.

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
- **Claude** → **do it like agentboard.** agentboard already runs `claude` as a
  local CLI process with *your own* logged-in subscription — that's "ordinary
  individual usage" on a machine you control, the same risk you accept today. The
  prohibition + server-side enforcement target **multi-tenant hosted MITM**
  (routing many users' subs through a shared broker), not you running your own
  CLI. So: a **BYO-terminal / local-bridge pane** (run `claude` with your auth in
  a PTY session you own — not the iron-proxy broker) is functionally identical to
  agentboard and fine for single-player. One caveat: a hosted sandbox is slightly
  more exposed than your laptop, and the calculus changes the day Atrium serves
  other people's Claude subs — keep a compliant API-key path for that future.
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
  cold S3. **Fidelity gap (from the data-arch audit):** `session_events` mirrors
  Centaur *frames*, not the harness **rollout JSONL** (the actual Codex/Claude
  transcript inside the sandbox) — which is **uncaptured today and lost on
  teardown**. True full-fidelity (and harness resume) needs capturing that rollout
  file too; same capture pipeline as artifacts.
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
- **Cross-container freshness / mid-session inbound sync (Track C1).** *The gating
  item* for live cross-container collaboration, **downstream of the CAS-ledger**
  (its pointer-advance `pg_notify` is the invalidation source — Lane 4 builds those
  hooks now). Capture-out (egress) is built; the inbound path is **new Centaur
  work**. Mechanism (corrected by the repo map): a running sandbox has **no held
  outbound stream** — only **stdin via the k8s attach pipe** — so the primary design
  is an **egress-poll inbound daemon** (harness-agnostic; polls a change-feed, GETs
  bytes, stages to `~/.atrium/incoming/`, never hot-swaps), with an optional stdin
  `artifact.sync` poke as a latency cut. The hand-compute (§3) sharpened three
  must-fixes before this is correct: the **change-feed must be workspace/topic-scoped**
  (it's session-scoped today, so it can't see other agents — see §10.1 scope), the
  staged bytes need a **reconcile trigger** for autonomous agents (decided:
  **auto-rebase** via diff3 at a safe checkpoint, §10.4 — not just a file in a
  folder), and the watermark must be a **`(created_at,seq)` cursor**. Spec:
  `notes/inbound-sync-spec.md`. **Design pass 2026-06-19 put live mid-session inbound
  IN SCOPE** (target: a running agent sees an edit within seconds via the egress-poll
  daemon + stdin poke) — single-player works on the built path day-1; live multi-actor
  is this C1 work.
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

## Open decisions

1. **Runtime model** (#5): **DECIDED — k3s on a US box** (decider: BYO-subs couple
   to the k8s iron-proxy sidecar), with the **M1 as a zero-cost bring-up step**
   first.
2. **Notebook model** (#2): **DECIDED (revised 2026-06-19) — notes are
   artifact-canonical**, agents edit them directly (base-aware + conflict-state).
   Chat is an **input method + rendered view**, not the source of truth. The
   voice/mobile braindump is kept via a **second write mode** — append-style
   capture → an **append-only daily/log artifact** (never conflicts) — while
   structured docs use the edit mode. Explorability stays the *mount's* job (notes
   are now plain greppable files, no projection step). *(This reverses the earlier
   "read-only / braindump-notes-canonical-in-chat/Postgres" call.)* See
   `cas-ledger-build-plan.md` §10.2.
2b. **Storage substrate** (under #2/#3/#8): **BUILDING NOW on `feat/cas-ledger`** —
   own CAS-ledger (mig 033: cas_blobs/artifacts/artifact_versions/artifact_pointers;
   foundation + 4 codex lanes incl. write-back + node-diff3 conflict-state + GC +
   C1-ready hooks). **Corrections (stress-tested):** overlay-FS execution model
   **dropped** (no CAP_SYS_ADMIN in the sandbox) → workspace stays a plain `git
   clone --shared`; inbound invalidation is a **stdin directive**, not an outbound
   stream. **Still open (Centaur):** mid-session inbound sync (Track C1, downstream
   of the ledger) + large-file streaming (no object store in Centaur; ~16 MiB
   ceiling today). Plan: `notes/cas-ledger-build-plan.md`; C1 spec
   `notes/inbound-sync-spec.md`; design [[agent-data-architecture]].
3. **Claude-on-subscription** (#6): **like agentboard** — BYO-terminal / local
   bridge with your own auth (user's lean). API key kept as the multi-tenant-future
   path.
4. **Day-1 scope**: user marked **all four** bundles must-have (fast spawn + BYO,
   notebook + artifacts, mobile + web, archival + watcher) → everything is in
   scope, so the real lever is **sequencing** (proposed below), not cutting.

### Proposed sequence (since all four are must-have)

1. **Bring-up:** point Atrium at the M1; validate spawn → transcript → artifacts
   end-to-end with no new infra.
2. **Runtime:** stand up the k3s US box with a fat warm pool + per-(repo,branch)
   leases. Wire BYO **Codex** via iron-proxy/broker; **Claude/Gemini** via the
   BYO-terminal pane.
3. **Notebook + artifacts:** chief-of-staff channel, audio→STT, markdown editor,
   `atrium-memory/` read-only mirror; the **CAS-ledger v1 is in build now**
   (`feat/cas-ledger`: capture→versions, serve-latest, write-back+conflict-state,
   GC) so capture→S3 + gallery preview/edit is durable, not capture-only. Confirm
   the **Centaur producer** is deployed (merged to `atrium/integration`; upstream
   when stable) + capture the rollout JSONL on the same pipeline.
4. **Archival + watcher:** raw `session_events` + rollout-JSONL + external-jsonl
   blobs to S3, redaction-as-projection, normalized search; ship the watcher CLI
   (sink into `cass`).
5. **Mobile:** EAS push + lockscreen voice capture; thin client over the sync
   stream. Video/guests = fast-follow after the above.

## Codex (xhigh) feedback — folded in

Codex (gpt-5.5, xhigh) verified against the live repo + this machine. Where it
sharpened the plan, it's already integrated above; the high-signal deltas:

- **Verified on this machine:** both `~/.claude/projects/.../*.jsonl` and
  `~/.codex/sessions/.../*.jsonl` exist. The **GUI desktop apps keep separate
  stores** (Claude Desktop → `IndexedDB/...leveldb`, ChatGPT/Codex → app DBs), and
  Anthropic docs say desktop/web/VS-Code history is separate from CLI. ⇒ "watch
  the CLI dirs" and "ingest desktop apps" are **separate bets**; CLI is MVP,
  GUI-app scraping is premature. Also: treat the **Codex jsonl schema as private**
  (Claude's is documented; Codex's isn't) — parse defensively.
- **Notebook:** keep Postgres canonical, materialize a read-only `atrium-memory/`
  tree (`channels/<name>/<month>.md`, `sessions/<id>.md`, `index.jsonl`); giving
  agents raw Postgres is "powerful but wrong as default" (couples them to schema +
  perms + prod data). Add reversible **distillations**. → adopted in §2.
- **Spin-up:** "warm pods alone do not match tmux" — model the lease by
  **repo + branch + dependency hash**, show cold/warm/restored in the UI. → §5.
- **Subs:** "productizing MITM credential injection is a bad foundation"; per-user
  scoping isn't the hard part — **ToS, enforcement, revocation, credential blast
  radius** are. Model a per-user **harness matrix**: `API` / `local subscription
  bridge` / `unsupported`. → §6.
- **Harness swapping:** Centaur *accepting a harness string ≠ Atrium support* —
  the surface reducer is Codex + Claude/Amp-shaped today (verified in
  `centaur-client`). Define a **canonical normalized event contract** (text / tool
  call / tool result / file change / artifact / usage / question / status), store
  raw forever, normalize for UI+search, and gate new harnesses with **conformance
  fixtures** (replay real JSONL/SSE into the reducer). → strengthens §7's tiers.
- **Archival:** **redaction must be a projection layer, not destructive mutation**
  (full-fidelity archives contain secrets); content-hash idempotency in the
  watcher. → §8.
- **Artifacts trap:** current code still *proxies* artifact bytes from Centaur
  staging in places (`getArtifactBytes` → `/agent/executions/.../artifacts/...`,
  evictable) — that is **not an archive**. Offload to Atrium S3 on capture; add a
  "promote artifact → durable channel item." → §3.
- **Bad/premature (codex's list):** custom Atrium doc/todo format; native desktop
  rewrite; desktop-app log scraping as MVP; multi-cloud k8s; full call recording;
  **Claude-subscription MITM as a product.**
- **Missing pieces codex stressed:** auth roles (owner/member/guest/**agent**/
  service-account); secrets vault with `.env` denial + transcript-redaction
  overlays; per-session file/network/repo policy with **first-class approval
  logs**; notification priority (`agent needs answer` > `finished` > `artifact
  ready` > digest); observability (warm-pool hit rate, spawn-latency phases,
  tailer lag, dropped/replayed events, offload failures, cost/duration); data
  export bundles; **Postgres FTS is enough for MVP — add vector search only after
  lexical covers all raw + normalized data.**
