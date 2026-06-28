# Spike: warm pool for repo-bearing sessions (post-claim overlay bind)

> **Status: SPIKE (2026-06-28). Verdict: GO — primitive empirically confirmed.** De-risks the last
> piece of "warm the whole lease": giving repo-bearing sessions the warm pool's pod-boot saving (they
> already get warm deps/git/toolchain from the warm-cache tier). Builds on
> `docs/archive/notes/warm-lease-build-plan.md` §5. The POC (`ci/warmpool-rebind-poc.sh`) ran **green on
> kind (real Linux)** and proved the load-bearing mechanic — with a twist that changed the design.
> This is a real Centaur runtime change, not a flag flip.

## The question

The warm pool only serves *generic* sessions — `centaur-session-runtime/src/lib.rs` claim filter:
`… && session_repos_json.is_none()`. Repo sessions are **excluded**, so they always cold-spawn and pay
full pod schedule + container start. Can a repo session instead **claim a generic warm pod and bind its
repo + cache _post-claim_** (build-plan §5: "claim generic, hydrate post-claim via the overlay daemon")?

## Findings (recon + POC)

**1. A warm pod already has a per-pod workspace slot.** The warm spec runs the overlay init containers
with **empty `AGENT_REPOS_JSON`**, so at boot the daemon mounts a generic overlay at the pod's slot
`/run/centaur/merged/<sandbox-id>` — keyed by the pod's own id (per-pod), not the thread/repo.

**2. There is a clean post-claim window, with precedent.** `claim()` already mutates a claimed pod
post-claim — it reassigns the iron-proxy principal and blocks until applied before any stdin is written.
The harness only runs on the **first `turn.start`** (`write_input_lines`), after `claim()` and
`set_runtime_context`. So there is a defined window — after claim, before turn 1 — to do the bind + a
readiness handshake. The hook fits right after `set_runtime_context`, before `ensure_session_pipe`.

**3. THE TWIST — in-place remount does NOT work; a submount does.** The obvious mechanism — re-mount the
overlay *at the pod's exact `/workspace` mountpoint* (swap the lower) — **fails**: the POC confirmed that
unmounting + remounting at the bind source does **not** propagate into an already-running container, even
with the mount marked `shared`. `mountPropagation: HostToContainer` (rslave) propagates mounts made
**UNDER** the watched path, not a replacement **OF** it. The mechanism that works: the warm pod's
`/workspace` is a **generic, empty, SHARED mountpoint**, and post-claim the daemon mounts the session
overlay at a **subpath** (`/workspace/<repo>`) — that submount propagates into the running pod. (The
daemon already gets "shared" propagation from its DaemonSet volume's `mountPropagation: Bidirectional`;
a raw mount is private and won't propagate — the first POC runs surfaced exactly this.)

## POC — green on kind (real Linux), incl. Docker Desktop

`centaur/services/api-rs/crates/centaur-node-sync/ci/warmpool-rebind-poc.sh`. Make a per-pod slot an empty
SHARED mountpoint → start a pod bound to it (HostToContainer), confirm Ready with empty `/workspace` while
the container runs → **post-start, mount a repo overlay at `<slot>/repo`** (chowning the upper to the agent
uid, as the daemon does) → assert the running container now sees `/workspace/repo/{README.md,src/lib.rs}`
and that a first-turn write lands in the (capturable) overlay upper. **Result: PASS (`POC_EXIT=0`)**, run
locally on a throwaway kind cluster with a stock `alpine` image (no node-sync image needed — the pod just
needs `/bin/sh`). It's also wired as an informational step in the kind CI job, which is **push-only**
(kept out of the required PR gate), so it re-runs on merge-to-master.

Negative result captured in the script's header so we don't relearn it: the in-place-remount variant
fails to propagate.

## Verdict: GO (scoped) — via the submount mechanism

Remaining build, in order:
1. **Generic shared workspace slot in the warm spec** — the warm pod's `/workspace` is an empty,
   `shared` mountpoint (no session overlay at boot); the pod stays Ready as a generic shell.
2. **Post-claim bind in `centaur-session-runtime`** — in the post-claim window, write the claimed
   session's manifest pointing the daemon to mount the composed overlay (repo lower + warm-cache lower +
   upper, upper chowned to the agent uid) at `<slot>/<repo>` — a **submount** under the slot — then a
   **readiness handshake** (block until the submount is visible) before the first turn. Mirror the
   iron-proxy "apply + wait" barrier.
3. **`cd` on the first turn** — the agent's working dir becomes `/workspace/<repo>` (the submount), set
   post-claim. (Single-repo: one submount; multi-repo: one per repo, as today's overlay compose does.)
4. **Relax the filter** — drop only `session_repos_json.is_none()`; keep env/persona/resume exclusions
   (personas are unused in Atrium, so "repos only" is sufficient).
5. **e2e** — promote this POC into a real-pod test driven by the actual daemon (Bidirectional volume) +
   the post-claim path, asserting the first turn runs in the bound repo.

## Decisions already locked (this thread)

- **Topology:** single-node now, multi-node later → locality is free for v1; don't corner it.
- **Cache locality:** claim any warm pod + cross-node CAS pull on a cold node (no affinity scheduling).
- **Dep-cache reach:** cross-node via the daemon (the warm-cache lower composes into the post-claim overlay).
- **Eligibility:** repos only.
- **Value:** the prize is the pod-boot seconds (interactive snappiness); cache locality is already maxed
  by Phase 1 on one node. Worth measuring pod-boot in prod to size it.

## Risks / open

- **The submount changes the agent's CWD** to `/workspace/<repo>` (vs `/workspace` today). Confirm the
  harness + tools are happy with that, or alias/bind `/workspace` → the submount for ergonomics.
- **Upper ownership**: the overlay upper must be chowned to the agent uid before the bind (the daemon's
  `prepare_upper_and_merged` already does this; the POC replicates it).
- **Failure mode**: if the bind fails, **release the warm pod + cold-spawn** — never serve a half-bound pod.
- **No new idle pods**: still one generic pool, so no per-repo idle cost.

## Future (not this work)

Per-repo prebuilt pools (build-plan §7 "Full") pre-pay the *install* second too, at combinatorial idle
cost — defer to hot repos only. At large multi-node scale, **eager cross-node replication** of the hot
dep-store set to every node (Dragonfly/Kraken-style p2p, bounded by disk) makes every node always-warm;
content-addressed blobs let it drop in without touching cache logic. Tracked in gbasin/atrium#141.
