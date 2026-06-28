# Spike: warm pool for repo-bearing sessions (post-claim overlay bind, flat-home)

> **Status: SPIKE (2026-06-28). Verdict: GO — primitive empirically confirmed (flat-home).** De-risks
> the last piece of "warm the whole lease": giving repo-bearing sessions the warm pool's pod-boot saving
> (they already get warm deps/git/toolchain from the warm-cache tier). Builds on
> `docs/archive/notes/warm-lease-build-plan.md` §5. The POC (`ci/warmpool-rebind-poc.sh`) ran **green on
> kind (real Linux), locally and on GHA**, and proved the load-bearing mechanic — with a twist that
> changed the design. A real Centaur runtime change, not a flag flip.

## The question

The warm pool only serves *generic* sessions — `centaur-session-runtime/src/lib.rs` claim filter:
`… && session_repos_json.is_none()`. Repo sessions are **excluded**, so they always cold-spawn and pay
full pod schedule + container start. Can a repo session instead **claim a generic warm pod and bind its
repo + cache _post-claim_** (build-plan §5: "claim generic, hydrate post-claim via the overlay daemon")?

## Flat-home is the model (not `/workspace`)

The default is **flat-home** (`contrib/chart/values.yaml: flatHome: true`): the agent's **HOME
(`/home/agent`) IS the workspace overlay** — there is no `/workspace`. `entrypoint.sh` sets
`WORKSPACE_DIR="$HOME_DIR"`, and the overlay mounts at `/home/agent` (`overlay.rs`:
`flat_home ? /home/agent : /workspace`). `/workspace` is the legacy non-flat path. So the rebind must
make **HOME itself** become the session overlay on a running pod.

## Findings (recon + POC)

**1. A warm pod already has a per-pod workspace slot.** The warm spec runs the overlay init containers
with **empty `AGENT_REPOS_JSON`**, mounting a generic overlay at the pod's slot (keyed by the pod's own
sandbox-id, per-pod, not the thread/repo).

**2. There is a clean post-claim window, with precedent.** `claim()` already mutates a claimed pod
post-claim — it reassigns the iron-proxy principal and blocks until applied before any stdin is written.
The harness only runs on the **first `turn.start`** (`write_input_lines`), after `claim()` and
`set_runtime_context`. So there is a defined window — after claim, before turn 1 — to do the bind + a
readiness handshake. The hook fits right after `set_runtime_context`, before `ensure_session_pipe`.

**3. THE TWIST — you cannot remount AT the mountpoint; you submount UNDER its parent.** The obvious
mechanism — re-mount the overlay *at* the pod's exact mountpoint (HOME) — **fails**: the POC confirmed
that mounting/re-mounting at the bind source does **not** propagate into an already-running container,
even with the mount marked `shared`. `mountPropagation: HostToContainer` (rslave) propagates mounts made
**UNDER** the watched path, not a replacement **OF** it. Under flat-home this is fatal for the naive
approach, because HOME *is* the mountpoint. The mechanism that works: the warm pod's HostToContainer
volume watches the **PARENT of HOME** (`/home`, a shared mountpoint, HOME present-but-empty at boot), and
post-claim the daemon mounts the session overlay **at HOME** (`/home/agent`) — a **submount under
`/home`** — which propagates in, flipping the running agent's `$HOME` to the repo, flat. (The daemon gets
"shared" propagation from its DaemonSet volume's `mountPropagation: Bidirectional`; a raw mount is private
and won't propagate — the first POC runs surfaced exactly this.)

## POC — green on kind (real Linux), local + GHA

`centaur/services/api-rs/crates/centaur-node-sync/ci/warmpool-rebind-poc.sh`. Make `/home` an empty SHARED
mountpoint with HOME (`/home/agent`) present-but-empty → start a pod with `HOME=/home/agent`, the parent
`/home` bound HostToContainer, idle agent (uid 1001) → confirm Ready with empty `$HOME` while the
container runs → **post-start, mount the repo overlay at `/home/agent`** (chowning the upper to the agent
uid, as the daemon does) → assert the running container's **`$HOME` *is* the repo, flat** (README.md +
src/lib.rs, `cd ~` works) and a first-turn write lands in the (capturable) overlay upper. **Result: PASS
(`POC_EXIT=0`)** — run locally on a throwaway kind cluster with a stock `alpine` image (no node-sync image
needed — the pod just needs `/bin/sh`) and again on a GHA runner. Wired as an informational step in the
kind CI job, which is **push-only**, so it re-runs on merge-to-master.

Negative result captured in the script header so we don't relearn it: mounting AT the mountpoint (HOME)
in place does not propagate post-start.

A second POC, `ci/warmpool-home-compose-poc.sh`, validates the **HOME composition** (build step 3): it
composes a generic-HOME-config lower (`~/.codex`/`~/.claude`/`~/.config` + centaur `~/AGENTS.md`) BENEATH a
repo lower (with its own `AGENTS.md`), submounts the composed overlay at HOME post-start, and asserts the
running pod's HOME has both the harness config and the repo with centaur's `AGENTS.md` winning — **green on
kind, and again with the real `centaur-agent` image where `codex` + `claude` actually run in the composed
HOME and read their config.** (Runs `alpine` in CI; the real-harness step auto-runs only when the agent
image is used.)

## Verdict: GO (scoped) — submount-at-HOME under flat-home

Remaining build, in order:
1. **Generic shared `/home` in the warm spec** — the warm pod's HostToContainer volume is the **parent of
   HOME** (`/home`), a `shared` mountpoint, with `/home/agent` present-but-empty; the pod stays Ready as a
   generic shell. (Today the warm/flat-home spec mounts the overlay AT `/home/agent`; this moves it up one
   level so the post-claim overlay can land as a submount.)
2. **Post-claim bind in `centaur-session-runtime`** — in the post-claim window, write the claimed
   session's manifest and have the daemon mount the composed overlay (repo lower + warm-cache lower +
   upper, upper chowned to the agent uid) **at `/home/agent`** (a submount under `/home`), then a
   **readiness handshake** (block until the submount is visible) before the first turn. Mirror the
   iron-proxy "apply + wait" barrier.
3. **Reconcile boot-time HOME setup — RESOLVED (compose generic HOME as a lower; POC'd with real harnesses).**
   Under flat-home the entrypoint writes the agent's whole generic HOME into HOME (`~/.codex`, `~/.claude`,
   `~/.config/amp`, `~/AGENTS.md` = the centaur system prompt; real creds are at the iron-proxy, NOT HOME — so
   the HOME content is GENERIC). A submount *at* HOME would shadow it. **Decision: the daemon composes the
   warm pod's generic HOME as a read-only LOWER beneath the repo** — `lowerdir=<generic-home>:<repo>` — so the
   submounted HOME = repo files + harness config, merged. The entrypoint copies
   `/opt/centaur/AGENTS.md` → `$HOME/AGENTS.md`. **Correction (2026-06-28):** an earlier draft said
   "centaur's `~/AGENTS.md` *wins over a repo's own*, matching today's flat-home" — that premise is
   **wrong**. Production flat-home nests session repos at `~/repos/<owner>/<repo>` (see the
   `flat-home-dir-cleanup-plan.md` empirical trace), so centaur's `~/AGENTS.md` and a repo's
   `~/repos/<owner>/<repo>/AGENTS.md` are *distinct paths that never collide* — there is no clobber,
   and no lowerdir-order "knob" is needed for it. The real `~/AGENTS.md` issue was *capture
   pollution* (it landed in the captured overlay upper), now fixed by excluding it in `classify_entry`
   (#170); relocating it into a read-only lower so it is read-only too is the part bundled with this
   warm-pool build. Validated by
   `ci/warmpool-home-compose-poc.sh` (green local + GHA, and again with the **real `centaur-agent` image**:
   `codex` + `claude --version` both run in the composed overlay HOME and `~/.codex/config.toml`,
   `~/.claude/settings.json`, `~/AGENTS.md` are all present + readable). Minor wrinkle to handle in the build:
   `codex` startup logs `could not create PATH aliases: Permission denied` under the composed HOME (it
   proceeds anyway) — ensure the dir it writes is writable, or it's harmless. (The `/home/agent/context` RO
   `/atrium` mount, also under HOME, likewise composes as a lower or re-mounts under the bound HOME.)
4. **Relax the filter** — drop only `session_repos_json.is_none()`; keep env/persona/resume exclusions
   (personas are unused in Atrium, so "repos only" is sufficient).
5. **e2e** — promote this POC into a real-pod test driven by the actual daemon (Bidirectional volume) +
   the post-claim path, asserting the first turn runs with `$HOME` == the bound repo.

## Decisions already locked (this thread)

- **Topology:** single-node now, multi-node later → locality is free for v1; don't corner it.
- **Cache locality:** claim any warm pod + cross-node CAS pull on a cold node (no affinity scheduling).
- **Dep-cache reach:** cross-node via the daemon (the warm-cache lower composes into the post-claim overlay).
- **Eligibility:** repos only.
- **Value:** the prize is the pod-boot seconds (interactive snappiness); cache locality is already maxed
  by Phase 1 on one node. Worth measuring pod-boot in prod to size it.

## Risks / open

- **HOME-setup vs the post-claim submount** (item 3 above) — the main integration wrinkle.
- **Upper ownership**: the overlay upper must be chowned to the agent uid before the bind (the daemon's
  `prepare_upper_and_merged` already does this; the POC replicates it).
- **Context submount**: flat-home also mounts `/home/agent/context` (read-only). With HOME a submount, the
  context volume must be re-established under the bound HOME post-claim (or composed into the overlay).
- **Failure mode**: if the bind fails, **release the warm pod + cold-spawn** — never serve a half-bound pod.
- **No new idle pods**: still one generic pool, so no per-repo idle cost.

## Future (not this work)

Per-repo prebuilt pools (build-plan §7 "Full") pre-pay the *install* second too, at combinatorial idle
cost — defer to hot repos only. At large multi-node scale, **eager cross-node replication** of the hot
dep-store set to every node (Dragonfly/Kraken-style p2p, bounded by disk) makes every node always-warm;
content-addressed blobs let it drop in without touching cache logic. Tracked in gbasin/atrium#141.
